/**
 * 前端错误消费层（ADR 0030 错误信封 & 用户提示边界）— 移动端
 *
 * 与桌面端 `wasmnest-desktop/src/utils/userError.ts` 同口径，收敛点：
 * 全部 Tauri invoke rejection / 事件失败 / renderer 未知异常统一归一到
 * `UserError { code, requestId, params? }`，三个收敛函数：
 * - `parseInvokeError(e)`   invoke rejection 解析（对象信封 | 其余形状 → host.internal）
 * - `showUserError(err)`    集中友好 toast + 日志落盘；永不渲染 code / request_id / 技术详情
 * - `userErrorFromUnknown(e)` renderer 侧未知异常 → frontend.internal
 * 另有 `userErrorText(err)`：只需要文案、不需要 toast 的路径（通知栏正文 /
 * 插件命令错误包装）复用同一查表，避免各处自拼技术串。
 *
 * UI 呈现规则（硬）：toast / 页面只显示友好文案（`errors.<code>` 模板 + params
 * 插值），不显示任何错误码；技术详情唯一的落点是产生方进程日志
 * （Rust tracing / 前端 logger）。
 */

import { toast } from 'vue-sonner'
import i18n from '@/locales'
import { logger } from '@/utils/frontendLogger'

/** 兜底码：未映射 / 畸形形状一律落此（i18n key = `errors.host.internal`） */
export const HOST_INTERNAL_CODE = 'host.internal'
/** renderer 侧未知异常兜底码（i18n key = `errors.frontend.internal`） */
export const FRONTEND_INTERNAL_CODE = 'frontend.internal'
/** IPC 超时码——v1 唯一提供「重试」按钮的码（i18n key = `errors.host.invoke.timeout`） */
export const IPC_TIMEOUT_CODE = 'host.invoke.timeout'

/** 边界信封形状（与 Rust `AppError` Serialize 输出一致） */
export interface ErrorEnvelope {
  code: string
  request_id?: string
  params?: Record<string, unknown>
}

/**
 * 前端统一错误类型：跨边界失败在 renderer 侧的规范形状。
 * `message` 仅为内部占位（存 code），**永不作展示用途**——展示走 userErrorText / showUserError。
 */
export class UserError extends Error {
  readonly code: string
  readonly requestId?: string
  readonly params?: Record<string, unknown>

  constructor(code: string, params?: Record<string, unknown>, requestId?: string) {
    super(code)
    this.name = 'UserError'
    this.code = code
    this.params = params
    this.requestId = requestId
  }
}

/** 形状守卫：信封对象（code 为字符串即可识别；畸形/缺失一律走兜底） */
function isEnvelopeShape(e: unknown): e is ErrorEnvelope {
  return typeof e === 'object' && e !== null && typeof (e as ErrorEnvelope).code === 'string'
}

/**
 * 解析 invoke rejection → UserError。
 *
 * - 对象信封 `{code, request_id?, params?}`（Rust AppError 序列化产物）→ 原样映射
 * - 其余任意形状（Error / 遗留字符串 / null / 无 code 对象）→ `host.internal` 兜底
 *
 * 兜底形状的原文只由调用方落日志：本函数保持纯解析（不落日志——展示路径
 * showUserError 统一记录），便于形状矩阵测试与 dup 排查。
 */
export function parseInvokeError(e: unknown): UserError {
  if (e instanceof UserError) return e
  if (isEnvelopeShape(e)) {
    return new UserError(e.code, e.params, e.request_id)
  }
  return new UserError(HOST_INTERNAL_CODE)
}

/** 懒取 t：i18n 实例可能在测试中被 mock；模块加载期绑定会让 mock 失效 */
function t(key: string, params?: Record<string, unknown>): string {
  // 无插值参数时不传空对象：部分 i18n 替身（单测 mock）会据「参数存在」改写返回值
  return params ? i18n.global.t(key, params) : i18n.global.t(key)
}

/**
 * 翻译友好文案（ADR 0030 决定 4「code 即 i18n key」，零映射层）：
 * 1. `errors.<code>`（宿主域 / 前端域注册表）
 * 2. 裸 `<code>`——插件域注册码（`<plugin_id>.<namespace>.<name>`，插件
 *    registerMessages 后 key 即全文；宿主不预埋插件文案，只在这里回退查找）
 * 3. `errors.host.internal` 兜底
 *
 * 判据沿用桌面端「t 未注册返回 key 原文」：`t(key) !== key` 才算命中。
 * 不用 `te`——扁平 key 不被 `te` 识别，且测试 mock 的 i18n 只提供 t。
 */
function lookupMessage(
  code: string,
  params?: Record<string, unknown>,
  fallbackCode?: string,
): string {
  const withErrors = `errors.${code}`
  const resolved = t(withErrors, params)
  if (resolved !== withErrors) return resolved
  const bare = t(code, params)
  if (bare !== code) return bare
  const fallback = fallbackCode ?? HOST_INTERNAL_CODE
  return t(`errors.${fallback}`)
}

/**
 * 只取用户可见文案（不发 toast、不落日志）：
 * 供通知栏正文、插件命令包装等需要字符串的路径复用同一查表。
 */
export function userErrorText(err: unknown): string {
  const ue = err instanceof UserError ? err : parseInvokeError(err)
  return lookupMessage(ue.code, ue.params)
}

/** showUserError 选项 */
export interface ShowUserErrorOptions {
  /** `errors.<code>` 缺文案时的回退码（如 expand 阶段尚未落文案的业务码） */
  fallbackCode?: string
  /** 重试回调——仅 `host.invoke.timeout` 且提供回调时 toast 显示「重试」按钮 */
  retry?: () => void
}

/**
 * 集中友好提示：toast 显示 `errors.<code>` 文案（params 插值），logger 记录 code +
 * request_id + 原始错误（error 级，release 下同样转发落盘，见 frontendLogger）。
 *
 * 硬不变量：toast 文本永不包含 code / request_id / 技术详情；未知 code 回退
 * fallbackCode / host.internal 文案。v1 仅 `host.invoke.timeout` 码支持重试按钮。
 *
 * @returns 归一化后的 UserError（调用方可继续处理 / 断言）
 */
export function showUserError(err: unknown, options?: ShowUserErrorOptions): UserError {
  const ue = err instanceof UserError ? err : parseInvokeError(err)
  const message = lookupMessage(ue.code, ue.params, options?.fallbackCode)

  // 日志：code + request_id + 原始错误全量（技术详情的唯一前端落点）
  logger.error(`[user-error] code=${ue.code} request_id=${ue.requestId ?? '-'}`, err)

  const toastOptions: Record<string, unknown> = { duration: 5000 }
  if (ue.code === IPC_TIMEOUT_CODE && options?.retry) {
    toastOptions.action = { label: t('errors.retry'), onClick: options.retry }
  }
  toast.error(message, toastOptions)
  return ue
}

/**
 * renderer 侧未知异常兜底（非 invoke 路径：纯前端逻辑抛错等）：
 * 日志留全量原文，返回 `frontend.internal` UserError。
 */
export function userErrorFromUnknown(e: unknown): UserError {
  logger.error('[user-error] unhandled renderer error:', e)
  return new UserError(FRONTEND_INTERNAL_CODE)
}
