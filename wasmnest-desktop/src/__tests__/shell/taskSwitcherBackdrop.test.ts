import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'

/**
 * 多任务全屏层：点非卡片区域自动退出（安卓 recents 同款）
 *
 * 需求：全屏层展示时，点卡片以外的任何地方（虚化背景、卡片之间的空隙、底部说明、
 * 顶部操作条的空位…）都收起它；点卡片本体则切回应用，不收起。
 *
 * 为什么用挂载测试而不是源码锁：判据是**事件命中范围**——`.ts-inner` 盖住虚化背景、
 * 卡片带横向滚动，`@click.self` 这类写法会在「卡片之间的空隙」整片失效。只有在真实
 * DOM 上派发点击才能钉住这条行为。
 */

// 只替换组件用的 useI18n（返回 key 原文），保留 createI18n——`src/i18n/index.ts` 仍在
// 导入图里（userError 等），整体替换会让它在模块求值期就炸
vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

/** 壳状态桩：只提供本组件消费的字段，动作用 spy 记录 */
const shellState = vi.hoisted(() => {
  // vi.hoisted 里不能直接用 vue 的 ref（hoist 早于 import 求值），这里手工造 .value 容器
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

let wrapper: VueWrapper | null = null

/** 重开全屏层并等 DOM 就位（关闭后 v-if 会把整棵子树摘掉） */
async function openSwitcher(): Promise<void> {
  shellState.recentsOpen.value = true
  await nextTick()
}

function el(selector: string): HTMLElement {
  const node = document.body.querySelector(selector)
  expect(node, `找不到 ${selector}（全屏层没渲染？）`).toBeTruthy()
  return node as HTMLElement
}

/** 在真实 DOM 上派发点击（冒泡到根节点的委托处理器） */
async function click(selector: string): Promise<void> {
  el(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await nextTick()
}

describe('多任务全屏层：点非卡片区域退出', () => {
  beforeEach(async () => {
    shellState.recentsOpen.value = true
    shellState.cards.value = ['sys:settings']
    shellState.activateCard.mockClear()
    shellState.closeCard.mockClear()
    wrapper = mount(ShellTaskSwitcher, { attachTo: document.body })
    await nextTick()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('点虚化背景 → 退出（正例）', async () => {
    await click('.ts-scrim')
    expect(shellState.recentsOpen.value).toBe(false)
  })

  it('点卡片之间的空隙 / 底部说明 → 退出（旧实现失效的那片区域）', async () => {
    await click('.ts-cards')
    expect(shellState.recentsOpen.value).toBe(false)

    await openSwitcher()
    await click('.ts-foot')
    expect(shellState.recentsOpen.value).toBe(false)
  })

  it('点卡片本体 → 切回应用，不退出（反例：别把卡片点击当空白）', async () => {
    // 卡片主区就是"点我切回去"的按钮；它的点击必须被 data-ts-keep 挡住，不当作空白
    await click('.ts-card-main')
    expect(shellState.activateCard).toHaveBeenCalledTimes(1)
    expect(shellState.recentsOpen.value).toBe(true)
  })

  it('点顶部操作条 → 不退出（关闭 / 全部关闭由各自按钮负责）', async () => {
    await click('.ts-head')
    expect(shellState.recentsOpen.value).toBe(true)
  })

  it('卡片里的关闭按钮 → 只关这张卡，全屏层留下（可连续关多张）', async () => {
    await click('.ts-card-x')
    expect(shellState.closeCard).toHaveBeenCalledTimes(1)
    expect(shellState.recentsOpen.value).toBe(true)
  })
})
