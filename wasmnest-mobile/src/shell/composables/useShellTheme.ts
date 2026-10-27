/**
 * 壳主题（内置目录 + 扩展注册），移动端
 *
 * 与桌面同名 composable 同构：主题只产出「CSS 自定义属性表 + 图标绘制语汇」，
 * 由 themePresets 机械挂到 `<html>`；壳不解释颜色语义。
 *
 * 生效条件有三条（偏好 / 明暗 / 扩展注册），漏掉任一条都表现为「切了没反应」：
 * 深色下切主题不重算 darkTokens、扩展加载完成后主题仍是旧色。
 */
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useShellExtensions } from '../extensions'
import type { ShellTheme } from '../extensions'
import {
  BUILTIN_THEMES,
  SHELL_THEME_DEFAULT,
  applyThemePresetDom,
  builtinThemeOf,
} from './themePresets'
import { useShellPreferences } from './useShellPreferences'
import { useShellDark } from './useShellDark'

export function useShellTheme() {
  const { t } = useI18n()
  // 深浅色取壳自足面（<html> 的 .dark 类），不依赖 @/composables/**（L7 锁）
  const isDark = useShellDark()
  const prefs = useShellPreferences()
  const { themes: registeredThemes } = useShellExtensions()

  /** 内置在前（默认永远第一个），扩展按 order 追加在后 */
  const themes = computed<ShellTheme[]>(() => [
    ...BUILTIN_THEMES.map((builtin): ShellTheme => {
      const glyphStyle = builtin.glyphStyle
      return {
        id: builtin.id,
        label: t(builtin.labelKey),
        description: t(builtin.descKey),
        order: builtin.order,
        dynamic: builtin.dynamic,
        ...(glyphStyle ? { glyphStyle } : {}),
      }
    }),
    // 内置 id 不可被扩展覆盖（registerTheme 已拒绝，这里再兜一层）
    ...registeredThemes.value.filter((theme) => !builtinThemeOf(theme.id)),
  ])

  const activeTheme = computed<ShellTheme>(
    () => themes.value.find((theme) => theme.id === prefs.theme.value) ?? themes.value[0],
  )

  /** 当前主题下生效的 token（darkTokens 只在暗色时覆盖 tokens） */
  function resolvedTokens(theme: ShellTheme): Record<string, string> {
    return {
      ...(theme.tokens ?? {}),
      ...(isDark.value ? (theme.darkTokens ?? {}) : {}),
    }
  }

  /**
   * 主题落盘到 `<html>`：内置主题的 token 在样式表里（传空表），扩展主题写内联
   * 变量。同一个出口保证「切回内置时摘掉上一套内联变量」只有一处实现。
   */
  function applyActiveTheme(): void {
    const theme = activeTheme.value
    const builtin = builtinThemeOf(theme.id)
    applyThemePresetDom(
      theme.id,
      builtin ? {} : resolvedTokens(theme),
      theme.glyphStyle ?? null,
      theme.glyphs ?? null,
    )
  }

  watch([() => prefs.theme.value, isDark, registeredThemes], applyActiveTheme, { immediate: true })

  /** 当前主题是否带缓慢动效（设置页据此显示标记；实际播放由 CSS 与系统偏好决定） */
  const isDynamic = computed(() => activeTheme.value.dynamic === true)

  return {
    themes,
    activeTheme,
    resolvedTokens,
    setTheme: prefs.setTheme,
    isDynamic,
    defaultThemeId: SHELL_THEME_DEFAULT,
  }
}
