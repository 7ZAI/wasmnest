/**
 * 应用更新面（应用版本更新全链路，桌面壳）
 *
 * 数据源 = 应用仓 GitHub Release：宿主命令 `plugin_check_app_update`（查最新版 +
 * 下载元数据）与 `plugin_download_update`（校验下载更新包），安装复用
 * `plugin_install_from_file` 升级模式（wasm-core 侧保留插件数据、宿主面凭证门、
 * 运行中 / 非 user-installed 拒绝——机制真源在能力仓）。
 *
 * **兼容判断在壳**（本文件）：壳持有 `MOUNT_CONTRACT`（与挂载期比对同源）与宿主
 * 自身版本（`get_app_version`）。三道判据（任一命中 = fail-visible 拒绝，绝不给出
 * 更新动作）：
 *  1. 元数据缺 `compat` 段（本功能前的旧发布物）→ 不兼容；
 *  2. `compat.mountContract !== MOUNT_CONTRACT` → 不兼容（挂载期兜底同判据）；
 *  3. `semverGt(compat.hostRuntime, 宿主版本)` → 不兼容（要求比当前平台新，先升级宿主）。
 *
 * 错误处理（ADR 0030 口径，同 useUpdateChecker）：检查失败置 `error` 态 + 界面通用
 * 文案，技术详情只进日志；更新（下载+安装）失败经 showUserError 集中提示——它是
 * 用户显式发起的动作，与 useShellApps 动作同约定。
 */
import { ref } from 'vue'
import { invoke } from '@/utils/invoke'
import { ensureHostCredential } from '@/utils/appCommands'
import { showUserError } from '@/utils/userError'
import { logger } from '@/utils/frontendLogger'
import { MOUNT_CONTRACT } from '../mount/useAppMount'

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'incompatible'
  | 'updating'
  | 'error'

/** 不兼容 / 失败原因（展示层按 key 翻译；params 只承载版本号等非技术值） */
export interface AppUpdateReason {
  key: string
  params?: Record<string, string>
}

export interface AppUpdateState {
  status: AppUpdateStatus
  latestVersion?: string
  currentVersion?: string
  reason?: AppUpdateReason
  /** 仅 `available` 态存在：更新动作所需的下载参数（Rust 侧已自证形态） */
  apply?: { tag: string; zipAsset: string; sha256: string }
}

/** 宿主命令 `plugin_check_app_update` 返回（compat 缺段时为 null = 旧发布物） */
interface AppUpdateCheckInfo {
  pluginId: string
  currentVersion: string
  latestVersion: string
  tag: string
  zipAsset: string
  sha256: string
  bytes: number
  compat: {
    hostRuntime: string
    mountContract: string
    sdkVersion: string
    witVersion: string
  } | null
}

// ==================== 语义化版本比较（严格解析，fail-visible） ====================

export interface ParsedSemver {
  major: number
  minor: number
  patch: number
  /** pre-release 段（`-rc.1` → ['rc', 1]）；无 pre-release 为 null */
  pre: Array<string | number> | null
}

/**
 * 严格 x.y.z[-pre] 解析；形态非法返回 null（调用方按「无法判断」处理，不猜测）。
 * 本地只做判断不用范围语法，核心三段 + 可选 pre-release 足够。
 */
export function parseSemver(v: string): ParsedSemver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] === undefined ? null : m[4].split('.').map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg)),
  }
}

function comparePre(a: Array<string | number> | null, b: Array<string | number> | null): number {
  // 无 pre-release > 有 pre-release（semver 规则 11）
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const sa = a[i]
    const sb = b[i]
    if (sa === undefined) return -1 // 前缀相等时段少者小
    if (sb === undefined) return 1
    if (typeof sa === 'number' && typeof sb === 'number') {
      if (sa !== sb) return sa < sb ? -1 : 1
    } else if (typeof sa === 'string' && typeof sb === 'string') {
      if (sa !== sb) return sa < sb ? -1 : 1
    } else {
      // 数字段 < 字母段（semver 规则 11.4）
      return typeof sa === 'number' ? -1 : 1
    }
  }
  return 0
}

/** 比较两个版本；任一形态非法返回 null（不猜测） */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return null
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  return comparePre(pa.pre, pb.pre)
}

// ==================== 兼容判断 ====================

