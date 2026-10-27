import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { Ref } from 'vue'
import type { ShellUiPrefs } from '@/shell/types'

/**
 * 壳主题 composable
 *
 * 锁五条行为：
 *   1. 内置主题恒在最前（默认第一），未知持久化 id 渲染时回落默认；
 *   2. 扩展主题追加在后，`setTheme` 只写壳偏好；
 *   3. 浅色用 tokens，暗色在 tokens 之上合并 darkTokens；
 *   4. 主题落到 `<html data-theme>`；切回默认时属性被移除（DOM 保持干净）；
 *   5. 扩展主题的内联变量在切走后被摘掉（否则内联样式会压住内置主题，切不回去）。
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

import { useShellTheme } from '@/shell/composables/useShellTheme'
import { BUILTIN_THEMES } from '@/shell/composables/themePresets'
import { clearShellExtensions, registerTheme } from '@/shell/extensions'

/**
 * 内联变量的真值读法：happy-dom 的 CSSStyleDeclaration 对自定义属性在
 * removeProperty 之后再 setProperty 时，getPropertyValue 会返回空（值其实已写进
 * style 属性）——读序列化字符串才准（同 useFontSize.test.ts 的口径）。
 */
function inlineStyle(root: HTMLElement): string {
  return root.getAttribute('style') ?? ''
}

describe('壳主题', () => {
  beforeEach(() => {
    clearShellExtensions()
    mocks.prefs.value.theme = 'default'
    mocks.isDark.value = false
  })

  it('内置主题在前且顺序固定；未知主题 id 渲染时回落默认', () => {
    const { themes, activeTheme } = useShellTheme()
    expect(themes.value.slice(0, BUILTIN_THEMES.length).map((theme) => theme.id)).toEqual(
      BUILTIN_THEMES.map((builtin) => builtin.id),
    )
    expect(themes.value[0].label).toBe('shell.settings.themes.default')

    mocks.prefs.value.theme = 'theme-from-a-removed-extension'
    expect(useShellTheme().activeTheme.value.id).toBe('default')
    expect(activeTheme.value.id).toBeDefined()
  })

  it('扩展主题追加在内置主题之后', () => {
    registerTheme({ id: 'dusk', label: 'Dusk', order: 10 })

    const { themes } = useShellTheme()
    expect(themes.value.map((theme) => theme.id)).toEqual([
      ...BUILTIN_THEMES.map((builtin) => builtin.id),
      'dusk',
    ])
  })

  it('暗色在 tokens 之上合并 darkTokens', () => {
    const theme = {
      id: 'dusk',
      label: 'Dusk',
      tokens: { '--bg-page': '#f5f5f4', '--color-primary': '#7c3aed' },
      darkTokens: { '--bg-page': '#111113', '--text-primary': '#f4f4f5' },
    }
    registerTheme(theme)
    const { resolvedTokens, themes } = useShellTheme()
    const registered = themes.value.find((item) => item.id === 'dusk')!

    expect(resolvedTokens(registered)).toEqual(theme.tokens)
    mocks.isDark.value = true
    expect(resolvedTokens(registered)).toEqual({
      '--bg-page': '#111113',
      '--color-primary': '#7c3aed',
      '--text-primary': '#f4f4f5',
    })
  })

  it('主题写到 <html data-theme>；切回默认移除属性', async () => {
    const { setTheme } = useShellTheme()
    const root = document.documentElement

    setTheme('liquid')
    await nextTick()
    expect(root.dataset.theme).toBe('liquid')

    setTheme('default')
    await nextTick()
    expect(root.dataset.theme).toBeUndefined()
  })

  it('扩展主题的内联变量在切回内置主题时被摘掉', async () => {
    registerTheme({ id: 'dusk', label: 'Dusk', tokens: { '--bg-page': '#111113' } })
    const { setTheme } = useShellTheme()
    const root = document.documentElement

    setTheme('dusk')
    await nextTick()
    expect(inlineStyle(root)).toContain('--bg-page: #111113')

    setTheme('liquid')
    await nextTick()
    expect(inlineStyle(root)).not.toContain('--bg-page')
    expect(root.dataset.theme).toBe('liquid')
  })

  it('内置主题透出 glyph 语汇，扩展主题透出 glyph 覆盖', async () => {
    const { setTheme } = useShellTheme()
    const presets = await import('@/shell/composables/themePresets')

    setTheme('hyper')
    await nextTick()
    expect(presets.activeGlyphStyle.value?.strokeWidth).toBe(2.6)

    registerTheme({
      id: 'dusk',
      label: 'Dusk',
      glyphs: { gear: ['M4 4h16v16H4z'] },
      glyphStyle: { fill: true },
    })
    setTheme('dusk')
    await nextTick()
    expect(presets.activeGlyphs.value?.gear).toEqual(['M4 4h16v16H4z'])
    expect(presets.activeGlyphStyle.value?.fill).toBe(true)
  })
})
