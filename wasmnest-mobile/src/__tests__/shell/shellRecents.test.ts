/**
 * 多任务（与桌面同形的卡片布局）行为契约测试（2026-10-21 改版）
 *
 * 被测：`src/shell/components/screens/ShellSwitcherScreen.vue`
 *
 * | 契约 | 来源 | 规则 | 预期 |
 * |---|---|---|---|
 * | C-S1 | cards computed | 运行中应用在前（MRU），最近未运行在后 | DOM 顺序 = 运行中(MRU) → 未运行(recent 序) |
 * | C-S2 | enter | 点整张卡片先回主屏重置栈，再走统一 openShellApp 口径 | goHome + openShellApp(appId) |
 * | C-S3 | dismiss（运行中） | 关闭 = 停用实例 + 移出最近列表 | stop 调用 + 卡片消失 |
 * | C-S4 | dismiss（未运行） | 只移出最近列表，不调 stop | stop 不调用 + 卡片消失 |
 * | C-S5 | closeAll | 停止所有运行中 + 清空最近列表 | stop 每个 + 卡片清空 |
 * | C-S6 | 上滑关闭 | 轴锁后纵向上滑超阈值才关闭；下滑是取消；pointercancel 不关闭 | 达阈值 dismiss，否则不 dismiss |
 * | C-S7 | 空态 | 无卡片时给出原因与出口（页头返回 + 主动作「回到主屏」） | 空态在场，不渲染卡片与「全部关闭」 |
 * | C-S8 | 卡片布局 | 与桌面同形的多行卡片：信息条在上 + 缩略区在下，行内居中 | 样式表锁 flex-wrap / 居中 / 3:4；无旧 deck 轨道 |
 * | C-S9 | 横向切卡 | 左滑下一张 / 右滑上一张；网格轻微跟手 | activeIndex 变化 + 跟手位移 |
 * | C-S10 | 空态主动作 | 空态给一条出路，不把用户堵在只有页头返回键的空屏 | 点「回到主屏」→ goHome |
 * | C-S11 | 触控目标 | 每张卡的 × 命中区 ≥44px | 样式表锁 width/height = touch-target token |
 * | C-S12 | 卡片内容 | 信息条 = 图标 + 名称 + 状态；缩略区 = 大图标 + 版本/权限 | 运行中不重复「运行中」，未运行写明状态 |
 * | C-S13 | 手势让位 | 贴屏幕左右边缘起手不接管（不与系统返回手势抢同一条边） | 贴边横滑不切卡，中部起手照常切卡 |
 * | C-S14 | 指针捕获 | 确认是拖拽后才捕获指针；纯点击不捕获 | 拖拽 setPointerCapture + 抬起释放；点击不捕获 |
 * | C-S15 | 整卡点击 | 覆盖整卡的打开按钮；不再有独立「进入」按钮 | 点卡片 goHome + open |
 * | C-S16 | 拖拽后不误触进入 | 拖拽抬手后浏览器补的 click 不得触发进入 | 上滑关闭后 mockOpenShellApp 未被调用 |
 * | C-S17 | 关闭按钮独占手势 | × 标 data-card-ignore-drag，从它起手不算卡片手势 | × 带标记；整卡按钮不带 |
 * | C-S18 | 每张卡都可操作 | 每张卡都有进入按钮与自己的 ×（桌面同形） | 无 aria-hidden，两张卡各 2 个按钮 |
 * | C-S19 | 滚动与手势分工 | 网格溢出时纵向上滑让位原生滚动，横向切卡仍生效 | 滚动场景上滑不 dismiss，横滑照常切卡 |
 * | C-S20 | 底部切换条退役 | 底部「上一个 / 下一个 / 圆点 / 页码」删除 | 源码 / 文案 / 样式表均无该组控件 |
 * | C-S21 | 页头计数 | 标题后显示卡片数（与桌面同一口径），空态不显示 | 有卡显示 N 个，无卡不显示 |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computed, ref } from 'vue'
import { clearRecent, pushRecent } from '@/shell/composables/useShellRecent'
import type { ShellApp } from '@/shell/types'

// ==================== 替身 ====================

const apps = ref<ShellApp[]>([])
const mockStop = vi.fn(async () => true)
const mockOpenShellApp = vi.fn(async () => true)
const mockGoHome = vi.fn()
const mockBack = vi.fn()

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    // 文案 key 原样回显：选择器与断言直接看 key，参数不参与取值
    t: (key: string) => key,
  }),
}))
vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({ apps: computed(() => apps.value), stop: mockStop }),
}))
vi.mock('@/shell/composables/useShellOpen', () => ({
  useShellOpen: () => ({
    open: (...args: unknown[]) => mockOpenShellApp(...(args as [string])),
  }),
  openShellApp: (...args: unknown[]) => mockOpenShellApp(...(args as [string])),
}))
vi.mock('@/shell/composables/useShellNavigation', () => ({
  useShellNavigation: () => ({ goHome: mockGoHome, back: mockBack }),
}))

import ShellSwitcherScreen from '@/shell/components/screens/ShellSwitcherScreen.vue'

function app(id: string, state: ShellApp['state'], name = id): ShellApp {
  return {
    id,
    name,
    version: '1.0.0',
    state,
    permissions: [{ key: 'fs:read', granted: true }],
    contributions: {},
  }
}

/** 卡片顺序（DOM 顺序 = 布局顺序） */
function cardIds(wrapper: ReturnType<typeof mount>): (string | undefined)[] {
  return wrapper.findAll('article.shell-recents-card').map((card) => card.attributes('data-app-id'))
}

