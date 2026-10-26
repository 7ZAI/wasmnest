/**
 * HTTP API Client Composable
 *
 * 移动端直接调用桌面端 HTTP REST API（ticket 03/07 收束：HTTP 全部经 Rust 统一代理）
 * - 所有请求走 `invoke('http_request')`，request_id 多路复用（D1/D3）
 * - JWT 注入 / 链路加密信封 / 超时 / 取消 / 日志全部在 Rust 端（前端只渲染）
 * - Egress：desktop 类请求经 L1 桌面端目标放行（setApiBaseUrl/httpProbe 时声明目标）
 *
 * 业务端点包装函数已随票 2026-10-10 C4 下沉 bedcode 应用（auth/session/file/git/
 * 任务历史/定时任务等），本文件只保留通用通道与配置/探活面（2026-10-25 死导出清理）。
 */

import { ref } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { invoke } from '@tauri-apps/api/core'
import { logger } from '@/utils/frontendLogger'

// ==================== Config ====================

const API_BASE_URL = ref<string>('')

/** http_request 响应形状（Rust 侧 HttpProxyResponse） */
interface HttpProxyResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  bodyText: string
}

// ==================== Core HTTP Client ====================

export interface ApiResult<T = any> {
  code: number
  message: string
  data?: T
}

async function request<T = any>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResult<T>> {
  const baseUrl = API_BASE_URL.value

  if (!baseUrl) {
    logger.error('[HttpApi] No base URL set, cannot make request to', path)
    return { code: -1, message: 'Not connected: no base URL set' }
  }

  const url = `http://${baseUrl}${path}`
  const requestId = uuidv4()

  // body 归一化：字符串原样，对象 JSON.stringify（与 httpRequest 通道一致）
  const body =
    typeof options.body === 'string'
      ? options.body
      : options.body !== undefined && options.body !== null
        ? JSON.stringify(options.body)
        : null

  try {
    logger.log('[HttpApi] Request:', options.method || 'GET', url)
    // Rust 命令签名 http_request(request: HttpProxyRequest, ...)——tauri 按参数名
    // 反序列化，必须嵌套 request 对象；平面传参会报 missing required key request
    //
    // 默认 application/json：桌面端 actix web::Json extractor 无此头即 400
    // Content type error（HTTP 收束 Rust 代理 6d5eeb18b 时丢失的默认头）；
    // 调用方显式指定（如 multipart / 自定义类型）时以显式值为准
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    }
    const resp = await invoke<HttpProxyResponse>('http_request', {
      request: {
        requestId,
        method: options.method || 'GET',
        url,
        headers,
        body,
        timeoutMs: 30000,
        kind: 'desktop',
      },
    })

    // HTTP 非 2xx：返回状态码（code=status，与迁移前语义一致）
    if (resp.status < 200 || resp.status >= 300) {
      const text = resp.bodyText || ''
      logger.error('[HttpApi] HTTP error:', resp.status, resp.statusText, text)
      return { code: resp.status, message: `HTTP ${resp.status}: ${resp.statusText}` }
    }

    // JWT / 加密信封 / pin 刷新均由 Rust 代理完成（bodyText 已解密）
    const result = JSON.parse(resp.bodyText)
    logger.log('[HttpApi] Response OK:', path, 'code=', result.code)
    return result
  } catch (e: any) {
    // invoke 拒绝 = Egress 拒绝（EXTERNAL_URL_*）/ 加密失败（LINK_ENCRYPTION_*）/
    // 取消（REQUEST_CANCELED）/ 网络错误——message 携带 Rust 侧错误码
    logger.error('[HttpApi] Fetch failed:', path, e?.message || e)
    return { code: -1, message: e?.message || String(e) }
  }
}

// ==================== 通用请求通道（插件 shared runtime mobileApi 用） ====================
/**
 * 通用对端 REST 请求选项（插件经 mobileApi.httpRequest 访问；body 支持对象或字符串） */
export interface MobileHttpRequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

/**
 * 外部 URL 请求（Egress external 类：L1/L2/L3 全层判定，未声明 → 弹窗）
 *
 * 供 useUpdateChecker（GitHub API 经宿主内置 L2 声明放行）等外网调用面使用；
 * 返回 Rust `HttpProxyResponse` 形状（调用方自行解析 bodyText）。
 */
