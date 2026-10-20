import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearShellExtensions,
  registerSettingsEntry,
  registerStatusBarItem,
  registerThemeSkin,
  useShellExtensions,
} from '@/shell/extensions'
import { SHELL_SKIN_DEFAULT } from '@/shell/composables/state'

/**
 * 桌面壳扩展点注册表
 *
 * 锁四条行为：
 *   1. 三类贡献（状态栏 / 设置项 / 皮肤）都按 order 升序暴露；
 *   2. 同 id 重复注册覆盖旧项，旧句柄 dispose 不得误删新项；
 *   3. 各 Disposable 只摘自己，clear 清空全部；
 *   4. 皮肤是纯 token 表：保留 id 拒绝、非 `--` 键拒绝。
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

  it('设置项按 order 排序，独立于状态栏注册', () => {
    registerSettingsEntry({ id: 'b', label: 'B', order: 2 })
    registerSettingsEntry({ id: 'a', label: 'A', order: 1 })
    registerStatusBarItem({ id: 'sb', label: 'SB' })

    const extensions = useShellExtensions()
    expect(extensions.settingsEntries.value.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(extensions.statusBarItems.value.map((item) => item.id)).toEqual(['sb'])
  })

  it('皮肤按 order 排序并保留 token 表', () => {
    registerThemeSkin({ id: 'dusk', label: 'Dusk', order: 20, tokens: { '--bg-page': '#111' } })
    registerThemeSkin({ id: 'dawn', label: 'Dawn', order: 10, darkTokens: { '--bg-page': '#222' } })

    const skins = useShellExtensions().themeSkins.value
    expect(skins.map((skin) => skin.id)).toEqual(['dawn', 'dusk'])
    expect(skins[1].tokens).toEqual({ '--bg-page': '#111' })
    expect(skins[0].darkTokens).toEqual({ '--bg-page': '#222' })
  })

  it('内置皮肤 id 保留，扩展注册即拒绝', () => {
    expect(() => registerThemeSkin({ id: SHELL_SKIN_DEFAULT, label: 'Fake default' })).toThrow(
      /reserved/,
    )
  })

  it('皮肤 token 必须是 CSS 自定义属性（-- 前缀）', () => {
    expect(() =>
      registerThemeSkin({ id: 'bad', label: 'Bad', tokens: { 'bg-page': '#111' } }),
    ).toThrow(/must start with --/)
    expect(() =>
      registerThemeSkin({ id: 'bad-dark', label: 'Bad dark', darkTokens: { color: '#111' } }),
    ).toThrow(/must start with --/)
  })

  it('clearShellExtensions 清空三类贡献', () => {
    registerStatusBarItem({ id: 'sb', label: 'SB' })
    registerSettingsEntry({ id: 'set', label: 'Set' })
    registerThemeSkin({ id: 'skin', label: 'Skin' })

    clearShellExtensions()

    const extensions = useShellExtensions()
    expect(extensions.statusBarItems.value).toHaveLength(0)
    expect(extensions.settingsEntries.value).toHaveLength(0)
    expect(extensions.themeSkins.value).toHaveLength(0)
  })
})
