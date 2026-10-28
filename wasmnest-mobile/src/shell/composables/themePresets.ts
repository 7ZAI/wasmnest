/**
 * 内置主题目录 + 主题落到 DOM 的唯一出口（移动端）
 *
 * 与桌面 `wasmnest-desktop/src/shell/composables/themePresets.ts` 同构：
 * token 表住 CSS（`src/styles/theme-presets.css`），图标语汇与动效开关住这里。
 * 差异只有一处——移动端的深浅色口径是「`:root` = 深色，`html:not(.dark)` = 浅色」
 * （mobile.css 头注），因此主题选择器也要在这两条上分别落地。
 */
import { shallowRef } from 'vue'
import type { ShellThemeGlyphStyle } from '../extensions'
import { setReservedThemeIds } from '../extensions'

export const SHELL_THEME_DEFAULT = 'default'

export interface BuiltinThemeDescriptor {
  id: string
  /** 主题名 i18n key（文案不硬编码） */
  labelKey: string
  /** 一行说明 i18n key */
  descKey: string
  order: number
  /** 主题自带缓慢动效（背景漂移），受 .anim-disabled 与 reduced-motion 抑制 */
  dynamic: boolean
  glyphStyle?: ShellThemeGlyphStyle
}

/**
 * 内置主题（与桌面同一套 id 与语义，双端视觉语言一致）
 *
 * 每个非默认 id 必须在 `theme-presets.css` 有对应选择器块，否则切过去只是
 * 「无变化」——`themePresetCoverage` 锁逐 id 校验两边一一对应。
 */
export const BUILTIN_THEMES: readonly BuiltinThemeDescriptor[] = [
  {
    id: SHELL_THEME_DEFAULT,
    labelKey: 'settings.appearance.themeDefault',
    descKey: 'settings.appearance.themeDefaultDesc',
    order: 0,
    dynamic: false,
  },
  {
    id: 'diffuse',
    labelKey: 'settings.appearance.themeDiffuse',
    descKey: 'settings.appearance.themeDiffuseDesc',
    order: 10,
    dynamic: true,
    glyphStyle: { strokeWidth: 1.6 },
  },
  {
    id: 'liquid',
    labelKey: 'settings.appearance.themeLiquid',
    descKey: 'settings.appearance.themeLiquidDesc',
    order: 20,
    dynamic: true,
    glyphStyle: { strokeWidth: 2 },
  },
  {
    id: 'hyper',
    labelKey: 'settings.appearance.themeHyper',
    descKey: 'settings.appearance.themeHyperDesc',
    order: 30,
    // 超色彩主义的层级靠硬阴影位移，动起来只是抖（与桌面同口径）
    dynamic: false,
    glyphStyle: { strokeWidth: 2.6 },
  },
]

export const BUILTIN_THEME_IDS: ReadonlySet<string> = new Set(BUILTIN_THEMES.map((t) => t.id))

// 保留 id 交给注册表（注册表反向依赖主题目录会造成环，改为这里单向注入）
setReservedThemeIds(BUILTIN_THEME_IDS)

export function builtinThemeOf(id: string): BuiltinThemeDescriptor | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id)
}

/** 应用图标 / 图标绘制消费：当前主题的 glyph 语汇（null = 组件默认） */
export const activeGlyphStyle = shallowRef<ShellThemeGlyphStyle | null>(null)
/** 当前主题的逐名 glyph 覆盖（null = 全用组件内置路径表） */
export const activeGlyphs = shallowRef<Record<string, string[]> | null>(null)

/** 扩展主题内联到 `<html>` 的变量名（切回内置主题时逐个摘掉） */
let appliedTokenKeys: string[] = []

/**
 * 主题落到 `<html data-theme>`：唯一写入口。
 *
 * @param themeId 主题 id；`default` 时移除属性
 * @param tokens  扩展主题的已解析 token 表；内置主题传空对象
 */
export function applyThemePresetDom(
  themeId: string,
  tokens: Record<string, string> = {},
  glyphStyle: ShellThemeGlyphStyle | null = null,
  glyphs: Record<string, string[]> | null = null,
): void {
  const root = document.documentElement

  for (const key of appliedTokenKeys) root.style.removeProperty(key)
  appliedTokenKeys = Object.keys(tokens)

  if (themeId === SHELL_THEME_DEFAULT) delete root.dataset.theme
  else root.dataset.theme = themeId

  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value)

  activeGlyphStyle.value = glyphStyle
  activeGlyphs.value = glyphs
}
