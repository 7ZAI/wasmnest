/**
 * 应用装载机制（桌面 UI 宿主修正 · 机制 B：同窗口全屏挂载独立构建的 app 包）
 *
 * 每个桌面 wasm app 前端是**独立构建**的挂载包（app 形态，非贡献面 / 非面板）：
 * 入口导出 `mountApp(root, env): Promise<AppMountHandle>`（契约见下）。宿主经
 * `convertFileSrc(<宿主给出的整包根目录>/<appId>/index.js)` 动态 import 装载，
 * 全屏挂载到挂载槽元素。整包根目录由宿主命令 `plugin_get_asset_dir` 提供（启动装配
 * 解析的唯一 `plugins_dir`，含 dev 回退）——**前端不拼路径**：resource 基目录在 dev 下
 * 是 `src-tauri/target/debug`，bundle resources 会被复制到它下面的 `resources/` 子目录，
 * 少写这一层就是「后端能扫描到、前端 asset URL 404」的静默断裂（2026-10-17 实测）。
 * 但**不复活**贡献面 / 注册表 / 启停状态机。
 *
 * 每个 app 实例是独立 Vue 应用（自带 router/stores/i18n/样式，bundled 自身依赖）：
 * **首次打开创建、切走保留、停用/卸载才销毁**（2026-10-23 表面保活裁决）：
 * - 切走 = `detachAppBundle`：容器脱离文档、实例与 DOM 保留，后台不渲染（JS 定时器
 *   继续），切回来 `attachAppSurface` 同一实例放回挂载槽；
 * - 停用 / 卸载 = `disposeAppBundle`：才真正 unmount 并释放界面租约。
 * 宿主只持有实例的**挂载容器与句柄**，不解释应用内部状态（§5.1 红线不变）。
 *
 * 界面租约（service-leases）随之从「每次挂载/卸载」改为「**首次创建 / 销毁**」：
 * 首次打开 → `plugin_surface_open`；`disposeAppBundle` → `plugin_surface_close`。
 * 端点注册只写路由表，不启动监听器。
 *
 * 例外由宿主判定：manifest `backgroundTransport: true` 的服务端型应用，租约跟
 * **应用运行期**走（启动成功 acquire，停用由内核回收），界面开关不再参与——
 * 前端照常调用两条命令，宿主命令层对这类应用直接返回 no-op，避免「界面卸载
 * 就把 8775 关掉」。
 *
 * 多任务卡片（2026-10-30 用户裁决）：卡片缩略区展示**真实实例的当前页面**——宿主把
 * 保活实例的容器搬进卡片，按整幅尺寸等比缩放（不重排 / 不 resize 终端 / 滚动与输入
 * 原样），不再要求应用自绘预览面；卡片里的实例 inert，收起后回后台（脱离文档不渲染）。
 * 代价：多任务层打开期间所有运行中应用都会重新渲染（见 `ShellTaskSwitcher` 注释）。
 */
import { convertFileSrc } from '@tauri-apps/api/core'
import { join } from '@tauri-apps/api/path'
import { logger } from '@/utils/frontendLogger'
import { invoke } from '@/utils/invoke'
import { appSurfaces, type AppSurfaceHandle } from './appSurfaceRegistry'

// ==================== 挂载契约（宿主面声明；各 app entry.ts 同形重复——drift 锁钉住） ====================

/**
 * 挂载契约版本（宿主壳 ↔ app 整包）。
 *
 * 只在**破坏性**改动 {@link AppMountEnv} / {@link AppMountHandle} 形状时 bump
 * （删除 / 改名 / 语义变化）；新增可选字段是兼容变更，不 bump。分发化之后宿主与
 * app 整包不再天然同版本，装载时必须显式比对（见 {@link assertMountContract}）。
 */
export const MOUNT_CONTRACT = '1'

