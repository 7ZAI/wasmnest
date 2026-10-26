//! 历史与配对设备域：连接历史 / 已配对设备 localStorage 持久化（自 useMobileConnection.ts 拆出）

import { logger } from '@/utils/frontendLogger'
import { connectionHistory, historyLoaded, pairedDevices, pairedDevicesLoaded, type PairedDevice } from './state'

/**
 * 加载连接历史
 * @param force - 强制从 localStorage 重新读取（页面切换回来时需要，因为其他页面可能直接修改了 localStorage）
 */
export function loadConnectionHistory(force: boolean = false): void {
  if (historyLoaded.value && !force) return
  const stored = localStorage.getItem('connection_history')
  if (stored) {
    try {
      connectionHistory.value = JSON.parse(stored)
    } catch {
      connectionHistory.value = []
    }
  }
  historyLoaded.value = true
}

/**
 * 保存连接历史到 localStorage
 */
export function saveConnectionHistory(): void {
  localStorage.setItem('connection_history', JSON.stringify(connectionHistory.value))
}

/**
 * 添加到连接历史
 */
export function addToConnectionHistory(address: string, name?: string): void {
  connectionHistory.value = connectionHistory.value.filter(item => item.address !== address)
  connectionHistory.value.unshift({
    address,
    name: name || address.split(':')[0],
    lastConnected: new Date().toISOString(),
  })
  if (connectionHistory.value.length > 10) {
    connectionHistory.value = connectionHistory.value.slice(0, 10)
  }
  saveConnectionHistory()
}

/**
 * 从连接历史移除
 */
export function removeFromConnectionHistory(address: string): void {
  connectionHistory.value = connectionHistory.value.filter(item => item.address !== address)
  saveConnectionHistory()
}

/**
 * 清除连接历史
 */
export function clearConnectionHistory(): void {
  connectionHistory.value = []
  saveConnectionHistory()
}

// ==================== Paired Devices Management ====================

/**
 * 加载已配对设备列表
 */
export function loadPairedDevices(): void {
  if (pairedDevicesLoaded.value) return
  const stored = localStorage.getItem('paired_devices')
  if (stored) {
    try {
      pairedDevices.value = JSON.parse(stored)
    } catch {
      pairedDevices.value = []
    }
  }
  pairedDevicesLoaded.value = true
}

/**
 * 保存已配对设备列表到 localStorage
 */
function savePairedDevices(): void {
  localStorage.setItem('paired_devices', JSON.stringify(pairedDevices.value))
}

/**
 * 添加或更新已配对设备
 * 使用设备指纹作为唯一标识，同一设备只记录一次
 */
export function addPairedDevice(device: { address: string; port: number; name: string; fingerprint: string }): void {
  const fullAddress = `${device.address}:${device.port}`
  const now = new Date().toISOString()

  // 查找是否已存在相同指纹的设备（同一设备）
  const existingIndex = pairedDevices.value.findIndex(d => d.fingerprint === device.fingerprint)

  if (existingIndex !== -1) {
    // 已存在，更新信息并增加连接次数
    const existing = pairedDevices.value[existingIndex]
    pairedDevices.value[existingIndex] = {
      ...existing,
      address: device.address,
      port: device.port,
      name: device.name,
      lastConnected: now,
      connectCount: existing.connectCount + 1,
    }
    logger.log('[MobileConnection] Updated paired device:', device.fingerprint,
      'new address:', fullAddress, 'connectCount:', existing.connectCount + 1)
  } else {
    // 新设备，添加到列表开头，初始连接次数为 1
    pairedDevices.value.unshift({
      address: device.address,
      port: device.port,
      name: device.name,
      fingerprint: device.fingerprint,
      pairedAt: now,
      lastConnected: now,
      connectCount: 1,
    })
    logger.log('[MobileConnection] Added new paired device:', device.fingerprint, 'address:', fullAddress)
  }

  // 限制最多保存 10 个设备
  if (pairedDevices.value.length > 10) {
    pairedDevices.value = pairedDevices.value.slice(0, 10)
  }

  savePairedDevices()
}

/**
 * 从已配对设备列表移除
 */
export function removePairedDevice(fingerprint: string): void {
  pairedDevices.value = pairedDevices.value.filter(d => d.fingerprint !== fingerprint)
  savePairedDevices()
}

/**
 * 清除所有已配对设备
 */
export function clearPairedDevices(): void {
  pairedDevices.value = []
  savePairedDevices()
}

/**
 * 根据指纹查找已配对设备
 */
export function findPairedDeviceByFingerprint(fingerprint: string): PairedDevice | undefined {
  return pairedDevices.value.find(d => d.fingerprint === fingerprint)
}
