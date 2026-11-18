/**
 * 应用表面实例注册表（机制 B 的「保活半边」）
 *
 * 机制 B 的完整口径（2026-10-23 修订，2026-10-30 多任务卡片改真实实例）：
 * - **首次打开**：创建应用整包的独立 Vue 实例，挂在 `.app-instance-host` 容器里；
 * - **切换应用 / 回主屏**：`detach` —— 容器从挂载槽移除、实例保留（DOM / 组件状态 /
 *   滚动 / 表单 / 内存路由原样），后台不渲染（脱离文档即停帧），JS 定时器继续；
 * - **多任务层打开**：`attachPreview` —— 同一实例的容器搬进卡片缩略区，按最近一次
 *   实测的整幅尺寸等比缩小到**整幅可见**（保住布局：不重排、终端不 resize、
 *   滚动 / 输入 / 弹层原样），卡片不是可交互前台，不通知 `setActive(true)`；
 *   收起 `detachPreview` 回后台；
 * - **停用 / 卸载**：`dispose` —— 才真正 `unmount` 并释放界面租约。
 *
 * 卡片的缩放不改实例的布局尺寸：容器用固定像素尺寸 + transform 等比缩小，
 * 整幅画面居中放进卡片缩略区（比例不一致时上下或左右留边，见 `fitPreviewStyle`）。
 * transform 同时成为 fixed 后代的包含块，应用弹层跟着缩进卡片
 * （Teleport 到 body 的层不在其中，属已知边界）。
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

/**
 * 卡片缩略区的已知尺寸（px）
 *
 * 由 `recentsLayout.recentsThumbSize` 解算得到——缩略区比例恒等于应用区比例，
 * 所以 contain 缩放正好铺满、零留边（见 `fitPreviewStyle` 的说明）。
 */
export interface PreviewBoxSize {
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
  attachPreview(appId: string, boxEl: HTMLElement, boxSize?: PreviewBoxSize): boolean
  /** 卡片尺寸变化后重算缩放；返回 false = 实例不在预览态 */
  fitPreview(appId: string, boxSize?: PreviewBoxSize): boolean
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

/**
 * 在文档里时实测应用整幅尺寸。
 *
 * **优先量挂载槽**（实例容器的父元素），其次才退回容器自身。原因：容器是
 * `.app-mount-slot > :deep(*)` 的 flex 项，正常应由槽的确定高度拉伸；但首帧 / 布局
 * 未稳时它的 clientHeight 可能只是应用内容的高度（实测带应用壳 432，而应用区真实
 * 高度 820）。把内容高度当成「应用整幅」会让多任务卡按错误比例缩放：缩略区被算得
 * 又宽又扁，正常比例的应用只能缩成一小块、或按错误尺寸重排后裁掉下半截——看起来
 * 就是「卡片没有显示应用当前的界面」。
 *
 * 槽是应用区的唯一几何真源（所有应用共用同一个槽，切换只搬容器），量它永远对；
 * 无布局的测试环境（槽没有尺寸）再退回容器自身。
 */
function measureInDocument(surface: AppSurfaceRecord): void {
  const host = surface.host
  if (!host.isConnected) return
  const slot = host.parentElement
  const slotWidth = slot?.clientWidth ?? 0
  const slotHeight = slot?.clientHeight ?? 0
  if (slotWidth > 0 && slotHeight > 0) {
    surface.size = { width: slotWidth, height: slotHeight }
    return
  }
  const width = host.clientWidth
  const height = host.clientHeight
  if (!(width > 0) || !(height > 0)) return
  surface.size = { width, height }
}

/**
 * 按卡片盒子的可用尺寸把实例的整幅画面**等比缩小到整幅可见**（contain），居中摆放。
 *
 * 用 `Math.min`（2026-11-04 用户裁决，取代 2026-11-01 的 cover 铺满）：缩略区展示的
 * 是「应用的整页」，必须能看全——cover 取较大比例会裁掉应用右侧内容
 * （只看得见左侧一小条），用户无法从缩略区认出应用当前在哪一页。
 * contain 取较小比例，比例不一致时上下或左右留出等宽边带（居中对齐），不裁切。
 * 与移动端多任务卡同一口径（`wasmnest-mobile/src/shell/surfaceAppRegistry.ts`）。
 *
 * 「零留边」由**卡片解算**保证，不由这里改缩放策略：`recentsLayout` 把缩略区比例
 * 定成与应用区比例相同（`recentsThumbSize`），于是 `Math.min` 与 `Math.max` 同值，
 * contain 正好铺满。这里若改成 cover，比例一旦有偏差就会裁掉应用内容——不可逆的
 * 信息丢失，比留边更糟。
 *
 * `box` 显式给出时用给定尺寸（调用方已解算好缩略区大小，首帧就准确）；缺省则量
 * 容器（首个 ResizeObserver 回调前 / 无布局的测试环境）。两者都拿不到时保持上次的
 * transform，不在这里猜。
 */
export function computePreviewTransform(
  surfaceSize: AppSurfaceSize,
  boxWidth: number,
  boxHeight: number,
): { x: number; y: number; scale: number } {
  const scale = Math.min(boxWidth / surfaceSize.width, boxHeight / surfaceSize.height)
  return {
    x: (boxWidth - surfaceSize.width * scale) / 2,
    y: (boxHeight - surfaceSize.height * scale) / 2,
    scale,
  }
}

function fitPreviewStyle(
  surface: AppSurfaceRecord,
  boxEl: HTMLElement,
  boxSize?: PreviewBoxSize,
): void {
  const size = surface.size
  if (!size) return
  const boxWidth = boxSize && boxSize.width > 0 ? boxSize.width : boxEl.clientWidth
  const boxHeight = boxSize && boxSize.height > 0 ? boxSize.height : boxEl.clientHeight
  if (!(boxWidth > 0) || !(boxHeight > 0)) return
  const { x, y, scale } = computePreviewTransform(size, boxWidth, boxHeight)
  surface.host.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
}

/** 进入预览态：固定整幅尺寸 + 内联缩放 + inert（卡片里的实例不可交互 / 不可聚焦） */
function applyPreviewStyle(
  surface: AppSurfaceRecord,
  boxEl: HTMLElement,
  boxSize?: PreviewBoxSize,
): void {
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
  fitPreviewStyle(surface, boxEl, boxSize)
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

    attachPreview(appId, boxEl, boxSize) {
      const surface = surfaces.get(appId)
      if (!surface) return false
      // 前台实例仍在槽里：先量整幅尺寸，再改写容器尺寸（否则量到的是卡片盒子）
      measureInDocument(surface)
      boxEl.appendChild(surface.host)
      surface.location = 'preview'
      applyPreviewStyle(surface, boxEl, boxSize)
      if (surface.active) {
        surface.active = false
        notifyActive(surface.handle, false)
      }
      return true
    },

    fitPreview(appId, boxSize) {
      const surface = surfaces.get(appId)
      if (!surface || surface.location !== 'preview') return false
      const boxEl = surface.host.parentElement
      if (!boxEl) return false
      fitPreviewStyle(surface, boxEl, boxSize)
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
