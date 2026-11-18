/**
 * 终端输出页面通道（票 15：宿主为插件提供的传输机制封装）
 *
 * 插件前端禁止直连 @tauri-apps/api；此处由宿主创建页面 Channel 并登记
 * （terminal_page_subscribe，裸字节 Raw 投递），把「按序字节回调」交给插件。
 * 链路订阅（bedcode.subscribe）仍由插件命令面负责。
 *
 * 注销带**本代页面令牌**（#13 残余修复）：dispose 是异步的，旧页面的注销可能晚于
 * 新页面的登记落定；宿主按令牌只摘当前代通道，旧代注销是 no-op——否则旧注销会把
 * 新通道摘掉，之后重放/实时全部 `no page channel` 丢弃且不可自愈。
 */

import { Channel } from '@tauri-apps/api/core'
import { terminalPageSubscribe, terminalPageUnsubscribe } from '@/composables/useMobileCommands'
import { logger } from '@/utils/frontendLogger'

/** 终端流句柄（插件侧只持 dispose） */
export interface HostTerminalStreamHandle {
  dispose(): void
}

/** 打开终端输出字节流（登记语义：同一会话重复调用以最后一次通道为准） */
export async function openTerminalStream(
  sessionId: string,
  onBytes: (bytes: Uint8Array) => void,
): Promise<HostTerminalStreamHandle> {
  const channel = new Channel<ArrayBuffer>()
  channel.onmessage = (payload) => {
    const bytes =
      payload instanceof ArrayBuffer ? new Uint8Array(payload) : new Uint8Array(payload as ArrayBufferLike)
    onBytes(bytes)
  }
  const pageToken = await terminalPageSubscribe(sessionId, channel)

  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      // 先摘回调再注销通道：注销往返期间到达的帧直接丢弃（页面已离开）
      channel.onmessage = () => {}
      void terminalPageUnsubscribe(sessionId, pageToken).catch((e) => {
        logger.warn(`[TerminalStream] page unsubscribe failed: sessionId=${sessionId}`, e)
      })
    },
  }
}