/** app 前端挂载环境（宿主注入；令牌/凭证已绑定本 app） */
export interface AppMountEnv {
  /** 插件 id（= 应用 id） */
  appId: string
  /** 挂载契约版本（宿主 MOUNT_CONTRACT；不匹配 = 显性报错，不静默挂载） */
  mountContract: string
  /** 宿主面命令（白名单代理，ADR 0058 方案 A）：plugin_list_loaded / get_app_settings 等；白名单真源在桌面 src-tauri APP_FRONTEND_INVOKE_WHITELIST */
  invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>
  /** 插件面命令（plugin_invoke，本 app 通道令牌已绑定） */
  appInvoke: <T = unknown>(command: string, ...args: unknown[]) => Promise<T>
  /** 本 app 插件 KV 存储（plugin_storage_*，宿主面凭证已绑定） */
  appStorageGet: <T = unknown>(key: string) => Promise<T | undefined>
  appStorageSet: (key: string, value: unknown) => Promise<void>
  appStorageDelete: (key: string) => Promise<void>
  /** 宿主面事实（挂载时快照；后续变更经 handle.setLocale / setTheme 通知） */
  locale: string
  theme: string
  platform?: string
  /** 宿主路由传入的应用初始路径（应用以内存路由消化） */
  initialRoute: string
  /**
   * 宿主面事件出口（可选）。当前两种事件：
   * - `'navigate'`（payload = 宿主任一已知路径字符串）：请求壳路由跳转；
   * - `'route'`（payload = `{ path: string }`）：应用**自报内部当前页**——应用跑内存
   *   路由，宿主 history 看不到它的内部跳转，壳据此记住「切回该应用时回到哪一页」。
   */
  onEvent?: (type: string, payload: unknown) => void
  /**
   * 自定义监控面板装载（只对 monitor 的 env 注入）。
   *
   * monitor 提供统一壳；面板实现住提供方应用工程，由宿主经 bundle 缓存装载，
   * monitor 不直接 import 他人 bundle、不拼 asset URL。
   */
  mountMonitorPanel?: (
    root: HTMLElement,
    appId: string,
    panelId: string,
  ) => Promise<MonitorPanelHandle>
}

// ==================== 自定义监控面板（monitor 统一壳 ↔ 提供方整包） ====================

/**
 * 监控面板环境（收窄只读面）：只给提供方自己的令牌 / 只读存储。
 * 不提供宿主 `invoke`、写存储、导航、事件出口；面板无权新增权限。
 */
export interface MonitorPanelEnv {
  appId: string
  panelId: string
  /** 本应用插件面命令（与主界面同一令牌 / 权限；只在面板内只读取数） */
  appInvoke: <T = unknown>(command: string, ...args: unknown[]) => Promise<T>
  /** 本应用插件 KV 只读访问 */
  appStorageGet: <T = unknown>(key: string) => Promise<T | undefined>
  locale: string
  theme: string
  platform?: string
}

/** 监控面板句柄（monitor 切换页签 / 卸载时销毁） */
export interface MonitorPanelHandle {
  unmount(): Promise<void>
}

/** 提供方 app bundle 可选导出；未导出 = 没有该面板实现（不是错误） */
export type MountMonitorPanel = (
  root: HTMLElement,
  env: MonitorPanelEnv,
) => Promise<MonitorPanelHandle>

/** app 前端挂载句柄（宿主卸载 / 路由通知用） */
export interface AppMountHandle {
  /** 卸载应用实例（销毁 Vue 实例 / 路由 / 监听） */
  unmount(): Promise<void>
  /** 宿主路由变化通知（应用内存路由消化；未实现 = 不支持宿主内路由切换） */
  setRoute?(route: string): void
  /**
   * 前台 / 后台切换通知（可选，2026-10-23 表面保活契约）。
   *
   * `false` = 应用界面已切到后台：DOM 与实例仍在（切回来原样），但已脱离文档、
   * 不再渲染；应用可据此暂停轮询 / 动画 / 高频定时器。
   * `true` = 回到前台（同一实例，不会重新 mount）。
   *
   * 未实现 = 壳照常保活，只是应用自己继续按原节奏跑。新增可选成员属兼容变更，
   * 不 bump {@link MOUNT_CONTRACT}。
   */
  setActive?(active: boolean): void
  /** 宿主面事实变更通知（语言 / 主题） */
  setLocale?(locale: string): void
  setTheme?(theme: string): void
}

/** 装载超时（秒）；超时 = 包损坏 / 契约不匹配，显性报错不静默 */
const MOUNT_TIMEOUT_MS = 8000

/**
 * 表面实例注册表（`appSurfaces`，见 `appSurfaceRegistry.ts`）：
 * 首次打开创建、切走 detach（保留）、停用 / 卸载 dispose（销毁）。
 */

/**
 * app 挂载包模块面：`mountApp` 必有（否则契约不匹配）。
 * `mountContract` 由各 app `entry.ts` 导出（与宿主 {@link MOUNT_CONTRACT} 比对）。
 */
interface AppBundleModule {
  mountContract?: string
  mountApp?: (root: HTMLElement, env: AppMountEnv) => Promise<AppMountHandle>
  mountMonitorPanel?: MountMonitorPanel
}

