import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Ref } from 'vue'
import type { ShellUiPrefs } from '@/shell/types'

/**
 * 设置页平台扩展面之一：主题。
 *
 * 内置主题 + 注册主题渲染成可选卡，点击写壳偏好。
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
    theme: 'default',
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

import SettingsThemeSection from '@/shell/settings/SettingsThemeSection.vue'
import { clearShellExtensions, registerTheme } from '@/shell/extensions'

describe('设置页 — 主题', () => {
  beforeEach(() => {
    clearShellExtensions()
    mocks.prefs.value.theme = 'default'
    mocks.isDark.value = false
  })

  it('内置四套主题 + 注册主题都渲染，默认选中；点击写入壳偏好', async () => {
    registerTheme({
      id: 'dusk',
      label: 'Dusk',
      description: 'A dark shell',
      tokens: { '--bg-page': '#111113' },
    })

    const wrapper = mount(SettingsThemeSection)
    const cards = wrapper.findAll('[data-theme-id]')
    expect(cards.map((card) => card.attributes('data-theme-id'))).toEqual([
      'default',
      'diffuse',
      'liquid',
      'hyper',
      'dusk',
    ])
    expect(cards[0].attributes('aria-pressed')).toBe('true')

    await cards[2].trigger('click')
    await nextTick()

    expect(mocks.prefs.value.theme).toBe('liquid')
    expect(wrapper.find('[data-theme-id="liquid"]').attributes('aria-pressed')).toBe('true')
  })

  it('预览块挂主题属性（默认主题不挂，靠基础档渲染）', () => {
    const wrapper = mount(SettingsThemeSection)
    const preview = (id: string) =>
      wrapper.find(`[data-theme-id="${id}"] .theme-preview`).attributes('data-theme')

    expect(preview('default')).toBeUndefined()
    expect(preview('diffuse')).toBe('diffuse')
    expect(preview('liquid')).toBe('liquid')
    expect(preview('hyper')).toBe('hyper')
  })

  it('默认主题预览挂 theme-base 类（隔离当前主题的 token），其余主题不挂', () => {
    const wrapper = mount(SettingsThemeSection)
    const classes = (id: string) =>
      wrapper.find(`[data-theme-id="${id}"] .theme-preview`).classes()

    // 默认档不复用当前主题的变量：不挂 theme-base 时，预览会继承 <html data-theme>
    // 的 token 而长成当前主题的样子（「默认」与「弥散玻璃」两张预览长得一样）
    expect(classes('default')).toContain('theme-base')
    expect(classes('diffuse')).not.toContain('theme-base')
    expect(classes('liquid')).not.toContain('theme-base')
    expect(classes('hyper')).not.toContain('theme-base')
  })

  it('只有带缓慢动效的主题显示「动态」标记', () => {
    const wrapper = mount(SettingsThemeSection)
    const badge = (id: string) => wrapper.find(`[data-theme-id="${id}"] .theme-badge`).exists()

    expect(badge('default')).toBe(false)
    expect(badge('diffuse')).toBe(true)
    expect(badge('liquid')).toBe(true)
    // 超色彩主义不做漂移：层级靠硬阴影位移，动起来是抖
    expect(badge('hyper')).toBe(false)
  })
})
