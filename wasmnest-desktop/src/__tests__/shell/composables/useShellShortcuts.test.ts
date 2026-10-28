/**
 * 壳快捷键装配层行为测试（dispatch KeyboardEvent 驱动，typeToSearch 范式）
 *
 * 断言三件事：守卫链（总闸 / IME 让位）、抢占边界（命中才拦截，未注册组合
 * defaultPrevented 保持 false）、动作分发（全部落在 mock 的壳原语上）。
 * 决策逻辑的穷举在 shortcutsModel.test.ts（纯函数直测），这里只测装配语义。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'

const mocks = vi.hoisted(() => ({
  prefs: null as unknown as Ref<Record<string, unknown>>,
  state: null as unknown as Record<string, unknown>,
  settingsStore: null as unknown as Record<string, unknown>,
  setupFontSize: vi.fn(),
}))

vi.mock('@/shell/composables/useShellSettings', async () => {
  const { ref } = await import('vue')
  return {
    useShellSettings: vi.fn(() => {
      if (!mocks.prefs) {
        mocks.prefs = ref({ wallpaper: 'aurora', wallDim: 30, wallpaperImage: '', theme: 'default' })
      }
      return { prefs: mocks.prefs }
    }),
  }
})

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: vi.fn(() => mocks.state),
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: vi.fn(() => mocks.settingsStore),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: vi.fn(() => ({ isDark: ref(false) })),
}))

vi.mock('@/composables/useFontSize', async (importOriginal) => {
  // FONT_SIZE_LEVELS / fontSizeLevelIndex / NORMAL_FONT_SIZE 走真实导出——
  // 桩只为隔离 setupFontSize 的 DOM 副作用
  const actual = await importOriginal<typeof import('@/composables/useFontSize')>()
  return { ...actual, useFontSize: () => ({ setupFontSize: mocks.setupFontSize }) }
})

import { useShellShortcuts } from '@/shell/composables/useShellShortcuts'

/** 派发 keydown 并返回「是否被壳拦截」（cancelable 才能观察 preventDefault） */
function press(init: KeyboardEventInit): boolean {
  const e = new KeyboardEvent('keydown', { cancelable: true, ...init })
  window.dispatchEvent(e)
  return e.defaultPrevented
}

function freshState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cards: ref(['app:hub', 'app:chat', 'sys:settings']),
    activeCard: ref(null),
    recentsOpen: ref(false),
    activateCard: vi.fn(),
    toggleRecents: vi.fn(),
    goHome: vi.fn(),
    openSys: vi.fn(),
    ...overrides,
  }
}

let teardown: (() => void) | null = null

beforeEach(() => {
  mocks.state = freshState()
  mocks.settingsStore = {
    settings: { ui: { theme: 'light', font_size: 12 } },
    saveSettings: vi.fn(),
  }
  mocks.prefs = ref({ wallpaper: 'aurora', wallDim: 30, wallpaperImage: '', theme: 'default' })
  teardown = useShellShortcuts().setupShellShortcuts({ enabled: () => true })
})

afterEach(() => {
  teardown?.()
  teardown = null
})

describe('capture 抢占语义', () => {
  it('命中默认绑定：拦截事件（preventDefault）并执行动作', () => {
    expect(press({ code: 'Tab', ctrlKey: true })).toBe(true)
    // 当前不在应用卡上（主屏）：向后 = MRU 第一张
    expect(mocks.state.activateCard).toHaveBeenCalledWith('app:hub')
  })

  it('未注册组合：完全放行（不拦截、不动作）——壳不抢应用按键', () => {
    expect(press({ code: 'KeyX', ctrlKey: true })).toBe(false)
    expect(mocks.state.activateCard).not.toHaveBeenCalled()
    expect(mocks.state.goHome).not.toHaveBeenCalled()
  })

  it('应用内单键完全放行（注册的都是含修饰键组合）', () => {
    expect(press({ code: 'KeyD' })).toBe(false)
  })

  it('总闸关闭（splash 期）：不拦截不动作', () => {
    teardown?.()
    teardown = useShellShortcuts().setupShellShortcuts({ enabled: () => false })
    expect(press({ code: 'Tab', ctrlKey: true })).toBe(false)
    expect(mocks.state.activateCard).not.toHaveBeenCalled()
  })

  it('IME 合成期让位（isComposing）', () => {
    expect(press({ code: 'Tab', ctrlKey: true, isComposing: true })).toBe(false)
    expect(mocks.state.activateCard).not.toHaveBeenCalled()
  })

  it('teardown 后监听移除', () => {
    teardown?.()
    teardown = null
    expect(press({ code: 'Tab', ctrlKey: true })).toBe(false)
    expect(mocks.state.activateCard).not.toHaveBeenCalled()
  })
})

