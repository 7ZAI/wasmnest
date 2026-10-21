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
  /** 宿主面命令（invoke 原样，无附加凭证）：get_app_settings 等 */
  invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>
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
}

/** app 前端挂载句柄（宿主卸载 / 路由通知用） */
export interface AppMountHandle {
  /** 卸载应用实例（销毁 Vue 实例 / 路由 / 监听） */
  unmount(): Promise<void>
  /** 宿主路由变化通知（应用内存路由消化；未实现 = 不支持宿主内路由切换） */
  setRoute?(route: string): void
  /** 宿主面事实变更通知（语言 / 主题） */
  setLocale?(locale: string): void
  setTheme?(theme: string): void
}

/**
 * 应用预览环境（宿主注入；只读面）
 *
 * 与 {@link AppMountEnv} 的差异是**收窄**而非放行：不提供宿主面 `invoke`、写 / 删
 * 存储、事件出口（navigate / route）。预览是卡片里的旁路展示，不能请求宿主导航、
 * 不能写存储、不能上报路由；安全边界仍由 Rust 权限仲裁（预览没有新增权限）。
 */
export interface AppPreviewEnv {
  /** 插件 id（= 应用 id） */
  appId: string
  /** 应用上次自报的内部路径；无记录 = undefined（应用自行回落落地页） */
  lastRoute?: string
  /** 本 app 插件面命令（与主界面同一令牌 / 权限；预览侧只读使用） */
  appInvoke: <T = unknown>(command: string, ...args: unknown[]) => Promise<T>
  /** 本 app 插件 KV 只读访问 */
  appStorageGet: <T = unknown>(key: string) => Promise<T | undefined>
  locale: string
  theme: string
  platform?: string
}

/** 应用预览句柄（卸载卡片时宿主调用；预览实例不登记到主应用 mounted 表） */
export interface AppPreviewHandle {
  unmount(): Promise<void>
}

/** entry.ts 可选导出；未导出 = 不支持预览（缺失不是错误，是能力声明） */
export type MountPreview = (root: HTMLElement, env: AppPreviewEnv) => Promise<AppPreviewHandle>

/**
 * app 挂载包模块面（dev-shell 侧）
 *
 * `mountApp` 必有（否则契约不匹配，dev-shell 显性报错）；`mountPreview` 可选。
 * 与宿主 `useAppMount.ts` 的 `AppBundleModule` 同形。
 */
export interface AppBundleModule {
  mountApp?: (root: HTMLElement, env: AppMountEnv) => Promise<AppMountHandle>
  mountPreview?: MountPreview
}
