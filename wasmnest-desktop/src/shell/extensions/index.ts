/**
 * 桌面壳扩展点公共入口
 *
 * 当前由壳内模块 / 宿主装配使用；接入应用贡献时，把同一组 register* 转发到
 * 挂载环境即可，壳内 UI 不需要知道注册者是谁。
 *
 * 用法：
 * ```ts
 * const handle = registerStatusBarItem({ id: 'demo', label: 'Demo' })
 * handle.dispose() // 停用 / 卸载时摘除
 * ```
 */
export type {
  ShellExtensionHandle,
  ShellSettingsEntry,
  ShellStatusBarAlign,
  ShellStatusBarItem,
  ShellTheme,
  ShellThemeGlyphStyle,
} from './types'

export {
  clearShellExtensions,
  registerSettingsEntry,
  registerStatusBarItem,
  registerTheme,
  useShellExtensions,
} from './registry'
