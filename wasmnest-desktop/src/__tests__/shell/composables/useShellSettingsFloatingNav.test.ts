/**
 * 壳偏好：悬浮导航字段（floatingNav / floatingNavPos）的读取与写穿
 *
 * 被测：`src/shell/composables/useShellSettings.ts`（模块级单例，用 resetModules
 * + 动态 import 隔离每个用例的模块状态）
 *
 * 口径与移动端 useShellPreferences 同构：
 * - 默认关闭（floatingNav: false），位置默认底部居中 {x: 0.5, y: 1}；
 * - 比例单轴校验：越界 / 非有限值各自回落默认，一个坏值不否定另一个轴；
 * - 非布尔开关回落 false；损坏 JSON 整包回落默认。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const STORAGE_KEY = 'wasmnest.shell-ui-prefs.v1'

/** 每个用例重新加载模块（单例 prefs 在模块加载时读一次 localStorage） */
async function loadPrefs() {
  vi.resetModules()
  const mod = await import('@/shell/composables/useShellSettings')
  return mod.useShellSettings().prefs
}

beforeEach(() => {
  localStorage.clear()
})

describe('floatingNav 读取', () => {
  it('should_defaultToOff_when_storageEmpty', async () => {
    const prefs = await loadPrefs()

    expect(prefs.value.floatingNav).toBe(false)
    expect(prefs.value.floatingNavPos).toEqual({ x: 0.5, y: 1 })
  })

  it('should_readBack_when_valuesValid', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ wallpaper: 'aurora', wallDim: 16, wallpaperImage: '', theme: 'default', floatingNav: true, floatingNavPos: { x: 0.2, y: 0.8 } }),
    )
    const prefs = await loadPrefs()

    expect(prefs.value.floatingNav).toBe(true)
    expect(prefs.value.floatingNavPos).toEqual({ x: 0.2, y: 0.8 })
  })

  it('should_fallbackToFalse_when_flagNotBoolean', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ wallpaper: 'aurora', wallDim: 16, wallpaperImage: '', theme: 'default', floatingNav: 'yes' }),
    )
    const prefs = await loadPrefs()

    expect(prefs.value.floatingNav).toBe(false)
  })

  it('should_clampPerAxis_when_ratioOutOfRange', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        wallpaper: 'aurora',
        wallDim: 16,
        wallpaperImage: '',
        theme: 'default',
        floatingNavPos: { x: -1, y: 1.7 },
      }),
    )
    const prefs = await loadPrefs()

    expect(prefs.value.floatingNavPos).toEqual({ x: 0, y: 1 })
  })

  it('should_fallbackPerAxis_when_ratioNotFinite', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        wallpaper: 'aurora',
        wallDim: 16,
        wallpaperImage: '',
        theme: 'default',
        // 一个坏值不否定另一个轴：x 回默认 0.5，y 合法保留
        floatingNavPos: { x: 'bad', y: 0.3 },
      }),
    )
    const prefs = await loadPrefs()

    expect(prefs.value.floatingNavPos).toEqual({ x: 0.5, y: 0.3 })
  })

  it('should_fallbackToDefaults_when_jsonCorrupt', async () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    const prefs = await loadPrefs()

    expect(prefs.value.floatingNav).toBe(false)
    expect(prefs.value.floatingNavPos).toEqual({ x: 0.5, y: 1 })
  })
})

describe('floatingNav 写穿', () => {
  it('should_persistToStorage_when_prefsMutated', async () => {
    const prefs = await loadPrefs()

    prefs.value.floatingNav = true
    prefs.value.floatingNavPos = { x: 0.9, y: 0.1 }
    await Promise.resolve()

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      floatingNav?: boolean
      floatingNavPos?: { x: number; y: number }
    }
    expect(stored.floatingNav).toBe(true)
    expect(stored.floatingNavPos).toEqual({ x: 0.9, y: 0.1 })
  })
})
