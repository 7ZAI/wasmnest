/**
 * 应用表面实例注册表（机制 B 的「保活半边」）
 *
 * 机制 B 的完整口径（2026-10-23 修订，2026-10-30 多任务卡片改真实实例）：
 * - **首次打开**：创建应用整包的独立 Vue 实例，挂在 `.app-instance-host` 容器里；
 * - **切换应用 / 回主屏**：`detach` —— 容器从挂载槽移除、实例保留（DOM / 组件状态 /
 *   滚动 / 表单 / 内存路由原样），后台不渲染（脱离文档即停帧），JS 定时器继续；
 * - **多任务层打开**：`attachPreview` —— 同一实例的容器搬进卡片缩略区，按最近一次
 *   实测的整幅尺寸等比缩放（保住布局：不重排、终端不 resize、滚动 / 输入 / 弹层原样），
 *   卡片不是可交互前台，不通知 `setActive(true)`；收起 `detachPreview` 回后台；
 * - **停用 / 卸载**：`dispose` —— 才真正 `unmount` 并释放界面租约。
 *
 * 卡片的缩放不改实例的布局尺寸：容器用固定像素尺寸 + transform 缩放，卡片的
 * `overflow: hidden` 裁掉多余部分；transform 同时成为 fixed 后代的包含块，
 * 应用弹层跟着缩进卡片（Teleport 到 body 的层不在其中，属已知边界）。
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

/** 实例当前挂在哪：挂载槽（前台）/ 多任务卡（预览）/ 后台（不在文档） */
export type AppSurfaceLocation = 'slot' | 'preview' | 'detached'

/** 实例在文档里实测到的整幅尺寸（px） */
export interface AppSurfaceSize {
  width: number
  height: number
}

/** 一个应用表面实例（跨挂载槽 / 多任务卡移动，生命周期跟着应用运行态） */
export interface AppSurfaceRecord {
  appId: string
  /** 应用自己的挂载容器（宿主不在里面放任何自己的 DOM） */
  host: HTMLElement
  handle: AppSurfaceHandle
  /** 当前是否在挂载槽（前台） */
  active: boolean
  /** 当前挂在哪儿（见 {@link AppSurfaceLocation}） */
  location: AppSurfaceLocation
  /** 最近一次在文档里实测的整幅尺寸；卡片等比缩放按它算（后台改窗口不伪造新值） */
  size: AppSurfaceSize | null
}

export interface AppSurfaceRegistry {
  has(appId: string): boolean
  get(appId: string): AppSurfaceRecord | undefined
  list(): string[]
  register(appId: string, host: HTMLElement, handle: AppSurfaceHandle): void
  /** 把实例容器放回挂载槽（幂等）；返回 false = 没有该实例 */
  attach(appId: string, slotEl: HTMLElement): boolean
  /** 把实例容器搬进多任务卡缩略区（等比缩放、不改前台语义）；返回 false = 没有该实例 */
  attachPreview(appId: string, boxEl: HTMLElement): boolean
  /** 卡片尺寸变化后重算缩放；返回 false = 实例不在预览态 */
  fitPreview(appId: string): boolean
  /** 把实例容器从卡片缩略区摘下（不销毁）；返回 false = 实例不在预览态 */
  detachPreview(appId: string): boolean
  /** 把实例容器从挂载槽移除（不销毁）；返回 false = 没有该实例 */
  detach(appId: string): boolean
  /** 真正销毁（停用 / 卸载）；返回 false = 没有该实例 */
  dispose(appId: string): Promise<boolean>
}

/** 预览态写在容器上的内联样式（摘下时逐项清掉，挂载槽的 CSS 尺寸规则要能重新生效） */
const PREVIEW_STYLE_PROPS = [
  'position',
  'left',
  'top',
  'width',
  'height',
  'transform-origin',
  'transform',
] as const

/** setActive 是可选契约：应用未实现 / 抛错都不得影响壳的切换 */
function notifyActive(handle: AppSurfaceHandle, active: boolean): void {
  try {
    handle.setActive?.(active)
  } catch {
    // 应用侧的显隐回调失败不应阻断壳：保活本身不依赖它
  }
}

