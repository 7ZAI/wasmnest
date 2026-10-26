/**
 * 宿主前端命令通道（桌面 UI 宿主修正后：宿主壳的取数通道 + 应用装载环境工厂）
 *
 * 承载两类面（AGENTS §5.1 ①②③ 内）：
 * 1. **宿主面机制命令**：宿主面凭证（loader 会话密钥）、插件通道令牌签发、
 *    授权应答 / 授权读模型（安全闸门）、插件存储（host-plugin-database KV）；
 * 2. **app 装载环境工厂**（useAppMount / AppMountSlot 消费）：按 appId 绑定
 *    令牌与凭证后注入各 wasm app 前端（独立挂载包），app 侧经 env.appInvoke
 *    调用自身 Rust 命令面（plugin_invoke 路由到 WASM 分派臂）。
 *
 * 与旧 `PluginContext.commands.execute` 的差异（D2/D6，均为收窄而非放行）：
 * - 无前端 handler 注册表；无前端权限 map（权限仲裁在 Rust 侧照旧）；
 * - 命令失败**原样上交信封 rejection**（ADR 0030：`{code, request_id, params}`），
 *   由调用方 `resolvePluginErrorText` 解析；技术详情唯一落点仍是日志。
 */

import { invoke } from './invoke'
import { logger } from './frontendLogger'
import { HOST_INTERNAL_CODE, parseInvokeError } from './userError'

// ==================== 凭证与令牌 ====================

/**
 * 宿主面凭证（loader 会话密钥）缓存
 *
 * 宿主前端 bootstrap 在首次使用前取得一次，之后复用（页面加载时由宿主
 * `on_page_load` 钩子重置，本缓存随页面卸载一起消失）。
 */
let hostCredentialCache: string | null = null

/** 取得宿主面凭证（幂等）：宿主面命令（插件面 invoke 之外的存储 / 授权应答）的凭证来源 */
export async function ensureHostCredential(): Promise<string> {
  if (hostCredentialCache) return hostCredentialCache
  hostCredentialCache = await invoke<string>('plugin_frontend_loader_session')
  logger.log('[HostCmd] host credential acquired (loader session)')
  return hostCredentialCache
}

/**
 * 某 app 的前端通道令牌（宿主签发；停用即回收，页面加载后重新签发）
 *
 * 令牌决定插件面命令的身份（`plugin_id` 只作目标），按 appId 分别缓存。
 * 未命中缓存即签发（{@link ensureChannelToken}），签发失败显性上报，不做静默无证调用。
 *
 * **缓存不等于有效**：宿主在插件停用 / 页面加载时回收令牌，而本模块的 Map 随页面
 * 内存存活——挂载路径用 {@link refreshChannelToken} 强制换发，命令失败按
 * {@link isChannelCredentialError} 判定后重签重试。
 */
const channelTokens = new Map<string, string>()

/**
 * 同一 appId 的**签发在途** promise（single-flight）。
 *
 * 为什么必须有：宿主对同一插件重新签发会**作废旧令牌**（`issue_token` 覆盖回收）。
 * 并发命令同时失败时，若各自「清缓存 → 重签」，后一张令牌会把前一张作废——拿到
 * 先签发令牌的调用照样被拒（2026-10-20 实测：进入 BedCode 时会话命令并发重签互踩，
 * 界面弹「操作未完成，请稍后重试」）。在途共享后，并发调用拿到同一张新令牌。
 */
const channelTokenInFlight = new Map<string, Promise<string>>()

/** 清掉某 app 的缓存令牌（停用回收 / 失败重签前调用） */
export function invalidateChannelToken(appId: string): void {
  channelTokens.delete(appId)
}

/** 签发新令牌（single-flight：并发调用共享同一次签发，不互相作废） */
async function issueChannelToken(appId: string): Promise<string> {
  const inFlight = channelTokenInFlight.get(appId)
  if (inFlight) return inFlight
  const pending = (async () => {
    const loaderSession = await ensureHostCredential()
    const token = await invoke<string>('plugin_channel_token', { pluginId: appId, loaderSession })
    channelTokens.set(appId, token)
    logger.log(`[HostCmd] channel token issued (${appId})`)
    return token
  })()
  channelTokenInFlight.set(appId, pending)
  try {
    return await pending
  } finally {
    // 只清在途登记；令牌缓存由成功路径写入（失败时本就没有新值可清）
    channelTokenInFlight.delete(appId)
  }
}

/**
 * 取得 app 的前端通道令牌（幂等，命中缓存不换发）
 *
 * 仅用于「缓存视为有效」的路径；挂载（身份重绑）必须走
 * {@link refreshChannelToken}。需宿主面凭证 + app 处于运行态（Rust 侧由宿主
 * PluginHost 自启，先于前端加载；用户经壳停用后令牌取不到 → 显性报错）。
 */
export async function ensureChannelToken(appId: string): Promise<string> {
  const cached = channelTokens.get(appId)
  if (cached) return cached
  return issueChannelToken(appId)
}

