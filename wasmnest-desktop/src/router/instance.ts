/**
 * 路由器持有者（打断 import 环）
 *
 * 背景：`useShellState` 需要在函数内调用 `router.push`，但若它顶层 `import router from
 * '@/router'`，就与 `router/index.ts → AppMountSlot.vue → useShellState` 构成环——
 * ES module 求值时 AppMountSlot 尚在 TDZ，浏览器报 `Cannot access 'AppMountSlot'
 * before initialization`，壳渲染卡死。
 *
 * 机制：本模块零依赖，只持有一个可延迟绑定的 router 引用。`router/index.ts` 创建
 * router 后立即 `setRouter(router)`；消费方在函数内经 `getRouter()` 取（调用时 router
 * 已注册）。顶层无副作用，故不参与环。
 */
import type { Router } from 'vue-router'

let current: Router | null = null

/** 由 router/index.ts 在创建 router 后注册（仅一次） */
export function setRouter(router: Router): void {
  current = router
}

/** 取已注册的 router；未注册即显性报错（fail-visible，不静默降级） */
export function getRouter(): Router {
  if (!current) {
    throw new Error('[router] not registered: getRouter called before router/index.ts setup')
  }
  return current
}
