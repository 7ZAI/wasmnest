/**
 * useLongPress 手势原语行为锁
 *
 * 契约（真源 = `useLongPress.ts` 头注释）：
 * - 按住 500ms（缺省）触发 onLongPress(ctx, x, y)；
 * - 触发前抬起 / 位移超阈值 / cancel() 都撤销；
 * - 非主键（右键 / 中键）不启动；已有按压进行中忽略第二指针；
 * - 触发后第一次 consumeClick() = true（长按不是打开），其后 false。
 *
 * 测试环境说明：happy-dom 无 PointerEvent 构造器与 setPointerCapture，
 * 用 Event + 显式字段合成（生产代码对 capture 可选调用，不依赖）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLongPress } from '@/shell/composables/useLongPress'

type PE = PointerEvent

function pointer(
  type: string,
  opts: { pointerId?: number; clientX?: number; clientY?: number; button?: number } = {},
): PE {
  return Object.assign(new Event(type), {
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    button: 0,
    ...opts,
  }) as unknown as PE
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup() {
  const onLongPress = vi.fn()
  const lp = useLongPress<string>(onLongPress)
  return { onLongPress, lp }
}

describe('useLongPress', () => {
  it('按住满时长 → 触发一次，带 context 与指针坐标', () => {
    const { onLongPress, lp } = setup()
    lp.down(pointer('pointerdown', { clientX: 30, clientY: 40 }), 'app-a')
    vi.advanceTimersByTime(499)
    expect(onLongPress).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onLongPress).toHaveBeenCalledTimes(1)
    expect(onLongPress).toHaveBeenCalledWith('app-a', 30, 40)
  })

  it('触发前抬起 → 不触发，click 不吞', () => {
    const { onLongPress, lp } = setup()
    lp.down(pointer('pointerdown'), 'app-a')
    vi.advanceTimersByTime(200)
    lp.up(pointer('pointerup'))
    vi.advanceTimersByTime(1000)
    expect(onLongPress).not.toHaveBeenCalled()
    expect(lp.consumeClick()).toBe(false)
  })

  it('位移超阈值 → 撤销；阈值内微动不撤销', () => {
    const { onLongPress, lp } = setup()
    lp.down(pointer('pointerdown'), 'app-a')
    lp.move(pointer('pointermove', { clientX: 40, clientY: 40 }))
    vi.advanceTimersByTime(1000)
    expect(onLongPress).not.toHaveBeenCalled()

    lp.down(pointer('pointerdown'), 'app-a')
    lp.move(pointer('pointermove', { clientX: 12, clientY: 11 }))
    vi.advanceTimersByTime(1000)
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('cancel()（右键先行等）→ 无条件撤销计时', () => {
    const { onLongPress, lp } = setup()
    lp.down(pointer('pointerdown'), 'app-a')
    lp.cancel()
    vi.advanceTimersByTime(1000)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('非主键按下（右键 / 中键）不启动计时', () => {
    const { onLongPress, lp } = setup()
    lp.down(pointer('pointerdown', { button: 2 }), 'app-a')
    lp.down(pointer('pointerdown', { button: 1 }), 'app-a')
    vi.advanceTimersByTime(1000)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('已有按压进行中 → 忽略第二指针（多点触控）', () => {
    const { onLongPress, lp } = setup()
    lp.down(pointer('pointerdown', { pointerId: 1, clientX: 10, clientY: 10 }), 'app-a')
    // 第二指针立刻抬起（第一指针的计时不应被它取消）
    lp.up(pointer('pointerup', { pointerId: 2 }))
    vi.advanceTimersByTime(1000)
    expect(onLongPress).toHaveBeenCalledTimes(1)
    expect(onLongPress).toHaveBeenCalledWith('app-a', 10, 10)
  })

  it('触发后第一次 consumeClick = true，其后 false；触发后再点击只吞一次', () => {
    const { onLongPress, lp } = setup()
    lp.down(pointer('pointerdown'), 'app-a')
    vi.advanceTimersByTime(500)
    expect(onLongPress).toHaveBeenCalledTimes(1)
    expect(lp.consumeClick()).toBe(true)
    expect(lp.consumeClick()).toBe(false)

    // 计时器已清：后续抬起/点击不再触发长按
    lp.up(pointer('pointerup'))
    vi.advanceTimersByTime(1000)
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })
})