/**
 * 强制换发新令牌（AppMountSlot 挂载前调用）
 *
 * 令牌缓存跨应用挂载存活，但宿主在停用插件时已回收旧令牌：停用再启用（同一页面
 * 不刷新）时缓存里是死令牌，直接复用会把「进入应用的第一批命令」全部打成
 * `host.internal`（2026-10-20：第二次进入 BedCode，会话列表加载被拒）。挂载是身份
 * 重绑点，一律换发。
 */
export async function refreshChannelToken(appId: string): Promise<string> {
  invalidateChannelToken(appId)
  return issueChannelToken(appId)
}

/**
 * 「通道凭证被拒」判定——失败是否重试的唯一分界。
 *
 * 宿主对无效 / 被回收凭证的拒绝走 `AppError::Plugin` → 信封 `host.internal` 且
 * **不带 params**；业务失败要么是插件注册码，要么是带 `params.plugin` 的兜底码。
 * 重试只属于前者：业务命令（如 upsert）失败若一并重试，一次提交会执行两遍
 * （有副作用的命令不可重放）。
 */
function isChannelCredentialError(e: unknown): boolean {
  const ue = parseInvokeError(e)
  return ue.code === HOST_INTERNAL_CODE && !ue.params
}

/**
 * 凭证被拒后的换发（重试前唯一入口）
 *
 * 只在缓存里仍是**刚被拒的那张**令牌时才清缓存换发；并发调用已换发过（缓存里已
 * 是新令牌）→ 直接复用，不再签发——重复签发会作废旧令牌，让先重试的调用再次被拒。
 * 无缓存（并发窗口内已被别的调用清掉）→ 交 issueChannelToken 的 single-flight 合流。
 */
async function reissueAfterRejection(appId: string, rejectedCredential: string): Promise<string> {
  const cached = channelTokens.get(appId)
  if (cached && cached !== rejectedCredential) return cached
  if (cached === rejectedCredential) channelTokens.delete(appId)
  return issueChannelToken(appId)
}

// ==================== 插件面命令（按 appId 路由） ====================

/**
 * 调用某 app 的 Rust 命令（经宿主插件面 invoke 命令路由到 WASM 分派臂）
 *
 * 入参形状与旧 `context.commands.execute(id, ...args)` 一致：单参透传参对象、
 * 多参/零参传数组（Rust 侧按同一约定解析，行为不变）。
 *
 * 失败处理：凭证被拒（令牌已被宿主回收）→ 换发一次再重试；其余失败不重试，
 * 信封原样上交（调用方 resolvePluginErrorText 按 code 取文案），原文 / 堆栈只进
 * 日志，不进用户可见面（ADR 0030）。
 */
export async function appInvoke<T = unknown>(
  appId: string,
  command: string,
  ...args: unknown[]
): Promise<T> {
  const payload = args.length === 1 ? args[0] : args
  const call = (credential: string) =>
    invoke<T>('plugin_invoke', { pluginId: appId, command, args: payload ?? null, credential })
  let used: string | null = null
  try {
    used = await ensureChannelToken(appId)
    return await call(used)
  } catch (e) {
    // used === null = 令牌本身没取到（签发失败），属挂载 / 运行态问题，不重试
    if (used === null || !isChannelCredentialError(e)) {
      logger.error(`[HostCmd] command "${command}" failed: appId=${appId}`, e)
      throw e
    }
    // 令牌已被宿主回收（插件停用 / 页面加载）：换发一次再重试（在途共享，并发不互踩）
    logger.warn(`[HostCmd] channel token rejected, reissuing: appId=${appId} command=${command}`)
    try {
      return await call(await reissueAfterRejection(appId, used))
    } catch (e2) {
      logger.error(`[HostCmd] command "${command}" failed: appId=${appId}`, e2)
      throw e2
    }
  }
}

/** 令牌失效自愈（同 appInvoke 口径）：被拒则换发、再试一次；业务失败不重试 */
async function withAuthRetry<T>(appId: string, run: (credential: string) => Promise<T>): Promise<T> {
  let used: string | null = null
  try {
    used = await ensureChannelToken(appId)
    return await run(used)
  } catch (e) {
    if (used === null || !isChannelCredentialError(e)) throw e
    logger.warn(`[HostCmd] channel token rejected, reissuing: appId=${appId}`)
    return run(await reissueAfterRejection(appId, used))
  }
}

// ==================== 插件存储（host-plugin-database KV，令牌限定 app 命名空间）====================

export async function appStorageGet<T = unknown>(appId: string, key: string): Promise<T | undefined> {
  return (await withAuthRetry(appId, (credential) =>
    invoke('plugin_storage_get', { pluginId: appId, key, credential }),
  )) as T | undefined
}

export async function appStorageSet(appId: string, key: string, value: unknown): Promise<void> {
  return withAuthRetry(appId, (credential) =>
    invoke('plugin_storage_set', { pluginId: appId, key, value, credential }),
  )
}

