/**
 * 应用运行面保活记账（移动端表面保活，2026-10-23 用户裁决）
 *
 * 语义与桌面同一口径：**首次打开创建、切走保留、停用/卸载才销毁**。本模块只
 * 记一件事：`opened` = 打开过运行面的应用（只有它们需要保活——运行中但从没
 * 打开过的应用没有界面可保）。
 *
 * 实例承载、容器位置与前后台信号都在 `surfaceRuntime` / `surfaceAppRegistry`
 * （每应用一个独立 Vue 应用；前台信号 = 注册表按 attach / detach 推动的该应用
 * `active` ref，应用侧经 `SURFACE_ACTIVE_KEY` 注入消费）。应用停用 / 卸载 =
 * 显式 dispose + `dropSurface` 清 `opened`（下次启动全新实例）。
 *
 * 后台**不渲染**：容器脱离文档，DOM 与组件状态保留、JS 定时器继续。
 */
import { ref, type Ref } from 'vue'

/** 应用 surface 可注入的前后台信号键（响应式 boolean） */
export const SURFACE_ACTIVE_KEY = Symbol.for('wasmnest.shell.surface-active')

/** 打开过运行面的应用（模块级单例：跨屏幕切换存活） */
const opened = ref<Set<string>>(new Set())

export function markSurfaceOpened(appId: string): void {
  if (!appId || opened.value.has(appId)) return
  const next = new Set(opened.value)
  next.add(appId)
  opened.value = next
}

/** 应用停用 / 卸载：移出保活集合（实例由调用方显式 dispose） */
export function dropSurface(appId: string): void {
  if (!opened.value.has(appId)) return
  const next = new Set(opened.value)
  next.delete(appId)
  opened.value = next
}

export function isSurfaceOpened(appId: string): boolean {
  return opened.value.has(appId)
}

export function useAppSurfaces(): {
  opened: Ref<Set<string>>
  markSurfaceOpened: typeof markSurfaceOpened
  dropSurface: typeof dropSurface
  isSurfaceOpened: typeof isSurfaceOpened
} {
  return { opened, markSurfaceOpened, dropSurface, isSurfaceOpened }
}
