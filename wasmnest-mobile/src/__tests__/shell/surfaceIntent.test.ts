/**
 * 运行面入口意图通道 行为契约测试（2026-11-11）
 *
 * 被测：`src/shell/surfaceIntent.ts`
 *
 * | 契约 | 来源 | 规则 | 预期 |
 * |---|---|---|---|
 * | C-I1 | 订阅前排队 | 运行面晚于点击创建 | 订阅时按序补投，不丢 |
 * | C-I2 | 订阅后直投 | 运行面已存活（切走保活不重挂） | 入队即投递，不等下一次挂载 |
 * | C-I3 | 只投本应用 | appId 键控 | 别的 appId 的订阅者收不到 |
 * | C-I4 | 队列上限 | 应用永不消费 | 只保留最近 N 条（丢最旧） |
 * | C-I5 | 生命周期清空 | 停用 / 卸载 / 运行面销毁 | clear 后不再投递旧意图 |
 * | C-I6 | 取消订阅 | Disposable.dispose | 该订阅者不再收到；其它订阅者不受影响 |
 * | C-I7 | 空输入 | 没有入口（null / 空 id） | 不入队，不抛 |
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  SURFACE_INTENT_MAX_PENDING,
  clearSurfaceIntents,
  pendingSurfaceIntentCount,
  queueSurfaceIntent,
  resetSurfaceIntents,
  subscribeSurfaceIntent,
} from '@/shell/surfaceIntent'

const APP = 'com.test.app'
const OTHER = 'com.test.other'

beforeEach(() => {
  resetSurfaceIntents()
})

describe('C-I1 订阅前排队（运行面晚于点击创建）', () => {
  it('should_flushPendingInOrder_when_subscriberAppearsLater', () => {
    queueSurfaceIntent(APP, { key: 'a', payload: 1 })
    queueSurfaceIntent(APP, { key: 'b', payload: 2 })
    expect(pendingSurfaceIntentCount(APP)).toBe(2)

    const handler = vi.fn()
    subscribeSurfaceIntent(APP, handler)

    expect(handler.mock.calls.map(([intent]) => intent.key)).toEqual(['a', 'b'])
    // 投递即清空排队，不会在下一次订阅时重复投递
    expect(pendingSurfaceIntentCount(APP)).toBe(0)
  })
})

describe('C-I2 订阅后直投（保活运行面不重挂）', () => {
  it('should_deliverImmediately_when_surfaceAlreadySubscribed', () => {
    const handler = vi.fn()
    subscribeSurfaceIntent(APP, handler)

    queueSurfaceIntent(APP, { key: 'open-session', payload: { sessionId: 's1' } })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toEqual({ key: 'open-session', payload: { sessionId: 's1' } })
  })
})

describe('C-I3 只投本应用', () => {
  it('should_notDeliverAcrossApps_when_otherAppSubscribed', () => {
    const mine = vi.fn()
    const others = vi.fn()
    subscribeSurfaceIntent(APP, mine)
    subscribeSurfaceIntent(OTHER, others)

    queueSurfaceIntent(APP, { key: 'k' })

    expect(mine).toHaveBeenCalledTimes(1)
    expect(others).not.toHaveBeenCalled()
  })
})

describe('C-I4 队列上限', () => {
  it('should_keepOnlyLatest_when_pendingExceedsCap', () => {
    for (let i = 0; i < SURFACE_INTENT_MAX_PENDING + 3; i += 1) {
      queueSurfaceIntent(APP, { key: `k${i}` })
    }
    expect(pendingSurfaceIntentCount(APP)).toBe(SURFACE_INTENT_MAX_PENDING)

    const handler = vi.fn()
    subscribeSurfaceIntent(APP, handler)
    const keys = handler.mock.calls.map(([intent]) => intent.key)
    // 丢最旧的，保留最近的 N 条（顺序不变）
    expect(keys[0]).toBe('k3')
    expect(keys[keys.length - 1]).toBe(`k${SURFACE_INTENT_MAX_PENDING + 2}`)
  })
})

describe('C-I5 生命周期清空（停用 / 卸载 / 运行面销毁）', () => {
  it('should_notDeliverStaleIntent_when_clearedBeforeSubscribe', () => {
    queueSurfaceIntent(APP, { key: 'stale' })
    clearSurfaceIntents(APP)

    const handler = vi.fn()
    subscribeSurfaceIntent(APP, handler)

    expect(handler).not.toHaveBeenCalled()
    expect(pendingSurfaceIntentCount(APP)).toBe(0)
  })
})

describe('C-I6 取消订阅', () => {
  it('should_stopDeliveryForDisposedHandler_when_disposed', () => {
    const first = vi.fn()
    const second = vi.fn()
    const a = subscribeSurfaceIntent(APP, first)
    subscribeSurfaceIntent(APP, second)

    a.dispose()
    queueSurfaceIntent(APP, { key: 'k' })

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('C-I7 空输入', () => {
  it('should_ignoreEmptyInput_when_noIntent', () => {
    queueSurfaceIntent('', { key: 'k' })
    queueSurfaceIntent(APP, null)
    queueSurfaceIntent(APP, undefined)

    expect(pendingSurfaceIntentCount(APP)).toBe(0)
    expect(pendingSurfaceIntentCount('')).toBe(0)
  })
})