/** 宿主自身版本（get_app_version = CARGO_PKG_VERSION；模块级缓存，失败不缓存） */
let hostVersionPromise: Promise<string> | null = null
function hostVersion(): Promise<string> {
  if (!hostVersionPromise) {
    hostVersionPromise = invoke<string>('get_app_version').catch((e) => {
      hostVersionPromise = null
      throw e
    })
  }
  return hostVersionPromise
}

/**
 * 兼容裁决：返回 null = 兼容；返回 reason = 不兼容（fail-visible 的理由）。
 * 与挂载期兜底（useAppMount assertMountContract）同判据——这里把拒绝提前到
 * 「下载之前」，挂载期比对仍是最后防线。
 */
export function evaluateCompat(
  compat: AppUpdateCheckInfo['compat'],
  currentHostVersion: string,
): AppUpdateReason | null {
  if (!compat) {
    return { key: 'shell.apps.update.reason.noCompat' }
  }
  if (compat.mountContract !== MOUNT_CONTRACT) {
    return {
      key: 'shell.apps.update.reason.mountContract',
      params: { required: compat.mountContract, current: MOUNT_CONTRACT },
    }
  }
  const gt = compareSemver(compat.hostRuntime, currentHostVersion)
  if (gt === null) {
    return {
      key: 'shell.apps.update.reason.hostRuntimeInvalid',
      params: { required: compat.hostRuntime, current: currentHostVersion },
    }
  }
  if (gt > 0) {
    return {
      key: 'shell.apps.update.reason.hostRuntime',
      params: { required: compat.hostRuntime, current: currentHostVersion },
    }
  }
  return null
}

// ==================== 状态与动作（模块级单例，与 useShellApps 同形） ====================

const states = ref<Record<string, AppUpdateState>>({})

function stateOf(appId: string): AppUpdateState {
  if (!states.value[appId]) {
    states.value[appId] = { status: 'idle' }
  }
  return states.value[appId]
}

/** 检查指定应用更新（成功落 available / up-to-date / incompatible，失败落 error） */
async function check(appId: string): Promise<void> {
  const st = stateOf(appId)
  st.status = 'checking'
  st.reason = undefined
  try {
    const credential = await ensureHostCredential()
    const info = await invoke<AppUpdateCheckInfo>('plugin_check_app_update', {
      pluginId: appId,
      credential,
    })
    st.currentVersion = info.currentVersion
    st.latestVersion = info.latestVersion
    const cmp = compareSemver(info.latestVersion, info.currentVersion)
    if (cmp !== null && cmp <= 0) {
      st.status = 'up-to-date'
      return
    }
    const reason = evaluateCompat(info.compat, await hostVersion())
    if (reason) {
      st.apply = undefined
      st.reason = reason
      st.status = 'incompatible'
      return
    }
    st.apply = { tag: info.tag, zipAsset: info.zipAsset, sha256: info.sha256 }
    st.status = 'available'
  } catch (e) {
    // 检查是被动动作：不 toast（避免连点刷屏），界面走 error 态通用文案，详情落日志
    logger.warn('[AppUpdates] check failed', e)
    st.apply = undefined
    st.reason = undefined
    st.status = 'error'
  }
}

/** 应用更新：下载（sha256 校验在 Rust 侧）→ 升级安装（保数据，wasm-core 裁决） */
async function applyUpdate(appId: string): Promise<boolean> {
  const st = stateOf(appId)
  if (st.status !== 'available' || !st.apply) return false
  const apply = st.apply
  st.status = 'updating'
  try {
    const credential = await ensureHostCredential()
    const path = await invoke<string>('plugin_download_update', {
      pluginId: appId,
      tag: apply.tag,
      zipAsset: apply.zipAsset,
      sha256: apply.sha256,
      credential,
    })
    await invoke('plugin_install_from_file', { path, credential, upgrade: true })
    st.apply = undefined
    st.reason = undefined
    st.status = 'up-to-date'
    return true
  } catch (e) {
    // 更新是显式动作：走集中提示（showUserError），错误码文案见 errors.*
    showUserError(e)
    logger.warn('[AppUpdates] apply failed', e)
    st.status = 'error'
    return false
  }
}

/** 清空指定应用的面状态（清单刷新 / 应用被卸载后由视图调用） */
function clear(appId: string): void {
  delete states.value[appId]
}

export function useAppUpdates() {
  return { states, check, applyUpdate, clear }
}
