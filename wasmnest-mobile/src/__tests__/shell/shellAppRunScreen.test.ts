/**
 * 应用运行页（平台顶栏 + 胶囊）行为契约测试（2026-10-14 二改；2026-10-24 承载切换）
 *
 * 被测：`src/shell/components/screens/ShellAppRunScreen.vue`
 *
 * | 契约 | 来源 | 规则 | 预期 |
 * |---|---|---|---|
 * | C-R1 | 应用身份 | 顶栏左侧显示运行中应用的图标与名称 | 名称在场 + 图标 aria-label = 应用名 |
 * | C-R2 | 胶囊菜单 | 菜单键开覆盖层（平台项与应用项在同一张卡里） | overlays.openCapsule(appId) |
 * | C-R3 | 胶囊多任务 | 多任务键进叠放屏（底部系统条退役后的入口） | nav.openSwitcher |
 * | C-R4 | 胶囊回主屏 | home 图标（不是「退出应用」语义）回主屏 | nav.goHome |
 * | C-R5 | 运行面承载 | 运行面由适配器（ShellAppSurface → 注册表）装载 | 适配器在场 + 登记 opened，本屏不直接渲染 surface（插槽级断言在 shellAppSurface.test.ts） |
 * | C-R6 | 无底部导航条 | 平台导航条已退役，本屏不渲染系统条 | 页面无 shell-system-bar |
 * | C-R7 | 清单未落地不出空态 | 壳重挂载后清单要等 refresh，这段窗口 apps 为空 | 标题留空，**不**显示 notFound |
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import type { ShellApp } from '@/shell/types'

const mockOpenCapsule = vi.fn()
const mockOpenSwitcher = vi.fn()
const mockGoHome = vi.fn()
/** 运行屏只做打开登记（运行面承载在适配器，插槽断言见 shellAppSurface.test.ts） */
const mockMarkSurfaceOpened = vi.fn()
const mockSetSurfaceOutlet = vi.fn()
const mockReleaseSurfaceOutlet = vi.fn()
const params = ref<Record<string, string>>({ appId: 'a' })

const apps = ref<ShellApp[]>([])
/** 清单是否已拉完（useShellApps.listReady 替身） */
const listReady = ref(true)

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    getApp: (id: string) => apps.value.find((a) => a.id === id),
    listReady,
  }),
}))
vi.mock('@/shell/composables/useShellNavigation', () => ({
  useShellNavigation: () => ({
    params: computed(() => params.value),
    openSwitcher: mockOpenSwitcher,
    goHome: mockGoHome,
  }),
}))
vi.mock('@/shell/composables/useShellOverlays', () => ({
  useShellOverlays: () => ({ openCapsule: mockOpenCapsule }),
}))
// 运行面适配器（桩掉渲染）经 surfaceRuntime 引共享运行时；测试面用轻桩，
// 真实共享行为由 #33 的契约锁负责
vi.mock('@/locales', () => ({ default: { install: () => {} } }))
vi.mock('@/router', () => ({ default: { install: () => {} } }))
// 工厂里必须包一层闭包：vi.mock 提升到导入之前，直接引用 mock 变量会
// 「Cannot access before initialization」（与上面几个 mock 同一写法）。
// setSurfaceOutlet / releaseSurfaceOutlet 由运行面适配器（本测试内被桩掉）
// 消费——模块加载仍会取这两个导出，必须一并给出。
vi.mock('@/shell/composables/useAppSurfaces', () => ({
  markSurfaceOpened: (...args: unknown[]) => mockMarkSurfaceOpened(...args),
  setSurfaceOutlet: (...args: unknown[]) => mockSetSurfaceOutlet(...args),
  releaseSurfaceOutlet: (...args: unknown[]) => mockReleaseSurfaceOutlet(...args),
}))

import ShellAppRunScreen from '@/shell/components/screens/ShellAppRunScreen.vue'

/** 适配器桩：保留插槽锚点，隔离注册表装配面（其行为由 shellAppSurface.test.ts 直测） */
const SurfaceAdapterStub = {
  name: 'ShellAppSurface',
  props: ['appId'],
  template: '<div data-testid="app-surface-outlet" />',
}

