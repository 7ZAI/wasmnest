/**
 * 后台运行应用的「上次停在哪一页」记忆（壳机制面，零业务语义）
 *
 * 为什么需要：应用表面保活（2026-10-23）之后，切走只是 detach、实例仍在内存里，
 * **同进程内切回不读本记录**（保活实例自带内存路由原状）。但实例会被 dispose
 * （停用后重新启用 / 进程内先卸载再装回等）重建，重建时宿主仍需要一条「上次在哪」
 * 的路径做 `initialRoute`；否则用户只能回到落地页（多任务语义里那是「应用被重置」，
 * 不是「切回后台应用」）。
 *
 * 数据来源：**app 自报**（挂载契约 `AppMountEnv.onEvent('route', { path })`）。
 * 宿主不解析应用内部路由语义（app 用内存路由，宿主 history 见不到它的内部跳转），
 * 只按 appId 原样存一个路径串。
 *
 * 生命周期口径：
 * - 应用**停用 / 卸载**（用户关了实例）→ `forgetAppRoute` 清记录（下次是全新开始）；
 * - 只是回主屏（表面实例仍保活）→ 记录保留；
 * - 进程内内存态，不落盘：重启应用后各自回落地页。
 */
import { ref } from 'vue'

/** appId → 应用内部路由路径（读时才展开，避免调用方直接改表） */
const lastRoutes = ref<Readonly<Record<string, string>>>({})

/**
 * 记录应用当前页（app 挂载包自报）。
 *
 * 非法输入（空 id / 空路径 / 根路径 / 非绝对路径）直接忽略：根路径不是「一页」，
 * 记下来只会让下次挂载多推一次无意义的路由。
 */
export function rememberAppRoute(appId: string, path: string): void {
  if (!appId || !path || !path.startsWith('/') || path === '/') return
  if (lastRoutes.value[appId] === path) return
  lastRoutes.value = { ...lastRoutes.value, [appId]: path }
}

/** 应用上次停留的路径；无记录 → undefined（调用方回落落地页） */
export function lastRouteOf(appId: string): string | undefined {
  return lastRoutes.value[appId]
}

/** 忘掉一个应用的页面记忆（停用 / 卸载时调用；幂等） */
export function forgetAppRoute(appId: string): void {
  if (!(appId in lastRoutes.value)) return
  const { [appId]: _dropped, ...rest } = lastRoutes.value
  lastRoutes.value = rest
}

/** 清空全部记忆（「全部关闭」与测试隔离用） */
export function clearAppRoutes(): void {
  lastRoutes.value = {}
}