export async function appStorageDelete(appId: string, key: string): Promise<void> {
  return withAuthRetry(appId, (credential) =>
    invoke('plugin_storage_delete', { pluginId: appId, key, credential }),
  )
}

// ==================== 授权应答（安全闸门，fail-closed）====================

/**
 * 文件授权询问的应答决定（宿主 `fs_auth::FsDecision` 的 wire 值，票 03）
 *
 * - `allow_once`：允许本次，不落账
 * - `allow_remember`：允许并按本次操作集落 allow 记录（仅「默认」档提供）
 * - `deny`：拒绝本次，不落账
 * - `deny_always`：以后都拒绝（落 deny 记录）
 */
export type FsAuthDecision = 'allow_once' | 'allow_remember' | 'deny' | 'deny_always'

/**
 * 回复文件系统授权请求（宿主面命令：需宿主凭证）
 *
 * 授权请求事件是广播的——命令绑定宿主凭证后，app 无法替用户「同意」自己的
 * 文件访问请求（审计票 06 同款威胁模型）。
 */
export async function fsAuthRespond(requestId: string, decision: FsAuthDecision): Promise<void> {
  const credential = await ensureHostCredential()
  return invoke('plugin_fs_auth_respond', { requestId, decision, credential })
}

/**
 * 出站授权询问的三态决定（宿主 `network_auth::NetworkDecision` 的 wire 值）
 *
 * - `allow_once`：允许本次询问覆盖的那批请求，并按 origin 落 allow 记录
 * - `deny`：拒绝本次，不落账
 * - `deny_always`：拒绝本次并落 deny 记录
 */
export type NetworkAuthDecision = 'allow_once' | 'deny' | 'deny_always'

/** 回复网络出站授权请求（宿主面命令：需宿主凭证，同 fs 侧威胁模型） */
export async function networkAuthRespond(
  requestId: string,
  decision: NetworkAuthDecision,
): Promise<void> {
  const credential = await ensureHostCredential()
  return invoke('plugin_network_auth_respond', { requestId, decision, credential })
}

// ==================== 应用授权读模型与策略面（宿主面命令，需宿主凭证）====================

import {
  type AuthStrategy,
  type PluginAuthOverview,
} from '@/shell/auth/authPolicy'

/**
 * 应用授权读模型（spec §9.3）：策略 + 授权记录 + 第一方免询问项
 *
 * 宿主面命令：授权记录是安全闸门的配给账。`pluginId` 省略 = 总览（全部已安装
 * wasm 应用；宿主 Rust 侧自启的四个 app 都在册）。
 */
export async function authOverview(pluginId?: string): Promise<PluginAuthOverview[]> {
  const credential = await ensureHostCredential()
  const apps = await invoke<PluginAuthOverview[]>('plugin_auth_overview', {
    pluginId: pluginId ?? null,
    credential,
  })
  logger.log(`[HostCmd] authOverview(${pluginId ?? 'all'}) returned ${apps.length} app(s)`)
  return apps
}

/**
 * 撤销某目标的授权（spec §8.4：删 allow 记录 + 落一条 `deny` 记录）
 *
 * @returns 被删除的 allow 记录条数（0 = 本就没有 allow 记录）
 */
export async function authRevoke(
  pluginId: string,
  resource: string,
  target: string,
): Promise<number> {
  const credential = await ensureHostCredential()
  const removed = await invoke<number>('plugin_auth_revoke', {
    pluginId,
    resource,
    target,
    credential,
  })
  logger.log(`[HostCmd] authRevoke(${pluginId}/${resource}) removed ${removed} allow record(s)`)
  return removed
}

/**
 * 移除某目标的 `deny` 记录（spec §8.4 的恢复出口：只删 deny，回到未覆盖状态）
 *
 * @returns 被删除的 deny 记录条数（0 = 本就没有 deny 记录）
 */
export async function authRemoveRecord(
  pluginId: string,
  resource: string,
  target: string,
): Promise<number> {
  const credential = await ensureHostCredential()
  const removed = await invoke<number>('plugin_auth_remove_record', {
    pluginId,
    resource,
    target,
    credential,
  })
  logger.log(
    `[HostCmd] authRemoveRecord(${pluginId}/${resource}) removed ${removed} deny record(s)`,
  )
  return removed
}

/**
 * 设置某应用在某资源上的授权策略档位（spec §4.1 三档）
 *
 * 未知档位值由宿主**显性报错**（写面不猜档位：手误写错却静默存成默认档，
 * 用户会以为设置成功了）。
 */
export async function authSetStrategy(
  pluginId: string,
  resource: string,
  strategy: AuthStrategy,
): Promise<void> {
  const credential = await ensureHostCredential()
  await invoke('plugin_auth_set_strategy', { pluginId, resource, strategy, credential })
  logger.log(`[HostCmd] authSetStrategy(${pluginId}/${resource}) = ${strategy}`)
}
