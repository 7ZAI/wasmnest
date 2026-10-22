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
 * 卸载即销毁，宿主不持有 app 内部状态（§5.1 红线：宿主零业务状态）。
 *
 * 界面挂载/卸载同时是**应用作用域服务租约**的信号（service-leases）：挂载 →
 * `plugin_surface_open` 为应用持有 `net.transport`（仅注册过 HTTP/WS 端点的应用），
 * 卸载 → `plugin_surface_close` 释放。端点注册只写路由表，不启动监听器。
 *
 * 预览面（2026-10-20 多任务卡）：同一挂载包还可选导出 `mountPreview(root, env)`，
 * 由应用在卡片缩略区**自绘**一张只读、点时刻的预览面（不是截图 / 不是 DOM 克隆，
 * 见 `.scratch/2026-10-20-app-preview-contract/spec.md`）。宿主只负责给容器、装载、
 * 超时（调用方 AppPreviewTile 控制）与卸载；未导出 / 失败 / 超时 → 回退品牌卡。
 * 预览环境是收窄面（无宿主命令 / 无写存储 / 无事件出口），不新增权限位。
 */
import { convertFileSrc } from '@tauri-apps/api/core'
import { join } from '@tauri-apps/api/path'
import { logger } from '@/utils/frontendLogger'
import { invoke } from '@/utils/invoke'

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
  /** 宿主面命令（invoke 原样，无附加凭证）：get_app_settings 等 */
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
}

/** app 前端挂载句柄（宿主卸载 / 路由通知用） */
export interface AppMountHandle {
  /** 卸载应用实例（销毁 Vue 实例 / 路由 / 监听） */
  unmount(): Promise<void>
  /** 宿主路由变化通知（应用内存路由消化；未实现 = 不支持宿主内路由切换） */
  setRoute?(route: string): void
  /** 宿主面事实变更通知（语言 / 主题） */
  setLocale?(locale: string): void
  setTheme?(theme: string): void
}

// ==================== 预览契约（宿主面声明；各 app entry.ts 同形重复——drift 锁 L5 钉住） ====================

/**
 * 应用预览环境（宿主注入；只读面）
 *
 * 与 {@link AppMountEnv} 的差异是**收窄**而非放行：不提供宿主面 `invoke`、写 / 删
 * 存储、事件出口（navigate / route）。预览是卡片里的旁路展示，不能请求宿主导航、
 * 不能写存储、不能上报路由；安全边界仍由 Rust 权限仲裁（预览没有新增权限）。
 */
export interface AppPreviewEnv {
  /** 插件 id（= 应用 id） */
  appId: string
  /** 应用上次自报的内部路径；无记录 = undefined（应用自行回落落地页） */
  lastRoute?: string
  /** 本 app 插件面命令（与主界面同一令牌 / 权限；预览侧只读使用） */
  appInvoke: <T = unknown>(command: string, ...args: unknown[]) => Promise<T>
  /** 本 app 插件 KV 只读访问 */
  appStorageGet: <T = unknown>(key: string) => Promise<T | undefined>
  locale: string
  theme: string
  platform?: string
}

/** 应用预览句柄（卸载卡片时宿主调用；预览实例不登记到主应用 mounted 表） */
export interface AppPreviewHandle {
  unmount(): Promise<void>
}

/** entry.ts 可选导出；未导出 = 不支持预览（缺失不是错误，是能力声明） */
export type MountPreview = (root: HTMLElement, env: AppPreviewEnv) => Promise<AppPreviewHandle>

/**
 * 预览装载超时（毫秒）。
 *
 * **只覆盖 `mountPreview` 返回句柄**，不覆盖预览内部的数据加载：应用应先挂出骨架 /
 * 空态并立即返回 handle，再异步取数；把「等命令返回」放在 resolve 之前会让慢命令把
 * 整张卡打成 fallback。主应用装载仍用 {@link MOUNT_TIMEOUT_MS}。
 */
export const PREVIEW_MOUNT_TIMEOUT_MS = 3000

/** 装载超时（秒）；超时 = 包损坏 / 契约不匹配，显性报错不静默 */
const MOUNT_TIMEOUT_MS = 8000

/** 已挂载实例（appId → handle）；同一 app 重复挂载先卸载旧实例 */
const mounted = new Map<string, AppMountHandle>()

