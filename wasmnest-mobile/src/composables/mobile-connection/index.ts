//! useMobileConnection 门面入口（2026-10-25 自单文件拆分为 mobile-connection/ 目录）
//!
//! 导出面与拆分前逐项一致；模块级 ref 不对外导出（与原单文件口径相同）。

import { readonly } from 'vue'
import {
  connectionStatus,
  currentDevice,
  connectionError,
  isConnecting,
  authCredentials,
  activeSessionId,
  lastMessage,
  sessionConfigs,
  activeSessions,
  connectionHistory,
  pairedDevices,
  isLoadingConfigs,
  hasLoadedConfigs,
  isConnected,
  isPaired,
} from './state'
import {
  connect,
  cancelConnection,
  syncAutoReconnectSetting,
  disconnect,
  authenticate,
  requestPairing,
  verifyPairingCode,
  authenticateWithBiometric,
  saveCredentials,
  clearCredentials,
} from './connection'
import {
  loadSessionConfigs,
  loadActiveSessions,
  startSession,
  stopSession,
  removeSession,
  sendInput,
  clearSessionConfigs,
  clearActiveSessions,
} from './sessions'
import {
  loadConnectionHistory,
  saveConnectionHistory,
  addToConnectionHistory,
  removeFromConnectionHistory,
  clearConnectionHistory,
  loadPairedDevices,
  addPairedDevice,
  removePairedDevice,
  clearPairedDevices,
  findPairedDeviceByFingerprint,
} from './history'

export type { ConnectionStatus, RemoteDevice, AuthCredentials } from '../useMobileCommands'
export type { PairedDevice } from './state'
export { isConnected, isPaired } from './state'
export {
  connect,
  cancelConnection,
  syncAutoReconnectSetting,
  disconnect,
  authenticate,
  requestPairing,
  verifyPairingCode,
  authenticateWithBiometric,
  saveCredentials,
  clearCredentials,
} from './connection'
export {
  loadSessionConfigs,
  loadActiveSessions,
  startSession,
  stopSession,
  removeSession,
  sendInput,
  clearSessionConfigs,
  clearActiveSessions,
} from './sessions'
export {
  loadConnectionHistory,
  saveConnectionHistory,
  addToConnectionHistory,
  removeFromConnectionHistory,
  clearConnectionHistory,
  loadPairedDevices,
  addPairedDevice,
  removePairedDevice,
  clearPairedDevices,
  findPairedDeviceByFingerprint,
} from './history'

/**
 * 移动端连接管理 composable
 *
 * 全局单例模式：连接状态在 app 生命周期内共享。
 * 首次调用时延迟初始化事件监听，后续组件复用同一份状态。
 */
export function useMobileConnection() {
  return {
    // State
    connectionStatus: readonly(connectionStatus),
    currentDevice: readonly(currentDevice),
    connectionError: readonly(connectionError),
    isConnecting,  // 不使用 readonly，允许组件设置
    authCredentials: readonly(authCredentials),
    activeSessionId,
    lastMessage,

    // Global Session State
    sessionConfigs,
    activeSessions,
    connectionHistory,
    pairedDevices,
    isLoadingConfigs,
    hasLoadedConfigs,

    // Computed
    isConnected,
    isPaired,

    // Operations
    connect,
    cancelConnection,
    disconnect,
    authenticate,
    authenticateWithBiometric,
    requestPairing,
    verifyPairingCode,
    loadSessionConfigs,
    loadActiveSessions,
    startSession,
    stopSession,
    removeSession,
    sendInput,
    saveCredentials,
    clearCredentials,

    // Connection History Operations
    loadConnectionHistory,
    saveConnectionHistory,
    addToConnectionHistory,
    removeFromConnectionHistory,
    clearConnectionHistory,

    // Paired Devices Operations
    loadPairedDevices,
    addPairedDevice,
    removePairedDevice,
    clearPairedDevices,
    findPairedDeviceByFingerprint,

    // Clear Operations
    clearSessionConfigs,
    clearActiveSessions,
  }
}