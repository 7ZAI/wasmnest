/**
 * app 前端 env.invoke 白名单代理（ADR 0058 方案 A）
 *
 * **审计 / DX 面，不是安全边界**：app 前端跑在宿主同窗口里，本就可以自带
 * @tauri-apps/api 触达 IPC（ADR 0058 F2）；真正的安全边界是 Rust 命令门禁
 * （管理类命令的宿主面凭证门，见桌面 src-tauri 与 wasm-core api_bridge）。
 * 本代理的职责是让「app 调了白名单外的宿主命令」**显性失败**（fail-visible）：
 * warn 留痕 + 点名命令拒绝，而不是放过去由 Rust 门禁以信封错误回复——
 * 两种拒绝混在一起时，排查分不清是前端白名单还是后端门禁拦的。
 *
 * 白名单真源在桌面 Rust：src-tauri/src/commands.rs 的
 * `APP_FRONTEND_INVOKE_WHITELIST`，经 `plugin_frontend_invoke_whitelist`
 * 命令下发（公开只读面），前端不在本文件复制第二份名单。
 */

import { invoke } from '@/utils/invoke'
import { logger } from '@/utils/frontendLogger'

/**
 * 白名单缓存（懒取一次，取用失败不缓存）：每个挂载环境各调一次是多余 IPC，
 * 取用失败（宿主命令尚未就绪等）必须可重试，不能一次失败钉成「本会话永远拒绝」。
 */
let whitelistPromise: Promise<string[]> | null = null

function loadWhitelist(): Promise<string[]> {
  if (!whitelistPromise) {
    whitelistPromise = invoke<string[]>('plugin_frontend_invoke_whitelist').catch((e) => {
      whitelistPromise = null
      throw e
    })
  }
  return whitelistPromise
}

/** 清空白名单缓存（测试用；下次调用重新取用） */
export function resetInvokeWhitelistCache(): void {
  whitelistPromise = null
}

/**
 * app 挂载环境的宿主面 invoke（白名单代理）
 *
 * 在名单内 → 原样透传；不在名单内 → warn 留痕（审计面）+ 显性报错（fail-visible，
 * 点名命令与白名单真源位置），不静默降级成「放过去让 Rust 门禁回错」。
 */
export async function whitelistedHostInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const whitelist = await loadWhitelist()
  if (!whitelist.includes(command)) {
    logger.warn(
      `[AppMount] env.invoke 拒绝：命令 "${command}" 不在 app 前端 env.invoke 白名单` +
        `（真源 = 桌面 src-tauri APP_FRONTEND_INVOKE_WHITELIST，ADR 0058 方案 A）`,
    )
    throw new Error(
      `app 前端 env.invoke 拒绝：命令 "${command}" 不在 app 前端 env.invoke 白名单` +
        `（真源 = 桌面 src-tauri APP_FRONTEND_INVOKE_WHITELIST，ADR 0058 方案 A）`,
    )
  }
  return invoke<T>(command, args ?? {})
}
