/**
 * PluginContext 命令面拒绝值提取测试（ADR 0030 信封消费侧）
 *
 * 被测：`src/plugin/context.ts` 的 `commands.execute` WASM 桥回退路径
 * （内部 `pluginCommandError` + 落盘包装）。
 *
 * 背景（2026-11-12 真机缺陷）：宿主 AppError 经 Tauri IPC 以信封对象
 * `{code, request_id, params?}` reject（真源 `wasmnest-server-base::error::AppError::Serialize`，
 * 不含 message / 错误原文）。此前桥把信封拼成
 * `Command not found: <cmd> (host.internal, request_id=…)` 抛出，插件侧再把它
 * 当前缀化 i18n key 查表 → toast 直接显示 `com.wasmnest.<plugin>.Command not found: …`。
 *
 * 现契约：插件拿到的 `message` 必须是可直接展示的友好文案（`errors.<code>`），技术详情
 * 只进日志；信封字段挂在 Error 上供插件侧错误消费层继续映射。
 *
 * | 契约 | 来源 | 规则 | 预期 |
 * |---|---|---|---|
 * | C-E1 | ADR 0030 信封 | `{code, request_id, params?}` 拒绝值 | message = `errors.<code>` 友好文案；Error 上带 code/request_id/params |
 * | C-E2 | 非信封形态 | Error / 纯字符串 / `{message}` | 一律 `errors.host.internal` 友好文案（原文只进日志） |
 * | C-E3 | 畸形兜底 | 空对象 / code 非字符串 / null / 数字 | 同上兜底文案 |
 * | C-E4 | 落盘 | 任意拒绝值 | frontendLogger.error 记命令 id + 原始拒绝值全量形状 |
 * | C-E5 | 本地 handler | 本地注册的 handler | 直接执行，不过桥、不落错误日志 |
 * | C-E6 | 端到端回归 | 失败 message 再交 `context.i18n.t()`（插件 toast 常见写法） | 原样返回，不出现 `com.wasmnest.*` 前缀化垃圾 key |
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockPluginInvoke = vi.fn()
vi.mock('@/plugin/commands', () => ({
  pluginInvoke: (...args: unknown[]) => mockPluginInvoke(...args),
}))

// 通道令牌面替身（issue #28）：本测试的被测对象是**拒绝值提取**，身份签发不是
// 被测面——固定返回一张令牌，命令派发按既有路径进 mockPluginInvoke。
vi.mock('@/plugin/credentials', () => ({
  ensureChannelToken: async () => 'test-channel-token',
}))

const mockLoggerError = vi.fn()
vi.mock('@/utils/frontendLogger', () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}))

import { createPluginContext } from '@/plugin/context'
import type { PluginInfo } from '@/plugin/types'

const PLUGIN_ID = 'com.wasmnest.file-transfer'
const COMMAND = 'file-transfer.list-remote'

/** 最小插件信息（本测试只走 commands 面，其余字段不参与） */
function makeInfo(): PluginInfo {
  return {
    id: PLUGIN_ID,
    name: 'File Transfer',
    version: '1.0.0',
    description: '',
    author: '',
    main: '',
    pluginType: 'wasm' as PluginInfo['pluginType'],
    permissions: [],
    state: 'activated' as PluginInfo['state'],
    contributes: {} as PluginInfo['contributes'],
    source: '',
    assetDir: '',
  } as PluginInfo
}

/** 取 rejection 的 Error 实例（断言完整消息，避免子串匹配漏掉多余内容） */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected rejection, got resolution')
    },
    (e: unknown) => e as Error,
  )
}

