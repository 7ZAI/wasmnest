import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ref } from 'vue'
import type { ShellUiPrefs } from '@/shell/types'

/**
 * 壳主题皮肤 composable
 *
 * 锁四条行为：
 *   1. 内置 default 恒在首位，未知持久化 id 渲染时回落 default；
 *   2. 扩展皮肤注册后追加在后，`setSkin` 只写壳偏好；
 *   3. 浅色用 tokens，暗色在 tokens 之上合并 darkTokens；
 *   4. skinStyle 是「当前皮肤 + 当前明暗」的纯 token 表，供 ShellHost 机械挂载。
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

import { useShellThemeSkin } from '@/shell/composables/useShellThemeSkin'
import { clearShellExtensions, registerThemeSkin } from '@/shell/extensions'

describe('壳主题皮肤', () => {
  beforeEach(() => {
    clearShellExtensions()
    mocks.prefs.value.skin = 'default'
    mocks.isDark.value = false
  })

  it('内置 default 恒在首位；未知皮肤 id 渲染时回落 default', () => {
    const { skins, activeSkin } = useShellThemeSkin()
    expect(skins.value[0].id).toBe('default')
    expect(skins.value[0].label).toBe('shell.settings.skins.default')

    mocks.prefs.value.skin = 'skin-from-a-removed-extension'
    expect(useShellThemeSkin().activeSkin.value.id).toBe('default')
  })

  it('扩展皮肤追加在内置 default 之后', () => {
    registerThemeSkin({ id: 'dusk', label: 'Dusk', order: 10 })

    expect(useShellThemeSkin().skins.value.map((skin) => skin.id)).toEqual(['default', 'dusk'])
  })

  it('暗色在 tokens 之上合并 darkTokens', () => {
    const skin = {
      id: 'dusk',
      label: 'Dusk',
      tokens: { '--bg-page': '#f5f5f4', '--color-primary': '#7c3aed' },
      darkTokens: { '--bg-page': '#111113', '--text-primary': '#f4f4f5' },
    }
    registerThemeSkin(skin)
    const { resolvedTokens } = useShellThemeSkin()
    const registered = useShellThemeSkin().skins.value[1]

    expect(resolvedTokens(registered)).toEqual(skin.tokens)
    mocks.isDark.value = true
    expect(resolvedTokens(registered)).toEqual({
      '--bg-page': '#111113',
      '--color-primary': '#7c3aed',
      '--text-primary': '#f4f4f5',
    })
  })

  it('skinStyle 跟随当前皮肤与明暗；setSkin 只写壳偏好', () => {
    registerThemeSkin({ id: 'dusk', label: 'Dusk', tokens: { '--bg-page': '#111113' } })
    mocks.prefs.value.skin = 'dusk'

    const { skinStyle, setSkin } = useShellThemeSkin()
    expect(skinStyle.value).toEqual({ '--bg-page': '#111113' })

    setSkin('default')
    expect(mocks.prefs.value.skin).toBe('default')
  })
})
