//! 移动连接全局单例状态（唯一状态真源）
//!
//! 2026-10-25 自 useMobileConnection.ts 拆出：全部模块级 ref / 接口 / computed 集中在此，
//! 其余子模块经此读写同一份状态；本文件不得反向 import 兄弟模块（保持无环）。

import { ref, computed } from 'vue'
import type { ConnectionStatus, RemoteDevice, AuthCredentials } from '../useMobileCommands'

// ==================== State ====================

export const connectionStatus = ref<ConnectionStatus>('disconnected')
export const currentDevice = ref<RemoteDevice | null>(null)
export const connectionError = ref<string | null>(null)
export const isConnecting = ref(false)

// 认证凭据
export const authCredentials = ref<AuthCredentials | null>(null)

// 当前活跃会话 ID
export const activeSessionId = ref<string | null>(null)

// 最后收到的消息
export const lastMessage = ref<any>(null)

// ==================== Global Session State ====================
// 会话配置列表（全局状态，切换页面不丢失）
interface SessionConfigSummary {
  id: string
  name: string
  environment: string
  wsl_distro?: string
  working_dir: string
  command: string
}
export const sessionConfigs = ref<SessionConfigSummary[]>([])
export const isLoadingConfigs = ref(false)
export const hasLoadedConfigs = ref(false)

// 活跃会话列表（全局状态）
export const activeSessions = ref<any[]>([])

// 连接历史（全局状态）
interface ConnectionHistoryItem {
  address: string
  name: string
  lastConnected: string
}
export const connectionHistory = ref<ConnectionHistoryItem[]>([])
export const historyLoaded = ref(false)

// 已配对设备列表（全局状态，认证成功后记录）
// 与连接历史不同：连接历史记录所有尝试连接的设备，已配对设备只记录成功认证的设备
export interface PairedDevice {
  address: string
  port: number
  name: string
  fingerprint: string  // 设备指纹，用于识别同一设备
  pairedAt: string     // 配对时间
  lastConnected: string // 最后连接时间
  connectCount: number  // 连接次数统计
}
export const pairedDevices = ref<PairedDevice[]>([])
export const pairedDevicesLoaded = ref(false)

// ==================== Computed ====================

export const isConnected = computed(() =>
  connectionStatus.value === 'connected' ||
  connectionStatus.value === 'paired'
)

export const isPaired = computed(() =>
  connectionStatus.value === 'paired'
)
