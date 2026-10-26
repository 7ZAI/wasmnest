/**
 * 自定义壁纸文件名的唯一判据（Rust 写下的 `custom-<数字>.<白名单扩展名>`）
 *
 * 单独成模块是为了让 `useShellSettings`（加载偏好时校验）与
 * `customWallpaper`（拼 asset URL / 取图）共用同一规则，又不形成循环依赖。
 */
const CUSTOM_WALLPAPER_FILE_RE = /^custom-\d+\.(png|jpe?g|webp)$/i

export function isCustomWallpaperFile(name: string): boolean {
  return CUSTOM_WALLPAPER_FILE_RE.test(name)
}
