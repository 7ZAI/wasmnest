/**
 * 挂载契约（桌面端 dev-shell）——与宿主 `src/shell/mount/useAppMount.ts` **同形**
 * -----------------------------------------------------------------------------
 * 桌面 UI 宿主修正（机制 B）后，桌面 app 是**独立构建的挂载包**：入口导出
 * `mountApp(root, env)`，宿主经挂载槽装载。dev-shell 走的是**同一条路径**——
 * 它加载 app 的 `src/entry.ts` 源码并调用 `mountApp`，因此本文件必须与宿主
 * `useAppMount.ts` 的契约逐字段对齐。
 *
 * 为什么逐字段对齐是硬要求：app 的 `entry.ts` 自带一份契约声明（各 app 独立
 * 重复，宿主侧有 drift 锁钉住），dev-shell 是**第三份**声明。三份不一致时，
 * 应用在真机正常、在 dev-shell 里某个字段静默为 undefined——预览与真机不等价，
 * 而这正是 dev-shell 唯一不该发生的事。
 *
 * 漂移门禁：`dev-shell/__tests__/shell/contractDrift.test.ts` 逐字段比对本文件
 * 与宿主 `useAppMount.ts`；宿主改了契约而本文件没跟上时该锁直接测红。
 */

/** app 前端挂载环境（宿主注入；令牌/凭证已绑定本 app） */
export interface AppMountEnv {
  /** 插件 id（= 应用 id） */
  appId: string
  /** 挂载契约版本（与宿主 MOUNT_CONTRACT 比对；不匹配 = 显性报错） */
  mountContract: string
  /** 宿主面命令（白名单代理，ADR 0058 方案 A）：plugin_list_loaded / get_app_settings 等；白名单真源在桌面 src-tauri APP_FRONTEND_INVOKE_WHITELIST */
  invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>
  /** 应用更新检查（宿主统一默认实现；dev-shell 无真实发布源，可省略） */
  appUpdate?: {
    check: () => Promise<{
      status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'incompatible' | 'error'
      latestVersion?: string
      currentVersion?: string
      reason?: { key: string; params?: Record<string, string> }
    }>
  }
  /** 插件面命令（plugin_invoke，本 app 通道令牌已绑定） */
  appInvoke: <T = unknown>(command: string, ...args: unknown[]) => Promise<T>
  /** 本 app 插件 KV 存储（plugin_storage_*，宿主面凭证已绑定） */
  appStorageGet: <T = unknown>(key: string) => Promise<T | undefined>
  appStorageSet: (key: string, value: unknown) => Promise<void>
  appStorageDelete: (key: string) => Promise<void>
  /** 宿主面事实（挂载时快照；后续变更经 handle.setLocale / setTheme 通知） */
  locale: string
  theme: string
  platform?: string
  /** 宿主路由传入的应用初始路径（应用以内存路由消化） */
  initialRoute: string
  /**
   * 宿主面事件出口（可选）。当前两种事件：
   * - `'navigate'`（payload = 宿主任一已知路径字符串）：请求壳路由跳转；
   * - `'route'`（payload = `{ path: string }`）：应用**自报内部当前页**——应用跑内存
   *   路由，宿主 history 看不到它的内部跳转，壳据此记住「切回该应用时回到哪一页」。
   */
  onEvent?: (type: string, payload: unknown) => void
  /** 自定义监控面板装载（只对 monitor 的 env 注入；dev-shell 可省略） */
  mountMonitorPanel?: (
    root: HTMLElement,
    appId: string,
    panelId: string,
  ) => Promise<MonitorPanelHandle>
}

/** 监控面板环境（收窄只读面；与宿主同形） */
export interface MonitorPanelEnv {
  appId: string
  panelId: string
  appInvoke: <T = unknown>(command: string, ...args: unknown[]) => Promise<T>
  appStorageGet: <T = unknown>(key: string) => Promise<T | undefined>
  locale: string
  theme: string
  platform?: string
}

/** 监控面板句柄 */
export interface MonitorPanelHandle {
  unmount(): Promise<void>
}

/** 提供方 app bundle 可选导出 */
export type MountMonitorPanel = (
  root: HTMLElement,
  env: MonitorPanelEnv,
) => Promise<MonitorPanelHandle>

/** app 前端挂载句柄（宿主卸载 / 路由通知用） */
export interface AppMountHandle {
  /** 卸载应用实例（销毁 Vue 实例 / 路由 / 监听） */
  unmount(): Promise<void>
  /** 宿主路由变化通知（应用内存路由消化；未实现 = 不支持宿主内路由切换） */
  setRoute?(route: string): void
  /**
   * 前台 / 后台切换通知（可选）：`false` = 界面已切到后台，DOM 与实例保留但
   * 脱离文档不再渲染；`true` = 回到前台（同一实例，不会重新 mount）。
   * 表面保活（2026-10-23）契约，旧应用不实现零影响。
   */
  setActive?(active: boolean): void
  /** 宿主面事实变更通知（语言 / 主题） */
  setLocale?(locale: string): void
  setTheme?(theme: string): void
}

/**
 * app 挂载包模块面（dev-shell 侧）
 *
 * `mountApp` 必有（否则契约不匹配，dev-shell 显性报错）。
 * 与宿主 `useAppMount.ts` 的 `AppBundleModule` 同形。自绘预览面（mountPreview）
 * 已随宿主退役（2026-10-30：多任务卡改挂载保活实例的真实页面，应用不再自报预览）。
 */
export interface AppBundleModule {
  mountContract?: string
  mountApp?: (root: HTMLElement, env: AppMountEnv) => Promise<AppMountHandle>
  mountMonitorPanel?: MountMonitorPanel
}
