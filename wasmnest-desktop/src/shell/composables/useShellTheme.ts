/**
 * 壳主题（内置目录 + 扩展注册）
 *
 * 主题只产出「CSS 自定义属性表 + 图标绘制语汇」，由 themePresets 机械地挂到
 * `<html>`；壳不解释颜色语义、不做产品级配色判断。应用根容器自己声明的 token
 * 优先，因此应用配色仍归应用（宿主只负责自己的 chrome）。
 *
 * 为什么要在 composable 里 watch 而不是在 ShellHost 里手写：
 * 生效条件有三条（偏好变化 / 明暗变化 / 扩展注册变化），漏掉任一条都会表现为
 * 「切了没反应」——深色下切主题不更新 darkTokens、扩展加载完成后主题仍是旧色。
 */
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTheme } from '@/composables/useTheme'
import { useShellExtensions } from '@/shell/extensions'
import type { ShellTheme } from '@/shell/extensions/types'
import {
  BUILTIN_THEMES,
  SHELL_THEME_DEFAULT,
  applyThemePresetDom,
  builtinThemeOf,
} from './themePresets'
import { useShellSettings } from './useShellSettings'

export function useShellTheme() {
  const { t } = useI18n()
  const { isDark } = useTheme()
  const { prefs } = useShellSettings()
  const { themes: registeredThemes } = useShellExtensions()

  /** 内置在前（顺序固定），扩展按 order 追加在后——用户心智里「默认」永远第一个 */
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
    () => themes.value.find((theme) => theme.id === prefs.value.theme) ?? themes.value[0],
  )

  /** 当前主题下生效的 token（darkTokens 只在暗色时覆盖 tokens） */
  function resolvedTokens(theme: ShellTheme): Record<string, string> {
    return {
      ...(theme.tokens ?? {}),
      ...(isDark.value ? (theme.darkTokens ?? {}) : {}),
    }
  }

  /**
   * 主题落盘到 `<html>`。
   *
   * 内置主题的 token 在样式表里（`theme-presets.css`），这里只传空表；扩展主题
   * 才写内联变量。写成同一个出口是为了让「切回内置时摘掉上一套内联变量」只有
   * 一处实现（见 applyThemePresetDom 的记账注释）。
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

  watch([() => prefs.value.theme, isDark, registeredThemes], applyActiveTheme, { immediate: true })

  function setTheme(id: string): void {
    prefs.value.theme = id
  }

  /** 当前主题是否带缓慢动效（设置页据此显示标记；实际播放仍由 CSS 与系统偏好决定） */
  const isDynamic = computed(() => activeTheme.value.dynamic === true)

  return {
    themes,
    activeTheme,
    resolvedTokens,
    setTheme,
    isDynamic,
    /** 主题 id 常量透出，避免调用方各自写字面量 */
    defaultThemeId: SHELL_THEME_DEFAULT,
  }
}