/** 当前卡片（信息条高亮、aria-current 的那张） */
function activeCard(wrapper: ReturnType<typeof mount>) {
  const card = wrapper
    .findAll('article.shell-recents-card')
    .find((c) => c.find('button[aria-current="true"]').exists())
  if (!card) throw new Error('no active card')
  return card
}

function activeId(wrapper: ReturnType<typeof mount>): string | undefined {
  return activeCard(wrapper).attributes('data-app-id')
}

/** 以触屏指针手势拖拽卡片区 */
async function drag(
  wrapper: ReturnType<typeof mount>,
  from: { x: number; y: number },
  to: { x: number; y: number },
  withMove = true,
) {
  const grid = wrapper.find('.shell-recents-grid')
  await grid.trigger('pointerdown', { clientX: from.x, clientY: from.y, pointerType: 'touch', button: 0 })
  if (withMove) {
    // 先越过轴锁阈值，再落到目标位移（首次 move 只用来锁轴）
    await grid.trigger('pointermove', { clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2 })
    await grid.trigger('pointermove', { clientX: to.x, clientY: to.y })
  }
  await grid.trigger('pointerup', { clientX: to.x, clientY: to.y })
}

/** 屏宽固定值：贴边让位带（EDGE_GUARD）按屏宽判定，测试需要确定的视口 */
const VIEWPORT_WIDTH = 400

/** 指针捕获替身：happy-dom 不实现该 API（组件侧有降级分支），这里装上以验证捕获时机 */
const pointerCapture = { set: vi.fn(), release: vi.fn() }

/** 在原型上装 / 卸指针捕获替身（严格模式：未预期调用也应能被断言） */
function installPointerCapture(): void {
  pointerCapture.set = vi.fn()
  pointerCapture.release = vi.fn()
  for (const [name, impl] of [
    ['setPointerCapture', pointerCapture.set],
    ['releasePointerCapture', pointerCapture.release],
  ] as const) {
    Object.defineProperty(Element.prototype, name, { configurable: true, writable: true, value: impl })
  }
}

function uninstallPointerCapture(): void {
  for (const name of ['setPointerCapture', 'releasePointerCapture']) {
    delete (Element.prototype as unknown as Record<string, unknown>)[name]
  }
}

/** 把网格标成「内容溢出」，用于验证纵向手势让位给原生滚动 */
function markScrollable(wrapper: ReturnType<typeof mount>): void {
  const grid = wrapper.find('.shell-recents-grid').element as HTMLElement
  Object.defineProperty(grid, 'scrollHeight', { configurable: true, value: 900 })
  Object.defineProperty(grid, 'clientHeight', { configurable: true, value: 400 })
}

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? ''
}