/** 在文档里时实测整幅尺寸（脱离文档的节点量不到布局，保留旧值） */
function measureInDocument(surface: AppSurfaceRecord): void {
  if (!surface.host.isConnected) return
  const width = surface.host.clientWidth
  const height = surface.host.clientHeight
  if (!(width > 0) || !(height > 0)) return
  surface.size = { width, height }
}

/**
 * 按卡片盒子的可用尺寸等比缩放实例的整幅画面（居中留边）。
 *
 * 尺寸没量到（首次布局前 / 测试环境）时保持上次的 transform：卡片尺寸变化会由
 * 调用方（ResizeObserver）再调一次，不在这里猜。
 */
function fitPreviewStyle(surface: AppSurfaceRecord, boxEl: HTMLElement): void {
  const size = surface.size
  if (!size) return
  const boxWidth = boxEl.clientWidth
  const boxHeight = boxEl.clientHeight
  if (!(boxWidth > 0) || !(boxHeight > 0)) return
  const scale = Math.min(boxWidth / size.width, boxHeight / size.height)
  const x = (boxWidth - size.width * scale) / 2
  const y = (boxHeight - size.height * scale) / 2
  surface.host.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
}

/** 进入预览态：固定整幅尺寸 + 内联缩放 + inert（卡片里的实例不可交互 / 不可聚焦） */
function applyPreviewStyle(surface: AppSurfaceRecord, boxEl: HTMLElement): void {
  const host = surface.host
  host.style.position = 'absolute'
  host.style.left = '0'
  host.style.top = '0'
  if (surface.size) {
    host.style.width = `${surface.size.width}px`
    host.style.height = `${surface.size.height}px`
    host.style.transformOrigin = '0 0'
  }
  host.inert = true
  fitPreviewStyle(surface, boxEl)
}

/** 离开预览态：清掉预览内联样式，让 `.app-instance-host` 的 100% 尺寸规则重新生效 */
function clearPreviewStyle(host: HTMLElement): void {
  for (const prop of PREVIEW_STYLE_PROPS) host.style.removeProperty(prop)
  host.inert = false
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
      surfaces.set(appId, {
        appId,
        host,
        handle,
        active: false,
        location: 'detached',
        size: null,
      })
    },

    attach(appId, slotEl) {
      const surface = surfaces.get(appId)
      if (!surface) return false
      if (surface.location === 'preview') clearPreviewStyle(surface.host)
      if (surface.host.parentElement !== slotEl) slotEl.appendChild(surface.host)
      surface.location = 'slot'
      measureInDocument(surface)
      if (!surface.active) {
        surface.active = true
        notifyActive(surface.handle, true)
      }
      return true
    },

    attachPreview(appId, boxEl) {
      const surface = surfaces.get(appId)
      if (!surface) return false
      // 前台实例仍在槽里：先量整幅尺寸，再改写容器尺寸（否则量到的是卡片盒子）
      measureInDocument(surface)
      boxEl.appendChild(surface.host)
      surface.location = 'preview'
      applyPreviewStyle(surface, boxEl)
      if (surface.active) {
        surface.active = false
        notifyActive(surface.handle, false)
      }
      return true
    },

    fitPreview(appId) {
      const surface = surfaces.get(appId)
      if (!surface || surface.location !== 'preview') return false
      const boxEl = surface.host.parentElement
      if (!boxEl) return false
      fitPreviewStyle(surface, boxEl)
      return true
    },

    detachPreview(appId) {
      const surface = surfaces.get(appId)
      if (!surface || surface.location !== 'preview') return false
      clearPreviewStyle(surface.host)
      surface.host.remove()
      surface.location = 'detached'
      return true
    },

    detach(appId) {
      const surface = surfaces.get(appId)
      if (!surface) return false
      if (surface.location === 'preview') clearPreviewStyle(surface.host)
      measureInDocument(surface)
      surface.host.remove()
      surface.location = 'detached'
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
      if (surface.location === 'preview') clearPreviewStyle(surface.host)
      try {
        await surface.handle.unmount()
      } finally {
        surface.host.remove()
      }
      return true
    },
  }
}

/** 宿主单例（挂载槽 / ShellHost disposer / 多任务卡片共用同一份记账） */
export const appSurfaces = createAppSurfaceRegistry()
