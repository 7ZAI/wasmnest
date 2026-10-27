/**
 * 悬浮导航行为契约测试（桌面版，与移动端 shellFloatingNav.test.ts 同构）
 *
 * 被测：`src/shell/components/ShellFloatingNav.vue`
 *
 * | 契约 | 来源 | 规则 | 预期 |
 * |---|---|---|---|
 * | C-F1 | 开关 | 默认关闭；关闭时不渲染 | DOM 无悬浮条 |
 * | C-F2 | 回主屏 | 点 home = state.goHome（清覆层 + 路由回 '/'） | goHome 被调 |
 * | C-F3 | 多任务 | 点多任务 = state.toggleRecents（开 ShellTaskSwitcher） | toggleRecents 被调 |
 * | C-F4 | 拖动 | 越过阈值才判拖拽；抬手落归一化位置 | floatingNavPos 在 [0,1] |
 * | C-F5 | 拖拽余波 | 拖动抬手补的 click 在捕获阶段被吞没 | preventDefault 为真 |
 * | C-F6 | 键盘替代 | 拖动面聚焦后方向键移动并持久化（WCAG 2.2） | 位置左移 + 落偏好 |
 * | C-F7 | 底部让位 | bottomReserve（状态栏条带）计入可移动范围 | 最底只到状态栏上缘 |
 * | C-F8 | 可读名 | 两个按钮与拖动面都有 aria-label | 定位即断言 |
 * | C-F9 | 挂载点 | 挂 ShellHost、bareWindow 不渲染 | 源码装配锁 |
 * | C-F10 | 双语 | floatingNav 与 settings.nav key 两侧同步 | 读两份语言表 |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ref, nextTick } from 'vue'

const mockGoHome = vi.fn()
const mockToggleRecents = vi.fn()

const prefs = ref<{
  floatingNav?: boolean
  floatingNavPos?: { x: number; y: number }
}>({ floatingNav: true, floatingNavPos: { x: 0.5, y: 1 } })

vi.mock('vue-i18n', async (importOriginal) => {
  // 部分 mock：组件引入链（ShellIcon → themePresets / logger）会拉到 '@/i18n' 的
  // createI18n，整包 mock 会在收集期炸掉；只替换 useI18n 的文案解析
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})
vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({ goHome: mockGoHome, toggleRecents: mockToggleRecents }),
}))
vi.mock('@/shell/composables/useShellSettings', () => ({
  useShellSettings: () => ({ prefs }),
}))

import ShellFloatingNav from '@/shell/components/ShellFloatingNav.vue'
import hostZhCN from '@/i18n/host-zh-CN'
import hostEn from '@/i18n/host-en'

/** 测试视口与悬浮条尺寸：位置换算依赖实测尺寸，happy-dom 默认给 0 */
const VIEWPORT = { width: 1280, height: 800 }
/** 与 shell.css 的胶囊尺寸同口径：5×2 padding + 42×2 按钮 + 10×2 间距 + 1 分隔线 */
const NAV_SIZE = { width: 115, height: 44 }
const EDGE_MARGIN = 12
/** 状态栏条带（ShellHost 的 floatNavBottomReserve，与 .shell-statusbar 高度同口径） */
const STATUSBAR_H = 26

function mountNav(bottomReserve = 0) {
  const wrapper = mount(ShellFloatingNav, {
    attachTo: document.body,
    props: { bottomReserve },
  })
  const el = wrapper.find('[data-testid="shell-floating-nav"]').element as HTMLElement
  // 实测尺寸在挂载后补：先给实例装尺寸，再触发一次 resize 让组件重新量
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: NAV_SIZE.width })
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: NAV_SIZE.height })
  window.dispatchEvent(new Event('resize'))
  return { wrapper, el }
}

/** 位置换算的上下界（与组件同一口径：四边 EDGE_MARGIN，底部再让 reserve） */
function bounds(bottomReserve = 0) {
  return {
    minX: EDGE_MARGIN,
    maxX: VIEWPORT.width - NAV_SIZE.width - EDGE_MARGIN,
    minY: EDGE_MARGIN,
    maxY: VIEWPORT.height - NAV_SIZE.height - EDGE_MARGIN - bottomReserve,
  }
}