/**
 * 已装载模块（appId → import promise）。
 *
 * 主应用与多任务预览共用同一 bundle URL 和模块缓存：打开多任务层时不会重复下载 /
 * 重复执行同一份整包。**失败不缓存**——产物构建中 / 刚清理时首次 import 可能失败，
 * 必须能重试，否则一次失败被钉成「本进程永远挂不上」。
 */
const loadedModules = new Map<string, Promise<AppBundleModule>>()

/** 装载 app 前端模块（bundle URL + import 超时的唯一入口）
 *
 * 顺序不变量（ADR 0058 方案 A）：所有装载路径（挂载槽 / 多任务预览 / 监控面板）
 * 都以「应用已激活」为前提，而激活经 `useShellApps` 先取宿主面凭证（loader 会话，
 * 域内首个调用者生效）。**不得新增不经过 activate 就 import app 模块的路径**——
 * 那会让插件前端有机会抢在宿主前自取宿主面凭证。
 */
export async function loadAppModule(appId: string): Promise<AppBundleModule> {
  const cached = loadedModules.get(appId)
  if (cached) return cached
  const pending = (async () => {
    const bundleUrl = await appBundleUrl(appId)
    logger.log(`[AppMount] loading bundle: ${appId} <- ${bundleUrl}`)
    return (await importWithTimeout(bundleUrl, MOUNT_TIMEOUT_MS)) as AppBundleModule
  })()
  loadedModules.set(appId, pending)
  pending.catch(() => {
    if (loadedModules.get(appId) === pending) loadedModules.delete(appId)
  })
  return pending
}

/**
 * 校验 app 整包的挂载契约版本（动态 import 之后、创建 app 之前）。
 *
 * 不匹配 / 缺失 = **显性报错**：分发化之后宿主运行时与 app 产物可以独立升级，
 * 版本错位必须点名（appId / 期望值 / 实际值 / 修复指引），不能退化成 mount
 * 失败的白屏。错误由挂载槽捕获并落到失败面 + 日志（ADR 0030）。
 */
export function assertMountContract(appId: string, actual: string | undefined): void {
  if (actual === MOUNT_CONTRACT) return
  const actualText = actual === undefined ? '缺失（bundle 未导出该常量）' : `实际 "${actual}"`
  throw new Error(
    `app bundle "${appId}" 挂载契约不匹配（mountContract）：期望 "${MOUNT_CONTRACT}"，${actualText}。` +
      `请重编 app（应用仓 pnpm run build）后再挂载，或换用 mountContract 与 app 整包匹配的宿主版本。`,
  )
}

/**
 * 应用界面租约：挂载时（mount 之前）为应用持有 `net.transport`。
 *
 * 端点注册只写路由表，不启动监听器；「界面打开」是**未声明 `backgroundTransport`
 * 的应用**的传输面需求信号（服务端型应用由宿主在启动成功后持有，本调用为 no-op）。
 * 失败只记日志：应用本地界面仍可用，但不会对外广播（宿主命令返回
 * StartFailed 等错误，排障看日志）。
 */
async function notifySurfaceOpen(appId: string): Promise<void> {
  try {
    await invoke('plugin_surface_open', { appId })
  } catch (e) {
    logger.error(`[AppMount] surface open failed: ${appId}`, e)
  }
}

/** 应用界面租约：卸载时释放（未持有 = 幂等成功；失败只记日志） */
async function notifySurfaceClose(appId: string): Promise<void> {
  try {
    await invoke('plugin_surface_close', { appId })
  } catch (e) {
    logger.error(`[AppMount] surface close failed: ${appId}`, e)
  }
}

/** 应用实例容器：跨挂载槽移动（应用包自己的 Vue 实例挂在它里面） */
function createInstanceHost(): HTMLElement {
  const host = document.createElement('div')
  host.className = 'app-instance-host'
  return host
}

/** 是否已有保活实例（切回来走 attach，不重新 mount） */
export function hasAppSurface(appId: string): boolean {
  return appSurfaces.has(appId)
}

/** 列出所有保活实例（`ShellHost` 停用回收用） */
export function listAppSurfaces(): string[] {
  return appSurfaces.list()
}

/** 最近一次把实例放进挂载槽的槽元素（多任务普通收起时把前台实例送回去） */
let lastSlotEl: HTMLElement | null = null

/** 把保活实例放回挂载槽（切回来）；返回 false = 没有实例（应走 mountAppBundle） */
export function attachAppSurface(slotEl: HTMLElement, appId: string): boolean {
  if (!appSurfaces.attach(appId, slotEl)) return false
  lastSlotEl = slotEl
  return true
}