beforeEach(() => {
  clearRecent()
  localStorage.clear()
  apps.value = []
  mockStop.mockClear()
  mockOpenShellApp.mockClear()
  mockGoHome.mockClear()
  mockBack.mockClear()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT_WIDTH })
})

afterEach(() => {
  uninstallPointerCapture()
})

describe('C-S1 卡片集合与顺序', () => {
  it('should_putRunningFirstByMru_thenDormantRecents', () => {
    // 最近使用序：b（最新）→ a；运行中只有 a 与 c（c 无 recent 记录 → 排运行组末尾）
    pushRecent('b')
    pushRecent('a')
    apps.value = [
      app('a', 'running', 'AppA'),
      app('c', 'running', 'AppC'),
      app('b', 'stopped', 'AppB'),
      app('d', 'stopped', 'AppD'), // 从未打开：不应出现在多任务里
    ]

    const wrapper = mount(ShellSwitcherScreen)

    expect(cardIds(wrapper)).toEqual(['a', 'c', 'b'])
    expect(activeId(wrapper), '当前卡是最该看到的（MRU 首位）').toBe('a')
  })

  it('should_showDormantState_when_appStoppedButRecent', () => {
    pushRecent('a')
    apps.value = [app('a', 'stopped', 'AppA')]

    const wrapper = mount(ShellSwitcherScreen)

    expect(wrapper.text(), '未运行卡片要写明状态').toContain('shell.switcher.dormant')
    // 未运行卡片的点击语义是「启动」而不是「进入」，靠可访问名区分
    expect(wrapper.find('button[aria-label="shell.switcher.launchApp"]').exists()).toBe(true)
  })

  it('should_notRepeatRunningState_when_cardIsRunning', () => {
    apps.value = [app('a', 'running', 'AppA')]

    const wrapper = mount(ShellSwitcherScreen)

    // 与桌面一致：运行中不追加状态行（后台卡默认就在跑，重复一遍是噪声）
    expect(wrapper.find('.shell-recents-status').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="shell.switcher.enterApp"]').exists()).toBe(true)
  })
})

describe('C-S2/C-S15 进入应用（整卡点击）', () => {
  it('should_resetStackAndOpenThroughUnifiedEntry_when_cardTapped', async () => {
    apps.value = [app('a', 'running', 'AppA')]
    const wrapper = mount(ShellSwitcherScreen)

    await activeCard(wrapper).find('button[aria-label="shell.switcher.enterApp"]').trigger('click')

    expect(mockGoHome, '进入前先回主屏，避免多任务屏留在历史里').toHaveBeenCalledTimes(1)
    expect(mockOpenShellApp).toHaveBeenCalledWith('a')
  })

  it('should_renderExactlyTwoControlsPerCard_when_cardRendered', () => {
    // 与桌面一致：一个是覆盖整卡的打开按钮，一个是卡片右上角的关闭键
    apps.value = [app('a', 'running', 'AppA')]
    const card = activeCard(mount(ShellSwitcherScreen))

    expect(card.findAll('button'), '每张卡只有「整卡进入」与「× 关闭」两个控件').toHaveLength(2)
    expect(card.text(), '不再渲染独立的「进入 / 启动」按钮文案').not.toContain('shell.switcher.enter')
    expect(card.text()).not.toContain('shell.switcher.launch')
  })

  it('should_coverWholeCardWithTappableTarget_when_cardRendered', () => {
    apps.value = [app('a', 'running', 'AppA')]

    const card = activeCard(mount(ShellSwitcherScreen))
    const tapTarget = card.find('button.shell-recents-open')

    // 打开按钮是卡片的直接子元素，并靠样式铺满整张卡
    expect(tapTarget.exists()).toBe(true)
    expect(tapTarget.element.parentElement).toBe(card.element)
    const css = readFileSync(join(process.cwd(), 'src/shell/styles/shell.css'), 'utf8')
    const block = cssBlock(css, '.shell-recents-open')
    expect(block, '覆盖整卡').toContain('position: absolute')
    expect(block).toContain('inset: 0')
    expect(css, '触屏按压反馈不能只有 hover').toContain('.shell-recents-open:active')
  })
})

