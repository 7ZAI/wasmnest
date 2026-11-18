import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 多任务关闭渐隐（2026-11-12 用户裁决「单关 / 全关各有对应的渐隐」）
 *
 * | 契约 | 动作 | 预期 |
 * |---|---|---|
 * | CM-1 | 单关 | 点 × 后立刻带 is-closing（视觉不等真停用），容器不带 is-clearing |
 * | CM-2 | 单关失败 | 停用返回 false ⇒ is-closing 撤销（卡片淡回来） |
 * | CM-3 | 单关占位 | 数据已离场后卡片仍占一个卡位（幽灵），渐隐结束才落位 |
 * | CM-4 | 全关 | 每张都带 is-closing + 按序交错 delay，容器带 is-clearing |
 * | CM-5 | 减少动效 | 渐隐与空态都带 reduce 分支，延迟被压成 0 |
 * | CM-6 | 属性边界 | 只动 opacity / transform（不出现 width / height / top / left） |
 */

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

const shellState = vi.hoisted(() => {
  const box = <T>(v: T) => ({ value: v })
  return {
    recentsOpen: box(true),
    cards: box<string[]>(['sys:settings', 'sys:apps']),
    activeCard: box<string | null>(null),
    cardTitleOf: (key: string) => key,
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

let wrapper: VueWrapper | null = null

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function cards(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.ts-card'))
}

function closingCards(): HTMLElement[] {
  return cards().filter((card) => card.classList.contains('is-closing'))
}

/** Vue 按运行环境把 inert 写成属性或属性值，两者都算生效 */
function isInert(el: HTMLElement): boolean {
  return el.hasAttribute('inert') || (el as HTMLElement & { inert?: boolean }).inert === true
}

/** 等真实计时器（渐隐窗口 200ms + 尾巴 30ms，留余量） */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  shellState.recentsOpen.value = true
  shellState.cards.value = ['sys:settings', 'sys:apps']
  shellState.activeCard.value = null
  shellState.closeCard = vi.fn()
  shellState.stopAllCards = vi.fn()
  wrapper = mount(ShellTaskSwitcher, { attachTo: document.body })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('CM-1/CM-2 单关渐隐', () => {
  it('should_fadeTheTappedCardImmediately_when_closeTapped', async () => {
    const pending = deferred<boolean>()
    shellState.closeCard = vi.fn(() => pending.promise)

    const before = closingCards()
    expect(before).toHaveLength(0)

    cards()[0]!.querySelector<HTMLButtonElement>('.ts-card-x')!.click()
    await nextTick()

    expect(closingCards(), '点下去就该开始渐隐，不等真停用').toHaveLength(1)
    expect(isInert(closingCards()[0]!), '关闭态不可聚焦 / 不可点').toBe(true)
    expect(
      document.body.querySelector('.ts-cards')!.classList.contains('is-clearing'),
      '单关不是清场',
    ).toBe(false)

    pending.resolve(true)
    await flushPromises()
    // 数据层没移走这张卡（测试桩不删）：安全窗口内不留下隐形卡
    expect(closingCards(), '停用成功但卡仍在清单里时，渐隐标记不得滞留到永久').toHaveLength(1)
  })

  it('should_restoreCard_when_stopFailed', async () => {
    shellState.closeCard = vi.fn(async () => false)

    cards()[0]!.querySelector<HTMLButtonElement>('.ts-card-x')!.click()
    await flushPromises()
    await nextTick()

    expect(closingCards(), '停用失败 ⇒ 卡片淡回来（fail-visible）').toHaveLength(0)
    expect(cards()).toHaveLength(2)
  })

  it('should_ignoreDoubleTap_when_closeAlreadyRunning', async () => {
    const pending = deferred<boolean>()
    shellState.closeCard = vi.fn(() => pending.promise)

    const x = cards()[0]!.querySelector<HTMLButtonElement>('.ts-card-x')!
    x.click()
    x.click()
    await nextTick()

    expect(shellState.closeCard).toHaveBeenCalledTimes(1)
    pending.resolve(false)
    await flushPromises()
  })
})

describe('CM-3 渐隐期间占位（布局不在卡还看得见时塌陷）', () => {
  it('should_keepTheSlot_until_fadeEnds_when_cardLeftTheList', async () => {
    shellState.closeCard = vi.fn(async (key: string) => {
      shellState.cards.value = shellState.cards.value.filter((k) => k !== key)
      return true
    })

    cards()[0]!.querySelector<HTMLButtonElement>('.ts-card-x')!.click()
    await flushPromises()
    await nextTick()

    expect(shellState.cards.value, '数据层立即离场').toHaveLength(1)
    expect(cards(), '渐隐期间仍占一个卡位（幽灵）').toHaveLength(2)
    expect(closingCards()).toHaveLength(1)

    await wait(320)
    await nextTick()

    expect(cards(), '渐隐结束才落位').toHaveLength(1)
    expect(closingCards()).toHaveLength(0)
  })
})

describe('CM-4 全部关闭：整组错峰', () => {
  it('should_staggerEveryCard_when_closeAllTapped', async () => {
    const pending = deferred<void>()
    shellState.stopAllCards = vi.fn(() => pending.promise)

    document.body.querySelector<HTMLButtonElement>('.shell-mini.danger')!.click()
    await nextTick()

    expect(closingCards(), '整组一起进入关闭态').toHaveLength(2)
    expect(document.body.querySelector('.ts-cards')!.classList.contains('is-clearing')).toBe(true)
    expect(cards()[0]!.style.transitionDelay, '第一张不延迟').toBe('0ms')
    expect(cards()[1]!.style.transitionDelay, '第二张按序 +22ms').toBe('22ms')

    pending.resolve()
    await flushPromises()
  })
})

describe('CM-5/CM-6 动效边界', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/shell/components/ShellTaskSwitcher.vue'),
    'utf8',
  )

  it('should_onlyAnimateOpacityAndTransform_when_closing', () => {
    const start = source.indexOf('.ts-card.is-closing {')
    const block = source.slice(start, source.indexOf('}', start))
    expect(block).toContain('opacity: 0')
    expect(block).toContain('transition:')
    expect(block, '只动合成层属性').not.toMatch(/\b(width|height|margin|padding|top|left):/)
  })

  it('should_shipReducedMotionBranch_when_motionAdded', () => {
    const reduce = source.slice(source.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduce).toContain('.ts-card.is-closing')
    expect(reduce, '减弱动态不等交错延迟').toContain('transition-delay: 0ms !important')
    expect(reduce).toContain('.ts-empty')
  })
})
