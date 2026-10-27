/**
 * 桌面壳扩展点注册表
 *
 * 职责边界：只做「注册 / 撤销 / 排序 / 查询」，不做任何 UI 决策，也不感知
 * 扩展从哪来。壳组件只消费描述符，不关心注册者是谁。
 *
 * 生命周期：`register*` 返回 Disposable，调用方停用 / 卸载时 dispose 即摘除；
 * 同 id 重复注册覆盖旧项（旧句柄的 dispose 不会误删新项）。
 */
import { computed, markRaw, shallowRef } from 'vue'
import { BUILTIN_THEME_IDS, SHELL_THEME_DEFAULT } from '../composables/themePresets'
import type {
  ShellExtensionHandle,
  ShellSettingsEntry,
  ShellStatusBarItem,
  ShellTheme,
} from './types'

const statusBarItems = shallowRef<ShellStatusBarItem[]>([])
const settingsEntries = shallowRef<ShellSettingsEntry[]>([])
const themes = shallowRef<ShellTheme[]>([])

function byOrder<T extends { order?: number }>(a: T, b: T): number {
  return (a.order ?? 100) - (b.order ?? 100)
}

const orderedStatusBarItems = computed(() => [...statusBarItems.value].sort(byOrder))
const orderedSettingsEntries = computed(() => [...settingsEntries.value].sort(byOrder))
const orderedThemes = computed(() => [...themes.value].sort(byOrder))

/** 注册 / 替换一个状态栏项 */
export function registerStatusBarItem(item: ShellStatusBarItem): ShellExtensionHandle {
  if (!item.label && !item.component) {
    throw new Error(`[shell-extensions] status bar item "${item.id}" needs label or component`)
  }
  const entry: ShellStatusBarItem = {
    ...item,
    component: item.component ? markRaw(item.component) : undefined,
  }
  statusBarItems.value = [
    ...statusBarItems.value.filter((current) => current.id !== entry.id),
    entry,
  ]
  return {
    dispose: () => {
      // 只摘自己：同 id 已被后来者覆盖时，旧句柄不得删除新注册
      statusBarItems.value = statusBarItems.value.filter((current) => current !== entry)
    },
  }
}

/** 注册 / 替换一个设置页扩展项 */
export function registerSettingsEntry(entry: ShellSettingsEntry): ShellExtensionHandle {
  const next: ShellSettingsEntry = { ...entry }
  settingsEntries.value = [
    ...settingsEntries.value.filter((current) => current.id !== next.id),
    next,
  ]
  return {
    dispose: () => {
      settingsEntries.value = settingsEntries.value.filter((current) => current !== next)
    },
  }
}

/** 注册 / 替换一套主题 */
export function registerTheme(theme: ShellTheme): ShellExtensionHandle {
  if (BUILTIN_THEME_IDS.has(theme.id)) {
    throw new Error(
      `[shell-extensions] theme id "${theme.id}" is reserved（内置主题 id 不可被扩展占用）`,
    )
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
  statusBarItems.value = []
  settingsEntries.value = []
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

/**
 * glyph 覆盖校验：只接受「图标名 → 非空 path d 字符串数组」。
 *
 * 不允许空数组——空数组等于「把这个图标抹掉」，是作者笔误而不是设计意图；
 * 真要隐藏图标应当不注册该名字（回落内置表）。
 */
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

/** 壳内消费入口：全部为已排序视图（computed，注册变化即时反映） */
export function useShellExtensions() {
  return {
    statusBarItems: orderedStatusBarItems,
    settingsEntries: orderedSettingsEntries,
    themes: orderedThemes,
  }
}

/** 默认主题 id 的再导出（壳内组件只需要「默认」这一个字面量） */
export { SHELL_THEME_DEFAULT }
