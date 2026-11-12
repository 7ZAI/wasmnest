/**
 * 应用装载（桌面端 dev-shell）
 * -----------------------------------------------------------------------------
 * 与宿主 `src/shell/mount/useAppMount.ts` **同构**，只有一处本质差别：
 *
 * | | 宿主 | dev-shell |
 * |---|---|---|
 * | app 来源 | 独立构建的整包 `index.js`（`convertFileSrc` + 动态 import） | **源码** `src/entry.ts`（vite 已解析进构建图，HMR 直达） |
 * | 契约校验 | 装载失败 → 显性报错面 | 同（`mountApp` 缺失 → 抛错） |
 *
 * 契约（`AppMountEnv` / `AppMountHandle`）逐字段对齐宿主，见
 * `dev-shell/src/shell/types.ts` 与漂移锁
 * `dev-shell/__tests__/shell/contractDrift.test.ts`。
 */
import type { AppBundleModule, AppMountEnv, AppMountHandle } from '../types'

/** 已挂载实例（appId → handle）；同一 app 重复挂载先卸载旧实例 */
const mounted = new Map<string, AppMountHandle>()

/**
 * 装载并挂载一个 app
 *
 * @param module app 的挂载包模块（app 的 `src/entry.ts`）
 * @throws app 未导出 `mountApp`（契约不匹配）→ 显性报错，不静默空挂
 */
export async function mountAppSource(
  appId: string,
  module: AppBundleModule | null | undefined,
  root: HTMLElement,
  env: AppMountEnv,
): Promise<AppMountHandle> {
  await unmountApp(appId)
  if (!module || typeof module.mountApp !== 'function') {
    throw new Error(
      `app "${appId}" 的挂载包未导出 mountApp（契约不匹配）——该 app 的入口应为 src/entry.ts`,
    )
  }
  const handle = await module.mountApp(root, env)
  mounted.set(appId, handle)
  return handle
}

/** 卸载一个已挂载的 app 实例（幂等） */
export async function unmountApp(appId: string): Promise<void> {
  const handle = mounted.get(appId)
  if (!handle) return
  mounted.delete(appId)
  try {
    await handle.unmount()
  } catch (e) {
    console.error(`[dev-shell] 卸载 app 失败：${appId}`, e)
  }
}

/** 通知已挂载 app：宿主路由变化（应用内存路由消化） */
export async function notifyAppRoute(appId: string, route: string): Promise<void> {
  const handle = mounted.get(appId)
  if (!handle) return
  try {
    handle.setRoute?.(route)
  } catch (e) {
    console.error(`[dev-shell] 通知 app 路由失败：${appId}`, e)
  }
}

/** 通知已挂载 app：宿主面事实变更（语言 / 主题） */
export async function notifyAppFact(
  appId: string,
  fact: 'locale' | 'theme',
  value: string,
): Promise<void> {
  const handle = mounted.get(appId)
  if (!handle) return
  try {
    if (fact === 'locale') handle.setLocale?.(value)
    else handle.setTheme?.(value)
  } catch (e) {
    console.error(`[dev-shell] 通知 app ${fact} 失败：${appId}`, e)
  }
}
