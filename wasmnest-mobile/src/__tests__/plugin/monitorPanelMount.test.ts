/**
 * 移动端自定义监控面板装载（宿主中介）单测
 *
 * 契约（spec `.scratch/2026-10-22-monitor-system-service` §5）：
 * - 宿主只 import 提供方前端模块并调用可选 `mountMonitorPanel`，**不调用
 *   `activate`**（面板是只读旁路，不因被监控而启动应用后端）；
 * - 提供方未导出 / 返回坏句柄 → fail-visible，点名 appId / panelId；
 * - 面板 env 用提供方自己的通道（appInvoke / 只读 storage），不带宿主 invoke；
 * - 面板实例由调用方（monitor）持有句柄卸载。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pluginGetInfo: vi.fn(),
  pluginInvoke: vi.fn(),
  pluginStorageGet: vi.fn(),
  loadPluginModuleScoped: vi.fn(),
  disposeAppRunScope: vi.fn(),
}))

vi.mock('@/plugin/commands', () => ({
  pluginGetInfo: (...args: unknown[]) => mocks.pluginGetInfo(...args),
  pluginInvoke: (...args: unknown[]) => mocks.pluginInvoke(...args),
  pluginStorageGet: (...args: unknown[]) => mocks.pluginStorageGet(...args),
}))

vi.mock('@/plugin/app-run-scope', () => ({
  loadPluginModuleScoped: (...args: unknown[]) => mocks.loadPluginModuleScoped(...args),
  disposeAppRunScope: (...args: unknown[]) => mocks.disposeAppRunScope(...args),
}))

import i18n from '@/locales'
import { pluginLoader } from '@/plugin/loader'
import type { MonitorPanelEnv } from '@/plugin/types'

const APP_ID = 'com.wasmnest.panel.provider'

function providerInfo(): unknown {
  return {
    id: APP_ID,
    name: 'Provider',
    version: '1.0.0',
    extensionPath: '/plugins/com.wasmnest.panel.provider',
    main: 'index.js',
  }
}

function container(): HTMLElement {
  return document.createElement('div')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.pluginGetInfo.mockResolvedValue(providerInfo())
  mocks.pluginInvoke.mockResolvedValue('invoked')
  mocks.pluginStorageGet.mockResolvedValue('stored')
})

describe('PluginLoader.mountMonitorPanel（宿主中介）', () => {
  it('装载提供方面板：env 绑定提供方通道，且不调用 activate', async () => {
    const unmount = vi.fn()
    const activate = vi.fn()
    let observed: MonitorPanelEnv | null = null
    mocks.loadPluginModuleScoped.mockResolvedValue({
      activate,
      async mountMonitorPanel(_root: HTMLElement, env: MonitorPanelEnv) {
        observed = env
        return { unmount }
      },
    })

    const handle = await pluginLoader.mountMonitorPanel(container(), APP_ID, 'usage')

    expect(mocks.loadPluginModuleScoped).toHaveBeenCalledWith(APP_ID, expect.any(Function))
    expect(activate).not.toHaveBeenCalled()
    expect(observed).not.toBeNull()
    expect(observed!.appId).toBe(APP_ID)
    expect(observed!.panelId).toBe('usage')
    expect(observed!.platform).toBe('mobile')
    expect(observed!.locale).toBe(i18n.global.locale.value)
    expect(['dark', 'light']).toContain(observed!.theme)

    // 面板命令 / 只读存储走提供方自己的通道（不是 monitor 的）
    await observed!.appInvoke('usage.get', { limit: 10 })
    expect(mocks.pluginInvoke).toHaveBeenCalledWith(APP_ID, 'usage.get', { limit: 10 })
    await observed!.appStorageGet('cache')
    expect(mocks.pluginStorageGet).toHaveBeenCalledWith(APP_ID, 'cache')

    await handle.unmount()
    expect(unmount).toHaveBeenCalledTimes(1)
  })

  it('提供方不存在 → 显性报错（点名 appId）', async () => {
    mocks.pluginGetInfo.mockResolvedValue(null)

    await expect(pluginLoader.mountMonitorPanel(container(), APP_ID, 'usage')).rejects.toThrowError(
      new RegExp(APP_ID),
    )
    expect(mocks.loadPluginModuleScoped).not.toHaveBeenCalled()
  })

  it('提供方未导出 mountMonitorPanel → 显性报错，点名 appId / panelId', async () => {
    mocks.loadPluginModuleScoped.mockResolvedValue({ activate: vi.fn() })

    await expect(pluginLoader.mountMonitorPanel(container(), APP_ID, 'health')).rejects.toThrowError(
      new RegExp(`${APP_ID}.*mountMonitorPanel.*health`, 's'),
    )
  })

  it('返回坏句柄（无 unmount）→ 按失败处理', async () => {
    mocks.loadPluginModuleScoped.mockResolvedValue({
      mountMonitorPanel: vi.fn(async () => ({})),
    })

    await expect(pluginLoader.mountMonitorPanel(container(), APP_ID, 'usage')).rejects.toThrowError(
      /invalid handle/,
    )
  })
})
