/**
 * 前端凭证域（ADR 0058：移动侧 loader 会话 + 插件通道令牌，issue #21 / #28）
 *
 * 语义对照桌面 `wasmnest-desktop/src/utils/appCommands.ts`：
 * - **宿主面凭证**（loader 会话密钥）：宿主前端 bootstrap 在首次使用前取得一次
 *   loader 会话密钥，之后模块级缓存复用；管理类命令与宿主代插件操作都带它。
 * - **插件通道令牌**：由宿主（持 loader 会话的一方）经 `plugin_channel_token`
 *   为**已运行**的插件签发，令牌决定插件面命令（`plugin_invoke` / `plugin_storage_*`
 *   / 自报面）的调用方身份；`plugin_id` 只作目标，两者不符即拒。
 *
 * 页面加载时由移动宿主 lib.rs 的 on_page_load 钩子重置该 webview 的凭证域，
 * 两级缓存随页面卸载一起消失——重新加载的页面重新取得（域内首个调用者生效），
 * 旧凭据无法复活；重复签发会被宿主显性拒绝（fail-visible）。
 *
 * 为什么令牌缓存必须可按 app 作废：宿主在**停用 / 卸载 / 热重载**时回收令牌
 * （`PluginManager::deactivate` → `revoke_plugin`），而本模块的 Map 随页面内存存活。
 * 停用即作废（`pluginDeactivate` 包装内）；重新启用后首次命令懒签发新令牌，
 * 否则同一页面内「停用再启用」会把进入应用的第一批命令全打成凭证错误。
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

/** 插件通道令牌缓存（pluginId → token） */
const channelTokens = new Map<string, string>()

/**
 * 同一插件的**签发在途** promise（single-flight）
 *
 * 宿主对同一插件重新签发会**作废旧令牌**（`issue_token` 覆盖回收）：并发命令
 * 各自「清缓存 → 重签」时，后一张令牌会把前一张作废，先拿到令牌的调用照样被拒。
 * 在途共享后，并发调用拿到同一张新令牌（与桌面 appCommands 同一处踩坑记录的收敛）。
 */
const channelTokenInFlight = new Map<string, Promise<string>>()

/** 作废某插件的缓存令牌（停用 / 卸载 / 重挂载换发前调用） */
export function invalidateChannelToken(pluginId: string): void {
  channelTokens.delete(pluginId)
}

/** 签发新令牌（single-flight） */
async function issueChannelToken(pluginId: string): Promise<string> {
  const inFlight = channelTokenInFlight.get(pluginId)
  if (inFlight) return inFlight
  const pending = (async () => {
    const loaderSession = await ensureHostCredential()
    const token = await invoke<string>('plugin_channel_token', { pluginId, loaderSession })
    // fail-closed：宿主拒签（插件未运行 / 会话失效）时不得当成「无凭证放行」用
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(`plugin_channel_token returned no token for ${pluginId}`)
    }
    channelTokens.set(pluginId, token)
    return token
  })()
  channelTokenInFlight.set(pluginId, pending)
  try {
    return await pending
  } finally {
    // 只清在途登记；令牌缓存由成功路径写入（失败时本就没有新值可清）
    channelTokenInFlight.delete(pluginId)
  }
}

/** 取得插件通道令牌（幂等，命中缓存不换发） */
export async function ensureChannelToken(pluginId: string): Promise<string> {
  const cached = channelTokens.get(pluginId)
  if (cached) return cached
  return issueChannelToken(pluginId)
}