describe('C-S16 拖拽后不误触进入', () => {
  it('should_notEnter_when_swipeUpDismissEndsWithClick', async () => {
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA')]
    const wrapper = mount(ShellSwitcherScreen)

    await drag(wrapper, { x: 200, y: 300 }, { x: 200, y: 150 })
    // 抬手后浏览器补的那次 click 落在整卡按钮上：必须被吞掉，否则上滑关闭顺手打开了应用
    await activeCard(wrapper)
      .find('button[aria-label="shell.switcher.enterApp"]')
      .trigger('click')

    expect(mockStop, '上滑超阈值应关闭').toHaveBeenCalledWith('a')
    expect(mockOpenShellApp, '拖拽余波 click 不得进入').not.toHaveBeenCalled()
  })

  it('should_switchWithoutEntering_when_swipedHorizontally', async () => {
    pushRecent('b')
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'running', 'AppB')]
    const wrapper = mount(ShellSwitcherScreen)

    await drag(wrapper, { x: 200, y: 300 }, { x: 120, y: 300 })
    await activeCard(wrapper)
      .find('button[aria-label="shell.switcher.enterApp"]')
      .trigger('click')

    expect(activeId(wrapper), '横滑只切当前卡').toBe('b')
    expect(mockOpenShellApp, '拖拽余波 click 不得进入').not.toHaveBeenCalled()
  })
})

describe('C-S17 关闭按钮独占手势', () => {
  it('should_markCloseButtonAsDragExempt_when_cardRendered', () => {
    apps.value = [app('a', 'running', 'AppA')]

    const card = activeCard(mount(ShellSwitcherScreen))

    // 整卡覆盖按钮仍要能起手横滑 / 上滑；只有 × 排除在拖拽之外
    expect(card.find('button[aria-label="shell.switcher.closeCard"]').attributes('data-card-ignore-drag'))
      .toBe('')
    expect(card.find('button.shell-recents-open').attributes('data-card-ignore-drag')).toBeUndefined()
  })
})

describe('C-S3/C-S4 关闭单张卡片', () => {
  it('should_stopAndDropFromRecents_when_runningCardClosed', async () => {
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA')]
    const wrapper = mount(ShellSwitcherScreen)

    await activeCard(wrapper).find('button[aria-label="shell.switcher.closeCard"]').trigger('click')

    expect(mockStop, '关闭运行中卡片 = 停用实例').toHaveBeenCalledWith('a')
    expect(localStorage.getItem('wasmnest.shell.recentApps') ?? '[]', '关闭后不得以未运行身份复活').toBe('[]')
  })

  it('should_onlyDropFromRecents_when_dormantCardClosed', async () => {
    pushRecent('a')
    apps.value = [app('a', 'stopped', 'AppA')]
    const wrapper = mount(ShellSwitcherScreen)

    await activeCard(wrapper).find('button[aria-label="shell.switcher.closeCard"]').trigger('click')

    expect(mockStop, '未运行的应用没有实例可停').not.toHaveBeenCalled()
    expect(localStorage.getItem('wasmnest.shell.recentApps') ?? '[]').toBe('[]')
  })

  it('should_closeAnyCard_when_itsOwnCloseTapped', async () => {
    pushRecent('b')
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'running', 'AppB')]
    const wrapper = mount(ShellSwitcherScreen)

    // 第二张卡不是当前卡，但它有自己的 ×（桌面同形）
    const second = wrapper.findAll('article.shell-recents-card')[1]
    await second.find('button[aria-label="shell.switcher.closeCard"]').trigger('click')

    expect(mockStop).toHaveBeenCalledWith('b')
    expect(activeId(wrapper), '关闭非当前卡不改变当前卡').toBe('a')
  })

  it('should_promoteNeighbour_when_activeCardClosed', async () => {
    pushRecent('b')
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'running', 'AppB')]
    const wrapper = mount(ShellSwitcherScreen)
    expect(activeId(wrapper)).toBe('a')

    await activeCard(wrapper).find('button[aria-label="shell.switcher.closeCard"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(activeId(wrapper), '当前卡被关掉后邻居补位').toBe('b')
  })
})

