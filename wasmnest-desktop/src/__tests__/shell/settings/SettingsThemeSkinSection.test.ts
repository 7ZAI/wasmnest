import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Ref } from 'vue'
import type { ShellUiPrefs } from '@/shell/types'

/**
 * 设置页平台扩展面之一：主题皮肤。
 *
 * 默认 + 注册皮肤渲染成可选卡，点击写壳偏好。
 * （扩展设置项不再有独立分组——别的应用贡献的动态设置项渲染在
 * 「系统设置」卡内，见 SettingsSystemSection.test.ts。）
 */

const mocks = vi.hoisted(() => ({
  prefs: null as unknown as Ref<ShellUiPrefs>,
  isDark: null as unknown as Ref<boolean>,
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

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import SettingsThemeSkinSection from '@/shell/settings/SettingsThemeSkinSection.vue'
import { clearShellExtensions, registerThemeSkin } from '@/shell/extensions'

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