describe('PluginContext 命令面拒绝值提取', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('C-E1 信封拒绝值：message 是友好文案，code/request_id/params 挂在 Error 上', async () => {
    const envelope = {
      code: 'host.plugin.trap',
      request_id: 'abc12345',
      params: { name: '文件传输' },
    }
    mockPluginInvoke.mockRejectedValueOnce(envelope)
    const ctx = createPluginContext(makeInfo())

    const err = await rejectionOf(ctx.commands.execute(COMMAND, { path: '', dirId: '' }))

    // 参数经单参直传（既有契约）+ 第 4 参为本插件通道令牌（issue #28：身份绑定）
    expect(mockPluginInvoke).toHaveBeenCalledWith(PLUGIN_ID, COMMAND, { path: '', dirId: '' }, 'test-channel-token')
    // 用户面：errors.<code> 模板 + params 插值；技术标识只挂字段、不进 message
    expect(err.message).toBe('应用「文件传输」运行异常，已尝试自动恢复')
    expect(err.message).not.toContain('host.plugin.trap')
    expect(err.message).not.toContain('abc12345')
    expect((err as Error & { code?: string }).code).toBe('host.plugin.trap')
    expect((err as Error & { request_id?: string }).request_id).toBe('abc12345')
    expect((err as Error & { params?: unknown }).params).toEqual({ name: '文件传输' })
  })

  it('C-E1 真机形态信封（host.internal + no active peer 场景）', async () => {
    mockPluginInvoke.mockRejectedValueOnce({ code: 'host.internal', request_id: 'ff09841a' })
    const ctx = createPluginContext(makeInfo())

    const err = await rejectionOf(ctx.commands.execute(COMMAND, {}))
    expect(err.message).toBe('操作未完成，请稍后重试')
    expect(err.message).not.toContain('request_id')
    expect((err as Error & { request_id?: string }).request_id).toBe('ff09841a')
  })

  it('C-E1 request_id 缺失时 message 不变、字段为 undefined', async () => {
    mockPluginInvoke.mockRejectedValueOnce({ code: 'host.internal' })
    const ctx = createPluginContext(makeInfo())

    const err = await rejectionOf(ctx.commands.execute(COMMAND))

    expect(err.message).toBe('操作未完成，请稍后重试')
    expect((err as Error & { request_id?: string }).request_id).toBeUndefined()
  })

  it('C-E2 Error 实例拒绝值：用户面兜底文案，原文只进日志', async () => {
    mockPluginInvoke.mockRejectedValueOnce(new Error('wasm trap: unreachable executed'))
    const ctx = createPluginContext(makeInfo())

    const err = await rejectionOf(ctx.commands.execute(COMMAND))
    expect(err.message).toBe('操作未完成，请稍后重试')
    expect(err.message).not.toContain('wasm trap')
    expect(mockLoggerError).toHaveBeenCalledTimes(1)
  })

  it('C-E2 纯字符串拒绝值：用户面兜底文案（旧形态兼容但不外泄原文）', async () => {
    mockPluginInvoke.mockRejectedValueOnce('no active peer')
    const ctx = createPluginContext(makeInfo())

    const err = await rejectionOf(ctx.commands.execute(COMMAND))
    expect(err.message).toBe('操作未完成，请稍后重试')
    expect(err.message).not.toContain('no active peer')
  })

  it('C-E2 带 message 的对象拒绝值：无 code 信封 → 兜底文案', async () => {
    mockPluginInvoke.mockRejectedValueOnce({ message: 'plugin not activated' })
    const ctx = createPluginContext(makeInfo())

    const err = await rejectionOf(ctx.commands.execute(COMMAND))
    expect(err.message).toBe('操作未完成，请稍后重试')
    expect(err.message).not.toContain('plugin not activated')
  })

  it('C-E3 畸形拒绝值一律无 detail（空对象 / code 非字符串 / null / 数字）', async () => {
    const ctx = createPluginContext(makeInfo())

    for (const malformed of [{}, { code: 42, request_id: 'x' }, null, 42]) {
      mockPluginInvoke.mockRejectedValueOnce(malformed)
      const err = await rejectionOf(ctx.commands.execute(COMMAND))
      expect(err.message, `畸形拒绝值 ${JSON.stringify(malformed)} 应走兜底文案`).toBe(
        '操作未完成，请稍后重试',
      )
    }
  })

  it('C-E4 任意拒绝值都落盘全量形状（信封对象原引用 + 命令 id）', async () => {
    const envelope = { code: 'host.internal', request_id: 'ff09841a' }
    mockPluginInvoke.mockRejectedValueOnce(envelope)
    const ctx = createPluginContext(makeInfo())

    await rejectionOf(ctx.commands.execute(COMMAND, {}))

    expect(mockLoggerError).toHaveBeenCalledTimes(1)
    const [message, logged] = mockLoggerError.mock.calls[0]!
    expect(String(message)).toContain(COMMAND)
    // 原始拒绝值原样落盘（不是提取后的字符串）：信封字段在日志里保持可 grep
    expect(logged).toBe(envelope)
  })

  it('C-E6 失败消息再交 i18n.t：原样返回，不产出前缀化垃圾 key', async () => {
    // 真机回归（2026-11-12）：插件 `toast.showToast(t(err.message))`，
    // 旧实现 t() 会给错误正文加插件前缀 → `com.wasmnest.xxx.Command not found: …`。
    mockPluginInvoke.mockRejectedValueOnce({ code: 'host.internal', request_id: '1c928a08' })
    const ctx = createPluginContext(makeInfo())

    const err = await rejectionOf(ctx.commands.execute(COMMAND))
    const shown = ctx.i18n.t(err.message)
    expect(shown).toBe(err.message)
    expect(shown).not.toContain(PLUGIN_ID)
    expect(shown).not.toContain('request_id')
  })

  it('C-E5 本地 handler 直接执行：不过 WASM 桥、不落错误日志', async () => {
    const ctx = createPluginContext(makeInfo())
    ctx.commands.register('local.cmd', (a: number, b: number) => a + b)

    await expect(ctx.commands.execute('local.cmd', 1, 2)).resolves.toBe(3)

    expect(mockPluginInvoke).not.toHaveBeenCalled()
    expect(mockLoggerError).not.toHaveBeenCalled()
  })
})
