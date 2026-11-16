import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 应用图标 URL 解析契约（appIcons）
 *
 * 需求来源：主屏 / 多任务的图标要显示**各 wasm-app 原来那张**（应用包自带
 * `manifest.icon`），不是宿主哈希派生的通用 glyph。
 *
 * 主通道：宿主 `plugin_get_asset_text` 读出 SVG 文本 → data URL（WebKitGTK 自定义
 * asset 协议不把 SVG 交给 `<img>` 渲染，2026-11-14 实机全量回退 glyph）。
 * 回退通道：旧宿主无该命令时，仍按 `<asset 目录>/<appId>/<icon>` 拼 asset URL；
 * 目录唯一真源 = `plugin_get_asset_dir`（与整包装载同源）。
 */

const TEXT_CMD = 'plugin_get_asset_text'
const DIR_CMD = 'plugin_get_asset_dir'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}))
vi.mock('@/utils/invoke', () => ({ invoke: vi.fn() }))
vi.mock('@/utils/frontendLogger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

import { invoke } from '@/utils/invoke'
import { appIconUrl, clearAppIconCache } from '@/shell/composables/appIcons'

const mockedInvoke = vi.mocked(invoke)

/** 模拟旧宿主：内联命令不可用 → 走 asset URL 回退 */
function mockLegacyHost(dir: string) {
  mockedInvoke.mockImplementation(((cmd: string) =>
    cmd === TEXT_CMD
      ? Promise.reject(new Error('no inline command'))
      : Promise.resolve(dir)) as never)
}

describe('应用图标 URL 解析', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
    clearAppIconCache()
    mockLegacyHost('/res/plugins/desktop')
  })

  it('按 <asset 目录>/<appId>/<manifest icon> 组装（Windows 反斜杠归一）', async () => {
    mockLegacyHost('C:\\res\\plugins\\desktop\\')
    await expect(appIconUrl('com.x', 'icon.svg')).resolves.toBe(
      'asset://C:/res/plugins/desktop/com.x/icon.svg',
    )
  })

  it('manifest 未声明 icon → 约定 icon.svg（反例：不拿空文件名去拼）', async () => {
    mockLegacyHost('/res/plugins/desktop')
    await expect(appIconUrl('com.x', '   ')).resolves.toBe(
      'asset:///res/plugins/desktop/com.x/icon.svg',
    )
  })

  it('目录只问一次 + URL 按 appId 缓存（同一进程内不重复 IPC）', async () => {
    mockLegacyHost('/res/plugins/desktop')
    await appIconUrl('a')
    await appIconUrl('a')
    await appIconUrl('b')
    const dirCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === DIR_CMD)
    expect(dirCalls).toHaveLength(1)
    expect(dirCalls[0][0]).toBe(DIR_CMD)
  })

  it('目录取不到 → undefined（回退壳内 glyph），且失败不缓存（下次能重试）', async () => {
    let dirCalls = 0
    mockedInvoke.mockImplementation(((cmd: string) => {
      if (cmd === TEXT_CMD) return Promise.reject(new Error('no inline command'))
      dirCalls += 1
      return dirCalls === 1
        ? Promise.reject(new Error('no asset dir'))
        : Promise.resolve('/res')
    }) as never)
    await expect(appIconUrl('a')).resolves.toBeUndefined()
    await expect(appIconUrl('a')).resolves.toBe('asset:///res/a/icon.svg')
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === DIR_CMD)).toHaveLength(2)
  })

  it('空 appId → undefined，且不打扰宿主（反例）', async () => {
    await expect(appIconUrl('')).resolves.toBeUndefined()
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('宿主提供 SVG 文本 → data URL，且不再问 asset 目录', async () => {
    mockedInvoke.mockImplementation(((cmd: string) =>
      cmd === TEXT_CMD
        ? Promise.resolve(SVG)
        : Promise.reject(new Error('should not ask asset dir'))) as never)
    const url = await appIconUrl('com.x')
    expect(url?.startsWith('data:image/svg+xml;charset=utf-8,%3Csvg')).toBe(true)
    expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === DIR_CMD)).toBe(false)
  })

  it('内联按 appId 缓存（同进程不重复读文件）', async () => {
    mockedInvoke.mockImplementation(((cmd: string) =>
      cmd === TEXT_CMD
        ? Promise.resolve(SVG)
        : Promise.reject(new Error('no dir'))) as never)
    await appIconUrl('com.x')
    await appIconUrl('com.x')
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === TEXT_CMD)).toHaveLength(1)
  })

  it('宿主返回的不是 SVG → 回退 asset URL', async () => {
    mockedInvoke.mockImplementation(((cmd: string) =>
      cmd === TEXT_CMD
        ? Promise.resolve('not an svg')
        : Promise.resolve('/res')) as never)
    await expect(appIconUrl('com.x')).resolves.toBe('asset:///res/com.x/icon.svg')
  })
})
