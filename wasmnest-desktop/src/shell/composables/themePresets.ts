/**
 * 内置主题目录 + 主题落到 DOM 的唯一出口
 *
 * 分工（为什么不把 token 表写在这里）：
 * - **token 表住 CSS**（`src/styles/theme-presets.css`）。主题要表达的不只是颜色，
 *   还有结构性规则（卡片模糊、图标外框、硬阴影、背景漂移动效）——这些只有 CSS 能写，
 *   而 CSP 禁止内联 `<style>`，运行时 `setProperty` 也表达不了选择器。副作用是
 *   `<html data-theme>` 一挂即生效，无需等 JS 求值。
 * - **图标语汇与动效开关是 TS 事实**，住这里（CSS 无法描述路径表）。
 *
 * 扩展主题（`registerTheme`）反着来：token 表在注册时以 CSS 自定义属性内联到
 * `<html>`，结构性规则不在契约内——扩展能换色与换 glyph，换不了布局形态。
 *
 * 生效层级（低 → 高）：`style.css :root` → 本文件内置主题选择器 → 扩展主题内联变量
 * → 组件 scoped 样式。同一时刻只有一个主题激活，因此后两层互斥。
 */
import { shallowRef } from 'vue'
import type { ShellThemeGlyphStyle } from '../extensions/types'
import { SHELL_THEME_DEFAULT } from './state'
import { useShellSettings } from './useShellSettings'

export { SHELL_THEME_DEFAULT }

export interface BuiltinThemeDescriptor {
  id: string
  /** 主题名 i18n key（文案不硬编码） */
  labelKey: string
  /** 一行说明 i18n key（表达「这套主题是什么」，不复述颜色） */
  descKey: string
  /** 排序权重，小者靠前 */
  order: number
  /** 主题自带缓慢动效（背景漂移 / 光泽流动），受 .anim-disabled 与 reduced-motion 抑制 */
  dynamic: boolean
  /** glyph 绘制语汇（容器语汇由 CSS 承担） */
  glyphStyle?: ShellThemeGlyphStyle
}

/**
 * 内置主题（2026 三套流行风格 + 现状默认）
 *
 * 每个 id 必须在 `theme-presets.css` 有对应选择器块，否则切过去只是「无变化」——
 * `themePresetCoverage.test.ts` 逐 id 校验两边一一对应，防止加了目录项忘写样式。
 */
export const BUILTIN_THEMES: readonly BuiltinThemeDescriptor[] = [
  {
    id: SHELL_THEME_DEFAULT,
    labelKey: 'shell.settings.themes.default',
    descKey: 'shell.settings.themes.defaultDesc',
    order: 0,
    dynamic: false,
  },
  {
    id: 'diffuse',
    labelKey: 'shell.settings.themes.diffuse',
    descKey: 'shell.settings.themes.diffuseDesc',
    order: 10,
    dynamic: true,
    glyphStyle: { strokeWidth: 1.6 },
  },
  {
    id: 'liquid',
    labelKey: 'shell.settings.themes.liquid',
    descKey: 'shell.settings.themes.liquidDesc',
    order: 20,
    dynamic: true,
    glyphStyle: { strokeWidth: 2 },
  },
  {
    id: 'hyper',
    labelKey: 'shell.settings.themes.hyper',
    descKey: 'shell.settings.themes.hyperDesc',
    order: 30,
    // 超色彩主义不做漂移动效：它的层级靠硬阴影位移，动起来只会抖（不是设计意图）
    dynamic: false,
    glyphStyle: { strokeWidth: 2.6 },
  },
]

/** 内置 id 集合：扩展注册占用即拒绝（内置主题不能被子模块顶掉） */
export const BUILTIN_THEME_IDS: ReadonlySet<string> = new Set(BUILTIN_THEMES.map((t) => t.id))

/** 内置主题元数据查询；未知 id 返回 undefined（扩展主题走注册表） */
export function builtinThemeOf(id: string): BuiltinThemeDescriptor | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id)
}

/** ShellIcon 消费：当前主题的 glyph 绘制语汇（null = 用组件默认） */
export const activeGlyphStyle = shallowRef<ShellThemeGlyphStyle | null>(null)
/** ShellIcon 消费：当前主题的逐名 glyph 覆盖（null = 全用组件内置路径表） */
export const activeGlyphs = shallowRef<Record<string, string[]> | null>(null)

/**
 * 扩展主题内联到 `<html>` 的变量名。
 *
 * 必须记账：切回内置主题时逐个 `removeProperty`，否则上一套扩展主题的颜色会一直
 * 压在内置主题的样式表之上（内联样式优先级最高），表现为「切不回去」。
 */
let appliedTokenKeys: string[] = []

/**
 * 主题落到 `<html>`：唯一写入口（ShellHost 的 watcher 与首帧预应用共用）。
 *
 * @param themeId 主题 id；`default` 时移除属性（保持 DOM 干净，也让默认主题的
 *   选择器不必写 `:root:not([data-theme])` 这种反选）
 * @param tokens  扩展主题的已解析 token 表；内置主题传空对象（token 在样式表里）
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

/**
 * 首帧预应用（`main.ts` 在 `app.mount` 之前调用）
 *
 * 只认内置主题：扩展主题此刻还没注册，持久化 id 先回落默认，等 ShellHost 的
 * watcher 在注册完成后纠正——扩展主题首帧可能闪一下默认色，这是可接受的边界
 * （内置主题零闪变，因为 token 全在静态 CSS 里）。
 */
export function presetThemeBeforeMount(): void {
  const { prefs } = useShellSettings()
  const builtin = builtinThemeOf(prefs.value.theme)
  applyThemePresetDom(
    builtin ? builtin.id : SHELL_THEME_DEFAULT,
    {},
    builtin?.glyphStyle ?? null,
    null,
  )
}
