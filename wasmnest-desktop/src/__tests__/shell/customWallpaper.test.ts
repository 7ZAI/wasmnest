import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 自定义壁纸链路锁（2026-10-20）
 *
 * 背景：设置页「自定义图片…」长期是 `disabled` 的占位按钮（文案写着「链路待接入」）。
 * 用户要求按「复制到应用数据目录」实现，并明确「恢复初始设置时也要删除复制的数据」。
 *
 * 本锁钉住：
 * 1. 偏好只存文件名（不存绝对路径），非法文件名 / custom 缺图回落默认；
 * 2. asset URL 只由合法文件名拼出（拒绝路径穿越）；
 * 3. 取图 / 清理命令的调用落点（设置页 + 恢复初始设置）；
 * 4. 壳根用 --wall-custom 渲染，设置页不再保留 disabled 占位。
 */

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => '/home/me/.local/share/com.wasmnest.desktop'),
}))
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}))
vi.mock('@/utils/invoke', () => ({ invoke: vi.fn() }))
vi.mock('@/utils/frontendLogger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

import { appDataDir } from '@tauri-apps/api/path'
import { invoke } from '@/utils/invoke'
import {
  customWallpaperUrl,
  resetCustomWallpaperState,
  pickCustomWallpaper,
  clearCustomWallpaper,
} from '@/shell/composables/customWallpaper'

const read = (p: string) => readFileSync(p, 'utf-8')

beforeEach(() => {
  vi.clearAllMocks()
  resetCustomWallpaperState()
})

describe('自定义壁纸：偏好只存文件名，非法值回落', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  async function loadPrefs(stored: Record<string, unknown>) {
    localStorage.setItem('wasmnest.shell-ui-prefs.v1', JSON.stringify(stored))
    const { useShellSettings } = await import('@/shell/composables/useShellSettings')
    return useShellSettings().prefs.value
  }

  it('接受 custom + 合法文件名', async () => {
    const prefs = await loadPrefs({
      wallpaper: 'custom',
      wallDim: 20,
      wallpaperImage: 'custom-1700000000000000000.png',
    })
    expect(prefs.wallpaper).toBe('custom')
    expect(prefs.wallpaperImage).toBe('custom-1700000000000000000.png')
  })

  it('custom 缺文件名 → 回落默认壁纸（避免壳根挂空背景）', async () => {
    const prefs = await loadPrefs({ wallpaper: 'custom', wallDim: 20, wallpaperImage: '' })
    expect(prefs.wallpaper).toBe('aurora')
    expect(prefs.wallpaperImage).toBe('')
  })

  it('文件名带路径 / 非本模块产出 → 丢弃（不落盘、不拼 URL）', async () => {
    const prefs = await loadPrefs({
      wallpaper: 'custom',
      wallDim: 20,
      wallpaperImage: '../../../etc/passwd.png',
    })
    expect(prefs.wallpaper).toBe('aurora')
    expect(prefs.wallpaperImage).toBe('')
  })

  it('切回内置壁纸时保留文件名（便于一键切回已选图片）', async () => {
    const prefs = await loadPrefs({
      wallpaper: 'dune',
      wallDim: 20,
      wallpaperImage: 'custom-1.webp',
    })
    expect(prefs.wallpaper).toBe('dune')
    expect(prefs.wallpaperImage).toBe('custom-1.webp')
  })
})

describe('自定义壁纸：asset URL 解析', () => {
  it('合法文件名拼出 appData/wallpapers 下的 asset URL', async () => {
    const url = await customWallpaperUrl('custom-1700000000000000000.png')
    expect(url).toBe(
      'asset://localhost//home/me/.local/share/com.wasmnest.desktop/wallpapers/custom-1700000000000000000.png',
    )
  })

  it('非法文件名直接拒绝，不解析目录', async () => {
    expect(await customWallpaperUrl('../escape.png')).toBeUndefined()
    expect(await customWallpaperUrl('custom-1.svg')).toBeUndefined()
    expect(appDataDir).not.toHaveBeenCalled()
  })

  it('目录解析失败 → undefined，且下次会重试（失败不缓存）', async () => {
    vi.mocked(appDataDir).mockRejectedValueOnce(new Error('no ipc'))
    expect(await customWallpaperUrl('custom-1.png')).toBeUndefined()
    expect(await customWallpaperUrl('custom-1.png')).toBe(
      'asset://localhost//home/me/.local/share/com.wasmnest.desktop/wallpapers/custom-1.png',
    )
  })
})

describe('自定义壁纸：命令通道', () => {
  it('取图 / 清理走宿主命令（前端无 fs 权限）', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('custom-1.png')
    await expect(pickCustomWallpaper()).resolves.toBe('custom-1.png')
    expect(invoke).toHaveBeenCalledWith('pick_custom_wallpaper')

    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    await clearCustomWallpaper()
    expect(invoke).toHaveBeenCalledWith('clear_custom_wallpaper')
  })
})

describe('自定义壁纸：UI / 壳根接线', () => {
  it('设置页启用按钮，不再保留 disabled 占位（2026-10-28 外观改版：随背景组搬进二级页）', () => {
    const src = read('src/shell/sys/SysAppearanceView.vue')
    expect(src).toContain('chooseCustomWallpaper')
    expect(src).toContain('removeCustomWallpaper')
    expect(src).toContain('customBusy')
    expect(src).not.toContain('customPending')
    expect(src).not.toContain('自定义壁纸链路待接入')
  })

  it('壳根把自定义图放进 --wall-custom，并由 .wall-custom 使用', () => {
    expect(read('src/shell/ShellHost.vue')).toContain('--wall-custom')
    const css = read('src/shell/styles/shell.css')
    expect(css).toContain('.shell-wall.wall-custom')
    expect(css).toContain('--wall-active: var(--wall-custom')
    expect(css).toContain('background-size: cover')
  })

  it('恢复初始设置删除复制到应用数据目录的壁纸', () => {
    const src = read('src/shell/settings/SettingsResetSection.vue')
    expect(src).toContain('clearCustomWallpaper')
    expect(src).toContain("prefs.value.wallpaperImage = ''")
  })
})