export async function externalRequest(
  url: string,
  options: MobileHttpRequestOptions = {},
): Promise<HttpProxyResponse> {
  const requestId = uuidv4()
  return invoke<HttpProxyResponse>('http_request', {
    request: {
      requestId,
      method: options.method || 'GET',
      url,
      headers: options.headers || {},
      body: null,
      timeoutMs: 30000,
      kind: 'external',
    },
  })
}

/**
 * 通用 HTTP 请求：与内部 request 一致（JWT 注入 / 链路加密 / 错误归一化），
 * body 为对象时自动 JSON.stringify（与既有业务包装函数行为对齐）。
 * 具体插件业务端点由各插件工程基于本通道自行封装，宿主不感知插件领域。
 */
export function httpRequest<T = any>(
  path: string,
  options: MobileHttpRequestOptions = {},
): Promise<ApiResult<T>> {
  const body =
    typeof options.body === 'string'
      ? options.body
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined
  return request<T>(path, { ...options, body } as RequestInit)
}

// ==================== Config API ====================

export async function httpListConfigs() {
  return request<{ configs: any[] }>('/api/configs')
}

// ==================== Auto Task Queue API ====================

/** 队列任务项 */
export interface AutoTaskQueueItem {
  id: string
  prompt: string
  position: number
  status: string
  created_at: string
}

/** 任务队列列表响应 */
export interface QueueListResponse {
  session_id: string
  tasks: AutoTaskQueueItem[]
  queue_count: number
  /** 当前处理中的队列项（waiting=等待 clear 后下发 / executing=已下发未完成），对账与状态展示用 */
  active_task?: AutoTaskQueueItem | null
}

/** 查询任务队列 */
export async function httpTaskQueueList(sessionId: string) {
  return request<QueueListResponse>(
    `/api/plugin/com.wasmnest.bedcode/task-queue/list?session_id=${encodeURIComponent(sessionId)}`
  )
}

// ==================== Setup ====================

export function setApiBaseUrl(address: string, port: number) {
  API_BASE_URL.value = `${address}:${port}`
  // Egress L1：声明桌面端目标（httpProbe 在 ws_connect 前执行，target 未设——
  // 此处提前声明使 probe/会话内 desktop 类请求放行，时序见 ticket 03 方案 a）
  invoke('egress_declare_desktop_target', { address, port }).catch(() => {
    // 声明失败（如测试环境无后端）不阻断；L1 判定在 Rust 端兜底
  })
}

// ==================== Connectivity Probe ====================

/** HTTP 探测结果 */
export interface ProbeResult {
  reachable: boolean
  status?: string
  port?: number
  uptimeSecs?: number
  error?: string
}

/**
 * 探测桌面端 HTTP 服务是否可达
 *
 * 在 WS 连接前调用，3 秒超时快速判断网络连通性。
 * 失败时立即返回而非等待 10 秒 WS 超时。
 * 经统一代理（desktop 类 + L1 放行）；Rust 端先行声明目标。
 */
export async function httpProbe(address: string, port: number): Promise<ProbeResult> {
  const url = `http://${address}:${port}/api/health`
  logger.log('[HttpApi] Probing:', url)

  try {
    // 声明目标（L1；probe 在 ws_connect 前，ConnectionManager.target 未设）
    await invoke('egress_declare_desktop_target', { address, port })
    const resp = await invoke<HttpProxyResponse>('http_request', {
      request: {
        requestId: uuidv4(),
        method: 'GET',
        url,
        headers: {},
        body: null,
        timeoutMs: 3000,
        kind: 'desktop',
      },
    })

    if (resp.status !== 200) {
      return { reachable: false, error: `HTTP ${resp.status}` }
    }

    const data = JSON.parse(resp.bodyText)
    logger.log('[HttpApi] Probe success:', data)
    return {
      reachable: true,
      status: data.status,
      port: data.port,
      uptimeSecs: data.uptime_secs,
    }
  } catch (e: any) {
    logger.warn('[HttpApi] Probe failed:', e?.message || e)
    return { reachable: false, error: e?.message || String(e) }
  }
}

export function useHttpApi() {
  return {
    setApiBaseUrl,
    httpProbe,
    httpRequest,
    externalRequest,
    // Config
    httpListConfigs,
    // Auto Task Queue
    httpTaskQueueList,
  }
}
