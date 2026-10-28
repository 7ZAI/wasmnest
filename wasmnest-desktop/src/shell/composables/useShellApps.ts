/**
 * 壳应用面（注册表投影 + 生命周期动作收口）
 *
 * 2026-10-17 lifecycle-sync 改造后：**静态面目录改为注册表投影**——应用清单经
 * `plugin_list_loaded` 真通道从宿主拉取（命令面已有），每个应用卡片的运行态 /
 * 待审批 / 错误都来自真实 `PluginState`；「打开 / 关闭 / 审批 / 卸载 / 启用 /
 * 自启」动作经宿主命令面驱动真实生命周期（D2/D3）。
 *
 * 归属（AGENTS §5.1）：这里只有「注册表投影 + 动作的机械转发」，无业务编排；
 * 动作的成功/失败口径只有一份实现（状态回写 + lastError 暴露），组件只调动作。
 *
 * 与移动端壳 `useShellApps`（launch/stop/approve/remove 动作收口）同构：
 * - 打开 = preauthorize → activate（真激活，仅当前会话；跨启动只认 autostart 偏好）
 * - 关闭 = deactivate（**真停用**：guest deactivate + 权限撤销 + 总线退订 +
 *   store 随实例回收——wasm-core 机制，见宿主 lifecycle.rs 头注释）
 * - 审批 = approve（整单批准 + 内容哈希钉扎）
 * - 卸载 = uninstall（停用 → 丢私有库 → 删目录 → 清存储）
 * - 启用 = set_enabled（**主屏入口可见性**，2026-10-21 用户裁决：缺省可见，false =
 *   主屏 / 搜索隐藏入口；不触发启停、不停止已运行实例——宿主 lifecycle.rs 头注释）
 * - 自启 = set_autostart（只改持久化偏好，boot 装配生效，与启用解耦）
 */
import { computed, ref } from 'vue'
import { invoke } from '@/utils/invoke'
import { logger } from '@/utils/frontendLogger'
import { ensureHostCredential, invalidateChannelToken } from '@/utils/appCommands'
import { HOST_INTERNAL_CODE, parseInvokeError, showUserError } from '@/utils/userError'
import { toneOf, type AppTone } from './state'
import type { AppDisplayState } from '../types'

/**
 * 宿主 `plugin_list_loaded` 返回的插件信息形状（与 wasm-core `HostPluginInfo`
 * serde camelCase 逐字段对应；state 为 `{state, error?}` 标签形状）
 */
export interface HostPluginInfo {
  id: string
  name: string
  version: string
  description: string
  author: string
  main: string
  pluginType: string
  /** 装配角色（manifest `type`；business-app / internal-business / basic-service） */
  kind?: string
  rustLibrary: string
  permissions: string[]
  state: { state: string; error?: string }
  extensionPath: string
  contributes: unknown
  icon?: string
  source: string
  sizeBytes?: number
  installedAt?: number | null
}

/** 壳主屏的业务应用条目（注册表投影；id = pluginId，宿主 manifest 单一事实源） */
export interface ShellAppEntry {
  /** 壳内面键（app:<id> 的 id 段 = pluginId；改名随 manifest 走，不碎卡） */
  id: string
  /** 宿主装配的应用 id（manifest 真源） */
  pluginId: string
  /** 显示名（manifest.name） */
  name: string
  version: string
  description?: string
  /**
   * 回退图标名（ShellIcon glyph；应用自带图标加载不出来时用）
   *
   * 应用图标真源 = 应用包自带的 `manifest.icon` 文件（见 `appIcons.ts`），这里只是
   * 降级兜底——故为机制哈希而非产品映射。
   */
  icon: string
  /** manifest 声明的图标文件名（`icon.svg` 等；缺省 = 未声明，走约定文件名） */
  iconFile?: string
  /** 图标色调档（机制哈希；仅回退 glyph 形态使用） */
  tone: AppTone
  /** 壳展示态（真实 PluginState 归并） */
  state: AppDisplayState
  /** 原始 PluginState 字符串（详情/排障用） */
  pluginState: string
  /** 装配角色（manifest `type`）：L1/L2 = 系统服务，L3 = 业务应用；缺省视为 L3 */
  kind?: string
  /** 错误详情（state=error 时非空） */
  error?: string
  /** 来源：builtin / scanned / wasm / user-installed */
  source: string
  sizeBytes?: number
  permissions: string[]
  /** 主屏入口可见性偏好（缺省 true；false = 用户停用 → 主屏 / 搜索隐藏入口，真源 = 宿主 lifecycle.rs） */
  enabled: boolean
  /** 启动时自动激活偏好（缺省 false；boot 装配真源，与启用解耦） */
  autostart: boolean
  /** 宿主挂载运行面的落地路由（有前端界面的应用在 SURFACE_ROUTES 登记；无界面应用缺省 = 无挂载面） */
  route?: string
}

