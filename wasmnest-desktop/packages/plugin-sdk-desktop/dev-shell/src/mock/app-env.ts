/**
 * Mock 挂载环境（桌面端 dev-shell）
 * -----------------------------------------------------------------------------
 * 构造 `AppMountEnv`（与宿主 `useAppMount.ts` 同形）：宿主在真机上注入真命令通道
 * 与真令牌，dev-shell 注入浏览器实现——
 *
 * - `invoke`（宿主面命令）：少数几个有浏览器语义（`get_app_settings` 读终端字号、
 *   `report_frontend_log` 收前端日志）；其余显性失败（Rust 侧不在浏览器）。
 * - `appInvoke`（插件面命令）：转交领域 mock 表（`mock/commands.ts`）。
 * - 存储：localStorage 持久化（键前缀 `wasmnest-dev-shell:<appId>:`）。
 * - 事件出口：`navigate` / `route` 转交 dev-shell 壳（前者无宿主路由可跳，只记日志；
 *   后者喂 `appSession` 的页面记忆）。
 */
import type { AppMountEnv } from '../shell/types'
import { dispatchCommand } from './commands'
import { pushLog } from '../registry'

/** 存储键前缀（与旧 dev-shell 一致，切换形态不换键：旧的本地数据不丢） */
function storageKey(appId: string, key: string): string {
  return `wasmnest-dev-shell:${appId}:${key}`
}

export interface MockEnvOptions {
  /** 应用 id */
  appId: string
  /** 宿主语言（zh-CN / en） */
  locale: string
  /** 宿主主题（light / dark / system） */
  theme: string
  /** 应用初始路由（应用内存路由的落地路径） */
  initialRoute: string
  /** 事件出口转发（壳侧消费） */
  onEvent?: (type: string, payload: unknown) => void
}

/** 宿主面命令 mock（Rust 侧不在浏览器，只有有浏览器语义的少数几个） */
async function invokeHostCommand(
  appId: string,
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case 'get_app_settings':
      // 终端窗口初值计算读这两个字段（见 app 侧 predictTerminalSize）
      return { ui: { terminal_font_size: 14, terminal_letter_spacing: 0 } }
    case 'report_frontend_log':
      // 前端日志上报：浏览器里没有上报通道，落到 dev-shell 日志面板即可
      pushLog('debug', appId, `前端日志上报（mock）：${JSON.stringify(args?.logs ?? [])}`)
      return undefined
    default:
      pushLog(
        'warn',
        appId,
        `宿主命令 "${command}" 在浏览器不可用（Rust 侧不在 dev-shell 运行），需到真机验证`,
      )
      throw new Error(
        `[dev-shell] 宿主命令 "${command}" 在浏览器不可用，请到真机验证该路径`,
      )
  }
}

/** 构造 mock 挂载环境 */
export function createMockEnv(options: MockEnvOptions): AppMountEnv {
  const { appId, locale, theme, initialRoute } = options
  return {
    appId,
    invoke: (command, args) => invokeHostCommand(appId, command, args) as Promise<never>,
    appInvoke: (command, ...args) =>
      dispatchCommand(appId, command, args) as Promise<never>,
    async appStorageGet<T = unknown>(key: string): Promise<T | undefined> {
      try {
        const raw = localStorage.getItem(storageKey(appId, key))
        return raw === null ? undefined : (JSON.parse(raw) as T)
      } catch {
        return undefined
      }
    },
    async appStorageSet(key: string, value: unknown): Promise<void> {
      try {
        localStorage.setItem(storageKey(appId, key), JSON.stringify(value))
      } catch {
        pushLog('warn', appId, `storage.set("${key}") 失败（localStorage 不可用）`)
      }
    },
    async appStorageDelete(key: string): Promise<void> {
      localStorage.removeItem(storageKey(appId, key))
    },
    locale,
    theme,
    platform: 'desktop',
    initialRoute,
    onEvent: (type, payload) => {
      if (type === 'navigate') {
        // dev-shell 没有宿主路由表可跳（只有一个挂载槽），只记日志说明去向
        pushLog('info', appId, `应用请求宿主导航：${String(payload)}（dev-shell 无宿主路由，忽略）`)
        return
      }
      options.onEvent?.(type, payload)
    },
  }
}
