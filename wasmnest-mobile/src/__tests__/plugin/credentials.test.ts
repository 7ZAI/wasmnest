/**
 * 宿主面凭证缓存测试（ADR 0058 方案 A：移动半场，issue #21）
 *
 * 被测行为（credentials.ts）：
 * - 幂等：多次 ensureHostCredential 只 invoke 一次 plugin_frontend_loader_session
 *   （宿主对同域重复签发显性报错——「域内首个调用者生效」，模块级缓存是
 *   幂等的唯一防线，见 frontend_channel::issue_loader_session）；
 * - 缓存跨调用共享同一凭证值（各管理类 wrapper 复用同一张宿主面凭证）。
 *
 * 测试 seam：mock @tauri-apps/api/core（凭证命令返回固定假凭证）；
 * credentials 模块持有模块级缓存，用例间 vi.resetModules() 重建模块重置缓存。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

/** 集成测试同款固定假凭证 */
const FAKE_CREDENTIAL = 'test-host-loader-session-credential'

function invokeCalls(cmd: string): unknown[][] {
  return mockInvoke.mock.calls.filter(([c]) => c === cmd).map((call) => call.slice(1))
}

describe('ensureHostCredential 宿主面凭证缓存', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'plugin_frontend_loader_session') {
        return Promise.resolve(FAKE_CREDENTIAL)
      }
      return Promise.resolve(undefined)
    })
  })

  it('幂等：两次调用只 invoke 一次，返回同一凭证', async () => {
    // 模块级缓存住模块内部：resetModules 后动态 import 拿全新模块（缓存为空）
    vi.resetModules()
    const { ensureHostCredential } = await import('@/plugin/credentials')

    const first = await ensureHostCredential()
    const second = await ensureHostCredential()

    expect(first).toBe(FAKE_CREDENTIAL)
    expect(second).toBe(first)
    expect(invokeCalls('plugin_frontend_loader_session')).toHaveLength(1)
  })
})