describe('C-S5 全部关闭', () => {
  it('should_stopEveryRunningAndClearRecents_when_closeAllTapped', async () => {
    pushRecent('b')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'stopped', 'AppB'), app('c', 'running', 'AppC')]
    const wrapper = mount(ShellSwitcherScreen)

    const closeAll = wrapper.findAll('button').find((b) => b.text().includes('shell.switcher.closeAll'))!
    await closeAll.trigger('click')

    expect(mockStop.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'c'])
    expect(localStorage.getItem('wasmnest.shell.recentApps') ?? '[]').toBe('[]')
  })
})

describe('C-S6 上滑关闭手势', () => {
  it('should_followFinger_when_draggingUp', async () => {
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA')]
    const wrapper = mount(ShellSwitcherScreen)

    const grid = wrapper.find('.shell-recents-grid')
    await grid.trigger('pointerdown', { clientX: 100, clientY: 200, pointerType: 'touch', button: 0 })
    await grid.trigger('pointermove', { clientX: 102, clientY: 190 })
    await grid.trigger('pointermove', { clientX: 104, clientY: 160 })
    await wrapper.vm.$nextTick()

    // 拖拽中卡片跟随位移（反馈是手势可发现性的前提，不能「松手才知道生效」）
    expect(activeCard(wrapper).attributes('style')).toContain('-40px')
    expect(mockStop).not.toHaveBeenCalled()
  })

  it('should_dismiss_when_swipeUpBeyondThreshold', async () => {
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA')]
    const wrapper = mount(ShellSwitcherScreen)

    await drag(wrapper, { x: 100, y: 300 }, { x: 102, y: 180 })

    expect(mockStop, '超过阈值（-120 ≤ -72）应关闭').toHaveBeenCalledWith('a')
  })

  it('should_notDismiss_when_swipeUpBelowThreshold', async () => {
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA')]
    const wrapper = mount(ShellSwitcherScreen)

    await drag(wrapper, { x: 100, y: 300 }, { x: 101, y: 270 })

    expect(mockStop, '未达阈值（-30 > -72）不得关闭').not.toHaveBeenCalled()
  })

  it('should_treatDownwardReleaseAsCancel_when_swipeBackDown', async () => {
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA')]
    const wrapper = mount(ShellSwitcherScreen)

    // 上滑超过阈值后又下拖回起点以下：以下滑方向为「取消」，不得关闭
    const grid = wrapper.find('.shell-recents-grid')
    await grid.trigger('pointerdown', { clientX: 100, clientY: 300, pointerType: 'touch', button: 0 })
    await grid.trigger('pointermove', { clientX: 101, clientY: 200 })
    await grid.trigger('pointermove', { clientX: 102, clientY: 360 })
    await grid.trigger('pointerup', { clientX: 102, clientY: 360 })

    expect(mockStop).not.toHaveBeenCalled()
  })

  it('should_notDismiss_when_pointerCancelled', async () => {
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA')]
    const wrapper = mount(ShellSwitcherScreen)

    const grid = wrapper.find('.shell-recents-grid')
    await grid.trigger('pointerdown', { clientX: 100, clientY: 300, pointerType: 'touch', button: 0 })
    await grid.trigger('pointercancel')
    await grid.trigger('pointerup', { clientX: 100, clientY: 100 })

    expect(mockStop, '取消后不得用旧起点继续判定').not.toHaveBeenCalled()
  })
})

describe('C-S19 滚动与手势分工', () => {
  function twoCards() {
    pushRecent('b')
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'running', 'AppB')]
    return mount(ShellSwitcherScreen)
  }

  it('should_yieldVerticalSwipeToNativeScroll_when_gridOverflows', async () => {
    const wrapper = twoCards()
    markScrollable(wrapper)

    await drag(wrapper, { x: 200, y: 300 }, { x: 202, y: 150 })

    expect(mockStop, '可滚动时纵向手势是滚动，不是关闭').not.toHaveBeenCalled()
    expect(activeId(wrapper), '纵向手势不切卡').toBe('a')
  })

  it('should_stillSwitchCards_when_gridOverflows', async () => {
    const wrapper = twoCards()
    markScrollable(wrapper)

    await drag(wrapper, { x: 200, y: 300 }, { x: 120, y: 300 })

    expect(activeId(wrapper), '横向切卡与纵向滚动不互相抢').toBe('b')
  })
})

