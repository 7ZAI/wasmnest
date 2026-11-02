/**
 * @binblink/wasmnest-plugin-sdk-mobile
 *
 * WasmNest 移动端插件开发工具包
 */

export type {
  Disposable,
  PluginType,
  PluginState,
  PluginManifest,
  PluginUpdateDecl,
  PluginConfiguration,
  ConfigProperty,
  MobilePluginContributes,
  LifecycleContribution,
  CommandContribution,
  ViewContribution,
  NavTabContribution,
  SettingsContribution,
  RouteContribution,
  TerminalContribution,
  TerminalToolbarItemContribution,
  TerminalStreamHandle,
  MobileHostSessionEvent,
  PluginRouteDescriptor,
  ShellSurfaceContribution,
  ShellSlotContribution,
  ShellCapsuleItem,
  PluginDialogAction,
  PluginDialogOptions,
  PluginDialogHandle,
  CommandRegistry,
  SessionAPI,
  UIRegistry,
  EventAPI,
  StorageAPI,
  I18nAPI,
  LifecycleAPI,
  LoggerAPI,
  DialogOptions,
  DialogResult,
  DialogAPI,
  NotificationAPI,
  StatusAPI,
  SystemAPI,
  PluginDevMock,
  PluginContext,
  PluginModule,
  AppUpdateReason,
  AppUpdateCheckResult,
  AppUpdateAPI,
  MobileHttpResult,
  MobileHttpRequestOptions,
  MobileHostApi,
  MonitorPanelContribution,
  MonitorPanelEnv,
  MonitorPanelHandle,
  MountMonitorPanel,
} from './types'

export {
  getSharedModule,
  getI18n,
  getVue,
  getVueI18n,
  getPinia,
  getRouter,
  getPluginContext,
  getPresetTasks,
  getMobileApi,
} from './runtime'

// SDK 常量（宿主与插件共用单一事实源）
export { MOCK_SESSION_ID } from './constants'

// 全局弹窗控制器（宿主 / dev-shell 共用，插件经 context.ui.showDialog 操控）
export {
  openGlobalDialog,
  closeGlobalDialog,
  updateGlobalDialog,
  getGlobalDialog,
  subscribeGlobalDialog,
  resolveDialogDeadline,
} from './global-dialog'
export type {
  GlobalDialogEntry,
  GlobalDialogListener,
  OpenGlobalDialogInput,
  GlobalDialogHandleOutput,
} from './global-dialog'

// 应用更新检查（SDK 默认实现；宿主统一 GitHub Release 判定）
export { useAppUpdate } from './update'
export type { AppUpdateStatus, UseAppUpdate, UseAppUpdateOptions } from './update'