/**
 * 宿主挂载运行面路由表（桌面 UI 宿主修正 2026-10-17）：应用前端由壳经挂载槽承载
 * 其独立构建的前端整包（机制 B，非贡献面）。每个有前端界面的挂载包都在此登记
 * （现状 6 个：bedcode / agent-hub / ai-chatbox / file-transfer / monitor /
 * auth-center）；`auth-center` 住应用仓 `servers/` 分组（服务型 wasm）；
 * 无前端界面的应用无挂载路由。registerSurface 契约为多应用扩展预留（防回接锁保持）。
 *
 * 插件 id 家族随 ADR 0056 全改 `com.wasmnest`（bedcode 应用豁免仅显示名 / rust
 * lib 名 / 目录 slug 三件，id 不在豁免内）——此处用改名后的终态 id；产物目录
 * 由构建脚本按 `PLUGIN_ID` 同步重建。
 */
export const TERMINAL_PLUGIN_ID = 'com.wasmnest.bedcode'
export const AGENT_HUB_PLUGIN_ID = 'com.wasmnest.agent-hub'
export const AI_CHATBOX_PLUGIN_ID = 'com.wasmnest.ai-chatbox'
export const FILE_TRANSFER_PLUGIN_ID = 'com.wasmnest.file-transfer'
export const MONITOR_PLUGIN_ID = 'com.wasmnest.monitor'
/** 认证中心（服务型 wasm：L1 基础服务 / L2 内部业务，随宿主分发；应用仓 `servers/auth-center`） */
export const AUTH_CENTER_PLUGIN_ID = 'com.wasmnest.auth-center'

/**
 * 宿主挂载运行面路由表（桌面 UI 宿主修正 2026-10-17）：每个有前端界面的 wasm
 * app 都是**独立应用**，由壳经挂载槽装载其独立构建的前端整包（机制 B，非贡献面）。
 *
 * `landing` = 主屏点卡后落地的默认路由；`prefixes` = 该 app 在宿主 history 路由表
 * 里的路由前缀集（宿主 router 逐条声明 → AppMountSlot）。bedcode 保持既有路径
 * 与深链语义（/terminal-window/:id 独立窗口）；其余三 app 单面单路由。
 *
 * 插件 id 家族随 ADR 0056 全改 `com.wasmnest`；产物目录由构建脚本按 `PLUGIN_ID`
 * 同步重建。
 */
export const SURFACE_ROUTES: Readonly<Record<string, string>> = {
  [TERMINAL_PLUGIN_ID]: '/sessions',
  [AGENT_HUB_PLUGIN_ID]: '/hub',
  [AI_CHATBOX_PLUGIN_ID]: '/chat',
  [FILE_TRANSFER_PLUGIN_ID]: '/transfer',
  [MONITOR_PLUGIN_ID]: '/monitor',
  [AUTH_CENTER_PLUGIN_ID]: '/auth',
}

/** 每 app 的路由前缀集（pluginIdOfAppRoute 反向映射用） */
const APP_ROUTE_PREFIXES: Readonly<Record<string, string[]>> = {
  [TERMINAL_PLUGIN_ID]: [
    '/pairing',
    '/sessions',
    '/tasks',
    '/settings',
    '/server',
    '/history',
    '/terminal-window',
  ],
  [AGENT_HUB_PLUGIN_ID]: ['/hub'],
  [AI_CHATBOX_PLUGIN_ID]: ['/chat'],
  [FILE_TRANSFER_PLUGIN_ID]: ['/transfer'],
  [MONITOR_PLUGIN_ID]: ['/monitor'],
  [AUTH_CENTER_PLUGIN_ID]: ['/auth'],
}

