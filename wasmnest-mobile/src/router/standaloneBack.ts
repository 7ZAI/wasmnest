/**
 * 壳外整页路由的返回动作（系统返回键与悬浮导航共用）
 * -----------------------------------------------------------------------------
 * 壳外整页路由（设置二级页 / 插件整页路由）不属壳内屏幕栈，返回语义是**浏览历史**：
 *   · 有历史 → `router.back()` 退一格
 *   · 无历史（深链冷启动直达二级页）→ `replace` 回壳入口，避免被困在二级页或直接退出
 *
 * 为什么住 router 层而不是某个 composable：壳（`ShellFloatingNav`）与壳外
 * `useStandaloneRouteBack` 都要用，而壳内纪律禁止 import `@/composables/**`
 * （移动端 shellConstraintLocks L7：壳内机制必须自持或走白名单）。路由语义本身
 * 归 router，两侧同源引用不产生依赖倒挂。
 *
 * `canGoBack` 由调用方提供：原生返回事件带 `payload.canGoBack`；悬浮导航的返回键
 * 只能代用 `history.state.back`（vue-router 写入的历史标记）。
 */

import type { Router } from 'vue-router'
import { SHELL_ROUTE_NAME } from './routeNames'

export function leaveStandaloneRoute(
  router: Pick<Router, 'back' | 'replace'>,
  canGoBack: boolean,
): void {
  if (canGoBack) {
    router.back()
    return
  }
  void router.replace({ name: SHELL_ROUTE_NAME })
}
