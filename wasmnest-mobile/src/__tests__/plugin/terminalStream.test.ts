/**
 * 终端输出页面通道封装单测（票 15 + #13 残余：页面令牌代际）
 *
 * 锁的是封装层的不变式，不是实现细节：
 * 1. 登记返回的页面令牌必须**按句柄**保存，dispose 时原样回传——宿主按令牌只摘
 *    当前代通道；不回传（或回传新代令牌）会让旧页面注销摘掉新页面通道。
 * 2. dispose 幂等：重复调用不得再发注销（避免多一次旧代注销往返）。
 * 3. 注销后回调作废：注销往返期间到达的帧直接丢弃，不得写进已卸载的 xterm。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSubscribe = vi.fn<(...args: any[]) => Promise<number>>(async () => 1)
const mockUnsubscribe = vi.fn<(...args: any[]) => Promise<void>>(async () => {})

vi.mock('@/composables/useMobileCommands', () => ({
  terminalPageSubscribe: (...args: any[]) => mockSubscribe(...args),
  terminalPageUnsubscribe: (...args: any[]) => mockUnsubscribe(...args),
}))

import { openTerminalStream } from '@/plugin/terminal-stream'

/** 取 mockSubscribe 收到的通道替身（Channel 由测试 setup 统一 mock，只留 onmessage） */
function channelOfCall(index = 0): { onmessage: ((message: ArrayBuffer) => void) | null } {
  const call = mockSubscribe.mock.calls[index]
  expect(call, `第 ${index} 次登记调用不存在`).toBeTruthy()
  return call[1] as { onmessage: ((message: ArrayBuffer) => void) | null }
}

describe('openTerminalStream（宿主页面通道封装）', () => {
  beforeEach(() => {
    mockSubscribe.mockClear()
    mockUnsubscribe.mockClear()
    mockSubscribe.mockImplementation(async () => 1)
  })

  it('dispose 回传本代页面令牌（宿主据此只摘当前代通道）', () => {
    mockSubscribe.mockImplementation(async () => 42)
    return openTerminalStream('s-1', () => {}).then((stream) => {
      expect(mockSubscribe).toHaveBeenCalledWith('s-1', expect.anything())
      stream.dispose()
      expect(mockUnsubscribe).toHaveBeenCalledWith('s-1', 42)
    })
  })

  it('同一会话两代句柄各带各的令牌：旧句柄注销不得冒充新代', async () => {
    mockSubscribe.mockImplementationOnce(async () => 7)
    const older = await openTerminalStream('s-1', () => {})
    mockSubscribe.mockImplementationOnce(async () => 8)
    const newer = await openTerminalStream('s-1', () => {})

    older.dispose()
    expect(mockUnsubscribe).toHaveBeenLastCalledWith('s-1', 7)
    newer.dispose()
    expect(mockUnsubscribe).toHaveBeenLastCalledWith('s-1', 8)
  })

  it('dispose 幂等：重复调用不再发注销', async () => {
    const stream = await openTerminalStream('s-1', () => {})
    stream.dispose()
    stream.dispose()
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
  })

  it('字节按序交给回调；注销后到达的帧丢弃', async () => {
    const received: Uint8Array[] = []
    const stream = await openTerminalStream('s-1', (bytes) => received.push(bytes))
    const channel = channelOfCall()

    channel.onmessage?.(new Uint8Array([104, 105]).buffer)
    expect(Array.from(received[0])).toEqual([104, 105])

    stream.dispose()
    channel.onmessage?.(new Uint8Array([120]).buffer)
    expect(received).toHaveLength(1)
  })
})