describe('动作分发', () => {
  it('切换应用：多任务层开着先收再切', () => {
    mocks.state = freshState({ activeCard: ref('app:hub'), recentsOpen: ref(true) })
    press({ code: 'Tab', ctrlKey: true })
    expect(mocks.state.toggleRecents).toHaveBeenCalledWith(false)
    expect(mocks.state.activateCard).toHaveBeenCalledWith('app:chat')
  })

  it('上一个应用：当前不在应用卡上时取 MRU 最后一张', () => {
    press({ code: 'Tab', ctrlKey: true, shiftKey: true })
    expect(mocks.state.activateCard).toHaveBeenCalledWith('app:chat')
  })

  it('多任务开关 / 回主屏 / 设置 / 应用管理', () => {
    press({ code: 'KeyO', ctrlKey: true, shiftKey: true })
    expect(mocks.state.toggleRecents).toHaveBeenCalledWith()
    press({ code: 'KeyH', ctrlKey: true, shiftKey: true })
    expect(mocks.state.goHome).toHaveBeenCalled()
    press({ code: 'Comma', ctrlKey: true })
    expect(mocks.state.openSys).toHaveBeenCalledWith('settings')
    press({ code: 'KeyM', ctrlKey: true, shiftKey: true })
    expect(mocks.state.openSys).toHaveBeenCalledWith('apps')
  })

  it('深浅色：isDark=false 时置 dark 并落盘（ShellToolbar 同款）', () => {
    press({ code: 'KeyD', ctrlKey: true, shiftKey: true })
    expect(mocks.settingsStore.settings.ui.theme).toBe('dark')
    expect(mocks.settingsStore.saveSettings).toHaveBeenCalledWith({
      ui: mocks.settingsStore.settings.ui,
    })
  })

  it('字号档位：12 → 增大 14 / 减小 11；到头 no-op', () => {
    press({ code: 'Equal', ctrlKey: true, shiftKey: true })
    expect(mocks.settingsStore.settings.ui.font_size).toBe(14)
    expect(mocks.setupFontSize).toHaveBeenCalled()
    press({ code: 'Minus', ctrlKey: true, shiftKey: true })
    expect(mocks.settingsStore.settings.ui.font_size).toBe(12)

    mocks.settingsStore.settings.ui.font_size = 16 // 顶级再增大 = no-op
    press({ code: 'Equal', ctrlKey: true, shiftKey: true })
    expect(mocks.settingsStore.settings.ui.font_size).toBe(16)
  })
})

describe('绑定覆盖（sparse 壳偏好）', () => {
  it('覆盖后旧组合放行、新组合生效', () => {
    mocks.prefs.value = { ...mocks.prefs.value, shortcuts: { home: 'Alt+H' } }
    expect(press({ code: 'KeyH', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(press({ code: 'KeyH', altKey: true })).toBe(true)
    expect(mocks.state.goHome).toHaveBeenCalledTimes(1)
  })

  it("清空（''）= 组合归还应用", () => {
    mocks.prefs.value = { ...mocks.prefs.value, shortcuts: { 'theme.toggle': '' } }
    expect(press({ code: 'KeyD', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(mocks.settingsStore.saveSettings).not.toHaveBeenCalled()
  })
})