/**
 * 多任务卡：把实例搬进卡片缩略区（真实实例、按整幅尺寸等比缩放）。
 *
 * 卡片不是前台：实例在预览期间不收到 `setActive(true)`，收起后仍是后台实例。
 *
 * @returns false = 没有保活实例（例如装载失败 / 已被停用）→ 卡片回退品牌卡
 */
export function presentAppSurfaceInPreview(appId: string, boxEl: HTMLElement): boolean {
  return appSurfaces.attachPreview(appId, boxEl)
}

/** 卡片尺寸变化（窗口缩放 / 卡片数变化）：重算等比缩放 */
export function fitAppSurfacePreview(appId: string): boolean {
  return appSurfaces.fitPreview(appId)
}

/** 卡片卸载：把实例从卡片摘下（保留实例，回后台不渲染） */
export function leaveAppSurfacePreview(appId: string): boolean {
  return appSurfaces.detachPreview(appId)
}

/** 多任务普通收起（没有切换应用）：把前台实例送回最近一次的挂载槽 */
export function returnAppSurfaceToSlot(appId: string): boolean {
  if (!lastSlotEl) return false
  return attachAppSurface(lastSlotEl, appId)
}

/**
 * 切走：把实例容器从挂载槽移除，但**保留实例**（DOM / 组件状态 / 内存路由原样）。
 *
 * 不释放界面租约——应用仍在运行，只是不在前台；真正回收在
 * [`disposeAppBundle`]（停用 / 卸载）。后台不渲染（容器脱离文档），JS 定时器继续。
 */
export function detachAppBundle(appId: string): boolean {
  return appSurfaces.detach(appId)
}

/** 停用 / 卸载：真正销毁实例并释放界面租约（幂等） */
export async function disposeAppBundle(appId: string): Promise<void> {
  if (!appSurfaces.has(appId)) return
  try {
    await appSurfaces.dispose(appId)
  } catch (e) {
    logger.error(`[AppMount] dispose failed: ${appId}`, e)
  }
  await notifySurfaceClose(appId)
}

/** @deprecated 停用 / 卸载请用 {@link disposeAppBundle}；切走请用 {@link detachAppBundle} */
export const unmountAppBundle = disposeAppBundle

/** 在途首次装载（appId → promise；并发首次打开合并用） */
const mounting = new Map<string, Promise<AppMountHandle>>()

/**
 * 装载并挂载一个 app 前端到挂载槽元素（首次打开）。
 *
 * 已有保活实例（切回来）不走这里：调用方先用 [`hasAppSurface`] +
 * [`attachAppSurface`] 复用实例——**不能重复 mount**：会重建 DOM / 丢状态，
 * 且 `refreshChannelToken` 会换发令牌、作废后台实例正在用的身份。
 *
 * 并发首次打开（用户快速切走再切回同一应用）合并为一次 mount：后到者等前一个
 * 装载完成后直接 attach。否则两个 Vue 实例会争同一 appId 的记账（一个变孤儿、
 * 界面租约被重复 acquire），这正是保活形态下最容易泄漏的路径。
 */
export function mountAppBundle(slotEl: HTMLElement, env: AppMountEnv): Promise<AppMountHandle> {
  const appId = env.appId
  const existing = appSurfaces.get(appId)
  if (existing) {
    attachAppSurface(slotEl, appId)
    return Promise.resolve(existing.handle as AppMountHandle)
  }

  const pending = mounting.get(appId)
  if (pending) {
    return pending.then((handle) => {
      // 先到的装载已把实例登记进注册表：本槽只做 attach，绝不再 mount 一份
      attachAppSurface(slotEl, appId)
      return handle
    })
  }

  const started = mountAppSurface(slotEl, env).finally(() => {
    if (mounting.get(appId) === started) mounting.delete(appId)
  })
  mounting.set(appId, started)
  return started
}

