/**
 * 标题栏窗口尺寸监听合帧锁（2026-11-08 性能审查 F4）
 *
 * 问题：`window.resize` 逐帧触发，原先每事件直接 `appWindow.isMaximized()` →
 * `plugin:window|is_maximized` IPC。拖边框缩放时高刷鼠标 ~60 次/s，持续整个手势，
 * 与 Rust 主线程争用；而最大化态只会在手势结束时变化。
 *
 * 口径：resize 事件只重置尾部定时器，静置 150ms 后查一次；`toggleMaximize` 后的
 * 短延时主动查询（走 setTimeout）不受影响。浏览器预览（appWindow 为空）仍然静默兜底。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import type { Ref } from 'vue'

const mocks = vi.hoisted(() => ({
  settings: null as unknown as { ui: { theme: string } },
  saveSettings: vi.fn(),
  isSystemDark: null as unknown as Ref<boolean>,
  shellState: null as unknown as Record<string, unknown>,
  isMaximized: vi.fn(async () => false),
  toggleMaximize: vi.fn(async () => {}),
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ settings: mocks.settings, saveSettings: mocks.saveSettings }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isSystemDark: mocks.isSystemDark }),
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => mocks.shellState,
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: mocks.isMaximized,
    toggleMaximize: mocks.toggleMaximize,
    minimize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import ShellToolbar from '@/shell/components/ShellToolbar.vue'

beforeEach(() => {
  vi.useFakeTimers()
  mocks.settings = reactive({ ui: { theme: 'dark' } })
  mocks.saveSettings = vi.fn()
  mocks.isSystemDark = ref(false)
  mocks.isMaximized = vi.fn(async () => false)
  mocks.toggleMaximize = vi.fn(async () => {})
  mocks.shellState = {
    screen: ref('home'),
    activeCard: ref(null),
    cards: ref<string[]>([]),
    recentsOpen: ref(false),
    panelOpen: ref(false),
    quickSettingsOpen: ref(false),
    dialog: ref(null),
    ctxMenu: ref(null),
    homeQ: ref(''),
    notifCountTotal: ref(0),
    notifPulse: ref(0),
    cardTitleOf: vi.fn(() => ''),
    goBack: vi.fn(),
    canGoBack: ref(false),
    goHome: vi.fn(),
    toggleRecents: vi.fn(),
    toggleQuickSettings: vi.fn(),
    openApp: vi.fn(),
    openSys: vi.fn(),
  }
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('窗口 resize → isMaximized 查询合帧', () => {
  it('拖拽期间连续 resize 只查一次（尾部 150ms），不是每事件一次 IPC', async () => {
    const wrapper = mount(ShellToolbar, { attachTo: document.body })
    // 挂载时主动查一次（最大化态初值）
    expect(mocks.isMaximized).toHaveBeenCalledTimes(1)

    // 模拟一次拖拽：60 个逐帧 resize
    for (let i = 0; i < 60; i++) window.dispatchEvent(new Event('resize'))
    await vi.advanceTimersByTimeAsync(149)
    expect(mocks.isMaximized, '静置未满不算手势结束，仍只有挂载那一次').toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.isMaximized, '手势结束后补查一次').toHaveBeenCalledTimes(2)

    // 第二次拖拽：又一批事件合帧为一次
    for (let i = 0; i < 30; i++) window.dispatchEvent(new Event('resize'))
    await vi.advanceTimersByTimeAsync(150)
    expect(mocks.isMaximized).toHaveBeenCalledTimes(3)

    wrapper.unmount()
  })

  it('卸载后解绑：resize 不再触发查询', async () => {
    const wrapper = mount(ShellToolbar, { attachTo: document.body })
    expect(mocks.isMaximized).toHaveBeenCalledTimes(1)

    // 卸载时还有在途尾部定时器：必须一并清掉
    window.dispatchEvent(new Event('resize'))
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.isMaximized).toHaveBeenCalledTimes(1)
  })
})