/**
 * app 挂载包模块面：`mountApp` 必有（否则契约不匹配），`mountPreview` 可选。
 * 「bundle 是否导出 mountPreview」就是应用的能力声明——宿主不维护预览名单。
 * `mountContract` 由各 app `entry.ts` 导出（与宿主 {@link MOUNT_CONTRACT} 比对）。
 */
interface AppBundleModule {
  mountContract?: string
  mountApp?: (root: HTMLElement, env: AppMountEnv) => Promise<AppMountHandle>
  mountPreview?: MountPreview
}

/**
 * 已装载模块（appId → import promise）。
 *
 * 主应用与多任务预览共用同一 bundle URL 和模块缓存：打开多任务层时不会重复下载 /
 * 重复执行同一份整包。**失败不缓存**——产物构建中 / 刚清理时首次 import 可能失败，
 * 必须能重试，否则一次失败被钉成「本进程永远挂不上」。
 */
const loadedModules = new Map<string, Promise<AppBundleModule>>()

/** 装载 app 前端模块（bundle URL + import 超时的唯一入口） */
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
 * 端点注册只写路由表，不启动监听器；「界面打开」是传输面的需求信号。
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

/** 装载并挂载一个 app 前端到挂载槽元素 */
export async function mountAppBundle(
  slotEl: HTMLElement,
  env: AppMountEnv,
): Promise<AppMountHandle> {
  const appId = env.appId
  await unmountAppBundle(appId)

  const module = await loadAppModule(appId)
  assertMountContract(appId, module.mountContract)
  if (typeof module.mountApp !== 'function') {
    throw new Error(`app bundle "${appId}" does not export mountApp (contract mismatch)`)
  }

  // 界面打开即租用传输面：先于 mount，让应用首屏的网络路径在服务就绪后运行；
  // mount 失败释放，避免失败挂载留下租约。
  await notifySurfaceOpen(appId)
  let handle: AppMountHandle
  try {
    handle = await module.mountApp(slotEl, env)
  } catch (e) {
    await notifySurfaceClose(appId)
    throw e
  }
  mounted.set(appId, handle)
  logger.log(`[AppMount] mounted: ${appId}`)
  return handle
}

/**
 * 在 `root` 中挂载应用自绘的只读预览面（多任务卡片缩略区）
 *
 * - 与主应用共用 {@link loadAppModule}：同一 bundle URL / 模块缓存，不重复下载；
 * - **不做超时**：3s 预览超时由调用方（AppPreviewTile）控制，只覆盖返回句柄；
 * - **不登记**到 {@link mounted}：预览实例与主应用实例生命周期独立，卸载由调用方
 *   持有 handle 完成（同一 app 主实例可能正在遮罩后运行，两者不得互相踩）；
 * - **不换发通道令牌**：预览是旁路展示，改身份绑定会作废主实例正在用的令牌。
 *
 * @returns `null` = bundle 未导出 `mountPreview`（正常的不支持，不是错误）
 * @throws bundle import 失败 / mountPreview 抛错 / 返回的 handle 无 `unmount`
 */
export async function mountAppPreview(
  root: HTMLElement,
  env: AppPreviewEnv,
): Promise<AppPreviewHandle | null> {
  const module = await loadAppModule(env.appId)
  if (typeof module.mountPreview !== 'function') return null

  const handle = await module.mountPreview(root, env)
  // 形状不对按失败处理（调用方清空容器 + 回退品牌卡），不把坏句柄当成功
  if (!handle || typeof handle.unmount !== 'function') {
    throw new Error(`app bundle "${env.appId}" mountPreview returned an invalid handle`)
  }
  logger.log(`[AppPreview] mounted preview: ${env.appId}`)
  return handle
}

/** 卸载一个已挂载的 app 实例（幂等） */
export async function unmountAppBundle(appId: string): Promise<void> {
  const handle = mounted.get(appId)
  if (!handle) return
  mounted.delete(appId)
  try {
    await handle.unmount()
  } catch (e) {
    logger.error(`[AppMount] unmount failed: ${appId}`, e)
  }
  await notifySurfaceClose(appId)
}

/** 通知已挂载 app：宿主路由变化 */
export async function notifyAppRoute(appId: string, route: string): Promise<void> {
  const handle = mounted.get(appId)
  if (!handle) return
  try {
    handle.setRoute?.(route)
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
  return { mountAppBundle, unmountAppBundle, notifyAppRoute, mountAppPreview }
}
