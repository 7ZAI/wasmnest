/**
 * 应用表面实例注册表（机制 B 的「保活半边」）
 *
 * 机制 B 的完整口径（2026-10-23 修订）：
 * - **首次打开**：创建应用整包的独立 Vue 实例，挂在 `.app-instance-host` 容器里；
 * - **切换应用 / 回主屏**：`detach` —— 容器从挂载槽移除、实例保留（DOM / 组件状态 /
 *   滚动 / 表单 / 内存路由原样），后台不渲染（脱离文档即停帧），JS 定时器继续；
 * - **停用 / 卸载**：`dispose` —— 才真正 `unmount` 并释放界面租约。
 *
 * 本模块只做纯 DOM 记账（可单测），不 import Tauri / 应用模块；应用整包的装载与
 * 传输面租约在 `useAppMount.ts`。
 */

/** 表面句柄的最小形状（`AppMountHandle` 的结构子集，避免本模块依赖挂载契约） */
export interface AppSurfaceHandle {
  unmount(): Promise<void>
  /** 前台/后台通知（可选）：false = 已切到后台（DOM 保留但不渲染） */
  setActive?(active: boolean): void
}

/** 一个应用表面实例（跨挂载槽移动，生命周期跟着应用运行态） */
export interface AppSurfaceRecord {
  appId: string
  /** 应用自己的挂载容器（宿主不在里面放任何自己的 DOM） */
  host: HTMLElement
  handle: AppSurfaceHandle
  /** 当前是否在文档中（前台） */
  active: boolean
}

export interface AppSurfaceRegistry {
  has(appId: string): boolean
  get(appId: string): AppSurfaceRecord | undefined
  list(): string[]
  register(appId: string, host: HTMLElement, handle: AppSurfaceHandle): void
  /** 把实例容器放回挂载槽（幂等）；返回 false = 没有该实例 */
  attach(appId: string, slotEl: HTMLElement): boolean
  /** 把实例容器从挂载槽移除（不销毁）；返回 false = 没有该实例 */
  detach(appId: string): boolean
  /** 真正销毁（停用 / 卸载）；返回 false = 没有该实例 */
  dispose(appId: string): Promise<boolean>
}

/** setActive 是可选契约：应用未实现 / 抛错都不得影响壳的切换 */
function notifyActive(handle: AppSurfaceHandle, active: boolean): void {
  try {
    handle.setActive?.(active)
  } catch {
    // 应用侧的显隐回调失败不应阻断壳：保活本身不依赖它
  }
}

export function createAppSurfaceRegistry(): AppSurfaceRegistry {
  const surfaces = new Map<string, AppSurfaceRecord>()

  return {
    has(appId) {
      return surfaces.has(appId)
    },

    get(appId) {
      return surfaces.get(appId)
    },

    list() {
      return [...surfaces.keys()]
    },

    register(appId, host, handle) {
      surfaces.set(appId, { appId, host, handle, active: false })
    },

    attach(appId, slotEl) {
      const surface = surfaces.get(appId)
      if (!surface) return false
      if (surface.host.parentElement !== slotEl) slotEl.appendChild(surface.host)
      if (!surface.active) {
        surface.active = true
        notifyActive(surface.handle, true)
      }
      return true
    },

    detach(appId) {
      const surface = surfaces.get(appId)
      if (!surface) return false
      surface.host.remove()
      if (surface.active) {
        surface.active = false
        notifyActive(surface.handle, false)
      }
      return true
    },

    async dispose(appId) {
      const surface = surfaces.get(appId)
      if (!surface) return false
      // 先摘记账再 unmount：unmount 期间若有并发 attach（用户连点），不能复用半销毁实例
      surfaces.delete(appId)
      try {
        await surface.handle.unmount()
      } finally {
        surface.host.remove()
      }
      return true
    },
  }
}

/** 宿主单例（挂载槽 / ShellHost disposer 共用同一份记账） */
export const appSurfaces = createAppSurfaceRegistry()
