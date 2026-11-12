/**
 * 移动端错误消费层测试（ADR 0030，与桌面端 `userError.test.ts` 同口径）
 *
 * 覆盖：parseInvokeError 形状矩阵 / showUserError 行为 / userErrorText 纯文案路径 /
 * userErrorFromUnknown 兜底。硬不变量：toast 与展示文案永不渲染
 * code / request_id / 技术详情（详情只进日志）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import i18n from '@/locales'
import { logger } from '@/utils/frontendLogger'
import {
  UserError,
  parseInvokeError,
  showUserError,
  userErrorText,
  userErrorFromUnknown,
  HOST_INTERNAL_CODE,
  FRONTEND_INTERNAL_CODE,
  IPC_TIMEOUT_CODE,
} from '@/utils/userError'

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn(() => 'mock-id'),
    error: vi.fn(() => 'mock-id-error'),
    warning: vi.fn(() => 'mock-id'),
    info: vi.fn(() => 'mock-id'),
  },
}))

import { toast } from 'vue-sonner'
const mockedToast = vi.mocked(toast)

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
})

describe('parseInvokeError：形状矩阵', () => {
  it('正例：对象信封完整映射三字段', () => {
    const ue = parseInvokeError({
      code: 'host.plugin.trap',
      request_id: 'a1b2c3d4',
      params: { name: 'x' },
    })
    expect(ue).toBeInstanceOf(UserError)
    expect(ue.code).toBe('host.plugin.trap')
    expect(ue.requestId).toBe('a1b2c3d4')
    expect(ue.params).toEqual({ name: 'x' })
  })

  it('正例：省略 request_id/params 时得 undefined', () => {
    const ue = parseInvokeError({ code: 'host.internal' })
    expect(ue.code).toBe('host.internal')
    expect(ue.requestId).toBeUndefined()
    expect(ue.params).toBeUndefined()
  })

  it('反例：字符串 / Error / null / undefined / 无 code 对象 → host.internal', () => {
    for (const bad of ['legacy plain error', new Error('backend crashed'), null, undefined, { error: 'nope' }]) {
      expect(parseInvokeError(bad).code).toBe(HOST_INTERNAL_CODE)
    }
  })

  it('反例：code 非字符串 → host.internal', () => {
    expect(parseInvokeError({ code: 404 }).code).toBe(HOST_INTERNAL_CODE)
    expect(parseInvokeError({ code: { nested: 'x' } }).code).toBe(HOST_INTERNAL_CODE)
  })

  it('幂等：UserError 实例原样返回', () => {
    const original = new UserError('host.invoke.timeout', { seconds: 30 }, 'abc12345')
    expect(parseInvokeError(original)).toBe(original)
  })
})

describe('userErrorText：纯文案路径（不发 toast / 不落日志）', () => {
  it('正例：信封 code → errors.<code> 文案 + params 插值', () => {
    expect(
      userErrorText({ code: 'host.plugin.trap', params: { name: '文件传输' } }),
    ).toBe('应用「文件传输」运行异常，已尝试自动恢复')
  })

  it('正例：插件注册码（裸完整 key）→ 插件自己的文案', () => {
    const code = 'com.wasmnest.bedcode.session.error.sessionNotFound'
    i18n.global.mergeLocaleMessage('zh-CN', { [code]: '会话不存在或已结束' })
    expect(userErrorText({ code })).toBe('会话不存在或已结束')
  })

  it('反例：未知 code / 非信封 → host.internal 兜底，不泄露原文', () => {
    const text = userErrorText(new Error('connection refused at 10.0.0.1:8765'))
    expect(text).toBe('操作未完成，请稍后重试')
    expect(text).not.toContain('connection refused')
  })

  it('反例：未知 code 且无插件文案 → host.internal 兜底', () => {
    expect(userErrorText({ code: 'some.future.code' })).toBe('操作未完成，请稍后重试')
  })
})

describe('showUserError：友好提示 + 日志 + 重试', () => {
  it('正例：已知 code → toast 出友好文案，日志带 code + request_id', () => {
    const ue = showUserError({ code: 'host.internal', request_id: 'deadbeef' })
    expect(mockedToast.error).toHaveBeenCalledWith('操作未完成，请稍后重试', { duration: 5000 })
    expect(errorSpy).toHaveBeenCalledWith(
      '[user-error] code=host.internal request_id=deadbeef',
      expect.objectContaining({ code: 'host.internal', request_id: 'deadbeef' }),
    )
    expect(ue.code).toBe('host.internal')
  })

  it('反例（关键）：toast 文案永不包含 code / request_id / 技术详情', () => {
    showUserError({ code: 'host.internal', request_id: 'cafe1234' })
    const message = mockedToast.error.mock.calls[0][0] as string
    expect(message).not.toContain('host.internal')
    expect(message).not.toContain('cafe1234')
    expect(message).not.toContain('10.0.0.1')
  })

  it('边界：未知 code 回退 fallbackCode', () => {
    showUserError({ code: 'some.business.code' }, { fallbackCode: FRONTEND_INTERNAL_CODE })
    expect(mockedToast.error).toHaveBeenCalledWith('操作未完成，请稍后重试', expect.anything())
  })

  it('正例：IPC 超时 + retry 回调 → toast 提供「重试」按钮', () => {
    const retry = vi.fn()
    showUserError(new UserError(IPC_TIMEOUT_CODE, { seconds: 30 }), { retry })
    expect(mockedToast.error).toHaveBeenCalledWith(
      '操作超时，请重试',
      expect.objectContaining({ action: { label: '重试', onClick: retry } }),
    )
  })

  it('反例：非超时码即使提供 retry 也不显示按钮', () => {
    showUserError(new UserError('host.internal'), { retry: () => {} })
    expect((mockedToast.error.mock.calls[0][1] as { action?: unknown }).action).toBeUndefined()
  })

  it('正例：返回归一化 UserError 供调用方继续使用', () => {
    const result = showUserError({ code: 'host.internal', request_id: 'abc' })
    expect(result).toBeInstanceOf(UserError)
    expect(result.code).toBe('host.internal')
    expect(result.requestId).toBe('abc')
  })

  it('en locale 同步：errors.* 基码文案存在', () => {
    i18n.global.locale.value = 'en'
    try {
      expect(i18n.global.t('errors.host.internal')).toBe('Operation failed, please try again')
      expect(i18n.global.t('errors.host.invoke.timeout')).toBe('Operation timed out, please retry')
      expect(i18n.global.t('errors.retry')).toBe('Retry')
      expect(i18n.global.t('errors.host.plugin.not-activated')).toBe(
        'This app is not enabled, this action is unavailable',
      )
      expect(i18n.global.t('mobile.runtimeUnexpected')).toBe(
        'An unexpected error occurred. See logs for details',
      )
    } finally {
      i18n.global.locale.value = 'zh-CN'
    }
  })
})

describe('userErrorFromUnknown：renderer 侧兜底', () => {
  it('返回 frontend.internal 并保留原文到日志', () => {
    const err = new Error('pure frontend bug with details')
    const ue = userErrorFromUnknown(err)
    expect(ue.code).toBe(FRONTEND_INTERNAL_CODE)
    expect(errorSpy).toHaveBeenCalledWith('[user-error] unhandled renderer error:', err)
  })

  it('非 Error 值也能兜底（不抛错）', () => {
    expect(userErrorFromUnknown('oops').code).toBe(FRONTEND_INTERNAL_CODE)
    expect(userErrorFromUnknown(undefined).code).toBe(FRONTEND_INTERNAL_CODE)
  })
})
