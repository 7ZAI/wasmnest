/**
 * 运行面入口意图通道（宿主 → 应用运行面）
 * -----------------------------------------------------------------------------
 * 场景：应用在首页快捷卡片上写「3 个活跃会话」，点击应直接进入某个会话，而不是
 * 只停在应用门口。每应用运行面是独立 Vue 应用、且切走保活不重挂，所以入口不能
 * 靠「首次挂载参数」传——必须是**可重复投递的事件通道**。
 *
 * 契约分三段：
 *   1. 应用在卡片注册里给 `onPress()`（`ShellSlotContribution.onPress`）；
 *   2. 宿主点击时照常「启动并打开应用」，再 `queueSurfaceIntent(appId, intent)`；
 *   3. 应用运行面经 `context.ui.onSurfaceIntent` 订阅，订阅前到达的按序补投。
 *
 * 边界纪律：意图对宿主**完全不透明**——只有 appId（键控）与两个应用自定义字段
 * （key / payload），宿主不读、不解释、不翻译。B1–B6 均不命中。
 *
 * 生命周期：意图只属于「这一次打开」。应用停用 / 卸载 / 运行面销毁时由
 * `clearSurfaceIntents` 清空排队项，旧意图不会在下一次打开时突然生效；队列有上限，
 * 应用永不消费时也不会无限增长。
 */
import type { Disposable, ShellSurfaceIntent } from '@binblink/wasmnest-plugin-sdk-mobile'

/** 单应用最多排队的意图数（超出丢最旧的；只保留「最近几次点击」） */
export const SURFACE_INTENT_MAX_PENDING = 8

/** 待投递意图（订阅者出现前滞留） */
const pending = new Map<string, ShellSurfaceIntent[]>()

/** 已订阅的运行面（同一应用通常一个；按 Set 容忍多订阅，逐个投递） */
const subscribers = new Map<string, Set<(intent: ShellSurfaceIntent) => void>>()

/** 把排队意图投给当前订阅者；没有订阅者时保留排队 */
function flush(appId: string): void {
  const queue = pending.get(appId)
  const handlers = subscribers.get(appId)
  if (!queue || queue.length === 0 || !handlers || handlers.size === 0) return
  pending.delete(appId)
  for (const intent of queue) {
    for (const handler of handlers) handler(intent)
  }
}

/**
 * 投递一条入口意图（宿主点击路径调用，启动成功后入队）
 *
 * 空 appId / 空意图直接忽略（调用方语义上是「没有入口」，不是错误）。
 */
export function queueSurfaceIntent(
  appId: string,
  intent: ShellSurfaceIntent | null | undefined,
): void {
  if (!appId || !intent) return
  const queue = pending.get(appId) ?? []
  queue.push(intent)
  if (queue.length > SURFACE_INTENT_MAX_PENDING) {
    queue.splice(0, queue.length - SURFACE_INTENT_MAX_PENDING)
  }
  pending.set(appId, queue)
  flush(appId)
}

/**
 * 应用运行面订阅入口意图（`context.ui.onSurfaceIntent` 的落点）
 *
 * 返回 Disposable：只摘本订阅者，不动排队项（其它订阅者仍可收到）。
 */
export function subscribeSurfaceIntent(
  appId: string,
  handler: (intent: ShellSurfaceIntent) => void,
): Disposable {
  let handlers = subscribers.get(appId)
  if (!handlers) {
    handlers = new Set()
    subscribers.set(appId, handlers)
  }
  handlers.add(handler)
  // 订阅前到达的意图按序补投
  flush(appId)
  return {
    dispose() {
      const current = subscribers.get(appId)
      if (!current) return
      current.delete(handler)
      if (current.size === 0) subscribers.delete(appId)
    },
  }
}

/**
 * 清空某应用的排队意图（停用 / 卸载 / 运行面销毁）
 *
 * 不清订阅者：运行面真正销毁时其订阅会随插件上下文 dispose 自摘；这里是
 * 防止「点了卡片但应用没起来 / 被停用」留下的旧意图劫持下一次打开。
 */
export function clearSurfaceIntents(appId: string): void {
  pending.delete(appId)
}

/** 测试隔离：清空全部排队与订阅 */
export function resetSurfaceIntents(): void {
  pending.clear()
  subscribers.clear()
}

/** 排障 / 测试：当前排队意图数（只读） */
export function pendingSurfaceIntentCount(appId: string): number {
  return pending.get(appId)?.length ?? 0
}
