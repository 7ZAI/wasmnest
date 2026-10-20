/**
 * 自定义壁纸（壳 UI 偏好）
 *
 * 数据流：Rust `pick_custom_wallpaper` 用原生对话框取图 → 校验并复制到
 * `app_data/wallpapers/custom-<nanos>.<ext>` → 返回文件名 → 偏好只存文件名。
 * 渲染时经 `appDataDir()` + asset 协议解析成 URL（CSP 的 img-src 已含 asset:）。
 *
 * 为什么复制而不是引用源路径：源图被移动 / 删除后壁纸不应失效；扩展名与大小
 * 校验、目录清理都在 Rust 侧（前端没有 fs 权限，也不把任意路径交给命令）。
 *
 * URL 解析失败（浏览器预览 / 文件被手删）→ 返回 undefined，调用方回退内置壁纸；
 * 装饰性资源缺失不弹错（与 appIcons 同口径）。
 */
import { ref, watch } from 'vue'
import { appDataDir } from '@tauri-apps/api/path'
import { convertFileSrc } from '@tauri-apps/api/core'
import { invoke } from '@/utils/invoke'
import { logger } from '@/utils/frontendLogger'
import { useShellSettings } from './useShellSettings'
import { isCustomWallpaperFile } from './wallpaperFile'

/** 与 Rust 侧 WALLPAPER_DIR 保持一致 */
const WALLPAPER_DIR = 'wallpapers'

/** appDataDir 解析结果缓存（失败不缓存：首次可能早于宿主就绪） */
let dirPromise: Promise<string | null> | null = null
/** 文件名 → asset URL（文件名每次选择都变，天然避开缓存） */
const urlCache = new Map<string, string>()

function resolveDir(): Promise<string | null> {
  if (!dirPromise) {
    dirPromise = appDataDir().catch((e) => {
      dirPromise = null
      logger.warn('[Shell] app data dir unavailable, custom wallpaper disabled', e)
      return null
    })
  }
  return dirPromise
}

/**
 * 文件名 → asset URL；文件名不合法或解析失败返回 undefined。
 * 存文件名而不是绝对路径，数据目录搬迁后仍能解析。
 */
export async function customWallpaperUrl(file: string): Promise<string | undefined> {
  if (!isCustomWallpaperFile(file)) return undefined
  const hit = urlCache.get(file)
  if (hit) return hit

  const dir = await resolveDir()
  if (!dir) return undefined
  try {
    // appIcons 同口径：字符串拼接而不是 path.join（少一次 IPC）；Windows 反斜杠归一
    const base = dir.replace(/\\/g, '/').replace(/\/+$/, '')
    const url = convertFileSrc(`${base}/${WALLPAPER_DIR}/${file}`)
    urlCache.set(file, url)
    return url
  } catch (e) {
    logger.warn(`[Shell] custom wallpaper url failed: file=${file}`, e)
    return undefined
  }
}

/**
 * 打开原生取图对话框并复制图片；用户取消返回 null。
 *
 * 不套 `invokeWithTimeout`：对话框是人工操作，30s 超时会在用户还在选图时
 * 把 Promise 判失败（而 Rust 侧对话框仍在）。失败由调用方 `showUserError` 呈现。
 */
export async function pickCustomWallpaper(): Promise<string | null> {
  return invoke<string | null>('pick_custom_wallpaper')
}

/** 删除复制到应用数据目录的自定义壁纸（移除图片 / 恢复初始设置） */
export async function clearCustomWallpaper(): Promise<void> {
  await invoke<void>('clear_custom_wallpaper')
}

/** 当前自定义壁纸 URL（模块级单例：壳根与设置页预览共用一次解析） */
const imageUrl = ref<string | undefined>()
let stopWatcher: (() => void) | null = null

export function useCustomWallpaper() {
  const { prefs } = useShellSettings()
  if (!stopWatcher) {
    stopWatcher = watch(
      () => prefs.value.wallpaperImage,
      async (file) => {
        imageUrl.value = file ? await customWallpaperUrl(file) : undefined
      },
      { immediate: true },
    )
  }
  return { imageUrl, pick: pickCustomWallpaper, clear: clearCustomWallpaper }
}

/** 测试隔离：停掉 watcher、清缓存（生产只在模块生命周期内建立一次） */
export function resetCustomWallpaperState(): void {
  stopWatcher?.()
  stopWatcher = null
  urlCache.clear()
  dirPromise = null
  imageUrl.value = undefined
}
