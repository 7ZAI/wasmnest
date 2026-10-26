/**
 * 壳主题皮肤（内置默认 + 扩展注册）
 *
 * 皮肤只产出「CSS 自定义属性表」，由 ShellHost 机械地挂到壳根样式上；壳不解释
 * 颜色语义、不做产品级配色判断。应用根容器自己声明的 token 优先，因此应用配色
 * 仍归应用（宿主壳只负责自己的 chrome）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTheme } from '@/composables/useTheme'
import { useShellExtensions } from '@/shell/extensions'
import type { ShellThemeSkin } from '@/shell/extensions/types'
import { useShellSettings } from './useShellSettings'
import { SHELL_SKIN_DEFAULT } from './state'

export function useShellThemeSkin() {
  const { t } = useI18n()
  const { isDark } = useTheme()
  const { prefs } = useShellSettings()
  const { themeSkins } = useShellExtensions()

  /** 内置默认皮肤：不覆盖任何 token，保证空注册时也有一个明确选项 */
  const defaultSkin = computed<ShellThemeSkin>(() => ({
    id: SHELL_SKIN_DEFAULT,
    label: t('shell.settings.skins.default'),
    description: t('shell.settings.skins.defaultDesc'),
    order: 0,
  }))

  const skins = computed<ShellThemeSkin[]>(() => [
    defaultSkin.value,
    // 内置 id 不可被扩展覆盖（registerThemeSkin 已拒绝，这里再兜一层）
    ...themeSkins.value.filter((skin) => skin.id !== SHELL_SKIN_DEFAULT),
  ])

  const activeSkin = computed<ShellThemeSkin>(
    () => skins.value.find((skin) => skin.id === prefs.value.skin) ?? defaultSkin.value,
  )

  /** 当前主题下生效的 token（darkTokens 只在暗色时覆盖 tokens） */
  function resolvedTokens(skin: ShellThemeSkin): Record<string, string> {
    return {
      ...(skin.tokens ?? {}),
      ...(isDark.value ? (skin.darkTokens ?? {}) : {}),
    }
  }

  /** 挂到壳根的样式（CSS 变量表） */
  const skinStyle = computed<Record<string, string>>(() => resolvedTokens(activeSkin.value))

  function setSkin(id: string): void {
    prefs.value.skin = id
  }

  return {
    skins,
    activeSkin,
    skinStyle,
    resolvedTokens,
    setSkin,
  }
}
