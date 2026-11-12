/**
 * 壳外整页路由系统返回兜底 行为契约测试
 *
 * 被测：`src/composables/useStandaloneRouteBack.ts`
 *
 * | 契约 | 来源 | 规则 | 预期 |
 * |---|---|---|---|
 * | C-R1 | 订阅开关 | 壳根路由（meta.shellRoot） | 不订阅（壳根返回由壳兜底） |
 * | C-R2 | 同上 | 壳外整页路由（设置二级页 / 插件整页） | 订阅平台返回通道 |
 * | C-R3 | `handleSystemBack` | canGoBack = true | router.back()，返回 true（已消费） |
 * | C-R4 | 同上 | canGoBack = false（深链冷启动直达） | 回落壳入口 replace，返回 true |
 * | C-R5 | 路由切换 | 整页 → 壳根 → 整页 | 退订 / 重新订阅 |
 * | C-R6 | `dispose` | 根组件卸载后 | 退订且不再随路由变化重新订阅 |
 * | C-R7 | 过渡窗口 | 处理器在壳根上被调用 | 返回 false（让给壳兜底） |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

// 平台返回通道替身：记录处理器 + 退订计数（跨进程边界按契约替身）
const backChannel = vi.hoisted(() => ({
  handlers: [] as Array<(payload: { canGoBack: boolean }) => boolean | void>,
  dispose: vi.fn(),
}))

const route = reactive<{ meta: Record<string, unknown> }>({ meta: {} })
const routerBack = vi.fn()
const routerReplace = vi.fn()

vi.mock('@/plugin/back-button', () => ({
  subscribeHostBackPressed: (handler: (payload: { canGoBack: boolean }) => boolean | void) => {
    backChannel.handlers.push(handler)
    return () => {
      const index = backChannel.handlers.indexOf(handler)
      if (index >= 0) backChannel.handlers.splice(index, 1)
      backChannel.dispose()
    }
  },
}))

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ back: routerBack, replace: routerReplace }),
}))

import { useStandaloneRouteBack } from '@/composables/useStandaloneRouteBack'

/** 本次用例的兜底实例（afterEach 统一 dispose，避免跨用例串味） */
let routeBack: ReturnType<typeof useStandaloneRouteBack> | null = null

function setup(): ReturnType<typeof useStandaloneRouteBack> {
  routeBack = useStandaloneRouteBack()
  return routeBack
}

beforeEach(() => {
  route.meta = {}
  backChannel.handlers.length = 0
  backChannel.dispose.mockClear()
  routerBack.mockClear()
  routerReplace.mockClear()
})

afterEach(() => {
  routeBack?.dispose()
  routeBack = null
})

describe('C-R1/C-R2 订阅开关', () => {
  it('should_notSubscribe_when_shellRootRoute', () => {
    route.meta = { shellRoot: true }

    setup()

    expect(backChannel.handlers).toHaveLength(0)
  })

  it('should_subscribe_when_standaloneRoute', () => {
    setup()

    expect(backChannel.handlers).toHaveLength(1)
  })
})

describe('C-R3/C-R4 返回语义', () => {
  it('should_goBackInHistory_when_canGoBack', () => {
    setup()

    const consumed = backChannel.handlers[0]({ canGoBack: true })

    expect(consumed).toBe(true)
    expect(routerBack).toHaveBeenCalledTimes(1)
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it('should_replaceWithShell_when_noHistory', () => {
    setup()

    const consumed = backChannel.handlers[0]({ canGoBack: false })

    // 深链冷启动直达二级页：回落入口而不是被困在二级页 / 退出应用
    expect(consumed).toBe(true)
    expect(routerReplace).toHaveBeenCalledWith({ name: 'mobile-shell' })
    expect(routerBack).not.toHaveBeenCalled()
  })
})

describe('C-R5/C-R6 订阅生命周期', () => {
  it('should_unsubscribeOnShellRoot_andResubscribeOnReturn', async () => {
    setup()
    expect(backChannel.handlers).toHaveLength(1)

    route.meta = { shellRoot: true }
    await nextTick()
    expect(backChannel.handlers).toHaveLength(0)
    expect(backChannel.dispose).toHaveBeenCalledTimes(1)

    route.meta = { standAlone: true }
    await nextTick()
    expect(backChannel.handlers).toHaveLength(1)
  })

  it('should_stopTakingOver_when_disposed', async () => {
    const back = setup()
    expect(backChannel.handlers).toHaveLength(1)

    back.dispose()
    expect(backChannel.handlers).toHaveLength(0)

    route.meta = { shellRoot: true }
    await nextTick()
    route.meta = {}
    await nextTick()
    expect(backChannel.handlers).toHaveLength(0)
  })
})

describe('C-R7 过渡窗口', () => {
  it('should_notConsume_when_handlerRunsOnShellRoot', () => {
    setup()
    const handler = backChannel.handlers[0]

    // 模拟路由已切到壳根、watcher 尚未退订的窗口：壳根返回必须让给壳兜底
    route.meta = { shellRoot: true }
    const consumed = handler({ canGoBack: true })

    expect(consumed).toBe(false)
    expect(routerBack).not.toHaveBeenCalled()
    expect(routerReplace).not.toHaveBeenCalled()
  })
})