beforeEach(() => {
  mockGoHome.mockClear()
  mockToggleRecents.mockClear()
  prefs.value = { floatingNav: true, floatingNavPos: { x: 0.5, y: 1 } }
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height })
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('C-F1 开关与渲染', () => {
  it('should_notRender_when_floatingNavDisabled', () => {
    prefs.value = { ...prefs.value, floatingNav: false }
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
    expect(wrapper.find('button[aria-label="shell.floatingNav.home"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="shell.floatingNav.recents"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('C-F2..C-F3 导航动作', () => {
  it('should_callGoHome_when_homeClicked', async () => {
    const { wrapper } = mountNav()

    await wrapper.find('button[aria-label="shell.floatingNav.home"]').trigger('click')

    expect(mockGoHome).toHaveBeenCalledTimes(1)
    expect(mockToggleRecents).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('should_toggleRecents_when_recentsClicked', async () => {
    const { wrapper } = mountNav()

    await wrapper.find('button[aria-label="shell.floatingNav.recents"]').trigger('click')

    expect(mockToggleRecents).toHaveBeenCalledTimes(1)
    expect(mockGoHome).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('C-F4..C-F5 拖动', () => {
  it('should_persistNormalizedPosition_when_dragged', async () => {
    const { wrapper } = mountNav()
    const bar = wrapper.find('[data-testid="shell-floating-nav"]')
    const { minX, maxX, minY, maxY } = bounds()
    // 初始比例 (0.5, 1)：像素位置在底部居中
    const start = {
      x: minX + 0.5 * (maxX - minX),
      y: minY + 1 * (maxY - minY),
    }

    await bar.trigger('pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: start.x,
      clientY: start.y,
    })
    // 先越过阈值（避免把点击判成拖拽），再落目标位移
    await bar.trigger('pointermove', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: start.x - 10,
      clientY: start.y - 10,
    })
    await bar.trigger('pointermove', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: start.x - 52,
      clientY: start.y - 134,
    })
    await bar.trigger('pointerup', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: start.x - 52,
      clientY: start.y - 134,
    })

    const pos = prefs.value.floatingNavPos as { x: number; y: number }
    expect(pos.x, '抬手才写偏好，且是归一化比例').toBeCloseTo(
      (start.x - 52 - minX) / (maxX - minX),
      3,
    )
    expect(pos.y).toBeCloseTo((start.y - 134 - minY) / (maxY - minY), 3)
    expect(bar.element.className, '拖拽结束退出 is-dragging').not.toContain('is-dragging')
    wrapper.unmount()
  })

  it('should_swallowClickAfterDrag_when_dragStartedOnButton', async () => {
    const { wrapper } = mountNav()
    const bar = wrapper.find('[data-testid="shell-floating-nav"]')
    const home = wrapper.find('button[aria-label="shell.floatingNav.home"]')

    await home.trigger('pointerdown', {
      pointerId: 2,
      pointerType: 'mouse',
      button: 0,
      clientX: 600,
      clientY: 700,
    })
    await bar.trigger('pointermove', {
      pointerId: 2,
      pointerType: 'mouse',
      clientX: 600,
      clientY: 650,
    })
    await bar.trigger('pointerup', { pointerId: 2, pointerType: 'mouse', clientX: 600, clientY: 650 })

    // 拖拽抬手后浏览器补发的那次 click：吞没分支（stopPropagation + preventDefault）
    // 必须在捕获阶段执行。断言 preventDefault 而不是 spy 未被调——happy-dom 13.10.1
    // 的捕获期 stopPropagation 不生效（事件仍会抵达目标节点；移动端同构用例
    // shellFloatingNav.test.ts 同点红），真实浏览器中 stopPropagation 生效、按钮不会
    // 触发；happy-dom 升级后两端的 spy 口径可一并恢复。
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
      pointerType: 'mouse',
      button: 0,
      clientX: 600,
      clientY: 700,
    })
    await bar.trigger('pointermove', {
      pointerId: 3,
      pointerType: 'mouse',
      clientX: 602,
      clientY: 701,
    })
    await bar.trigger('pointerup', { pointerId: 3, pointerType: 'mouse', clientX: 602, clientY: 701 })
    await home.trigger('click')

    expect(prefs.value.floatingNavPos, '未过阈值不算拖拽，位置不落盘').toEqual({ x: 0.5, y: 1 })
    expect(mockGoHome).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

describe('C-F6 键盘替代路径', () => {
  it('should_moveAndPersist_when_arrowKeyPressed', async () => {
    const { wrapper } = mountNav()
    const bar = wrapper.find('[data-testid="shell-floating-nav"]')
    const { minX, maxX } = bounds()
    const startX = minX + 0.5 * (maxX - minX)

    await bar.trigger('keydown', { key: 'ArrowLeft' })

    const pos = prefs.value.floatingNavPos as { x: number; y: number }
    expect(pos.x).toBeCloseTo((startX - 8 - minX) / (maxX - minX), 3)
    expect(pos.y, '纵向未动，仍停在底部').toBeCloseTo(1, 3)
    wrapper.unmount()
  })
})

describe('C-F7 底部让位（状态栏条带）', () => {
  it('should_stopAboveStatusBar_when_bottomReserveGiven', async () => {
    const { wrapper } = mountNav(STATUSBAR_H)
    // resize 后的像素重算要等一次渲染 flush 才落到 :style
    await nextTick()
    const bar = wrapper.find('[data-testid="shell-floating-nav"]')

    // 默认比例 (0.5, 1)：像素落位在状态栏上缘，而不是窗口底缘
    const style = bar.attributes('style') ?? ''
    expect(style).toContain(`${VIEWPORT.height - NAV_SIZE.height - EDGE_MARGIN - STATUSBAR_H}px`)

    // 拖到「最底」：比例到 1，像素仍钉在状态栏上缘
    const { minX, maxX, minY, maxY } = bounds(STATUSBAR_H)
    const start = { x: minX + 0.5 * (maxX - minX), y: minY + (maxY - minY) }
    await bar.trigger('pointerdown', {
      pointerId: 4,
      pointerType: 'mouse',
      button: 0,
      clientX: start.x,
      clientY: start.y,
    })
    await bar.trigger('pointermove', {
      pointerId: 4,
      pointerType: 'mouse',
      clientX: start.x,
      clientY: VIEWPORT.height + 100,
    })
    await bar.trigger('pointerup', {
      pointerId: 4,
      pointerType: 'mouse',
      clientX: start.x,
      clientY: VIEWPORT.height + 100,
    })

    expect(prefs.value.floatingNavPos?.y, '比例语义仍是 1（最底）').toBe(1)
    wrapper.unmount()
  })
})

describe('C-F10 文案双语在场', () => {
  it('should_resolveFloatingNavKeysInBothLocales', () => {
    // i18n 双语纪律：新增 key 必须两侧同步，缺一边即不可交付
    for (const [locale, tree] of [
      ['zh-CN', (hostZhCN as { shell: Record<string, unknown> }).shell],
      ['en', (hostEn as { shell: Record<string, unknown> }).shell],
    ] as const) {
      const shellTree = tree as {
        floatingNav?: Record<string, string>
        settings?: { nav?: Record<string, string> }
      }
      for (const key of ['home', 'recents', 'move']) {
        expect(typeof shellTree.floatingNav?.[key], `${locale} 缺 shell.floatingNav.${key}`).toBe(
          'string',
        )
        expect(String(shellTree.floatingNav[key]).length).toBeGreaterThan(0)
      }
      for (const key of ['title', 'label', 'hint']) {
        expect(
          typeof shellTree.settings?.nav?.[key],
          `${locale} 缺 shell.settings.nav.${key}`,
        ).toBe('string')
      }
    }
  })
})

describe('C-F9 挂载点（ShellHost 壳根）', () => {
  it('should_mountAtShellHost_when_featureWired', () => {
    // 「任意面可见」是装配事实：桌面所有路由（主屏 / 系统页 / 应用面）都渲染在
    // ShellHost 之内，壳根是唯一与所有面同层的落点；bareWindow 独立窗口不渲染
    // （窗口 chrome 归应用）。这里把装配与豁免口径一起钉住，防止重构悄悄挪走。
    const host = readFileSync(join(process.cwd(), 'src/shell/ShellHost.vue'), 'utf8')
    expect(host).toContain(
      "import ShellFloatingNav from '@/shell/components/ShellFloatingNav.vue'",
    )
    expect(host).toMatch(/<ShellFloatingNav\s+v-if="!isBareWindow"\s+:bottom-reserve=/)
  })
})
