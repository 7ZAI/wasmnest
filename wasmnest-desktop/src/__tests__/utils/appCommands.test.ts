/**
 * appCommands 通道令牌生命周期测试（2026-10-20 修复）
 *
 * 实况形态（日志证据）：插件停用 → 再启用后点进 BedCode，页面内存里仍是停用时
 * 被宿主回收的旧通道令牌 → 进入应用的第一批命令（session.list）全被
 * 「缺少有效通道凭证」拒绝 → 应用侧 toast 「操作未完成，请稍后重试」。
 *
 * 本锁钉三条不变量：
 * - 挂载（身份重绑）必须**换发**令牌，不信任页面内存缓存；
 * - 凭证被拒后的并发重签 single-flight：并发调用共享一次签发，不互相作废；
 * - 业务失败**不重试**（有副作用的命令不得重放）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockInvoke = vi.fn()
vi.mock('@/utils/invoke', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))
vi.mock('@/utils/frontendLogger', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  appInvoke,
  appStorageGet,
  ensureChannelToken,
  ensureHostCredential,
  invalidateChannelToken,
  refreshChannelToken,
} from '@/utils/appCommands'

const APP = 'com.test.app'

/** 凭证被拒信封：AppError::Plugin → host.internal 且**不带 params** */
function credentialReject() {
  return { code: 'host.internal', request_id: 'deadbeef' }
}

/** 本次用例内签发的通道令牌数（loader 会话另有计数，不混入） */
function tokenIssueCalls(): number {
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === 'plugin_channel_token').length
}

/**
 * 假宿主：loader 会话 + 通道令牌（覆盖签发即回收旧令牌）+ 插件面凭证校验。
 * `validTokens` 即宿主侧令牌表——清空它 = 模拟停用 / 页面加载回收。
 */
function installFakeHost() {
  const validTokens = new Set<string>()
  let issued = 0
  mockInvoke.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case 'plugin_frontend_loader_session': {
        return 'loader-session'
      }
      case 'plugin_channel_token': {
        issued += 1
        const token = `token-${issued}`
        // 覆盖签发：宿主侧同插件旧令牌立即回收（frontend_channel::issue_token 同口径）
        validTokens.clear()
        validTokens.add(token)
        return token
      }
      case 'plugin_invoke': {
        if (!validTokens.has(args.credential as string)) throw credentialReject()
        return { command: args.command }
      }
      case 'plugin_storage_get': {
        if (!validTokens.has(args.credential as string)) throw credentialReject()
        return undefined
      }
      default:
        throw new Error(`unexpected command: ${cmd}`)
    }
  })
  return {
    validTokens,
    issuedCount: () => issued,
    /** 模拟宿主回收全部令牌（停用 / 页面加载重置） */
    revokeAll: () => validTokens.clear(),
  }
}

let host: ReturnType<typeof installFakeHost>

beforeEach(async () => {
  mockInvoke.mockReset()
  // 模块级令牌缓存跨用例存活：逐项复位
  for (const id of [APP, 'com.test.other']) invalidateChannelToken(id)
  host = installFakeHost()
  // 宿主面 loader 凭证每次页面加载只签发一次，且被模块缓存；
  // 先预热，让用例里的 mock 调用序列不受执行顺序影响
  await ensureHostCredential()
})

describe('挂载换发令牌（refreshChannelToken）', () => {
  it('缓存存在也强制换发：停用回收后旧令牌不会被带进新挂载', async () => {
    await refreshChannelToken(APP)
    expect(host.issuedCount()).toBe(1)

    // 宿主回收（停用）——页面内存缓存仍在
    host.revokeAll()

    // 挂载路径换发：新令牌有效，进入应用的第一批命令不再被拒
    const token = await refreshChannelToken(APP)
    expect(host.issuedCount()).toBe(2)
    expect(host.validTokens.has(token)).toBe(true)
    await expect(appInvoke(APP, 'session.list')).resolves.toBeTruthy()
  })

  it('ensureChannelToken 命中缓存不换发（非挂载路径保持幂等）', async () => {
    await refreshChannelToken(APP)
    await ensureChannelToken(APP)
    await ensureChannelToken(APP)
    expect(host.issuedCount()).toBe(1)
  })

  it('签发失败显性上报（挂载槽转错误面，不静默降级）', async () => {
    await refreshChannelToken(APP)
    mockInvoke.mockRejectedValueOnce({ code: 'host.internal', request_id: 'issuefail' })
    await expect(refreshChannelToken(APP)).rejects.toMatchObject({ code: 'host.internal' })
  })
})

describe('凭证被拒后的重签（single-flight）', () => {
  it('并发失败共享一次换发：后签发不作废先签发，重试全部成功', async () => {
    await refreshChannelToken(APP)
    const before = host.issuedCount()
    host.revokeAll() // 缓存里是宿主已回收的死令牌

    const [a, b] = await Promise.all([appInvoke(APP, 'session.list'), appInvoke(APP, 'config.list')])

    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    // 旧实现：两条并发命令各自换发 → 后一张作废前一张 → 至少一条仍被拒。
    // 修复后：single-flight → 只签发一张新令牌。
    expect(host.issuedCount() - before).toBe(1)
  })

  it('每次凭证被拒只换发一张（不叠加签发）', async () => {
    await refreshChannelToken(APP) // token-1
    host.revokeAll()
    // 第一条命令自行完成重签（token-2）
    await expect(appInvoke(APP, 'first')).resolves.toBeTruthy()
    expect(host.issuedCount()).toBe(2)

    // 第二条命令带着 token-2 时宿主仍拒（模拟宿主又回收一次）：必须换发；
    // 但若缓存里已是别的调用换发的新令牌，则复用、不再作废
    host.revokeAll()
    const before = host.issuedCount()
    await expect(appInvoke(APP, 'second')).resolves.toBeTruthy()
    expect(host.issuedCount() - before).toBe(1)
  })
})

describe('业务失败不重试（命令不重放）', () => {
  it('插件命令业务失败：只执行一次，不换签令牌', async () => {
    await refreshChannelToken(APP)
    mockInvoke.mockClear()
    mockInvoke.mockImplementationOnce(async () => {
      // 未标记业务错误 → host.internal + params.plugin（与凭证拒绝的形状区分）
      throw { code: 'host.internal', params: { plugin: APP }, request_id: 'biz00001' }
    })

    await expect(appInvoke(APP, 'session.config.upsert', { name: '' })).rejects.toMatchObject({
      code: 'host.internal',
      params: { plugin: APP },
    })
    const invokes = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'plugin_invoke')
    expect(invokes, '业务失败重放会让一次提交执行两遍').toHaveLength(1)
    expect(tokenIssueCalls()).toBe(0)
  })

  it('存储通道同样只在凭证被拒时换签重试', async () => {
    await refreshChannelToken(APP)
    const before = host.issuedCount()
    host.revokeAll()

    await expect(appStorageGet(APP, 'form-defaults')).resolves.toBeUndefined()
    expect(host.issuedCount() - before).toBe(1)
  })

  it('存储业务失败不重试', async () => {
    await refreshChannelToken(APP)
    mockInvoke.mockClear()
    mockInvoke.mockImplementationOnce(async () => {
      throw { code: 'com.test.app.storage.denied', request_id: 'deny0001' }
    })

    await expect(appStorageGet(APP, 'k')).rejects.toMatchObject({
      code: 'com.test.app.storage.denied',
    })
    const calls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'plugin_storage_get')
    expect(calls).toHaveLength(1)
  })
})
