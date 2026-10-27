/**
 * 壳外整页路由的系统返回兜底（浏览历史回退）
 * -----------------------------------------------------------------------------
 * 壳路由（/mobile/shell）的返回由壳自己兜底（`useShellSystemBack`）；壳卸载时它
 * 明确退订，把返回交给「当前整页路由自己的历史」。但系统返回只有在 JS 侧**没有**
 * 原生监听时才会走 WebView 默认后退——只要有应用运行面挂着，应用层订阅就会把
 * 原生监听留在场，返回落到应用层后没人消费就消失了（2026-10-27 用户反馈：
 * 从设置进入二级页后系统返回手势 / 返回键无反应）。
 *
 * 所以壳外整页路由（设置二级页 / 插件整页路由）必须自己持有返回处理器：
 *   · 有浏览历史 → `router.back()` 退一格
 *   · 无历史（深链冷启动直达二级页）→ 回落壳入口，避免被困在二级页或直接退出
 *
 * 订阅按「当前路由是否为壳根」开关：壳根由壳自己兜底，不常驻订阅（否则「主屏
 * 返回退出应用」失效）；其它路由都走历史回退。返回 true = 已消费。
 */

import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { subscribeHostBackPressed, type BackPressPayload } from '@/plugin/back-button'
import { SHELL_ROUTE_NAME } from '@/router/routeNames'

export interface StandaloneRouteBack {
  /** 停止接管并撤销订阅 */
  dispose: () => void
}

export function useStandaloneRouteBack(): StandaloneRouteBack {
  const route = useRoute()
  const router = useRouter()

  /** 当前路由是否壳根（壳根返回由壳兜底，这里不得参与） */
  function isShellRoot(): boolean {
    return route.meta.shellRoot === true
  }

  /** 平台层返回处理：壳外整页路由一律消费（历史回退 / 回落入口） */
  function handleSystemBack(payload: BackPressPayload): boolean {
    // 正常已退订；过渡窗口内壳根与整页路由可能同时在场，壳根让给壳
    if (isShellRoot()) return false
    if (payload.canGoBack) {
      router.back()
      return true
    }
    // 无浏览历史（深链冷启动直达二级页）：回落入口而不是退出应用
    void router.replace({ name: SHELL_ROUTE_NAME })
    return true
  }

  let disposeBackPressed: (() => void) | null = null

  const stopWatch = watch(
    isShellRoot,
    (shellRoot) => {
      if (!shellRoot) {
        if (!disposeBackPressed) disposeBackPressed = subscribeHostBackPressed(handleSystemBack)
        return
      }
      disposeBackPressed?.()
      disposeBackPressed = null
    },
    { immediate: true },
  )

  return {
    dispose() {
      stopWatch()
      disposeBackPressed?.()
      disposeBackPressed = null
    },
  }
}