describe('C-S7 空态', () => {
  it('should_showEmptyStateWithExit_when_noCards', () => {
    apps.value = [app('a', 'stopped', 'AppA')] // 未运行且不在最近列表 → 无卡片
    const wrapper = mount(ShellSwitcherScreen)

    expect(wrapper.findAll('article.shell-recents-card')).toHaveLength(0)
    expect(wrapper.text()).toContain('shell.switcher.empty')
    expect(wrapper.text(), '空态不渲染「全部关闭」').not.toContain('shell.switcher.closeAll')
  })

  it('should_exitThroughHeaderBack_when_noSystemBar', async () => {
    // 底部系统条退役后，返回出口由页头承担（空态另有主动作，见 C-S10）
    apps.value = []
    const wrapper = mount(ShellSwitcherScreen)

    await wrapper.find('button[aria-label="shell.switcher.back"]').trigger('click')

    expect(mockBack).toHaveBeenCalledTimes(1)
  })
})

describe('C-S10 空态主动作', () => {
  it('should_goHome_when_emptyStateActionTapped', async () => {
    // 空态只留文案没有动作 = 用户被堵在空屏里（ui-ux-pro-max Empty States：文案 + 动作）
    apps.value = []
    const wrapper = mount(ShellSwitcherScreen)

    const action = wrapper.findAll('button').find((b) => b.text().includes('shell.switcher.goHome'))
    expect(action, '空态要有主动作').toBeTruthy()

    await action!.trigger('click')

    expect(mockGoHome).toHaveBeenCalledTimes(1)
  })

  it('should_notRenderEmptyAction_when_cardsExist', () => {
    apps.value = [app('a', 'running', 'AppA')]
    const text = mount(ShellSwitcherScreen).text()

    expect(text, '有卡片时不渲染空态动作').not.toContain('shell.switcher.goHome')
  })
})

describe('C-S11 触控目标（× 关闭）', () => {
  it('should_keepCloseButtonHitAreaAtLeast44px_when_cardRendered', () => {
    apps.value = [app('a', 'running', 'AppA')]

    const close = activeCard(mount(ShellSwitcherScreen)).find(
      'button[aria-label="shell.switcher.closeCard"]',
    )
    expect(close.exists()).toBe(true)

    // 命中区由样式表 token 给（44px），视觉图标仍只有 15px
    const css = readFileSync(join(process.cwd(), 'src/shell/styles/shell.css'), 'utf8')
    const block = cssBlock(css, '.shell-recents-close')
    expect(block).toContain('width: var(--mobile-touch-target-min)')
    expect(block).toContain('height: var(--mobile-touch-target-min)')
    expect(block, '不得退回 36px 定宽').not.toContain('width: 36px')
  })
})

describe('C-S12 卡片内容（与桌面同形）', () => {
  it('should_renderInfoBarAndThumb_when_cardRendered', () => {
    pushRecent('a')
    apps.value = [app('a', 'stopped', 'AppA')]
    const wrapper = mount(ShellSwitcherScreen)

    const card = activeCard(wrapper)
    // 信息条：图标 + 名称 + 状态（未运行）
    expect(card.find('.shell-recents-meta').exists()).toBe(true)
    expect(card.find('.shell-recents-name').text()).toBe('AppA')
    expect(card.find('.shell-recents-status').text()).toBe('shell.switcher.dormant')
    // 缩略区：大图标 + 版本 / 权限数（真实元信息，不伪造应用截图）
    expect(card.find('.shell-recents-thumb').exists()).toBe(true)
    expect(card.text()).toContain('v1.0.0')
    expect(card.text()).toContain('shell.apps.permissionCount')
  })
})

