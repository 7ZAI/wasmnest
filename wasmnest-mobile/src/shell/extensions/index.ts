/**
 * 移动壳扩展点契约与注册表（目前只有主题一类）
 *
 * 与桌面壳 `wasmnest-desktop/src/shell/extensions/**` 同形（双端同一套词汇）：
 * 注册 / 撤销 / 排序 / 查询，不感知注册者是谁，不替扩展决定默认值。
 *
 * 为什么移动端只有主题一类而桌面有三类：状态栏项与设置项扩展属于桌面壳的
 * chrome 形态，移动壳的对应面（胶囊菜单 / 设置入口）在 2026-10-25 已整面退役
 * （见 `ShellSettingsScreen` 头注）——没有消费方就不提供注册点，避免「注册了
 * 但没人渲染」的静默死路。
 */
import { computed, shallowRef } from 'vue'

/** 可释放句柄：注册扩展点的返回值，dispose 即摘除该注册 */
export interface ShellExtensionHandle {
  dispose(): void
}

/**
 * 主题的 glyph 绘制语汇
 *
 * 主题只调整「图标怎么画」（描边粗细 / 填充与否），不改路径语义；容器语汇
 * （底色 / 圆角 / 光环）由 CSS 侧的 `--theme-icon-*` 承担。
 */
export interface ShellThemeGlyphStyle {
  /** 填充模式：路径闭合并填色、不描边 */
  fill?: boolean
  /** 描边宽度覆盖（描边模式） */
  strokeWidth?: number
}

/**
 * 主题
 *
 * 内置主题的 token 表住 `src/styles/theme-presets.css`（结构性规则与动效只有
 * CSS 能表达）；本契约面向**扩展**主题：只能换 token 与 glyph，不能加结构规则。
 */
export interface ShellTheme {
  id: string
  label: string
  description?: string
  /** 排序权重，小者靠前；缺省 100 */
  order?: number
  /** 浅色 / 共用 token（键必须是 -- 开头的 CSS 自定义属性） */
  tokens?: Record<string, string>
  /** 深色主题下覆盖的 token（与 tokens 合并，后者优先） */
  darkTokens?: Record<string, string>
  /** 逐名 glyph 覆盖：图标名 → path d 数组 */
  glyphs?: Record<string, string[]>
  /** glyph 绘制语汇 */
  glyphStyle?: ShellThemeGlyphStyle
  /** 主题自带缓慢动效；`.anim-disabled` 与 `prefers-reduced-motion` 下自动停 */
  dynamic?: boolean
}

const themes = shallowRef<ShellTheme[]>([])

/** 内置主题 id（由 themePresets 提供，注册时用于保留校验） */
let reservedThemeIds: ReadonlySet<string> = new Set()

/** 由 themePresets 在模块初始化时注入保留 id（避免本文件反向依赖主题目录） */
export function setReservedThemeIds(ids: ReadonlySet<string>): void {
  reservedThemeIds = ids
}

const orderedThemes = computed(() =>
  [...themes.value].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
)

/**
 * 注册 / 替换一套主题
 *
 * 三处拒绝：占用内置 id、token 键不是 CSS 自定义属性、glyph 是空列表。
 * 前两条防「顶掉内置主题 / 静默无样式」，第三条把「抹掉图标」这类笔误挡在注册期。
 */
export function registerTheme(theme: ShellTheme): ShellExtensionHandle {
  if (reservedThemeIds.has(theme.id)) {
    throw new Error(`[shell-extensions] theme id "${theme.id}" is reserved（内置主题 id 不可占用）`)
  }
  assertTokens(theme.id, theme.tokens)
  assertTokens(theme.id, theme.darkTokens)
  assertGlyphs(theme.id, theme.glyphs)

  const next: ShellTheme = { ...theme }
  themes.value = [...themes.value.filter((current) => current.id !== next.id), next]
  return {
    dispose: () => {
      themes.value = themes.value.filter((current) => current !== next)
    },
  }
}

/** 清空全部扩展注册（宿主重载 / 测试隔离；正常注销走各 Disposable） */
export function clearShellExtensions(): void {
  themes.value = []
}

function assertTokens(themeId: string, tokens: Record<string, string> | undefined): void {
  if (!tokens) return
  for (const key of Object.keys(tokens)) {
    if (!key.startsWith('--')) {
      throw new Error(`[shell-extensions] theme "${themeId}" token must start with --: ${key}`)
    }
  }
}

function assertGlyphs(themeId: string, glyphs: Record<string, string[]> | undefined): void {
  if (!glyphs) return
  for (const [name, paths] of Object.entries(glyphs)) {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error(`[shell-extensions] theme "${themeId}" glyph "${name}" needs path list`)
    }
    for (const d of paths) {
      if (typeof d !== 'string' || d.trim() === '') {
        throw new Error(`[shell-extensions] theme "${themeId}" glyph "${name}" has empty path`)
      }
    }
  }
}

/** 壳内消费入口：已排序视图（computed，注册变化即时反映） */
export function useShellExtensions() {
  return { themes: orderedThemes }
}
