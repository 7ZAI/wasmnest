/**
 * 领域 mock 的接线适配器（dev-shell 内部用）
 * -----------------------------------------------------------------------------
 * 领域 mock（file-transfer）此前把命令 handler 注册进 app 的
 * `PluginContext`。挂载包形态下 **app 自己持 context**（宿主注入 env，app 在
 * `entry.ts` 里造 context），dev-shell 触不到它——但领域 mock 仍需要两条通道：
 *
 * - `commands.register(id, handler)` → 全局命令 mock 表；app 经
 *   `env.appInvoke(id, …)` 打到这张表（`mock/commands.ts`）。
 * - `events.emit(event, payload)` → Tauri 事件垫片；app 经 `listen()` 收到
 *   （`mock/tauri-ipc.ts`），与真机同一条通道。
 *
 * 因此领域 mock 只拿到这个**两通道最小接线对象**，不再拿整个 PluginContext：
 * 领域 mock 触不到 app 的 i18n / storage / terminal / 权限等面——那些面在
 * 挂载包形态下由 app 自行持有或经 env 注入，不该由 dev-shell 插手。
 */
import { registerCommand } from './commands'
import { emitTauriEvent } from './tauri-ipc'

/** 领域 mock 用的最小接线面 */
export interface DomainContext {
  commands: {
    register(id: string, handler: (...args: any[]) => any): { dispose(): void }
  }
  events: {
    emit(event: string, ...args: unknown[]): void
  }
}

/** 造一个领域 mock 接线对象 */
export function createDomainContext(): DomainContext {
  return {
    commands: {
      register(id: string, handler: (...args: any[]) => any) {
        registerCommand(id, handler)
        return { dispose() {} }
      },
    },
    events: {
      emit(event: string, ...args: unknown[]): void {
        // 真机上 Rust 侧一次 emit 带一个载荷；这里逐个派发（多载荷时顺序保持）
        for (const payload of args) emitTauriEvent(event, payload)
      },
    },
  }
}
