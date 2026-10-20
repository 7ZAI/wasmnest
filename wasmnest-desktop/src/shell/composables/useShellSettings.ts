/**
 * 设备壳本地 UI 偏好（wallpaper / wallDim / wallpaperImage / skin）
 *
 * 壁纸铺在壳根（ShellHost 的 .shell-wall），主屏 / 系统页 / 兜底面共用；
 * 这些是**壳的 UI 偏好**（纯机制词汇），不是宿主 AppConfig 字段——
 * Rust 侧 AppConfig 反序列化契约不加壳词汇（引擎面纯净性，AGENTS §5.1 /
 * 防回接锁 `binding_surface_must_not_return_to_wasm_core` 同向）。持久化走
 * localStorage（前端 UI 状态，非业务真源、非凭据，零资源访问红线不涉及）。
 *
 * 主题 / 色板 / 语言 / 字号 / 动画仍走既有 settings store（已是线上真值）。
 */
import { ref, watch } from 'vue'
import { SHELL_SKIN_DEFAULT, WALL_DIM_DEFAULT, WALLPAPER_DEFAULT } from './state'
import { isCustomWallpaperFile } from './wallpaperFile'
import type { ShellUiPrefs } from '../types'

const STORAGE_KEY = 'wasmnest.shell-ui-prefs.v1'

const prefs = ref<ShellUiPrefs>(load())

function load(): ShellUiPrefs {
  const fallback: ShellUiPrefs = {
    wallpaper: WALLPAPER_DEFAULT,
    wallDim: WALL_DIM_DEFAULT,
    wallpaperImage: '',
    skin: SHELL_SKIN_DEFAULT,
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<ShellUiPrefs>
    // 只取已知键，未知字段不扩散（容错：损坏 / 旧版本数据回落默认）
    const wallpaperImage =
      typeof parsed.wallpaperImage === 'string' && isCustomWallpaperFile(parsed.wallpaperImage)
        ? parsed.wallpaperImage
        : ''
    let wallpaper = typeof parsed.wallpaper === 'string' ? parsed.wallpaper : fallback.wallpaper
    // custom 必须带合法文件名，否则回落默认（避免壳根挂 empty/custom 导致无背景）
    if (wallpaper === 'custom' && !wallpaperImage) wallpaper = fallback.wallpaper
    return {
      wallpaper,
      wallDim:
        typeof parsed.wallDim === 'number' && parsed.wallDim >= 0 && parsed.wallDim <= 70
          ? parsed.wallDim
          : fallback.wallDim,
      wallpaperImage,
      // 未知 / 缺失皮肤 id 保留原值，由渲染侧回落默认（扩展可能尚未注册）
      skin:
        typeof parsed.skin === 'string' && parsed.skin.trim() !== ''
          ? parsed.skin
          : fallback.skin,
    }
  } catch {
    return fallback
  }
}

// 持久化（写穿）：值变化即存盘，异常静默回落（UI 偏好丢失可接受，不打断主流程）
watch(
  prefs,
  (v) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(v))
    } catch {
      /* localStorage 不可用（隐私模式等）时忽略——偏好仅本次会话生效 */
    }
  },
  { deep: true },
)

export function useShellSettings() {
  return { prefs }
}
