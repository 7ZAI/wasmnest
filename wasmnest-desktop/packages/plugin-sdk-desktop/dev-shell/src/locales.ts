/**
 * Dev Shell 界面文案（桌面端 · 挂载包形态）
 *
 * 只剩 dev-shell **自己**的壳文案（工具栏 / 状态栏 / 日志 / 挂载槽）。
 * 宿主机制文案（`shell.*`）不复刻：dev-shell 不复刻宿主的应用管理面，
 * 复刻一份只会产生第二处会漂移的文案副本。
 */
export const zhCN = {
  'devshell.brand': 'WasmNest Dev Shell',
  'devshell.toolbar.debugging': '正在调试：{name}',
  'devshell.toolbar.noApp': '未选中应用',
  'devshell.toolbar.switchApp': '切换被调试应用',
  'devshell.toolbar.themeToLight': '切换到浅色',
  'devshell.toolbar.themeToDark': '切换到深色',
  'devshell.statusBar.aria': '状态栏',
  'devshell.statusBar.ready': '运行环境就绪',
  'devshell.statusBar.loading': '正在装载应用',
  'devshell.statusBar.apps': '{count} 个应用',
  'devshell.apps.loading': '正在挂载应用…',
  'devshell.apps.mountFailed': '应用挂载失败',
  'devshell.apps.retry': '重试',
  'devshell.apps.none': '没有被调试的应用',
  'devshell.apps.noneHint':
    '在被调试应用目录运行 `pnpm exec wasmnest-plugin-desktop dev` 启动本环境；应用入口应为 src/entry.ts（导出 mountApp）',
  'devshell.logs.title': 'Dev Shell 日志',
  'devshell.logs.clear': '清空',
  'devshell.logs.empty': '暂无日志',
}

export const en = {
  'devshell.brand': 'WasmNest Dev Shell',
  'devshell.toolbar.debugging': 'Debugging: {name}',
  'devshell.toolbar.noApp': 'No app selected',
  'devshell.toolbar.switchApp': 'Switch app',
  'devshell.toolbar.themeToLight': 'Switch to light',
  'devshell.toolbar.themeToDark': 'Switch to dark',
  'devshell.statusBar.aria': 'Status bar',
  'devshell.statusBar.ready': 'Runtime ready',
  'devshell.statusBar.loading': 'Loading app',
  'devshell.statusBar.apps': '{count} apps',
  'devshell.apps.loading': 'Mounting app…',
  'devshell.apps.mountFailed': 'App mount failed',
  'devshell.apps.retry': 'Retry',
  'devshell.apps.none': 'No app under debug',
  'devshell.apps.noneHint':
    'Run `pnpm exec wasmnest-plugin-desktop dev` inside the app project; the app entry should be src/entry.ts (exporting mountApp)',
  'devshell.logs.title': 'Dev Shell Logs',
  'devshell.logs.clear': 'Clear',
  'devshell.logs.empty': 'No logs',
}