function mountScreen() {
  return mount(ShellAppRunScreen, { global: { stubs: { ShellAppSurface: SurfaceAdapterStub } } })
}

function app(id: string, name: string): ShellApp {
  return {
    id,
    name,
    version: '1.0.0',
    state: 'running',
    permissions: [],
    contributions: {},
  }
}

beforeEach(() => {
  params.value = { appId: 'a' }
  apps.value = [app('a', 'AppA')]
  listReady.value = true
  mockOpenCapsule.mockClear()
  mockOpenSwitcher.mockClear()
  mockGoHome.mockClear()
  mockMarkSurfaceOpened.mockClear()
  mockSetSurfaceOutlet.mockClear()
  mockReleaseSurfaceOutlet.mockClear()
})

describe('C-R1 应用身份', () => {
  it('should_renderAppIconAndName_when_runningAppShown', () => {
    const wrapper = mountScreen()

    expect(wrapper.text()).toContain('AppA')
    expect(wrapper.find('[role="img"][aria-label="AppA"]').exists(), '应用图标应在场').toBe(true)
  })

  it('should_fallBackToNotFound_when_appMissingAfterListReady', () => {
    apps.value = []
    listReady.value = true
    const wrapper = mountScreen()

    expect(wrapper.text()).toContain('shell.run.notFound')
  })

  it('should_notShowNotFound_when_appMissingButListStillLoading', () => {
    // 回归（2026-10-16 用户反馈：从插件设置页返回闪「应用不存在」）：
    // 清单未落地（壳先渲染、清单后到的窗口）时不得判空——「还没拉」不是「不存在」
    apps.value = []
    listReady.value = false
    const wrapper = mountScreen()

    expect(wrapper.text()).not.toContain('shell.run.notFound')
  })
})

describe('C-R2..C-R4 胶囊（菜单 / 多任务 / 回主屏）', () => {
  it('should_openCapsuleMenu_when_menuTapped', async () => {
    const wrapper = mountScreen()

    await wrapper.find('button[aria-label="shell.run.menu"]').trigger('click')

    expect(mockOpenCapsule).toHaveBeenCalledWith('a')
  })

  it('should_openSwitcher_when_recentsTapped', async () => {
    const wrapper = mountScreen()

    await wrapper.find('button[aria-label="shell.run.recents"]').trigger('click')

    expect(mockOpenSwitcher).toHaveBeenCalledTimes(1)
  })

  it('should_goHome_when_homeTapped', async () => {
    const wrapper = mountScreen()

    await wrapper.find('button[aria-label="shell.run.home"]').trigger('click')

    expect(mockGoHome).toHaveBeenCalledTimes(1)
  })

  it('should_notExposeExitAppSemantics_when_capsuleRendered', () => {
    // 「退出应用」措辞已退役：本屏只回主屏，不停应用（停止在胶囊菜单里显式给出）
    expect(mountScreen().text()).not.toContain('shell.run.exitApp')
  })
})

describe('C-R5 运行面承载（适配器在场 + 打开登记）', () => {
  it('should_mountSurfaceAdapter_when_rendered', () => {
    const wrapper = mountScreen()

    expect(
      wrapper.find('[data-testid="app-surface-outlet"]').exists(),
      '适配器（及其插槽）在场',
    ).toBe(true)
  })

  it('should_notRenderSurfaceDirectly_when_rendered', () => {
    // 运行屏直接渲染 surface = 切走即卸载，保活失效（承载已切注册表）
    const wrapper = mountScreen()

    expect(wrapper.find('.surface').exists()).toBe(false)
  })

  it('should_markOpened_when_mounted', () => {
    mountScreen()

    expect(mockMarkSurfaceOpened, '打开过运行面的应用才进保活').toHaveBeenCalledWith('a')
  })
})

describe('C-R6 无底部导航条', () => {
  it('should_notRenderBottomSystemBar_when_rendered', () => {
    // 底部系统条整条退役：本屏不再有常驻导航条，导航只在胶囊里
    const wrapper = mountScreen()

    expect(wrapper.find('.shell-system-bar').exists()).toBe(false)
  })
})
