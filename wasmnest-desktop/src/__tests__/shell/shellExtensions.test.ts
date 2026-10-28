import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearShellExtensions,
  registerSettingsEntry,
  registerStatusBarItem,
  registerTheme,
  useShellExtensions,
} from '@/shell/extensions'
import { SHELL_THEME_DEFAULT } from '@/shell/composables/themePresets'

/**
 * 桌面壳扩展点注册表
 *
 * 锁四条行为：
 *   1. 三类贡献（状态栏 / 设置项 / 主题）都按 order 升序暴露；
 *   2. 同 id 重复注册覆盖旧项，旧句柄 dispose 不得误删新项；
 *   3. 各 Disposable 只摘自己，clear 清空全部；
 *   4. 主题是纯 token 表 + glyph 表：内置 id 拒绝、非 `--` 键拒绝、空 glyph 拒绝。
 */

describe('桌面壳扩展点注册表', () => {
  beforeEach(() => clearShellExtensions())

  it('状态栏项按 order 排序，缺省 100', () => {
    registerStatusBarItem({ id: 'late', label: 'Late', order: 200 })
    registerStatusBarItem({ id: 'default', label: 'Default' })
    registerStatusBarItem({ id: 'early', label: 'Early', order: 10 })

    const ids = useShellExtensions().statusBarItems.value.map((item) => item.id)
    expect(ids).toEqual(['early', 'default', 'late'])
  })

  it('同 id 覆盖：旧句柄 dispose 不误删新注册', () => {
    const first = registerStatusBarItem({ id: 'same', label: 'First' })
    const second = registerStatusBarItem({ id: 'same', label: 'Second' })

    expect(useShellExtensions().statusBarItems.value).toHaveLength(1)
    expect(useShellExtensions().statusBarItems.value[0].label).toBe('Second')

    first.dispose()
    expect(useShellExtensions().statusBarItems.value[0].label).toBe('Second')

    second.dispose()
    expect(useShellExtensions().statusBarItems.value).toHaveLength(0)
  })

  it('状态栏项必须提供 label 或 component', () => {
    expect(() => registerStatusBarItem({ id: 'empty' })).toThrow(/label or component/)
  })

  it('三类注册都拒绝空 / 空白 / 未 trim 的 id', () => {
    for (const bad of ['', '   ', ' padded ']) {
      expect(() => registerStatusBarItem({ id: bad, label: 'X' })).toThrow(/non-blank/)
      expect(() => registerSettingsEntry({ id: bad, label: 'X' })).toThrow(/non-blank/)
      expect(() => registerTheme({ id: bad, label: 'X' })).toThrow(/non-blank/)
    }
  })

  it('设置项必须提供非空 label', () => {
    expect(() => registerSettingsEntry({ id: 'x', label: '' })).toThrow(/non-blank label/)
    expect(() => registerSettingsEntry({ id: 'x', label: '   ' })).toThrow(/non-blank label/)
  })

  it('设置项按 order 排序，独立于状态栏注册', () => {
    registerSettingsEntry({ id: 'b', label: 'B', order: 2 })
    registerSettingsEntry({ id: 'a', label: 'A', order: 1 })
    registerStatusBarItem({ id: 'sb', label: 'SB' })

    const extensions = useShellExtensions()
    expect(extensions.settingsEntries.value.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(extensions.statusBarItems.value.map((item) => item.id)).toEqual(['sb'])
  })

  it('主题按 order 排序并保留 token / glyph 表', () => {
    registerTheme({ id: 'dusk', label: 'Dusk', order: 20, tokens: { '--bg-page': '#111' } })
    registerTheme({
      id: 'dawn',
      label: 'Dawn',
      order: 10,
      darkTokens: { '--bg-page': '#222' },
      glyphs: { gear: ['M4 4h16v16H4z'] },
      glyphStyle: { strokeWidth: 2.4 },
    })

    const themes = useShellExtensions().themes.value
    expect(themes.map((theme) => theme.id)).toEqual(['dawn', 'dusk'])
    expect(themes[1].tokens).toEqual({ '--bg-page': '#111' })
    expect(themes[0].darkTokens).toEqual({ '--bg-page': '#222' })
    expect(themes[0].glyphs?.gear).toHaveLength(1)
    expect(themes[0].glyphStyle?.strokeWidth).toBe(2.4)
  })

  it('内置主题 id 保留，扩展注册即拒绝', () => {
    expect(() => registerTheme({ id: SHELL_THEME_DEFAULT, label: 'Fake default' })).toThrow(
      /reserved/,
    )
    // 三套内置风格 id 同样保留（扩展不能顶掉它们）
    expect(() => registerTheme({ id: 'liquid', label: 'Fake liquid' })).toThrow(/reserved/)
  })

  it('主题 token 必须是 CSS 自定义属性（-- 前缀）', () => {
    expect(() => registerTheme({ id: 'bad', label: 'Bad', tokens: { 'bg-page': '#111' } })).toThrow(
      /must start with --/,
    )
    expect(() =>
      registerTheme({ id: 'bad-dark', label: 'Bad dark', darkTokens: { color: '#111' } }),
    ).toThrow(/must start with --/)
  })

  it('glyph 覆盖必须是非空 path 列表（空数组 = 抹掉图标，属笔误）', () => {
    expect(() => registerTheme({ id: 'bad-glyph', label: 'Bad', glyphs: { gear: [] } })).toThrow(
      /needs path list/,
    )
    expect(() => registerTheme({ id: 'blank-glyph', label: 'Bad', glyphs: { gear: ['  '] } })).toThrow(
      /empty path/,
    )
  })

  it('clearShellExtensions 清空三类贡献', () => {
    registerStatusBarItem({ id: 'sb', label: 'SB' })
    registerSettingsEntry({ id: 'set', label: 'Set' })
    registerTheme({ id: 'extra', label: 'Extra' })

    clearShellExtensions()

    const extensions = useShellExtensions()
    expect(extensions.statusBarItems.value).toHaveLength(0)
    expect(extensions.settingsEntries.value).toHaveLength(0)
    expect(extensions.themes.value).toHaveLength(0)
  })
})
