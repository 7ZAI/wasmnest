/**
 * 多任务层测量链合帧 + 等值短路（2026-11-08 性能审查 F9）
 *
 * 问题：`window.resize` 与 ResizeObserver 双路都直接 `measureBand()`，每次回调都
 * `getComputedStyle` + `clientWidth/Height`（强制同步布局），且数值未变也全量重算
 * metrics / cardSize / thumbSize 并重渲染整片卡片。
 *
 * 口径：
 * - 两个入口只调度一帧，同一帧内多次 resize 只量一次；
 * - 数值没变不写回（不触发下游 computed 重算）；
 * - 卸载时取消在途帧。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

const shellState = vi.hoisted(() => {
  const box = <T>(v: T) => ({ value: v })
  return {
    recentsOpen: box(true),
    cards: box<string[]>(['sys:settings']),
    activeCard: box<string | null>(null),
    cardTitleOf: () => 'Settings',
    activateCard: vi.fn(),
    closeCard: vi.fn(),
    stopAllCards: vi.fn(),
    toggleRecents: vi.fn(),
  }
})

vi.mock('@/shell/composables/useShellState', () => ({ useShellState: () => shellState }))
vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    appOf: () => undefined,
    tones: { value: {} },
    displayStates: { value: {} },
  }),
}))

import ShellTaskSwitcher from '@/shell/components/ShellTaskSwitcher.vue'

/** 等一帧 rAF（jsdom 用定时器实现，真实等待即可） */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

let wrapper: VueWrapper | null = null

beforeEach(() => {
  shellState.recentsOpen.value = true
  shellState.cards.value = ['sys:settings']
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('多任务层测量链', () => {
  it('同一帧内多次 resize 只量一次（合帧），不是每事件一次强制布局', async () => {
    wrapper = mount(ShellTaskSwitcher, { attachTo: document.body })
    await nextTick()

    // 挂载时的首测是同步的（打开态需要首帧尺寸）；从这里开始计增量
    const styleSpy = vi.spyOn(window, 'getComputedStyle')
    const before = styleSpy.mock.calls.length

    for (let i = 0; i < 60; i++) window.dispatchEvent(new Event('resize'))
    expect(styleSpy.mock.calls.length, '同一帧内不该同步量').toBe(before)

    await nextFrame()
    // 一次测量 = 带宽 1 次 + 卡片 chrome 1 次
    expect(styleSpy.mock.calls.length - before).toBe(2)
  })

  it('数值未变不写回：同尺寸的第二次测量不再触发下游重算', async () => {
    wrapper = mount(ShellTaskSwitcher, { attachTo: document.body })
    await nextTick()

    // 首帧尺寸已落地（bandStyle 写 --ts-card-w 等）
    const bandEl = document.body.querySelector('.ts-cards') as HTMLElement | null
    expect(bandEl).toBeTruthy()
    const styleBefore = bandEl!.getAttribute('style')

    // 同名尺寸再来一帧：jsdom 的 clientWidth/getComputedStyle 恒定 → 等值
    window.dispatchEvent(new Event('resize'))
    await nextFrame()

    expect(bandEl!.getAttribute('style'), '等值不重写，样式串逐字不变').toBe(styleBefore)
  })

  it('卸载取消在途帧：卸载后不再测量', async () => {
    wrapper = mount(ShellTaskSwitcher, { attachTo: document.body })
    await nextTick()

    const styleSpy = vi.spyOn(window, 'getComputedStyle')
    const before = styleSpy.mock.calls.length
    window.dispatchEvent(new Event('resize'))
    wrapper.unmount()
    wrapper = null

    await nextFrame()
    expect(styleSpy.mock.calls.length, '在途帧已取消').toBe(before)
  })
})
