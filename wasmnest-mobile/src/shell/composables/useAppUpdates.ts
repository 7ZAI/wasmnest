/**
 * 应用更新面（应用版本更新全链路，移动壳）
 *
 * 数据源 = 应用仓 GitHub Release：宿主命令 `plugin_check_app_update`（查最新版 +
 * 下载元数据）与 `plugin_download_update`（校验下载更新包），安装复用
 * `plugin_install_from_file` 升级模式（`upgrade = true`；先停用，插件 KV 保留，
 * 目录换新后审批哈希失配 → 下次激活需重新批准）。
 *
 * 兼容判断真源在宿主（`plugin_check_app_update` 的 `compatible` / `compatReason`：
 * 移动端只有宿主运行时轴，mountContract 是桌面概念）。本文件只做状态机与动作编排。
 *
 * 错误口径（与桌面 useAppUpdates 同约定）：检查失败落 `error` 态 + 通用文案，
 * 技术详情只进日志；更新是用户显式动作，失败经 toast 提示。
 */
import { ref } from 'vue'
import {
  pluginCheckAppUpdate,
  pluginDownloadUpdate,
  pluginInstallFromFile,
} from '@/plugin/commands'
import { logger } from '@/utils/frontendLogger'
import i18n from '@/locales'
import { useToast } from '../../composables/useToast'

export type AppUpdateStatus =
  'idle' | 'checking' | 'up-to-date' | 'available' | 'incompatible' | 'updating' | 'error'

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

// ==================== 语义化版本比较（严格解析，fail-visible） ====================

interface ParsedSemver {
  major: number
  minor: number
  patch: number
  pre: Array<string | number> | null
}

function parseSemver(v: string): ParsedSemver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre:
      m[4] === undefined
        ? null
        : m[4].split('.').map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg)),
  }
}

function comparePre(a: Array<string | number> | null, b: Array<string | number> | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const sa = a[i]
    const sb = b[i]
    if (sa === undefined) return -1
    if (sb === undefined) return 1
    if (typeof sa === 'number' && typeof sb === 'number') {
      if (sa !== sb) return sa < sb ? -1 : 1
    } else if (typeof sa === 'string' && typeof sb === 'string') {
      if (sa !== sb) return sa < sb ? -1 : 1
    } else {
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

// ==================== 状态与动作（模块级单例，与桌面 useAppUpdates 同形） ====================

const states = ref<Record<string, AppUpdateState>>({})

function stateOf(appId: string): AppUpdateState {
  if (!states.value[appId]) {
    states.value[appId] = { status: 'idle' }
  }
  return states.value[appId]
}

function t(key: string, params?: Record<string, unknown>): string {
  return i18n.global.t(key, params ?? {})
}

/** 检查指定应用更新（成功落 available / up-to-date / incompatible，失败落 error） */
async function check(appId: string): Promise<void> {
  const st = stateOf(appId)
  st.status = 'checking'
  st.reason = undefined
  try {
    const info = await pluginCheckAppUpdate(appId)
    st.currentVersion = info.currentVersion
    st.latestVersion = info.latestVersion
    const cmp = compareSemver(info.latestVersion, info.currentVersion)
    if (cmp !== null && cmp <= 0) {
      st.status = 'up-to-date'
      return
    }
    if (!info.compatible) {
      st.apply = undefined
      st.reason = info.compatReason ?? { key: 'shell.apps.update.reason.noCompat' }
      st.status = 'incompatible'
      return
    }
    st.apply = { tag: info.tag, zipAsset: info.zipAsset, sha256: info.sha256 }
    st.status = 'available'
  } catch (e) {
    logger.warn('[AppUpdates] check failed', e)
    st.apply = undefined
    st.reason = undefined
    st.status = 'error'
  }
}

/** 应用更新：下载（sha256 校验在 Rust 侧）→ 升级安装（保数据；需重新审批） */
async function applyUpdate(appId: string): Promise<boolean> {
  const st = stateOf(appId)
  if (st.status !== 'available' || !st.apply) return false
  const apply = st.apply
  st.status = 'updating'
  try {
    const path = await pluginDownloadUpdate({
      pluginId: appId,
      tag: apply.tag,
      zipAsset: apply.zipAsset,
      sha256: apply.sha256,
    })
    await pluginInstallFromFile(path, true)
    st.apply = undefined
    st.reason = undefined
    st.status = 'up-to-date'
    useToast().success(t('shell.apps.update.installed'))
    return true
  } catch (e) {
    logger.warn('[AppUpdates] apply failed', e)
    useToast().error(t('shell.apps.update.failed'))
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
