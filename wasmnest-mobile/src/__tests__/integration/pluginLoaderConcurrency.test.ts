/**
 * loader 前端装载并发去重
 *
 * 启动扫描（loadManifests）与用户激活（activate）在 plugins.has 检查与
 * plugins.set 之间隔了多次 await：同一插件并发进入会创建两个 PluginContext
 * （运行面 / 事件监听 / disposable 双份），Map 只留后一份。本用例锁住
 * 「同一插件并发激活只执行一次 module.activate」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PluginInfo } from '@/plugin/types'
import { flushAsync, resetLocalStorage } from './helpers'

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  convertFileSrc: () => '@/__tests__/integration/fixtures/mockLifecyclePlugin',
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}))

function makePluginInfo(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: 'mock-plugin',
    name: 'Mock Plugin',
    version: '1.0.0',
    description: '',
    author: 'test',
    main: 'index.js',
    pluginType: 'frontend',
    permissions: ['ui:route'],
    state: 'loaded',
    contributes: {},
    source: 'builtin',
    extensionPath: '/plugins/mock-plugin',
    sizeBytes: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetLocalStorage()
  ;(globalThis as any).__WASMNEST_SHARED__ = {
    router: { addRoute: vi.fn(() => vi.fn()) },
  }
})

afterEach(() => {
  delete (globalThis as any).__WASMNEST_SHARED__
})

describe('pluginLoader 前端装载并发去重', () => {
  it('同一插件并发 activate：只装载一次、只创建一份运行面', async () => {
    const info = makePluginInfo()
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case 'plugin_frontend_loader_session':
          return Promise.resolve('test-host-loader-session-credential')
        case 'plugin_get_info':
          return Promise.resolve(info)
        case 'plugin_activate':
        case 'plugin_deactivate':
        case 'plugin_mark_error':
          return Promise.resolve(undefined)
        default:
          return Promise.resolve(undefined)
      }
    })

    vi.resetModules()
    const { pluginLoader } = await import('@/plugin/loader')
    const { getShellRegistry } = await import('@/shell/registry')
    const { toShellApp, PLUGIN_APP_SOURCE_ID } = await import('@/shell/adapters/pluginAppSource')
    const registry = getShellRegistry()
    registry.upsertApps(PLUGIN_APP_SOURCE_ID, [toShellApp(info)])

    const mockModule = await import('@/__tests__/integration/fixtures/mockLifecyclePlugin')
    mockModule._resetCounts()

    // 两个入口（启动扫描 / 用户点击）同时进入同一个插件的装载窗口
    await Promise.all([pluginLoader.activate(info.id), pluginLoader.activate(info.id)])
    await flushAsync(3)

    expect(mockModule.activateCallCount).toBe(1)
    expect(registry.getApp(info.id)?.contributions.surface).toBeTruthy()
    expect(pluginLoader.getActivePlugin(info.id)?.module.activate).toBe(mockModule.activate)
  })
})
