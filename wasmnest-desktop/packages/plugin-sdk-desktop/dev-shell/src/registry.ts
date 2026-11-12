/**
 * Dev Shell 全局注册表（桌面端 · 挂载包形态）
 * -----------------------------------------------------------------------------
 * 模块级响应式状态：**应用记录**（挂载包 + 领域种子 + 运行态）、**日志**。
 *
 * 2026-10-21 同步到宿主前端（机制 B）后，此前登记 UI 贡献项的那一面
 * （registerSidebarPanel / registerToolboxPage / registerTitleBarItem /
 * registerStatusBarItem / registerInputExtension / registerTerminalToolbarItem /
 * registerPageToolbarItem / registerFileHandler / registerSettingsSection /
 * registerEndpoint / activeView）**整面退役**：桌面宿主已改「同窗口全屏挂载
 * 独立构建的 app 整包」，app 不再向宿主注册任何贡献项，宿主也没有消费这些
 * 注册项的代码路径。留着它们只会让开发者以为贡献面仍受支持。
 */
import { ref } from 'vue'
import type { PluginDevMock } from '../../src/types'
import type { AppBundleModule } from './shell/types'

// ==================== 应用 devMock（领域种子数据） ====================

/** 按 appId 注册的开发期领域数据（loader 在挂载前调用） */
const devMocks = new Map<string, PluginDevMock>()

export function registerDevMock(appId: string, mock: PluginDevMock): void {
  devMocks.set(appId, mock)
}

/** 取指定应用的领域种子（mock 命令实现消费，与移动端 SDK 同构） */
export function getDevMock(appId: string): PluginDevMock | undefined {
  return devMocks.get(appId)
}

// ==================== 日志 ====================

export interface DevLogEntry {
  id: number
  ts: string
  pluginId: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}

const logs = ref<DevLogEntry[]>([])
let nextLogId = 0
const MAX_LOGS = 500

export function pushLog(level: DevLogEntry['level'], pluginId: string, message: string): void {
  const entry: DevLogEntry = {
    id: ++nextLogId,
    ts: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    pluginId,
    level,
    message,
  }
  logs.value.push(entry)
  if (logs.value.length > MAX_LOGS) logs.value.splice(0, logs.value.length - MAX_LOGS)
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(`[dev-shell][${pluginId}] ${message}`)
}

export function clearLogs(): void {
  logs.value = []
}

// ==================== 应用记录 ====================

export type DevAppState = 'loaded' | 'mounted' | 'error'

export interface DevAppRecord {
  /** 应用 id（= manifest.id；缺失时回落 `dev-app-<n>`） */
  id: string
  /** 显示名（manifest.name） */
  name: string
  /** 源清单（plugin.json） */
  manifest: Record<string, unknown>
  /** 挂载包模块（app 的 `src/entry.ts`；未导出 mountApp 时为 null） */
  module: AppBundleModule | null
  /** 应用工程目录（排障用：日志与提示里点明 app 源在哪） */
  dir: string
  state: DevAppState
  /** 装载失败原因（state=error 时非空） */
  error?: string
}

const apps = ref<DevAppRecord[]>([])

export function getAppRecord(appId: string): DevAppRecord | undefined {
  return apps.value.find((a) => a.id === appId)
}

export { apps, logs }
