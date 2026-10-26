/**
 * 宿主面凭证（ADR 0058 方案 A：移动宿主面凭证域，issue #21）
 *
 * 语义对照桌面 `wasmnest-desktop/src/utils/appCommands.ts` 的 ensureHostCredential：
 * 宿主前端 bootstrap 在首次使用前取得一次 loader 会话密钥，之后模块级缓存复用。
 * 页面加载时由移动宿主 lib.rs 的 on_page_load 钩子重置该 webview 的凭证域，
 * 缓存随页面卸载一起消失——重新加载的页面重新取得（域内首个调用者生效），
 * 旧密钥无法复活；重复签发会被宿主显性拒绝（fail-visible）。
 */

import { invoke } from '@tauri-apps/api/core'

/** 宿主面凭证缓存（null = 尚未取得） */
let hostCredentialCache: string | null = null

/** 取得宿主面凭证（幂等）：管理类命令（插件面 invoke 之外的宿主职权操作）的凭证来源 */
export async function ensureHostCredential(): Promise<string> {
  if (hostCredentialCache) return hostCredentialCache
  hostCredentialCache = await invoke<string>('plugin_frontend_loader_session')
  return hostCredentialCache
}