/** 应用 id（= pluginId）→ 挂载路由（landing）；无运行面的应用返回 undefined */
export function routeOfApp(pluginId: string): string | undefined {
  return SURFACE_ROUTES[pluginId]
}

/** 应用路由 → 属主 pluginId（faceOfRoute 反向映射用；无属主返回 undefined） */
export function pluginIdOfAppRoute(path: string): string | undefined {
  for (const [pluginId, prefixes] of Object.entries(APP_ROUTE_PREFIXES)) {
    if (prefixes.some((p) => path === p || path.startsWith(`${p}/`))) return pluginId
  }
  return undefined
}

/** 装配角色是否为系统服务（L1 基础服务 / L2 内部业务） */
export function isServiceKind(kind?: string): boolean {
  return kind === 'basic-service' || kind === 'internal-business'
}

/** PluginState 字符串 → 壳展示态（AppDisplayState 五档） */
export function mapDisplayState(pluginState: string): AppDisplayState {
  switch (pluginState) {
    case 'activated':
      return 'running'
    case 'degraded':
      // 实例活着（命令可用）但启动初始化未完成：桌面保留独立「降级」档
      return 'degraded'
    case 'needsApproval':
      return 'approval'
    case 'error':
      return 'error'
    case 'activating':
      // 激活进行中：后端未给终态，按未启动呈现，刷新后自愈
      return 'dormant'
    case 'loaded':
    case 'deactivated':
    default:
      return 'dormant'
  }
}

/** 回退图标名（机制哈希自 pluginId，非产品映射；正常路径用应用自带图标） */
function shellIconForApp(pluginId: string): string {
  const SET = ['terminal', 'ai', 'transfer', 'hub', 'folder', 'bolt']
  let h = 0
  for (let i = 0; i < pluginId.length; i++) h = (h * 31 + pluginId.charCodeAt(i)) >>> 0
  return SET[h % SET.length]
}

/** 注册表投影：HostPluginInfo → ShellAppEntry（enabled/autostart 另查命令面） */
function toEntry(info: HostPluginInfo, enabled: boolean, autostart: boolean): ShellAppEntry {
  return {
    id: info.id,
    pluginId: info.id,
    name: info.name,
    version: info.version,
    description: info.description || undefined,
    icon: shellIconForApp(info.id),
    iconFile: typeof info.icon === 'string' && info.icon.trim() !== '' ? info.icon : undefined,
    tone: toneOf(info.id),
    state: mapDisplayState(info.state.state),
    pluginState: info.state.state,
    kind: info.kind,
    error: info.state.error,
    source: info.source,
    sizeBytes: typeof info.sizeBytes === 'number' ? info.sizeBytes : undefined,
    permissions: info.permissions ?? [],
    enabled,
    autostart,
    route: routeOfApp(info.id),
  }
}

const plugins = ref<ShellAppEntry[]>([])
const loading = ref(false)
/** 是否已首次拉取落地（false = 还在拉，UI 出加载态而非空态） */
const listReady = ref(false)
/** 正在切换的应用 id（动作进行中禁用重复点击） */
const busyId = ref<string | null>(null)
/** 外部应用包安装/升级进行中（安装无属主应用，不占 busyId；安装入口据此禁用） */
const installing = ref(false)
/**
 * 最近一次动作的错误**码**（ADR 0030 信封 `code`，成功清空）。
 *
 * 只做分支判据（如「激活失败后终态是否 NeedsApproval」），**不作展示**：用户可见
 * 文案统一由 `showUserError` 走 `errors.<code>` 模板发出。此前这里是错误原文，配合
 * `String(e)` 把 Tauri 的 `{code, request_id}` 信封渲染成 `[object Object]`。
 */
const lastError = ref<string | null>(null)

function appOf(id: string): ShellAppEntry | undefined {
  return plugins.value.find((a) => a.id === id)
}

