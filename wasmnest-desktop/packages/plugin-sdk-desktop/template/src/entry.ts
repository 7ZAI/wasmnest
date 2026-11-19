/**
 * {{NAME}} 应用入口（Desktop · 挂载包形态）
 *
 * 桌面应用是**独立构建的挂载包**：入口导出 `mountApp(root, env)`，由宿主壳
 * （`src/shell/mount/useAppMount.ts`）装载到应用运行屏；本包自带全部依赖，
 * 不读 `window.__WASMNEST_SHARED__`。
 *
 * 契约与宿主逐字段同形（破坏性变更才 bump，新增可选字段不 bump）；完整字段
 * 清单见 SDK `dev-shell/src/shell/types.ts`，dev-shell 有漂移锁比对宿主真源。
 */
import { createApp, h, type App as VueApp } from 'vue'

/** 挂载契约版本（与宿主 MOUNT_CONTRACT 同值） */
export const mountContract = '1'

/** 宿主注入的挂载环境（最小可用面；扩展能力按需增补字段声明） */
export interface AppMountEnv {
  appId: string
  mountContract: string
  /** 宿主面命令白名单代理（plugin_list_loaded / get_app_settings 等） */
  invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>
  /** 应用更新检查（宿主统一默认实现；旧宿主不注入 = 无此能力） */
  appUpdate?: {
    check: () => Promise<{
      status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'incompatible' | 'error'
      latestVersion?: string
      currentVersion?: string
      reason?: { key: string; params?: Record<string, string> }
    }>
  }
  /** 本应用插件面命令（通道令牌已绑定本应用） */
  appInvoke: <T = unknown>(command: string, ...args: unknown[]) => Promise<T>
  /** 本应用插件 KV 存储 */
  appStorageGet: <T = unknown>(key: string) => Promise<T | undefined>
  appStorageSet: (key: string, value: unknown) => Promise<void>
  appStorageDelete: (key: string) => Promise<void>
  locale: string
  theme: string
  platform?: string
  /** 宿主路由传入的初始路径（应用以内存路由消化） */
  initialRoute: string
  /** 宿主面事件出口（'navigate' 请求壳跳转 / 'route' 自报内部当前页） */
  onEvent?: (type: string, payload: unknown) => void
}

/** 挂载句柄（宿主卸载 / 路由与主题通知用） */
export interface AppMountHandle {
  unmount(): Promise<void>
  setRoute?(route: string): void
  setActive?(active: boolean): void
  setLocale?(locale: string): void
  setTheme?(theme: string): void
}

let vueApp: VueApp | null = null

export async function mountApp(root: HTMLElement, env: AppMountEnv): Promise<AppMountHandle> {
  vueApp = createApp({
    name: '{{STRUCT}}Root',
    render: () =>
      h(
        'div',
        { style: 'padding: 16px; color: var(--text-secondary); font-size: 13px' },
        `{{NAME}} — 在这里编写你的应用界面（appId=${env.appId} / locale=${env.locale}）`,
      ),
  })
  vueApp.mount(root)

  return {
    async unmount() {
      vueApp?.unmount()
      vueApp = null
    },
  }
}
