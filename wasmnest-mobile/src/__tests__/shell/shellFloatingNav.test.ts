/**
 * 悬浮导航行为契约测试
 *
 * 被测：`src/shell/components/ShellFloatingNav.vue`
 *
 * | 契约 | 来源 | 规则 | 预期 |
 * |---|---|---|---|
 * | C-F1 | 开关 | 默认关闭；关闭时不渲染 | DOM 无悬浮条 |
 * | C-F2 | 回主屏 | 任意页面点 home = 重置壳栈 + 进壳路由 | goHome + push(mobile-shell) |
 * | C-F3 | 多任务 | 点多任务 = 打开切换屏 + 进壳路由 | openSwitcher + push |
 * | C-F3b | 返回 | 壳内走共用返回序列；整页路由回浏览器历史；无可退时置灰 | 调用 / disabled 在场 |
 * | C-F4 | 已在壳内 | 不重复导航 | 只调 goHome，不 push |
 * | C-F5 | 拖动 | 越过阈值才判拖拽；抬手落归一化位置 | setFloatingNavPos(x,y) 在 [0,1] |
 * | C-F6 | 拖拽余波 | 拖动抬手补的 click 在捕获阶段被吞没 | preventDefault 为真 |
 * | C-F7 | 键盘替代 | 拖动面聚焦后方向键移动并持久化 | 位置左移 + setFloatingNavPos |
 * | C-F8 | 可读名 | 三个按钮与拖动面都有 aria-label | 定位即断言 |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { reactive, ref } from 'vue'

const mockGoHome = vi.fn()
const mockOpenSwitcher = vi.fn()
const mockBackInShell = vi.fn(() => true)
const mockPush = vi.fn(async () => undefined)
const mockRouterBack = vi.fn()
const mockRouterReplace = vi.fn(async () => undefined)
const mockLeaveStandalone = vi.fn()
const mockSetFloatingNavPos = vi.fn()

const floatingNav = ref(true)
const floatingNavPos = ref({ x: 0.5, y: 1 })
/** 壳内是否有可返回目标（系统返回 / 悬浮返回同源判据） */
const hasBackTarget = ref(false)
/** 当前整页路由（旧设置二级页时 name 不是 mobile-shell） */
const route = reactive<{ name: string }>({ name: 'mobile-shell' })

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockRouterBack, replace: mockRouterReplace }),
  useRoute: () => route,
}))
vi.mock('@/shell/composables/useShellSystemBack', () => ({
  useShellBackAction: () => ({ hasBackTarget, back: mockBackInShell }),
}))
vi.mock('@/router/standaloneBack', () => ({
  leaveStandaloneRoute: (...args: unknown[]) => mockLeaveStandalone(...args),
}))
vi.mock('@/shell/composables/useShellNavigation', () => ({
  useShellNavigation: () => ({ goHome: mockGoHome, openSwitcher: mockOpenSwitcher }),
}))
vi.mock('@/shell/composables/useShellPreferences', () => ({
  useShellPreferences: () => ({
    floatingNav,
    floatingNavPos,
    setFloatingNavPos: (...args: unknown[]) => mockSetFloatingNavPos(...args),
  }),
}))

import ShellFloatingNav from '@/shell/components/ShellFloatingNav.vue'
import zhShell from '@/locales/zh-CN/shell'
import enShell from '@/locales/en/shell'

/** 测试视口与悬浮条尺寸：位置换算依赖实测尺寸，happy-dom 默认给 0 */
const VIEWPORT = { width: 400, height: 800 }
/** 与 shell.css 的胶囊尺寸同口径：6×2 padding + 48×3 按钮 + 12×2 间距 + 2 分隔线 */
const NAV_SIZE = { width: 182, height: 56 }
const EDGE_MARGIN = 12

/**
 * 模拟整页路由的历史回退目标
 *
 * happy-dom 的 `history.state` 不跟 `replaceState`（恒为 null），直接覆盖 getter：
 * 一条断言就能分开「有整页历史」与「深链直入无历史」两个分支。
 */