/** 拉取注册表 + 偏好（幂等；多入口调用合并为一次在途请求） */
async function refresh(): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    const infos = (await invoke('plugin_list_loaded')) as HostPluginInfo[]
    // 偏好逐应用查询（命令面真通道；失败按各 key 的缺省取向容错——enabled 缺省
    // 可见 / autostart 缺省关，与宿主 read_bool_pref 的 fallback 一致，不影响清单投影）
    const entries: ShellAppEntry[] = []
    for (const info of infos) {
      const pluginId = info.id
      let enabled = true
      let autostart = false
      try {
        enabled = (await invoke('plugin_is_enabled', { pluginId })) as boolean
        autostart = (await invoke('plugin_is_autostart', { pluginId })) as boolean
      } catch (e) {
        logger.warn(`[Shell] pref query failed: pluginId=${pluginId}`, e)
      }
      entries.push(toEntry(info, enabled, autostart))
    }
    plugins.value = entries
    // 刷新不清 lastError：动作的成功路径在调用 refresh 之前已清空错误；
    // 若刷新本身失败（清单拉取断链），由下方 catch 写入——不互相覆盖
  } catch (e) {
    // 清单拉取断链：只落错误码 + 日志（不 toast——主屏会停在「无应用」态，
    // 再弹一条提示只会重复暴露同一次失败）
    logger.error('[Shell] app registry projection failed', e)
    lastError.value = parseInvokeError(e).code
  } finally {
    loading.value = false
    // 无论成败都算「已尝试过」：否则拉取持续失败时主屏永远停在加载态
    listReady.value = true
  }
}

/** 首拉（幂等；刷新用 refresh） */
async function load(): Promise<void> {
  if (listReady.value && plugins.value.length > 0) return
  await refresh()
}

/** 展示态（id → 壳展示态；壳 chip / 徽标消费） */
const displayStates = computed<Record<string, AppDisplayState>>(() => {
  const out: Record<string, AppDisplayState> = {}
  for (const a of plugins.value) out[a.id] = a.state
  return out
})

/** 图标色调表（机制哈希） */
const tones = computed<Record<string, AppTone>>(() => {
  const out: Record<string, AppTone> = {}
  for (const a of plugins.value) out[a.id] = a.tone
  return out
})

// ==================== 生命周期动作（真实命令面；成功清空 lastError 并刷新） ====================

/**
 * 生命周期命令动作公共骨架：busyId 置位（防连点）→ 命令 invoke → 成功清
 * lastError 并刷新 / 失败落 lastError 并刷新（refresh 不清 lastError，失败后重新
 * 投影让调用方按终态分流——如激活失败落 NeedsApproval 需读最新清单）→ finally
 * 复位 busyId。每个动作只剩「命令调用」这一个事实（invoke 名 + 参数），骨架只此一份。
 */
async function runAction(
  appId: string,
  label: string,
  busy: boolean,
  run: () => Promise<void>,
): Promise<boolean> {
  if (busy) busyId.value = appId
  try {
    await run()
    lastError.value = null
    await refresh()
    return true
  } catch (e) {
    // ADR 0030：Tauri 的 rejection 是 `{code, request_id, params?}` 信封（普通对象，
    // 不是 Error），必须走错误消费层；toast 只出 `errors.<code>` 友好文案，技术详情
    // 由 showUserError 带 request_id 落日志。调用方不再各自 toast（否则会二次暴露码）。
    const userError = showUserError(e)
    logger.warn(`[Shell] ${label} failed: appId=${appId} code=${userError.code}`)
    lastError.value = userError.code
    await refresh()
    return false
  } finally {
    if (busy) busyId.value = null
  }
}

/** 打开应用：preauthorize（预授权/高权限位提示）→ activate（真激活，仅当前会话） */
async function activate(appId: string): Promise<boolean> {
  const app = appOf(appId)
  if (!app) {
    // 不可达分支（id 来自清单投影）：仍按信封码记，界面侧不会显示裸文案
    logger.error(`[Shell] activate on unknown app: appId=${appId}`)
    lastError.value = HOST_INTERNAL_CODE
    return false
  }
  return runAction(appId, 'activate', true, async () => {
    // 管理命令宿主面凭证门（ADR 0058 方案 A）：一个动作内两条命令共用一次取用
    const credential = await ensureHostCredential()
    // 一个动作内串行两条命令：preauthorize 拒绝直接抛错，不进入 activate
    await invoke('plugin_preauthorize', { pluginId: appId, credential })
    await invoke('plugin_activate', { pluginId: appId, credential })
  })
}

