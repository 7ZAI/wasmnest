import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * app 前端 env.invoke 白名单代理（ADR 0058 方案 A）测试
 *
 * 契约（真源 = `shell/mount/invokeWhitelist.ts` 头注释 + 桌面 src-tauri
 * `APP_FRONTEND_INVOKE_WHITELIST`）：
 * - 白名单内命令原样透传（command + args 逐字转发，args 省略 = 空对象）；
 * - 白名单外命令 fail-visible：错误点名命令与「白名单」，且 logger.warn 留痕
 *   （审计面，不是安全边界——安全边界在 Rust 命令门禁）；
 * - 白名单懒取一次并缓存；取用失败不缓存（下次调用可重试）。
 *
 * 依赖桩：`@/utils/invoke`（白名单取用与业务命令同一通道）与
 * `@/utils/frontendLogger`（断言 warn 调用）。
 */

vi.mock('@/utils/invoke', () => ({ invoke: vi.fn() }))
vi.mock('@/utils/frontendLogger', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { invoke } from '@/utils/invoke'
import { logger } from '@/utils/frontendLogger'
import {
  whitelistedHostInvoke,
  resetInvokeWhitelistCache,
} from '@/shell/mount/invokeWhitelist'

const mockedInvoke = vi.mocked(invoke)

describe('whitelistedHostInvoke（app 前端 env.invoke 白名单代理）', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
    vi.mocked(logger.warn).mockClear()
    resetInvokeWhitelistCache()
  })

  it('白名单内命令透传：command + args 原样转发，返回值直通', async () => {
    mockedInvoke
      .mockResolvedValueOnce(['plugin_list_loaded', 'get_app_settings']) // 白名单取用
      .mockResolvedValueOnce([{ id: 'app-1' }]) // 业务命令返回
    const result = await whitelistedHostInvoke('plugin_list_loaded', { extra: 1 })
    expect(result).toEqual([{ id: 'app-1' }])
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, 'plugin_list_loaded', { extra: 1 })
  })

  it('args 省略时以空对象透传（与挂载槽既有口径一致）', async () => {
    mockedInvoke
      .mockResolvedValueOnce(['get_app_settings'])
      .mockResolvedValueOnce({ network: {} })
    await whitelistedHostInvoke('get_app_settings')
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, 'get_app_settings', {})
  })

  it('白名单外命令被拒：错误点名命令与白名单字样，且 warn 留痕', async () => {
    mockedInvoke.mockResolvedValueOnce(['plugin_list_loaded']) // 白名单里没有管理命令
    await expect(whitelistedHostInvoke('plugin_activate', { pluginId: 'app-1' })).rejects.toThrow(
      /plugin_activate.*白名单/,
    )
    // 业务命令不得透传（只发生白名单取用这一次 invoke）
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke.mock.calls[0][0]).toBe('plugin_frontend_invoke_whitelist')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('plugin_activate'))
  })

  it('白名单懒取一次缓存：第二次调用不再取白名单命令', async () => {
    mockedInvoke
      .mockResolvedValueOnce(['plugin_list_loaded', 'get_app_settings'])
      .mockResolvedValueOnce('v1')
      .mockResolvedValueOnce('v2')
    await whitelistedHostInvoke('get_app_settings')
    await whitelistedHostInvoke('plugin_list_loaded')
    const whitelistCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'plugin_frontend_invoke_whitelist',
    )
    expect(whitelistCalls).toHaveLength(1)
    expect(mockedInvoke).toHaveBeenLastCalledWith('plugin_list_loaded', {})
  })

  it('白名单取用失败不缓存：下次调用重新取用后放行（不钉成永久拒绝）', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('backend down'))
    await expect(whitelistedHostInvoke('get_app_settings')).rejects.toThrow('backend down')
    mockedInvoke
      .mockResolvedValueOnce(['get_app_settings'])
      .mockResolvedValueOnce('ok')
    await expect(whitelistedHostInvoke('get_app_settings')).resolves.toBe('ok')
  })
})
