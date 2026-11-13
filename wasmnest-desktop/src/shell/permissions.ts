/**
 * 宿主壳权限展示元数据（桌面）
 * -----------------------------------------------------------------------------
 * 权限词汇的真源是插件 SDK（packages/plugin-sdk-desktop/rust/src/permission.rs），
 * 本文件不复制词表，只做两件展示层的事：
 *   1. 把权限词映射成本地化文案 key（复用 shell.apps.perm.*，不另造一套）
 *   2. 提供权限描述，让审批弹窗与应用详情能逐条说明权限语义
 *
 * 授权裁决仍然在 Rust 端执行，前端展示只是 UX（docs/security.md §1）——因此这里
 * 的映射与文案不参与任何安全判定。
 *
 * 词表口径：覆盖 SDK 权限常量全集 + 内置应用清单已声明的权限。
 * 缺一条的代价是「审批弹窗」里直接裸显英文 code，因此新增权限词时必须同步补这里
 * 与双语 locale——`src/__tests__/shell/permissionsI18nCoverage.test.ts` 是这条
 * 纪律的锁（生成物里的每个权限词都必须有映射与双语 title/desc）。
 */

/** 权限词 → 本地化文案 key 后缀（前缀统一 shell.apps.perm.） */
export const PERMISSION_I18N_KEY: Record<string, string> = {
  storage: 'storage',
  'terminal:output': 'terminalOutput',
  'session:read': 'sessionRead',
  'session:write': 'sessionWrite',
  'ui:toolbox': 'uiToolbox',
  'ui:navtab': 'uiNavtab',
  'ui:settings': 'uiSettings',
  'ui:input': 'uiInput',
  'ui:route': 'uiRoute',
  'ui:dialog': 'uiDialog',
  'ui:back': 'uiBack',
  'ui:sidebar': 'uiSidebar',
  'ui:statusbar': 'uiStatusbar',
  'ui:pageToolbar': 'uiPageToolbar',
  'ui:fileHandler': 'uiFileHandler',
  'connection:read': 'connectionRead',
  'timer:schedule': 'timerSchedule',
  'app:cli': 'appCli',
  'app:path': 'appPath',
  'ws:server': 'wsServer',
  'pty:io': 'ptyIo',
  'task:run': 'taskRun',
  'worker:run': 'workerRun',
  'crypto:aead': 'cryptoAead',
  'crypto:asym': 'cryptoAsym',
  'crypto:kdf': 'cryptoKdf',
  'clipboard:read': 'clipboardRead',
  'clipboard:write': 'clipboardWrite',
  'tunnel:serve': 'tunnelServe',
  'tunnel:connect': 'tunnelConnect',
  'tunnel:probe': 'tunnelProbe',
  'ui:globalEntry': 'uiGlobalEntry',
  'network:http': 'networkHttp',
  'fs:read': 'fsRead',
  'fs:write': 'fsWrite',
  'fs:pick': 'fsPick',
  fileservice: 'fileservice',
  'system:open': 'systemOpen',
  bus: 'bus',
  broadcast: 'broadcast',
  transfer: 'transfer',
  mdns: 'mdns',
  peer: 'peer',
  'ws:client': 'wsClient',
  auth: 'auth',
  notify: 'notify',
  'metrics:read': 'metricsRead',
  'apps:control': 'appsControl',
  'process:run': 'processRun',
  'pty:spawn': 'ptySpawn',
  'terminal:input': 'terminalInput',
  'database:main': 'databaseMain',
}

/** 权限标题的 i18n key（未知权限返回 undefined，由调用方回退原始权限词） */
export function permissionTitleKey(key: string): string | undefined {
  const suffix = PERMISSION_I18N_KEY[key]
  return suffix ? `shell.apps.perm.${suffix}.title` : undefined
}

/** 权限描述的 i18n key（未知权限返回 undefined） */
export function permissionDescKey(key: string): string | undefined {
  const suffix = PERMISSION_I18N_KEY[key]
  return suffix ? `shell.apps.perm.${suffix}.desc` : undefined
}
