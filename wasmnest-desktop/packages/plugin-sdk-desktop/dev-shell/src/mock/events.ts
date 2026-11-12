/**
 * dev-shell 事件出口（薄封装）
 * -----------------------------------------------------------------------------
 * 领域 mock 推的事件必须走 **app 真正在听的那条通道**——app 的 `context.events.on`
 * 内部调 `@tauri-apps/api/event` 的 `listen()`（Tauri 事件通道），app 自带的
 * 内存总线在 app 包内部、dev-shell 触不到。
 *
 * 因此这里只做一件事：把 dev-shell 侧的事件派发到 Tauri 事件垫片
 * （`mock/tauri-ipc.ts`），app 侧 `listen()` 的回调随即收到。
 */
import { emitTauriEvent } from './tauri-ipc'

/** 派发一个事件（载荷与真机 Rust 侧 emit 同形：单载荷） */
export function emitDevEvent(event: string, payload: unknown): void {
  emitTauriEvent(event, payload)
}