describe('C-S13 手势让位（不与系统返回手势抢边）', () => {
  function twoCards() {
    pushRecent('b')
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'running', 'AppB')]
    return mount(ShellSwitcherScreen)
  }

  it('should_ignoreSwipe_when_startedAtLeftEdge', async () => {
    const wrapper = twoCards()

    await drag(wrapper, { x: 8, y: 300 }, { x: 80, y: 300 })

    expect(activeId(wrapper), '贴边起手交给系统返回手势，卡片不切').toBe('a')
  })

  it('should_ignoreSwipe_when_startedAtRightEdge', async () => {
    const wrapper = twoCards()

    await drag(wrapper, { x: VIEWPORT_WIDTH - 8, y: 300 }, { x: VIEWPORT_WIDTH - 80, y: 300 })

    expect(activeId(wrapper)).toBe('a')
  })

  it('should_switchCard_when_startedInsideGuard', async () => {
    // 反例护栏：让位带之外的同一手势必须照常切卡，否则手势整体失效
    const wrapper = twoCards()

    await drag(wrapper, { x: 150, y: 300 }, { x: 80, y: 300 })

    expect(activeId(wrapper)).toBe('b')
  })
})

describe('C-S14 指针捕获（拖拽收尾）', () => {
  it('should_captureAndReleasePointer_when_dragPassesAxisLock', async () => {
    installPointerCapture()
    pushRecent('b')
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'running', 'AppB')]
    const wrapper = mount(ShellSwitcherScreen)

    await drag(wrapper, { x: 200, y: 300 }, { x: 120, y: 300 })

    // 捕获后手指滑出网格区仍能收到 move/up，否则网格会停在偏移位
    expect(pointerCapture.set).toHaveBeenCalledTimes(1)
    expect(pointerCapture.release, '抬起即释放').toHaveBeenCalledTimes(1)
  })

  it('should_notCapturePointer_when_tapWithoutMove', async () => {
    // 纯点击不捕获：捕获会把 click 改派到网格容器，卡片上的点击就落空了
    installPointerCapture()
    pushRecent('b')
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'running', 'AppB')]
    const wrapper = mount(ShellSwitcherScreen)

    await drag(wrapper, { x: 200, y: 300 }, { x: 202, y: 302 }, false)

    expect(pointerCapture.set).not.toHaveBeenCalled()
    await wrapper
      .findAll('article.shell-recents-card')[1]
      .find('button[aria-label="shell.switcher.enterApp"]')
      .trigger('click')
    expect(mockOpenShellApp, '未拖拽的点击照常进入').toHaveBeenCalledWith('b')
  })
})

describe('C-S8 卡片布局（与桌面同形）', () => {
  function twoCards() {
    pushRecent('b')
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'running', 'AppB')]
    return mount(ShellSwitcherScreen)
  }

  it('should_layCardsInCenteredWrappingRows_when_cardsRendered', () => {
    const css = readFileSync(join(process.cwd(), 'src/shell/styles/shell.css'), 'utf8')
    const inner = cssBlock(css, '.shell-recents-grid-inner')
    const card = cssBlock(css, '.shell-recents-card')

    expect(inner, '多行按行排布').toContain('flex-wrap: wrap')
    expect(inner, '整组水平居中').toContain('justify-content: center')
    expect(inner, '内容不足一屏时纵向居中').toContain('align-content: center')
    expect(card, '与桌面同一 3/4 竖版比例').toContain('aspect-ratio: 3 / 4')
    expect(card, '卡片不再叠压').not.toContain('position: absolute')
    expect(css, '旧卡片轨道已退役').not.toContain('.shell-deck')
  })

  it('should_followFingerWithWholeGrid_when_swipedHorizontally', async () => {
    const wrapper = twoCards()

    const grid = wrapper.find('.shell-recents-grid')
    await grid.trigger('pointerdown', { clientX: 200, clientY: 300, pointerType: 'touch', button: 0 })
    await grid.trigger('pointermove', { clientX: 175, clientY: 300 })
    await grid.trigger('pointermove', { clientX: 150, clientY: 300 })

    // 横向手势是「切当前卡」：网格整体轻微跟手（-50 × 0.14 = -7px），抬手吸附
    expect(wrapper.find('.shell-recents-grid-inner').attributes('style')).toContain('-7px')
  })

  it('should_keepCurrentCardMarked_when_cardsRendered', () => {
    const wrapper = twoCards()

    const cards = wrapper.findAll('article.shell-recents-card')
    expect(cards).toHaveLength(2)
    expect(cards[0].find('button[aria-current="true"]').exists(), '当前卡片有 aria-current').toBe(true)
    expect(cards[1].find('button[aria-current="true"]').exists()).toBe(false)
  })
})

