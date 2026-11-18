/**
 * 前端凭证域测试（ADR 0058：移动侧 loader 会话 + 插件通道令牌，issue #21 / #28）
 *
 * 被测行为（credentials.ts）：
 * - 宿主面凭证：多次 ensureHostCredential 只 invoke 一次 plugin_frontend_loader_session
 *   （宿主对同域重复签发显性报错——「域内首个调用者生效」，模块级缓存是
 *   幂等的唯一防线，见 frontend_channel::issue_loader_session）；
 * - 插件通道令牌：按 pluginId 幂等缓存、带 loader 会话签发、宿主拒签即 fail-closed
 *   （不得把空值当「无凭证放行」）、停用后作废并从缓存摘除、并发签发 single-flight
 *   （宿主重签会作废旧令牌——各自重签会互踩）。
 *
 * 测试 seam：mock @tauri-apps/api/core（凭证命令返回固定假值）；
 * credentials 模块持有模块级缓存，用例间 vi.resetModules() 重建模块重置缓存。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

/** 集成测试同款固定假凭证 */
const FAKE_CREDENTIAL = 'test-host-loader-session-credential'
/** 假插件通道令牌（按 pluginId 生成，断言「令牌对得上目标」） */
const fakeToken = (pluginId: string) => `test-channel-token:${pluginId}`

function invokeCalls(cmd: string): unknown[][] {
  return mockInvoke.mock.calls.filter(([c]) => c === cmd).map((call) => call.slice(1))
}

describe('ensureHostCredential 宿主面凭证缓存', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((cmd: string, args?: { pluginId?: string }) => {
      if (cmd === 'plugin_frontend_loader_session') {
        return Promise.resolve(FAKE_CREDENTIAL)
      }
      if (cmd === 'plugin_channel_token') {
        return Promise.resolve(fakeToken(args?.pluginId ?? ''))
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

describe('ensureChannelToken 插件通道令牌', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation((cmd: string, args?: { pluginId?: string }) => {
      if (cmd === 'plugin_frontend_loader_session') return Promise.resolve(FAKE_CREDENTIAL)
      if (cmd === 'plugin_channel_token') return Promise.resolve(fakeToken(args?.pluginId ?? ''))
      return Promise.resolve(undefined)
    })
  })

  it('带 loader 会话签发一次，同插件重复取用命中缓存', async () => {
    vi.resetModules()
    const { ensureChannelToken } = await import('@/plugin/credentials')

    const first = await ensureChannelToken('com.test.a')
    const second = await ensureChannelToken('com.test.a')

    expect(first).toBe(fakeToken('com.test.a'))
    expect(second).toBe(first)
    // 签发请求带的是宿主面 loader 会话（宿主门：loader 会话 + 运行态才签发）
    expect(invokeCalls('plugin_channel_token')).toEqual([
      [{ pluginId: 'com.test.a', loaderSession: FAKE_CREDENTIAL }],
    ])
  })

  it('按 pluginId 分别缓存（令牌决定身份，不能跨应用复用）', async () => {
    vi.resetModules()
    const { ensureChannelToken } = await import('@/plugin/credentials')

    const a = await ensureChannelToken('com.test.a')
    const b = await ensureChannelToken('com.test.b')

    expect(a).not.toBe(b)
    expect(invokeCalls('plugin_channel_token')).toHaveLength(2)
  })

  it('宿主拒签（未运行 / 会话失效）→ fail-closed 抛错，不缓存', async () => {
    vi.resetModules()
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'plugin_frontend_loader_session') return Promise.resolve(FAKE_CREDENTIAL)
      // 宿主拦在签发环节：插件未运行时不发令牌（返回空）
      if (cmd === 'plugin_channel_token') return Promise.resolve(undefined)
      return Promise.resolve(undefined)
    })
    const { ensureChannelToken } = await import('@/plugin/credentials')

    await expect(ensureChannelToken('com.test.stopped')).rejects.toThrowError(/no token/)

    // 失败不进缓存：下次仍会重新签发（而不是把空凭证当有效用下去）
    mockInvoke.mockImplementation((cmd: string, args?: { pluginId?: string }) => {
      if (cmd === 'plugin_frontend_loader_session') return Promise.resolve(FAKE_CREDENTIAL)
      if (cmd === 'plugin_channel_token') return Promise.resolve(fakeToken(args?.pluginId ?? ''))
      return Promise.resolve(undefined)
    })
    await expect(ensureChannelToken('com.test.stopped')).resolves.toBe(fakeToken('com.test.stopped'))
    expect(invokeCalls('plugin_channel_token')).toHaveLength(2)
  })

  it('invalidateChannelToken 后重新签发（停用回收 → 再启用换新牌）', async () => {
    vi.resetModules()
    const { ensureChannelToken, invalidateChannelToken } = await import('@/plugin/credentials')

    await ensureChannelToken('com.test.a')
    // 宿主停用回收令牌，本地缓存同步作废
    invalidateChannelToken('com.test.a')
    const after = await ensureChannelToken('com.test.a')

    expect(after).toBe(fakeToken('com.test.a'))
    expect(invokeCalls('plugin_channel_token')).toHaveLength(2)
  })

  it('并发签发 single-flight：同一插件只签一次（重签会作废旧令牌）', async () => {
    vi.resetModules()
    const { ensureChannelToken } = await import('@/plugin/credentials')

    const [a, b, c] = await Promise.all([
      ensureChannelToken('com.test.a'),
      ensureChannelToken('com.test.a'),
      ensureChannelToken('com.test.a'),
    ])

    expect(new Set([a, b, c]).size).toBe(1)
    expect(invokeCalls('plugin_channel_token')).toHaveLength(1)
  })
})
