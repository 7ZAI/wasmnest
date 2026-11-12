/**
 * 自定义监控面板装载（宿主中介）单测
 *
 * 契约（spec `.scratch/2026-10-22-monitor-system-service` §5）：
 * - monitor 只拿容器 + 句柄，宿主经 `loadAppModule` 装载**提供方** bundle；
 * - 提供方未导出 `mountMonitorPanel` = 实现缺失（manifest 声明了面板却挂不上），
 *   fail-visible 点名 appId / panelId，不静默显示空面板；
 * - 装载前仍比对挂载契约版本（与主界面同一把锁）；
 * - 返回句柄必须带 `unmount`，坏句柄按失败处理；
 * - 面板环境是收窄只读面：只有提供方自己的令牌 / 只读存储，没有宿主 `invoke`。
 *
 * 与 `mountContract.test.ts` 同法：`convertFileSrc` 返回 data: URL，走真实
 * 动态 import（loadAppModule / importWithTimeout），只是绕开 asset protocol。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MonitorPanelEnv } from '@/shell/mount/useAppMount'

const asset = vi.hoisted(() => ({ root: '', sources: new Map<string, string>() }))

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) =>
    `data:text/javascript,${encodeURIComponent(asset.sources.get(path) ?? '')}`,
}))
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => parts.join('/'),
}))
vi.mock('@/utils/invoke', () => ({ invoke: vi.fn(async () => asset.root) }))

import { MOUNT_CONTRACT, mountAppMonitorPanel } from '@/shell/mount/useAppMount'

/** 面板装载时提供方 bundle 观察到的 env 与卸载次数 */
interface PanelProbe {
  appId: string
  panelId: string
  locale: string
  theme: string
  platform?: string
  hasHostInvoke: boolean
  hasWriteStorage: boolean
}

declare global {
  // eslint-disable-next-line no-var
  var __monitorPanelProbe: PanelProbe[]
  // eslint-disable-next-line no-var
  var __monitorPanelUnmounted: number
}

function writeBundle(appId: string, source: string): void {
  asset.sources.set(join(asset.root, appId, 'index.js'), source)
}

function panelEnv(appId: string, panelId: string): MonitorPanelEnv {
  return {
    appId,
    panelId,
    appInvoke: async () => null,
    appStorageGet: async () => undefined,
    locale: 'zh-CN',
    theme: 'dark',
    platform: 'desktop',
  }
}

/**
 * 提供方整包桩：记录 env 形状 + 返回可卸载句柄。
 * `handleSource` 可替换成坏句柄（验证宿主 fail-check）。
 */
function panelBundleSource(opts: {
  mountContract?: string
  exportPanel?: boolean
  handleSource?: string
}): string {
  const { mountContract = MOUNT_CONTRACT, exportPanel = true, handleSource } = opts
  const lines = [
    `export const mountContract = '${mountContract}'`,
    `export async function mountApp() { return { async unmount() {} } }`,
  ]
  if (exportPanel) {
    lines.push(
      `export async function mountMonitorPanel(root, env) {`,
      `  globalThis.__monitorPanelProbe.push({`,
      `    appId: env.appId,`,
      `    panelId: env.panelId,`,
      `    locale: env.locale,`,
      `    theme: env.theme,`,
      `    platform: env.platform,`,
      `    hasHostInvoke: 'invoke' in env,`,
      `    hasWriteStorage: 'appStorageSet' in env,`,
      `  })`,
      opts.handleSource ??
        `  return { async unmount() { globalThis.__monitorPanelUnmounted += 1 } }`,
      `}`,
    )
  }
  return lines.join('\n')
}

beforeAll(() => {
  asset.root = mkdtempSync(join(tmpdir(), 'wasmnest-monitor-panel-'))
  globalThis.__monitorPanelProbe = []
  globalThis.__monitorPanelUnmounted = 0
})

afterAll(() => {
  asset.sources.clear()
})

beforeEach(() => {
  globalThis.__monitorPanelProbe.length = 0
  globalThis.__monitorPanelUnmounted = 0
})

describe('mountAppMonitorPanel（宿主中介装载）', () => {
  it('装载提供方面板：env 带 appId / panelId，且是收窄只读面（无宿主 invoke / 无写存储）', async () => {
    const appId = 'com.wasmnest.panel.provider'
    writeBundle(appId, panelBundleSource({}))

    const handle = await mountAppMonitorPanel(document.createElement('div'), panelEnv(appId, 'usage'))

    expect(globalThis.__monitorPanelProbe).toEqual([
      {
        appId,
        panelId: 'usage',
        locale: 'zh-CN',
        theme: 'dark',
        platform: 'desktop',
        hasHostInvoke: false,
        hasWriteStorage: false,
      },
    ])
    await handle.unmount()
    expect(globalThis.__monitorPanelUnmounted).toBe(1)
  })

  it('提供方未导出 mountMonitorPanel → 显性报错，点名 appId / panelId 与缺失原因', async () => {
    const appId = 'com.wasmnest.panel.no-export'
    writeBundle(appId, panelBundleSource({ exportPanel: false }))

    await expect(
      mountAppMonitorPanel(document.createElement('div'), panelEnv(appId, 'health')),
    ).rejects.toThrowError(/com\.wasmnest\.panel\.no-export.*mountMonitorPanel.*health/s)
    expect(globalThis.__monitorPanelProbe).toEqual([])
  })

  it('挂载契约不符 → 先于装载报错（不调用提供方面板实现）', async () => {
    const appId = 'com.wasmnest.panel.stale'
    writeBundle(appId, panelBundleSource({ mountContract: '0' }))

    await expect(
      mountAppMonitorPanel(document.createElement('div'), panelEnv(appId, 'usage')),
    ).rejects.toThrowError(/mountContract.*实际.*"0"/s)
    expect(globalThis.__monitorPanelProbe).toEqual([])
  })

  it('返回坏句柄（无 unmount）→ 按失败处理，不把坏句柄当成功', async () => {
    const appId = 'com.wasmnest.panel.bad-handle'
    writeBundle(appId, panelBundleSource({ handleSource: '  return {}' }))

    await expect(
      mountAppMonitorPanel(document.createElement('div'), panelEnv(appId, 'usage')),
    ).rejects.toThrowError(/com\.wasmnest\.panel\.bad-handle.*mountMonitorPanel.*非法.*usage/s)
  })

  it('同一 bundle 重复装载复用模块缓存（每次仍返回独立句柄，由调用方各自卸载）', async () => {
    const appId = 'com.wasmnest.panel.reuse'
    writeBundle(appId, panelBundleSource({}))

    const first = await mountAppMonitorPanel(document.createElement('div'), panelEnv(appId, 'usage'))
    const second = await mountAppMonitorPanel(document.createElement('div'), panelEnv(appId, 'usage'))

    expect(globalThis.__monitorPanelProbe).toHaveLength(2)
    await first.unmount()
    await second.unmount()
    expect(globalThis.__monitorPanelUnmounted).toBe(2)
  })
})
