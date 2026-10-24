/**
 * 应用运行面保活记账（移动端表面保活，2026-10-23 用户裁决）
 *
 * 语义与桌面同一口径：**首次打开创建、切走保留、停用/卸载才销毁**。
 * 本模块只做三件记账（spec `.scratch/2026-10-24-mobile-app-surface-vue-instances`
 * §4.2：职责收窄）：
 * - `opened`：打开过运行面的应用（只有它们需要保活——运行中但从没打开过的应用
 *   没有界面可保）；
 * - `outletEl`：当前应用运行屏的插槽 DOM（由运行面适配器 `ShellAppSurface` 登记，
 *   注销只认自己登记的那一个）；
 * - `activeSurfaceId`：当前前台应用（壳在路由变化时写入）。
 *
 * 实例承载与生命周期在 `surfaceRuntime` / `surfaceAppRegistry`（每应用一个独立
 * Vue 应用；前后台信号 = 注册表按 attach/detach 推动的该应用 active ref，应用侧
 * 经 `SURFACE_ACTIVE_KEY` 注入消费）。应用停用 / 卸载 = 显式 dispose + `dropSurface`
 * 清 `opened`（下次启动全新实例）。
 *
 * 后台**不渲染**：容器脱离文档，DOM 与组件状态保留、JS 定时器继续。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'

/** 应用 surface 可注入的前后台信号键（响应式 boolean） */
export const SURFACE_ACTIVE_KEY = Symbol.for('wasmnest.shell.surface-active')

/** 打开过运行面的应用（模块级单例：跨屏幕切换存活） */
const opened = ref<Set<string>>(new Set())
/** 当前应用运行屏的 surface 插槽（null = 不在应用面） */
const outletEl = ref<HTMLElement | null>(null)
/** 当前前台应用（供 surface 注入判断显隐） */
const activeSurfaceId = ref('')

export function markSurfaceOpened(appId: string): void {
  if (!appId || opened.value.has(appId)) return
  const next = new Set(opened.value)
  next.add(appId)
  opened.value = next
}

/** 应用停用 / 卸载：移出保活池（池内组件随之卸载） */
export function dropSurface(appId: string): void {
  if (!opened.value.has(appId)) return
  const next = new Set(opened.value)
  next.delete(appId)
  opened.value = next
  if (activeSurfaceId.value === appId) activeSurfaceId.value = ''
}

export function isSurfaceOpened(appId: string): boolean {
  return opened.value.has(appId)
}

export function setSurfaceOutlet(el: HTMLElement | null): void {
  outletEl.value = el
}

/**
 * 注销插槽（只注销**自己登记的**那个）
 *
 * 屏幕过渡期间新旧运行屏共存：新屏先 `onMounted` 登记，旧屏要等离场动画结束才
 * `onBeforeUnmount`。无条件清空会把新屏刚登记的插槽抹掉——当前应用随即退回隐藏池，
 * 表现就是「切到另一个应用后运行面空白」。故按引用比对，只有仍是自己时才清。
 */
export function releaseSurfaceOutlet(el: HTMLElement | null): void {
  if (el && outletEl.value === el) outletEl.value = null
}

/** 由壳（`ShellHost`）在路由变化时写入；空串 = 不在应用面 */
export function setActiveSurface(appId: string): void {
  activeSurfaceId.value = appId
}

export function useAppSurfaces(): {
  opened: Ref<Set<string>>
  outletEl: Ref<HTMLElement | null>
  activeSurfaceId: Ref<string>
  markSurfaceOpened: typeof markSurfaceOpened
  dropSurface: typeof dropSurface
  isSurfaceOpened: typeof isSurfaceOpened
  setSurfaceOutlet: typeof setSurfaceOutlet
  releaseSurfaceOutlet: typeof releaseSurfaceOutlet
  setActiveSurface: typeof setActiveSurface
  isSurfaceActive: (appId: string) => boolean
  activeSignal: (appId: string) => ComputedRef<boolean>
} {
  return {
    opened,
    outletEl,
    activeSurfaceId,
    markSurfaceOpened,
    dropSurface,
    isSurfaceOpened,
    setSurfaceOutlet,
    releaseSurfaceOutlet,
    setActiveSurface,
    isSurfaceActive: (appId: string) => activeSurfaceId.value === appId,
    activeSignal: (appId: string) => computed(() => activeSurfaceId.value === appId),
  }
}
