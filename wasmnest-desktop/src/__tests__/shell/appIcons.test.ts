import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 应用图标 URL 解析契约（appIcons）
 *
 * 需求来源：主屏 / 多任务的图标要显示**各 wasm-app 原来那张**（应用包自带
 * `manifest.icon`），不是宿主哈希派生的通用 glyph。
 *
 * 机制判据：图标是应用包资源，只能用 asset 协议按 `<asset 目录>/<appId>/<icon>` 取；
 * 目录唯一真源 = 宿主命令 `plugin_get_asset_dir`（与整包装载同源）。
 */

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}))
vi.mock('@/utils/invoke', () => ({ invoke: vi.fn() }))

import { invoke } from '@/utils/invoke'
import { appIconUrl, clearAppIconCache } from '@/shell/appIcons'

const mockedInvoke = vi.mocked(invoke)

describe('应用图标 URL 解析', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
    clearAppIconCache()
  })

  it('按 <asset 目录>/<appId>/<manifest icon> 组装（Windows 反斜杠归一）', async () => {
    mockedInvoke.mockResolvedValueOnce('C:\\res\\plugins\\desktop\\')
    await expect(appIconUrl('com.x', 'icon.svg')).resolves.toBe(
      'asset://C:/res/plugins/desktop/com.x/icon.svg',
    )
  })

  it('manifest 未声明 icon → 约定 icon.svg（反例：不拿空文件名去拼）', async () => {
    mockedInvoke.mockResolvedValueOnce('/res/plugins/desktop')
    await expect(appIconUrl('com.x', '   ')).resolves.toBe(
      'asset:///res/plugins/desktop/com.x/icon.svg',
    )
  })

  it('目录只问一次 + URL 按 appId 缓存（同一进程内不重复 IPC）', async () => {
    mockedInvoke.mockResolvedValue('/res/plugins/desktop')
    await appIconUrl('a')
    await appIconUrl('a')
    await appIconUrl('b')
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke.mock.calls[0][0]).toBe('plugin_get_asset_dir')
  })

  it('目录取不到 → undefined（回退壳内 glyph），且失败不缓存（下次能重试）', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('no asset dir'))
    await expect(appIconUrl('a')).resolves.toBeUndefined()
    mockedInvoke.mockResolvedValueOnce('/res')
    await expect(appIconUrl('a')).resolves.toBe('asset:///res/a/icon.svg')
    expect(mockedInvoke).toHaveBeenCalledTimes(2)
  })

  it('空 appId → undefined，且不打扰宿主（反例）', async () => {
    await expect(appIconUrl('')).resolves.toBeUndefined()
    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})
