//! Platform Detection Composable
//!
//! 提供跨平台检测功能
//!
//! 开发环境 (浏览器):
//!   - 通过 URL 参数 ?platform=mobile 模拟移动端
//!   - 通过 localStorage.setItem('platform-mode', 'mobile') 持久化设置
//!
//! 生产环境 (Tauri):
//!   - 使用 @tauri-apps/plugin-os 获取真实平台信息
//!
//! 运行时判定（issue #22 / ADR 0058，2026-10-24）：不再读 `window.__TAURI__`
//! 注入全局——withGlobalTauri=false 后该全局不存在（#16 依赖点 #1 解除）。与
//! 移动端壳内机制副本 `wasmnest-mobile/src/shell/composables/usePlatform.ts`
//! 同形：判定真源是 plugin-os 插件调用本身，插件模块任何环境都能 import，只有
//! 在 Tauri WebView 里带 IPC 桥才会返回已知平台名；名字不在已知集合内一律视为
//! 探测不可信，回落浏览器模拟（行为与旧实现一致）。

import { ref, readonly, onMounted } from 'vue'
import { logger } from '@/utils/frontendLogger'

// Re-export from model
import type { PlatformInfo } from './model'
export type { PlatformInfo }

export type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios'
export type Arch = 'x86_64' | 'aarch64' | 'arm'

const platformInfo = ref<PlatformInfo>({
  platform: null,
  arch: null,
  osVersion: null,
  osType: null,
  isDesktop: false,
  isMobile: true,
  isWindows: false,
  isMacos: false,
  isLinux: false,
  isAndroid: false,
  isIos: false,
})

let initialized = false
let initPromise: Promise<PlatformInfo> | null = null

/** 已知平台名（与 Platform 类型同集合）：返回值不在其中即视为探测不可信 */
const KNOWN_PLATFORMS: readonly string[] = ['windows', 'macos', 'linux', 'android', 'ios']

/**
 * 探测运行时平台名。
 *
 * 返回 `null` = 不在 Tauri 运行时（浏览器 / dev 预览）或插件不可用；调用方据此
 * 落到模拟模式。IPC 桥缺失时拿到的是 undefined / 异常，这类值绝不能被当成
 * 真实平台。
 */
async function detectRuntimePlatform(): Promise<Platform | null> {
  try {
    const { platform } = await import('@tauri-apps/plugin-os')
    const name = platform()
    if (typeof name === 'string' && KNOWN_PLATFORMS.includes(name)) return name as Platform
    logger.log('[Platform] runtime platform unavailable, fall back to browser simulation:', name)
    return null
  } catch (e) {
    logger.log('[Platform] Tauri OS plugin unavailable, fall back to browser simulation:', e)
    return null
  }
}

/** 从 Tauri OS 插件取完整平台信息；非 Tauri 运行时返回 null */
async function detectFromTauri(): Promise<PlatformInfo | null> {
  const platformName = await detectRuntimePlatform()
  if (platformName === null) return null

  try {
    const { arch, version, type } = await import('@tauri-apps/plugin-os')
    const archResult = arch()
    const versionResult = version()
    const typeResult = type()

    const isDesktop = !['android', 'ios'].includes(platformName)
    const isMobile = ['android', 'ios'].includes(platformName)

    const info: PlatformInfo = {
      platform: platformName,
      arch: (archResult as Arch | null) ?? null,
      osVersion: versionResult ?? null,
      osType: typeResult ?? null,
      isDesktop,
      isMobile,
      isWindows: platformName === 'windows',
      isMacos: platformName === 'macos',
      isLinux: platformName === 'linux',
      isAndroid: platformName === 'android',
      isIos: platformName === 'ios',
    }
    logger.log('[Platform] Detected (Tauri):', info)
    return info
  } catch (e) {
    logger.warn('[Platform] Tauri OS plugin metadata unavailable:', e)
    return null
  }
}

function simulateForBrowser(): PlatformInfo {
  const urlParams = new URLSearchParams(window.location.search)
  const urlMode = urlParams.get('platform')
  const storedMode = localStorage.getItem('platform-mode')
  const simulatedPlatform = urlMode || storedMode || 'desktop'

  const isMobile = simulatedPlatform === 'mobile'

  logger.log(
    '[Platform] Browser simulation mode:',
    simulatedPlatform,
    '- Use ?platform=mobile or localStorage to switch',
  )

  return {
    platform: isMobile ? 'android' : 'windows',
    arch: 'x86_64',
    osVersion: 'Browser',
    osType: 'Web',
    isDesktop: !isMobile,
    isMobile,
    isWindows: !isMobile,
    isMacos: false,
    isLinux: false,
    isAndroid: isMobile,
    isIos: false,
  }
}

export function usePlatform() {
  async function detectPlatform() {
    if (initialized) {
      return
    }

    const info = (await detectFromTauri()) ?? simulateForBrowser()

    platformInfo.value = info
    initialized = true
  }

  onMounted(() => {
    detectPlatform()
  })

  return {
    platformInfo: readonly(platformInfo),
    detectPlatform,
  }
}

export async function initPlatform(): Promise<PlatformInfo> {
  if (initialized && platformInfo.value.platform !== null) {
    return platformInfo.value
  }

  if (initPromise) {
    return initPromise
  }

  initPromise = (async () => {
    const info = (await detectFromTauri()) ?? simulateForBrowser()

    platformInfo.value = info
    initialized = true
    return info
  })()

  return initPromise
}