/** 首次装载实体（`mountAppBundle` 已处理复用 / 合并，这里只管建实例） */
async function mountAppSurface(slotEl: HTMLElement, env: AppMountEnv): Promise<AppMountHandle> {
  const appId = env.appId
  const module = await loadAppModule(appId)
  assertMountContract(appId, module.mountContract)
  if (typeof module.mountApp !== 'function') {
    throw new Error(`app bundle "${appId}" does not export mountApp (contract mismatch)`)
  }

  // 界面首次打开即租用传输面：先于 mount，让应用首屏的网络路径在服务就绪后运行；
  // mount 失败释放，避免失败挂载留下租约。切走 / 切回不再 acquire / release。
  await notifySurfaceOpen(appId)
  const host = createInstanceHost()
  slotEl.appendChild(host)
  let handle: AppMountHandle
  try {
    handle = await module.mountApp(host, env)
  } catch (e) {
    host.remove()
    await notifySurfaceClose(appId)
    throw e
  }
  appSurfaces.register(appId, host, handle as AppSurfaceHandle)
  attachAppSurface(slotEl, appId)
  logger.log(`[AppMount] mounted: ${appId}`)
  return handle
}

/**
 * 在容器中装载提供方 app 的自定义监控面板（host-mediated；monitor 只拿句柄）。
 *
 * - 复用 {@link loadAppModule} 的 bundle 缓存；不重复下载；
 * - 校验 mountContract 与可选导出存在，失败 fail-visible（点名 appId / panelId）；
 * - 面板实例与主应用实例生命周期独立，句柄由调用方（monitor）持有并负责卸载。
 */
export async function mountAppMonitorPanel(
  root: HTMLElement,
  env: MonitorPanelEnv,
): Promise<MonitorPanelHandle> {
  const module = await loadAppModule(env.appId)
  assertMountContract(env.appId, module.mountContract)
  if (typeof module.mountMonitorPanel !== 'function') {
    throw new Error(
      `app bundle "${env.appId}" 未导出 mountMonitorPanel（panel=${env.panelId}）` +
        `——manifest contributes.monitorPanels 有声明但实现缺失`,
    )
  }
  const handle = await module.mountMonitorPanel(root, env)
  if (!handle || typeof handle.unmount !== 'function') {
    throw new Error(
      `app bundle "${env.appId}" mountMonitorPanel 返回的句柄非法（panel=${env.panelId}）`,
    )
  }
  logger.log(`[AppMount] mounted monitor panel: ${env.appId}/${env.panelId}`)
  return handle
}

/** 通知已挂载 app：宿主路由变化（实例可能处于后台保活态，仍要同步） */
export async function notifyAppRoute(appId: string, route: string): Promise<void> {
  const surface = appSurfaces.get(appId)
  if (!surface) return
  try {
    ;(surface.handle as AppMountHandle).setRoute?.(route)
  } catch (e) {
    logger.error(`[AppMount] setRoute failed: ${appId}`, e)
  }
}

/**
 * 应用整包根目录（路径真源 = 宿主 `plugin_get_asset_dir`）。
 *
 * 一次取用后缓存：每个 app 挂载都问一次宿主是多余 IPC，且同一进程内该目录不会变。
 * **失败不缓存**——第一次挂载可能早于产物就绪（构建中 / 刚清理），重试必须能重新
 * 问宿主，否则一次失败会被钉成「本进程永远挂不上」。
 */
let bundleDirPromise: Promise<string> | null = null

function appBundleDir(): Promise<string> {
  if (!bundleDirPromise) {
    bundleDirPromise = invoke<string>('plugin_get_asset_dir').catch((e) => {
      bundleDirPromise = null
      throw e
    })
  }
  return bundleDirPromise
}

/**
 * app 前端整包 URL：`<宿主给出的整包根目录>/<appId>/index.js`。
 *
 * 目录由宿主解析（含 dev 回退），前端不拼任何 `resources/plugins` 字面量——
 * 同一份路径约定只留一处，避免再次出现「后端对、前端少一层」的静默 404。
 */
async function appBundleUrl(appId: string): Promise<string> {
  const dir = await appBundleDir()
  return convertFileSrc(await join(dir, appId, 'index.js'))
}

/** 动态 import 带超时（装载挂死 = 显性报错，不白屏） */
function importWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`app bundle import timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    import(/* @vite-ignore */ url)
      .then((m) => {
        clearTimeout(timer)
        resolve(m)
      })
      .catch((e) => {
        clearTimeout(timer)
        reject(e)
      })
  })
}

export function useAppMount() {
  return {
    mountAppBundle,
    hasAppSurface,
    attachAppSurface,
    detachAppBundle,
    disposeAppBundle,
    /** @deprecated 用 disposeAppBundle（停用） / detachAppBundle（切走） */
    unmountAppBundle,
    listAppSurfaces,
    notifyAppRoute,
    presentAppSurfaceInPreview,
    fitAppSurfacePreview,
    leaveAppSurfacePreview,
    returnAppSurfaceToSlot,
  }
}
