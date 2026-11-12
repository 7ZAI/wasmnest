/**
 * Tauri IPC 垫片（桌面端 dev-shell）
 * -----------------------------------------------------------------------------
 * app 的事件订阅走 `context.events.on` → `@tauri-apps/api/event` 的 `listen()`
 * → `window.__TAURI_INTERNALS__.invoke('plugin:event|listen', …)`。浏览器里没有
 * Tauri 运行时，app 的 `listen()` 会静默失败——**领域 mock 推的事件就送不到 app**，
 * 界面停在空态（看起来像「app 坏了」，实际是事件通道没接）。
 *
 * 本模块补上最小可用的 IPC 垫片，让 app 的事件订阅**走与真机同一条通道**：
 *   · `invoke('plugin:event|listen' | 'unlisten' | 'emit')` —— 事件注册 / 注销 / 派发
 *   · `transformCallback` —— 把回调挂到 `window._<id>`（Tauri 后端回调的约定位置）
 *   · `convertFileSrc` —— 恒等（dev-shell 不读宿主资源目录）
 *
 * 边界：只实现事件面。其余 Tauri 命令（宿主命令 / 窗口 / 路径）一律**显性抛错**，
 * 不做假成功——静默 undefined 会让 app 以为「后端返回了空」。
 */

/** 事件名 → (eventId → handler 回调 id) */
const listeners = new Map<string, Map<number, number>>()
let nextEventId = 0
let nextCallbackId = 0

/** 把回调挂到 `window._<id>`（Tauri 后端按此位置回调） */
function transformCallback(callback: (...args: any[]) => void, once = false): number {
  const id = ++nextCallbackId
  Object.defineProperty(window, `_${id}`, {
    value: (result: unknown) => {
      if (once) delete (window as any)[`_${id}`]
      return callback(result)
    },
    writable: false,
    configurable: true,
  })
  return id
}

/** 向已注册该事件的监听者派发载荷（与 Rust 侧 emit 同形：{ event, id, payload }） */
export function emitTauriEvent(event: string, payload: unknown): void {
  const map = listeners.get(event)
  if (!map || map.size === 0) return
  for (const [eventId, handlerId] of [...map.entries()]) {
    const cb = (window as any)[`_${handlerId}`]
    if (typeof cb !== 'function') {
      // 回调已被清理（app 侧 unlisten 过）→ 顺手摘掉这条陈旧登记
      map.delete(eventId)
      continue
    }
    try {
      cb({ event, id: eventId, payload })
    } catch (e) {
      console.error(`[dev-shell] 事件处理失败（${event}）：`, e)
    }
  }
}

/** 当前已注册的事件名（排障用：日志面板可列） */
export function registeredTauriEvents(): string[] {
  return [...listeners.keys()].sort()
}

async function invoke(cmd: string, args: Record<string, any> = {}): Promise<unknown> {
  switch (cmd) {
    case 'plugin:event|listen': {
      const { event, handler } = args
      const eventId = ++nextEventId
      let map = listeners.get(event)
      if (!map) {
        map = new Map()
        listeners.set(event, map)
      }
      map.set(eventId, handler)
      return eventId
    }
    case 'plugin:event|unlisten': {
      const { event, eventId } = args
      listeners.get(event)?.delete(eventId)
      return null
    }
    case 'plugin:event|emit':
    case 'plugin:event|emit_to': {
      emitTauriEvent(args.event, args.payload)
      return null
    }
    default:
      throw new Error(
        `[dev-shell] Tauri 命令 "${cmd}" 在浏览器不可用（dev-shell 无 Rust 后端），请到真机验证`,
      )
  }
}

/** 安装 IPC 垫片（dev-shell 启动时调用一次，幂等） */
export function installTauriIpcShim(): void {
  const w = window as any
  if (w.__TAURI_INTERNALS__) return
  w.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    convertFileSrc: (path: string) => path,
    unregisterCallback: (id: number) => {
      delete w[`_${id}`]
    },
  }
  // @tauri-apps/api 的 `_unlisten` 会直接调它（不经 invoke）——缺了会抛错
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, eventId: number) => {
      listeners.get(event)?.delete(eventId)
    },
  }
}
