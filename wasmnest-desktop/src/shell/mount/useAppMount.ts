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
 */
import { convertFileSrc } from '@tauri-apps/api/core'
import { join } from '@tauri-apps/api/path'
import { logger } from '@/utils/frontendLogger'
import { invoke } from '@/utils/invoke'

// ==================== 挂载契约（宿主面声明；各 app entry.ts 同形重复——drift 锁钉住） ====================

/** app 前端挂载环境（宿主注入；令牌/凭证已绑定本 app） */
export interface AppMountEnv {
  /** 插件 id（= 应用 id） */
  appId: string
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

/** 装载超时（秒）；超时 = 包损坏 / 契约不匹配，显性报错不静默 */
const MOUNT_TIMEOUT_MS = 8000

/** 已挂载实例（appId → handle）；同一 app 重复挂载先卸载旧实例 */
const mounted = new Map<string, AppMountHandle>()

/** 装载并挂载一个 app 前端到挂载槽元素 */
export async function mountAppBundle(
  slotEl: HTMLElement,
  env: AppMountEnv,
): Promise<AppMountHandle> {
  const appId = env.appId
  await unmountAppBundle(appId)

  const bundleUrl = await appBundleUrl(appId)
  logger.log(`[AppMount] loading bundle: ${appId} <- ${bundleUrl}`)
  const module = (await importWithTimeout(bundleUrl, MOUNT_TIMEOUT_MS)) as {
    mountApp?: (root: HTMLElement, env: AppMountEnv) => Promise<AppMountHandle>
  }
  if (typeof module.mountApp !== 'function') {
    throw new Error(`app bundle "${appId}" does not export mountApp (contract mismatch)`)
  }

  const handle = await module.mountApp(slotEl, env)
  mounted.set(appId, handle)
  logger.log(`[AppMount] mounted: ${appId}`)
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
  return { mountAppBundle, unmountAppBundle, notifyAppRoute }
}
