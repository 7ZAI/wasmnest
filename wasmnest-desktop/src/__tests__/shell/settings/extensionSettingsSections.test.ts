import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Ref } from 'vue'
import type { ShellUiPrefs } from '@/shell/types'

/**
 * 设置页两个平台扩展面：
 *   - 主题皮肤：默认 + 注册皮肤渲染成可选卡，点击写壳偏好；
 *   - 扩展设置：无注册时保留可见空态；注册后按 order 渲染，有动作为按钮 / 无动作为静态行。
 */

const mocks = vi.hoisted(() => ({
  prefs: null as unknown as Ref<ShellUiPrefs>,
  isDark: null as unknown as Ref<boolean>,
  loggerError: vi.fn(),
}))

vi.mock('@/shell/composables/useShellSettings', async () => {
  const { ref } = await import('vue')
  const prefs = ref<ShellUiPrefs>({
    wallpaper: 'aurora',
    wallDim: 30,
    wallpaperImage: '',
    skin: 'default',
  })
  mocks.prefs = prefs
  return { useShellSettings: () => ({ prefs }) }
})

vi.mock('@/composables/useTheme', async () => {
  const { ref } = await import('vue')
  const isDark = ref(false)
  mocks.isDark = isDark
  return { useTheme: () => ({ isDark }) }
})

vi.mock('@/utils/frontendLogger', () => ({ logger: { error: mocks.loggerError } }))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import SettingsThemeSkinSection from '@/shell/settings/SettingsThemeSkinSection.vue'
import SettingsExtensionsSection from '@/shell/settings/SettingsExtensionsSection.vue'
import { clearShellExtensions, registerSettingsEntry, registerThemeSkin } from '@/shell/extensions'

describe('设置页 — 主题皮肤', () => {
  beforeEach(() => {
    clearShellExtensions()
    mocks.prefs.value.skin = 'default'
    mocks.isDark.value = false
  })

  it('默认皮肤 + 注册皮肤都渲染，默认选中；点击皮肤写入壳偏好', async () => {
    registerThemeSkin({
      id: 'dusk',
      label: 'Dusk',
      description: 'A dark shell',
      tokens: { '--bg-page': '#111113' },
    })

    const wrapper = mount(SettingsThemeSkinSection)
    const cards = wrapper.findAll('[data-skin-id]')
    expect(cards.map((card) => card.attributes('data-skin-id'))).toEqual(['default', 'dusk'])
    expect(cards[0].attributes('aria-pressed')).toBe('true')
    expect(cards[1].attributes('aria-pressed')).toBe('false')

    await cards[1].trigger('click')
    await nextTick()

    expect(mocks.prefs.value.skin).toBe('dusk')
    expect(wrapper.find('[data-skin-id="dusk"]').attributes('aria-pressed')).toBe('true')
  })
})

describe('设置页 — 扩展设置', () => {
  beforeEach(() => {
    clearShellExtensions()
    vi.clearAllMocks()
  })

  it('没有注册时保留可见空态（预留区域）', () => {
    const wrapper = mount(SettingsExtensionsSection)
    expect(wrapper.find('[data-testid="settings-extensions"]').text()).toContain(
      'shell.settings.extensions.empty',
    )
    expect(wrapper.findAll('[data-entry-id]')).toHaveLength(0)
  })

  it('注册项按 order 渲染；有动作是按钮，无动作是静态行', async () => {
    const select = vi.fn()
    registerSettingsEntry({ id: 'later', label: 'Later', order: 20 })
    registerSettingsEntry({
      id: 'first',
      label: 'First',
      hint: 'hint',
      order: 10,
      onSelect: select,
    })

    const wrapper = mount(SettingsExtensionsSection)
    const rows = wrapper.findAll('[data-entry-id]')
    expect(rows.map((row) => row.attributes('data-entry-id'))).toEqual(['first', 'later'])
    expect(rows[0].element.tagName).toBe('BUTTON')
    expect(rows[1].element.tagName).toBe('DIV')

    await rows[0].trigger('click')
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('扩展动作失败只进日志，不冒泡到界面', async () => {
    registerSettingsEntry({
      id: 'broken',
      label: 'Broken',
      onSelect: () => Promise.reject(new Error('boom')),
    })

    const wrapper = mount(SettingsExtensionsSection)
    await wrapper.find('[data-entry-id="broken"]').trigger('click')
    await vi.waitFor(() => expect(mocks.loggerError).toHaveBeenCalled())
    expect(mocks.loggerError.mock.calls[0][0]).toContain('broken')
  })
})