function stubHistoryBack(back: string | null): void {
  Object.defineProperty(window.history, 'state', {
    configurable: true,
    get: () => (back ? { back } : null),
  })
}

function mountNav() {
  const wrapper = mount(ShellFloatingNav, { attachTo: document.body })
  const el = wrapper.find('[data-testid="shell-floating-nav"]').element as HTMLElement
  // 实测尺寸在挂载后补：先给实例装尺寸，再触发一次 resize 让组件重新量
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: NAV_SIZE.width })
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: NAV_SIZE.height })
  window.dispatchEvent(new Event('resize'))
  return { wrapper, el }
}

/** 位置换算的上下界（与组件同一口径：两端各留 EDGE_MARGIN） */
function bounds() {
  return {
    minX: EDGE_MARGIN,
    maxX: VIEWPORT.width - NAV_SIZE.width - EDGE_MARGIN,
    minY: EDGE_MARGIN,
    maxY: VIEWPORT.height - NAV_SIZE.height - EDGE_MARGIN,
  }
}

beforeEach(() => {
  mockGoHome.mockClear()
  mockOpenSwitcher.mockClear()
  mockBackInShell.mockClear()
  mockPush.mockClear()
  mockRouterBack.mockClear()
  mockRouterReplace.mockClear()
  mockLeaveStandalone.mockClear()
  mockSetFloatingNavPos.mockClear()
  floatingNav.value = true
  floatingNavPos.value = { x: 0.5, y: 1 }
  hasBackTarget.value = false
  route.name = 'mobile-shell'
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height })
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('C-F1 开关与渲染', () => {
  it('should_notRender_when_floatingNavDisabled', () => {
    floatingNav.value = false
    const wrapper = mount(ShellFloatingNav)

    expect(wrapper.find('[data-testid="shell-floating-nav"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('should_renderWithAccessibleNames_when_enabled', () => {
    const { wrapper } = mountNav()

    const bar = wrapper.find('[data-testid="shell-floating-nav"]')
    expect(bar.attributes('role'), '拖动面是语义分组').toBe('group')
    expect(bar.attributes('tabindex'), '拖动面可聚焦（方向键替代路径）').toBe('0')
    expect(bar.attributes('aria-label')).toBe('shell.floatingNav.move')
    expect(wrapper.find('button[aria-label="shell.floatingNav.back"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="shell.floatingNav.home"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="shell.floatingNav.recents"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('C-F2..C-F4 导航动作', () => {
  it('should_useSharedBackAction_when_backTappedInsideShell', async () => {
    hasBackTarget.value = true
    const { wrapper } = mountNav()
    const back = wrapper.find('button[aria-label="shell.floatingNav.back"]')

    expect(back.attributes('disabled'), '壳内有可退项时可点').toBeUndefined()
    await back.trigger('click')
    await flushPromises()

    expect(mockBackInShell).toHaveBeenCalledTimes(1)
    expect(mockPush, '已在壳内不重复导航').not.toHaveBeenCalled()
    expect(mockRouterBack).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('should_disableBack_when_shellHasNothingToGoBackTo', () => {
    // 主屏且无覆盖层 = 没有可退的东西：保留占位（胶囊宽度不跳）但置灰
    const { wrapper } = mountNav()

    expect(
      wrapper.find('button[aria-label="shell.floatingNav.back"]').attributes('disabled'),
    ).toBeDefined()
    wrapper.unmount()
  })

  it('should_goBackInHistory_when_backTappedOnLegacyRoute', async () => {
    route.name = 'mobile-settings-about'
    stubHistoryBack('/mobile/shell')
    const { wrapper } = mountNav()

    await wrapper.find('button[aria-label="shell.floatingNav.back"]').trigger('click')
    await flushPromises()

    // 「有整页历史」交给共用实现判定（router.back）；壳内返回序列不得插手
    expect(mockLeaveStandalone).toHaveBeenCalledTimes(1)
    expect(mockLeaveStandalone.mock.calls[0][1]).toBe(true)
    expect(mockBackInShell).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('should_fallBackToShellEntry_when_legacyRouteHasNoHistoryToGoBackTo', async () => {
    // 直接深链进旧二级页：没有可回退的整页历史（交给共用实现 replace 回壳入口）
    route.name = 'mobile-settings-appearance'
    stubHistoryBack(null)
    const { wrapper } = mountNav()

    await wrapper.find('button[aria-label="shell.floatingNav.back"]').trigger('click')
    await flushPromises()

    expect(mockLeaveStandalone).toHaveBeenCalledTimes(1)
    expect(mockLeaveStandalone.mock.calls[0][1]).toBe(false)
    expect(mockBackInShell).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('should_goHomeAndEnterShell_when_homeTappedFromLegacyRoute', async () => {
    route.name = 'mobile-settings-about'
    const { wrapper } = mountNav()

    await wrapper.find('button[aria-label="shell.floatingNav.home"]').trigger('click')
    await flushPromises()

    expect(mockGoHome).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith({ name: 'mobile-shell' })
    wrapper.unmount()
  })

  it('should_openSwitcherAndEnterShell_when_recentsTappedFromLegacyRoute', async () => {
    route.name = 'mobile-settings-appearance'
    const { wrapper } = mountNav()

    await wrapper.find('button[aria-label="shell.floatingNav.recents"]').trigger('click')
    await flushPromises()

    expect(mockOpenSwitcher).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith({ name: 'mobile-shell' })
    wrapper.unmount()
  })

  it('should_notPushAgain_when_alreadyOnShellRoute', async () => {
    const { wrapper } = mountNav()

    await wrapper.find('button[aria-label="shell.floatingNav.home"]').trigger('click')
    await flushPromises()

    expect(mockGoHome).toHaveBeenCalledTimes(1)
    expect(mockPush).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('C-F5..C-F6 拖动', () => {
  it('should_persistNormalizedPosition_when_dragged', async () => {
    const { wrapper, el } = mountNav()
    const bar = wrapper.find('[data-testid="shell-floating-nav"]')
    const { minX, maxX, minY, maxY } = bounds()
    // 初始比例 (0.5, 1)：像素位置在底部居中
    const start = {
      x: minX + 0.5 * (maxX - minX),
      y: minY + 1 * (maxY - minY),
    }

    await bar.trigger('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      button: 0,
      clientX: start.x,
      clientY: start.y,
    })
    // 先越过阈值（避免把点击判成拖拽），再落目标位移
    await bar.trigger('pointermove', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: start.x - 10,
      clientY: start.y - 10,
    })
    await bar.trigger('pointermove', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: start.x - 50,
      clientY: start.y - 134,
    })
    await bar.trigger('pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: start.x - 50,
      clientY: start.y - 134,
    })

    expect(mockSetFloatingNavPos, '抬手才写偏好').toHaveBeenCalledTimes(1)
    const pos = mockSetFloatingNavPos.mock.calls[0][0] as { x: number; y: number }
    expect(pos.x).toBeCloseTo((start.x - 50 - minX) / (maxX - minX), 3)
    expect(pos.y).toBeCloseTo((start.y - 134 - minY) / (maxY - minY), 3)
    expect(el.className).not.toContain('is-dragging')
    wrapper.unmount()
  })

  it('should_swallowClickAfterDrag_when_dragStartedOnButton', async () => {
    const { wrapper } = mountNav()
    const bar = wrapper.find('[data-testid="shell-floating-nav"]')
    const home = wrapper.find('button[aria-label="shell.floatingNav.home"]')

    await home.trigger('pointerdown', {
      pointerId: 2,
      pointerType: 'touch',
      button: 0,
      clientX: 100,
      clientY: 700,
    })
    await bar.trigger('pointermove', {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 100,
      clientY: 650,
    })
    await bar.trigger('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 100, clientY: 650 })
    // 拖拽抬手后浏览器补发的那次 click：吞没分支（stopPropagation + preventDefault）
    // 在捕获阶段执行。断言 preventDefault 而不是 spy 未被调——happy-dom 13.10.1 的捕获期
    // stopPropagation 不生效（事件仍会抵达目标节点），真实浏览器中按钮不会触发；
    // 口径与桌面 shellFloatingNav.test.ts 同构用例一致，happy-dom 升级后一并恢复 spy 口径。
    let prevented = false
    bar.element.addEventListener(
      'click',
      (e) => {
        prevented = e.defaultPrevented
      },
      true,
    )
    await home.trigger('click')

    expect(prevented, '拖拽余波 click 在捕获阶段被吞没（preventDefault）').toBe(true)
    wrapper.unmount()
  })

  it('should_keepClickWorking_when_movementWithinThreshold', async () => {
    const { wrapper } = mountNav()
    const bar = wrapper.find('[data-testid="shell-floating-nav"]')
    const home = wrapper.find('button[aria-label="shell.floatingNav.home"]')

    await bar.trigger('pointerdown', {
      pointerId: 3,
      pointerType: 'touch',
      button: 0,
      clientX: 200,
      clientY: 700,
    })
    await bar.trigger('pointermove', {
      pointerId: 3,
      pointerType: 'touch',
      clientX: 202,
      clientY: 701,
    })
    await bar.trigger('pointerup', { pointerId: 3, pointerType: 'touch', clientX: 202, clientY: 701 })
    await home.trigger('click')

    expect(mockSetFloatingNavPos, '未过阈值不算拖拽').not.toHaveBeenCalled()
    expect(mockGoHome).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

describe('C-F8 文案双语在场', () => {
  it('should_resolveFloatingNavKeysInBothLocales', () => {
    // i18n 双语纪律：新增 key 必须两侧同步，缺一边即不可交付
    for (const [locale, tree] of [
      ['zh-CN', (zhShell as any).shell],
      ['en', (enShell as any).shell],
    ] as const) {
      for (const key of ['back', 'home', 'recents', 'move']) {
        expect(typeof tree.floatingNav?.[key], `${locale} 缺 shell.floatingNav.${key}`).toBe(
          'string',
        )
        expect(String(tree.floatingNav[key]).length).toBeGreaterThan(0)
      }
      for (const key of ['navigation', 'floatingNavLabel', 'floatingNavHint']) {
        expect(typeof tree.settings?.[key], `${locale} 缺 shell.settings.${key}`).toBe('string')
        expect(String(tree.settings[key]).length).toBeGreaterThan(0)
      }
    }
  })
})

describe('C-F7 键盘替代路径', () => {
  it('should_moveAndPersist_when_arrowKeyPressed', async () => {
    const { wrapper } = mountNav()
    const bar = wrapper.find('[data-testid="shell-floating-nav"]')
    const { minX, maxX } = bounds()
    const startX = minX + 0.5 * (maxX - minX)

    await bar.trigger('keydown', { key: 'ArrowLeft' })

    expect(mockSetFloatingNavPos).toHaveBeenCalledTimes(1)
    const pos = mockSetFloatingNavPos.mock.calls[0][0] as { x: number; y: number }
    expect(pos.x).toBeCloseTo((startX - 8 - minX) / (maxX - minX), 3)
    expect(pos.y, '纵向未动，仍停在底部').toBeCloseTo(1, 3)
    wrapper.unmount()
  })
})

describe('C-F9 挂载点（App 根）', () => {
  it('should_mountAtAppRoot_when_featureWired', () => {
    // 「任意页面可见」是装配事实：挂在壳根（ShellHost）会漏掉整页路由与应用运行面。
    // App 根是唯一与所有页面同层的落点，这里把它钉住，防止后续重构悄悄挪走。
    const appVue = readFileSync(join(process.cwd(), 'src/App.vue'), 'utf8')
    expect(appVue).toContain(
      "import ShellFloatingNav from '@/shell/components/ShellFloatingNav.vue'",
    )
    expect(appVue).toMatch(/<ShellFloatingNav\s*\/>/)
  })
})