/** 关闭应用：deactivate（**真停用**；持久化停用态，下次 boot 不复活） */
async function deactivate(appId: string): Promise<boolean> {
  if (!appOf(appId)) return false
  return runAction(appId, 'deactivate', true, async () => {
    const credential = await ensureHostCredential()
    await invoke('plugin_deactivate', { pluginId: appId, credential })
    // 停用即回收通道令牌（宿主 frontend_channel 同口径）：同步清前端缓存，
    // 防止同页后续调用带着已作废令牌（挂载路径另有强制换发兜底）
    invalidateChannelToken(appId)
  })
}

/** 批准应用权限（整单：全部声明权限 + 内容哈希钉扎；批准后仍需显式激活） */
async function approve(appId: string): Promise<boolean> {
  if (!appOf(appId)) return false
  return runAction(appId, 'approve', true, async () => {
    const credential = await ensureHostCredential()
    await invoke('plugin_approve', { pluginId: appId, credential })
  })
}

/** 卸载应用（含数据清理；后端仅未启用插件可卸） */
async function uninstall(appId: string): Promise<boolean> {
  if (!appOf(appId)) return false
  return runAction(appId, 'uninstall', true, async () => {
    const credential = await ensureHostCredential()
    await invoke('plugin_uninstall', { pluginId: appId, credential })
    // 卸载同样回收通道令牌：清前端缓存，防残留死令牌
    invalidateChannelToken(appId)
  })
}

/**
 * 安装 / 升级外部应用包（zip；无属主应用，不占 busyId，走 installing 置位）。
 *
 * `upgrade = false` 新装（同 id 已装由后端回滚并拒绝，壳层在安装前按注册表现状
 * 裁决分流）；`upgrade = true` 就地升级（宿主 install.rs：保留插件存储 / 授权
 * 记录 / 审批记录，仅换代码；内容哈希失配 → 下次激活落 NeedsApproval 重新批准）。
 */
async function installFromZip(path: string, upgrade: boolean): Promise<boolean> {
  installing.value = true
  try {
    const credential = await ensureHostCredential()
    await invoke('plugin_install_from_file', { path, credential, upgrade })
    lastError.value = null
    await refresh()
    return true
  } catch (e) {
    // 错误消费口径与 runAction 一致（ADR 0030）：toast 只出 errors.<code>，详情落日志
    const userError = showUserError(e)
    logger.warn(`[Shell] installFromZip failed: upgrade=${upgrade} code=${userError.code}`)
    lastError.value = userError.code
    await refresh()
    return false
  } finally {
    installing.value = false
  }
}

/** 设置启用偏好（只改持久化偏好，不触发当前进程启停） */
async function setEnabled(appId: string, enabled: boolean): Promise<boolean> {
  return runAction(appId, 'setEnabled', true, async () => {
    await invoke('plugin_set_enabled', { pluginId: appId, enabled })
  })
}

/** 设置自启偏好（只改持久化偏好，下次 boot 生效） */
async function setAutostart(appId: string, autostart: boolean): Promise<boolean> {
  return runAction(appId, 'setAutostart', true, async () => {
    await invoke('plugin_set_autostart', { pluginId: appId, autostart })
  })
}

/** 查询运行态（真通道；主屏 chip 之外的单点查询） */
async function isRunning(appId: string): Promise<boolean> {
  try {
    return (await invoke('plugin_is_running', { pluginId: appId })) as boolean
  } catch (e) {
    logger.warn(`[Shell] isRunning query failed: appId=${appId}`, e)
    return false
  }
}

/** 待审批应用列表（壳审批徽标 / 通知派生；真实 NeedsApproval 态） */
const approvalApps = computed<ShellAppEntry[]>(() =>
  plugins.value.filter((a) => a.state === 'approval'),
)

export function useShellApps() {
  return {
    plugins,
    loading,
    listReady,
    busyId,
    installing,
    lastError,
    appOf,
    load,
    refresh,
    displayStates,
    tones,
    approvalApps,
    activate,
    deactivate,
    approve,
    uninstall,
    installFromZip,
    setEnabled,
    setAutostart,
    isRunning,
  }
}
