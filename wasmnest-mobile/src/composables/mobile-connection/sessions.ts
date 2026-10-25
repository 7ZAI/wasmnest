//! 会话域：配置列表 / 活跃会话 / 终端数量上限 / 输入发送（自 useMobileConnection.ts 拆出）

import { logger } from '@/utils/frontendLogger'
import i18n from '@/locales'
import { useToast } from '@/composables/useToast'
import { useMobileSettings, defaultMobileSettings } from '@/composables/useMobileSettings'
import * as sessionCommands from '@/plugin/sessionCommands'
import { useHttpApi } from '../useHttpApi'
import { sessionConfigs, hasLoadedConfigs, activeSessions } from './state'

export async function loadSessionConfigs(): Promise<any[]> {
  const { httpListConfigs } = useHttpApi()
  try {
    const result = await httpListConfigs()
    if (result.code === 0 && result.data) {
      const configs = result.data.configs || []
      sessionConfigs.value = configs.map((c: any) => ({
        id: c.id,
        name: c.name,
        environment: c.environment,
        wsl_distro: c.wslDistro,
        working_dir: c.workingDir,
        command: c.command,
      }))
      hasLoadedConfigs.value = true
      return configs
    }
    logger.warn('[MobileConnection] Failed to load session configs via HTTP:', result.message)
    return []
  } catch (e: any) {
    logger.error('[MobileConnection] loadSessionConfigs error:', e?.message || e)
    return []
  }
}

// ==================== 终端数量限制（外观设置 maxOpenTerminals） ====================

/** 当前占用槽位的运行中会话数（running / waitingInput 计入，stopped 为历史记录不占槽位） */
export function runningSessionCount(): number {
  return activeSessions.value.filter(s => s.status === 'running' || s.status === 'waitingInput').length
}

/** 读取「最大可打开终端数量」设置（1-20，非法值回退默认） */
export function maxOpenTerminalsLimit(): number {
  const v = Number(useMobileSettings().settings.value.maxOpenTerminals)
  return Number.isFinite(v) && v > 0
    ? Math.min(20, Math.max(1, Math.round(v)))
    : defaultMobileSettings.maxOpenTerminals
}

/**
 * 加载活跃会话列表（同步桌面端）
 *
 * 数量限制：只同步前 N 个运行中的会话，超出的运行会话丢弃（stopped 会话不占槽位全保留），
 * 有丢弃时 toast 通知用户
 */
export async function loadActiveSessions(): Promise<any[]> {
  const result = await sessionCommands.listSessions()
  if (result.code === 0 && result.data) {
    const sessions = result.data.sessions || []
    const limit = maxOpenTerminalsLimit()

    // 保持原列表顺序，仅丢弃超出上限的「运行中」会话
    const kept: any[] = []
    let runningKept = 0
    for (const s of sessions) {
      const isRunning = s.status === 'running' || s.status === 'waitingInput'
      if (isRunning && runningKept >= limit) continue
      if (isRunning) runningKept++
      kept.push(s)
    }

    const dropped = sessions.length - kept.length
    if (dropped > 0) {
      const toast = useToast()
      toast.warning(i18n.global.t('mobile.session.maxSyncLimited', { max: limit, dropped }))
    }

    activeSessions.value = kept
    return kept
  }
  logger.warn('[MobileConnection] Failed to load sessions via HTTP:', result.message)
  return []
}

/**
 * 启动会话，返回完整会话信息
 *
 * size：本端终端组件按设备屏幕预算的默认网格（computeDeviceDefaultGridSize），
 * 随请求传给主机，PTY 以该尺寸创建；同一设备/朝向下数值稳定
 */
export async function startSession(
  configId: string,
  size?: { cols: number; rows: number }
): Promise<{ sessionId: string; session?: any }> {
  // 数量限制：运行中会话已达上限时拒绝启动（错误由调用方 toast 提示）
  const limit = maxOpenTerminalsLimit()
  if (runningSessionCount() >= limit) {
    throw new Error(i18n.global.t('mobile.session.maxReached', { max: limit }))
  }

  const result = await sessionCommands.startSession(configId, size)
  if (result.code === 0 && result.data) {
    const sessionId = result.data.sessionId
    // 终端订阅由页面驱动（进入终端页时 fresh subscribe 回放环窗口）：
    // 不在会话启动时建连（后台常拉违例；输出由桌面环窗口保留，重播覆盖历史）
    return { sessionId, session: undefined }
  }
  throw new Error(result.message || 'Failed to start session')
}

/**
 * 停止会话：通过 HTTP API 发送停止请求，成功后更新本地状态
 */
export async function stopSession(sessionId: string): Promise<void> {
  const result = await sessionCommands.stopSession(sessionId)
  if (result.code === 0) {
    const index = activeSessions.value.findIndex(s => s.id === sessionId)
    if (index !== -1) {
      activeSessions.value[index].status = 'stopped'
    }
  } else {
    throw new Error(result.message || 'Failed to stop session')
  }
}

/**
 * 删除会话：通过 HTTP API 发送删除请求，成功后更新本地状态
 */
export async function removeSession(sessionId: string): Promise<void> {
  const result = await sessionCommands.removeSession(sessionId)
  if (result.code === 0) {
    activeSessions.value = activeSessions.value.filter(s => s.id !== sessionId)
  } else {
    throw new Error(result.message || 'Failed to remove session')
  }
}

/**
 * 清除会话配置（断开连接时）
 */
export function clearSessionConfigs(): void {
  sessionConfigs.value = []
  hasLoadedConfigs.value = false
}

/**
 * 清除活跃会话（断开连接时）
 */
export function clearActiveSessions(): void {
  activeSessions.value = []
}

/**
 * 发送输入到会话（通过 HTTP API，绕过 WebSocket 阻塞）
 */
export async function sendInput(sessionId: string, data: string, specialKey?: string): Promise<void> {
  const result = await sessionCommands.sendHttpInput(sessionId, data, specialKey)
  if (result.code !== 0) {
    throw new Error(result.message || 'Send input failed')
  }
}
