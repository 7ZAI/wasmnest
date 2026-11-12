/**
 * 快捷设置面板磁贴行为契约（桌面）
 *
 * 被测：`src/shell/components/ShellQuickSettings.vue`
 *
 * | 契约 | 来源 | 规则 | 预期 |
 * |---|---|---|---|
 * | Q-1 | 悬浮导航磁贴（2026-11-07 用户要求上提到快捷面） | 开 / 关两态都可点 | on 类与 aria-pressed 跟随 |
 * | Q-2 | 同一真源 | 磁贴直写壳偏好 floatingNav（不另设副本） | prefs.floatingNav 翻转 |
 * | Q-3 | 即时生效 | ref 是响应式真源，ShellFloatingNav 立刻读 | 写后立即可见 |
 * | Q-4 | 主题磁贴仍走 settings store | 不因新增磁贴改道 | saveSettings 收到 ui 组 |
 * | Q-5 | 关闭面板 | 面板头按钮收面 | quickSettingsOpen 置 false |
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

const prefs = ref<{ floatingNav?: boolean; floatingNavPos?: { x: number; y: number } }>({
  floatingNav: false,
  floatingNavPos: { x: 0.5, y: 1 },
})
const quickSettingsOpen = ref(true)
const saveSettings = vi.fn(async () => {})

const uiSettings = { theme: 'light', animations_enabled: true }
const networkSettings = { prevent_sleep: false }
const settings = { ui: uiSettings, network: networkSettings }

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ settings, saveSettings }),
}))
vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isSystemDark: ref(false) }),
}))
vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({ quickSettingsOpen }),
}))
vi.mock('@/shell/composables/useShellSettings', () => ({
  useShellSettings: () => ({ prefs }),
}))

import ShellQuickSettings from '@/shell/components/ShellQuickSettings.vue'

/** 按 aria-pressed 找磁贴：顺序 = 主题 / 动画 / 防休眠 / 悬浮导航 */
function tileAt(wrapper: ReturnType<typeof mount>, index: number) {
  return wrapper.findAll('button.tile')[index]
}

beforeEach(() => {
  prefs.value = { floatingNav: false, floatingNavPos: { x: 0.5, y: 1 } }
  quickSettingsOpen.value = true
  settings.ui.theme = 'light'
  settings.ui.animations_enabled = true
  settings.network.prevent_sleep = false
  saveSettings.mockClear()
})

describe('Q-1/Q-2 悬浮导航磁贴', () => {
  it('默认关：无 on 类、aria-pressed=false', () => {
    const wrapper = mount(ShellQuickSettings)
    const nav = tileAt(wrapper, 3)
    expect(nav.classes()).not.toContain('on')
    expect(nav.attributes('aria-pressed')).toBe('false')
  })

  it('点击后直写壳偏好 floatingNav=true（on 类与 aria-pressed 跟随）', async () => {
    const wrapper = mount(ShellQuickSettings)
    await tileAt(wrapper, 3).trigger('click')
    expect(prefs.value.floatingNav).toBe(true)
    expect(tileAt(wrapper, 3).classes()).toContain('on')
    expect(tileAt(wrapper, 3).attributes('aria-pressed')).toBe('true')
    // 壳偏好不经 settings store（写穿在 useShellSettings 的 watch 里）
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('偏好已是开：再点置 false（不新增字段副本）', async () => {
    prefs.value = { ...prefs.value, floatingNav: true }
    const wrapper = mount(ShellQuickSettings)
    await tileAt(wrapper, 3).trigger('click')
    expect(prefs.value.floatingNav).toBe(false)
    expect(Object.keys(prefs.value).sort()).toEqual(['floatingNav', 'floatingNavPos'])
  })
})

describe('Q-4/Q-5 既有磁贴与收面不受影响', () => {
  it('主题磁贴仍回传 ui 分组', async () => {
    const wrapper = mount(ShellQuickSettings)
    await tileAt(wrapper, 0).trigger('click')
    expect(settings.ui.theme).toBe('dark')
    expect(saveSettings).toHaveBeenCalledWith({ ui: settings.ui })
  })

  it('关闭按钮把 quickSettingsOpen 置 false', async () => {
    const wrapper = mount(ShellQuickSettings)
    await wrapper.find('.panel-h button').trigger('click')
    expect(quickSettingsOpen.value).toBe(false)
  })
})