describe('C-S9 横向切卡（手势）', () => {
  function twoCards() {
    pushRecent('b')
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'running', 'AppB')]
    return mount(ShellSwitcherScreen)
  }

  it('should_switchToNext_when_swipedLeft', async () => {
    const wrapper = twoCards()

    await drag(wrapper, { x: 200, y: 300 }, { x: 120, y: 300 })

    expect(activeId(wrapper)).toBe('b')
    expect(mockStop, '切卡不是关闭').not.toHaveBeenCalled()
  })

  it('should_switchBack_when_swipedRight', async () => {
    const wrapper = twoCards()
    await drag(wrapper, { x: 200, y: 300 }, { x: 120, y: 300 })
    expect(activeId(wrapper)).toBe('b')

    await drag(wrapper, { x: 120, y: 300 }, { x: 200, y: 300 })

    expect(activeId(wrapper)).toBe('a')
  })
})

describe('C-S18 每张卡都可操作', () => {
  it('should_exposeEveryCardToScreenReaders_when_multipleCards', () => {
    pushRecent('b')
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'running', 'AppB')]
    const wrapper = mount(ShellSwitcherScreen)

    const cards = wrapper.findAll('article.shell-recents-card')
    // 多行布局每张卡都完整可见：每张都在无障碍树里，各带进入按钮与自己的 ×
    expect(cards.map((c) => c.attributes('aria-hidden'))).toEqual([undefined, undefined])
    for (const card of cards) {
      expect(card.find('button.shell-recents-open').exists()).toBe(true)
      expect(card.find('button[aria-label="shell.switcher.closeCard"]').exists()).toBe(true)
    }
  })

  it('should_enterTappedApp_when_nonActiveCardTapped', async () => {
    pushRecent('b')
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'running', 'AppB')]
    const wrapper = mount(ShellSwitcherScreen)

    // 点哪张开哪张（Android recents）：不需要先把它滑到前面
    await wrapper
      .findAll('article.shell-recents-card')[1]
      .find('button[aria-label="shell.switcher.enterApp"]')
      .trigger('click')

    expect(mockGoHome).toHaveBeenCalledTimes(1)
    expect(mockOpenShellApp).toHaveBeenCalledWith('b')
  })
})

describe('C-S20 底部切换条退役', () => {
  it('should_notRenderBottomSwitcher_when_cardsRendered', () => {
    pushRecent('b')
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'running', 'AppB')]
    const wrapper = mount(ShellSwitcherScreen)

    expect(wrapper.find('button[aria-label="shell.switcher.prev"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="shell.switcher.next"]').exists()).toBe(false)
    expect(wrapper.find('[role="status"]').exists(), '位置播报随底部切换条一起退役').toBe(false)
    expect(wrapper.find('.shell-deck').exists()).toBe(false)
  })

  it('should_notKeepRetiredKeys_when_sourceAndLocalesScanned', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/shell/components/screens/ShellSwitcherScreen.vue'),
      'utf8',
    )
    for (const retired of ['shell.switcher.prev', 'shell.switcher.next', 'shell.switcher.position']) {
      expect(source, `${retired} 不应再被引用`).not.toContain(retired)
    }

    for (const locale of ['src/locales/zh-CN/shell.ts', 'src/locales/en/shell.ts']) {
      const text = readFileSync(join(process.cwd(), locale), 'utf8')
      expect(text, `${locale} 不应保留退役文案`).not.toMatch(/\b(prev|next|position):/)
    }
  })
})

describe('C-S21 页头计数', () => {
  it('should_showCardCount_when_cardsExist', () => {
    pushRecent('a')
    apps.value = [app('a', 'running', 'AppA'), app('b', 'stopped', 'AppB')]
    pushRecent('b')

    const wrapper = mount(ShellSwitcherScreen)

    expect(wrapper.text()).toContain('2 shell.switcher.countUnit')
  })

  it('should_hideCount_when_noCards', () => {
    apps.value = []

    const wrapper = mount(ShellSwitcherScreen)

    expect(wrapper.text()).not.toContain('shell.switcher.countUnit')
  })
})
