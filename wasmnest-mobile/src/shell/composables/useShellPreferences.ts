/**
 * 壳 UI 偏好（宿主壁纸 / 自定义壁纸图 / 遮罩强度）
 * -----------------------------------------------------------------------------
 * 归属：这是**壳的视觉偏好**（纯机制词汇，不含任何业务语义），因此不写宿主
 * AppConfig——引擎面不加壳词汇（与桌面壳 `useShellSettings.ts` 同口径，
 * AGENTS §5.1 B1/B5）。持久化走 localStorage：偏好丢失只影响观感，不影响功能；
 * 隐私模式等写入失败按 warn 记录，不静默吞掉（壳 L4 纪律）。
 *
 * 壁纸 id 是**稳定标识**而非样式值：渐变真源在 `styles/shell.css` 的 --wall-*，
 * 这里只存 id。新增内置壁纸 = 加一条 id + 一条 token + 一条 i18n，三处同步。
 *
 * 自定义壁纸存的是**宿主导入后的绝对路径**（用户选中的原件已由宿主命令拷进
 * $APPDATA，见 src-tauri/src/system/shell_ui.rs）——壳不持有文件内容，也不
 * 自己读盘（AGENTS §6 前端零资源访问）；渲染时经 asset protocol URL 取图。
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { logger } from '@/utils/frontendLogger'
import { SHELL_THEME_DEFAULT } from './themePresets'

/** 壁纸档位（前四档与 shell.css 的 --wall-* 一一对应；custom = 用户选的自定义图） */
export const SHELL_WALLPAPERS = ['none', 'aurora', 'dune', 'reef', 'custom'] as const
export type ShellWallpaper = (typeof SHELL_WALLPAPERS)[number]

/** 自定义档位的内部标识（与 i18n / token 无关，只用于分支） */
export const WALLPAPER_CUSTOM: ShellWallpaper = 'custom'

export const WALLPAPER_DEFAULT: ShellWallpaper = 'aurora'
/** 遮罩强度上限：超过 70% 壁纸几乎不可见，留着只是让用户白调 */
export const WALL_DIM_MAX = 70
/**
 * 遮罩默认值从 30 降到 16：30% 的页面底色压上去后，壁纸只剩顶部一条亮带、
 * 下半屏糊成纯底色，空白读起来像没做完。16% 仍给正文留足对比（最亮档的壁
 * 纸底与 --mobile-text-primary 约 7:1），同时让整屏色调读作一个整体。
 */
export const WALL_DIM_DEFAULT = 16

/**
 * 悬浮导航位置
 *
 * 存的是「可移动空间」的归一化比例而不是像素：0 = 最左 / 最上，1 = 最右 / 最下。
 * 视口变化（旋转、分屏、键盘）时按同一比例重算像素，悬浮条不会被甩到屏外，
 * 也不同步改写用户偏好。
 */
export interface FloatingNavPosition {
  x: number
  y: number
}

/** 默认停在底部居中（拇指可达，且不挡标题与顶部胶囊） */
export const FLOATING_NAV_POS_DEFAULT: FloatingNavPosition = { x: 0.5, y: 1 }

interface ShellUiPrefs {
  wallpaper: ShellWallpaper
  /** 自定义壁纸的本地绝对路径；未选过 / 已移除为 null */
  wallpaperImage: string | null
  /** 壁纸之上的页面色遮罩强度（%，护文字对比度） */
  wallDim: number
  /**
   * 主题 id（`<html data-theme>`；缺省 = 内置默认主题）。
   * 与深浅色（`settings.ui.theme`）不是同一个轴：深浅色归 AppConfig，主题是纯
   * 外观偏好，与壁纸同层走 localStorage（同步可读，首帧可预应用）。
   */
  theme: string
  /** 悬浮导航开关（默认关闭：需要用户在设置里显式开启） */
  floatingNav: boolean
  /** 悬浮导航位置（归一化比例，见 FloatingNavPosition） */
  floatingNavPos: FloatingNavPosition
}

const STORAGE_KEY = 'wasmnest.shell-ui-prefs.v1'

function isWallpaper(value: unknown): value is ShellWallpaper {
  return typeof value === 'string' && (SHELL_WALLPAPERS as readonly string[]).includes(value)
}

/** 比例值单字段校验：非有限数 / 越界各自回落，不因一个坏值否定另一个轴 */
function clampRatio(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

/** 悬浮导航位置归一（加载与写入共用同一口径） */
function normalizeFloatingNavPos(value: unknown): FloatingNavPosition {
  const pos = (value ?? {}) as Partial<FloatingNavPosition>
  return {
    x: clampRatio(pos.x, FLOATING_NAV_POS_DEFAULT.x),
    y: clampRatio(pos.y, FLOATING_NAV_POS_DEFAULT.y),
  }
}

function load(): ShellUiPrefs {
  const fallback: ShellUiPrefs = {
    wallpaper: WALLPAPER_DEFAULT,
    wallpaperImage: null,
    wallDim: WALL_DIM_DEFAULT,
    theme: SHELL_THEME_DEFAULT,
    floatingNav: false,
    floatingNavPos: { ...FLOATING_NAV_POS_DEFAULT },
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<ShellUiPrefs>
    // 只取已知键、逐项校验：损坏 / 旧版本 / 手改数据一律回落默认，不把脏值带进渲染
    const wallpaper = isWallpaper(parsed.wallpaper) ? parsed.wallpaper : fallback.wallpaper
    const wallpaperImage =
      typeof parsed.wallpaperImage === 'string' && parsed.wallpaperImage.length > 0
        ? parsed.wallpaperImage
        : null
    return {
      // custom 档没有图就等于没选：回落到默认渐变，而不是渲染一层空背景
      wallpaper: wallpaper === WALLPAPER_CUSTOM && wallpaperImage === null ? fallback.wallpaper : wallpaper,
      wallpaperImage,
      wallDim:
        typeof parsed.wallDim === 'number' && parsed.wallDim >= 0 && parsed.wallDim <= WALL_DIM_MAX
          ? Math.round(parsed.wallDim)
          : fallback.wallDim,
      // 未知 id 原样保留：主题可能来自尚未注册的扩展，渲染侧负责回落默认
      theme:
        typeof parsed.theme === 'string' && parsed.theme.trim() !== ''
          ? parsed.theme
          : fallback.theme,
      floatingNav:
        typeof parsed.floatingNav === 'boolean' ? parsed.floatingNav : fallback.floatingNav,
      floatingNavPos: normalizeFloatingNavPos(parsed.floatingNavPos),
    }
  } catch (e) {
    logger.warn('[Shell] shell ui prefs unreadable; falling back to defaults', e)
    return fallback
  }
}

const prefs: Ref<ShellUiPrefs> = ref(load())

watch(
  prefs,
  (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    } catch (e) {
      // localStorage 不可用（隐私模式 / 配额满）：偏好仅本次会话生效，不打断主流程
      logger.warn('[Shell] shell ui prefs not persisted', e)
    }
  },
  { deep: true },
)

/** 当前壁纸 id */
const wallpaper: ComputedRef<ShellWallpaper> = computed(() => prefs.value.wallpaper)
/** 当前自定义壁纸路径（null = 未选过） */
const wallpaperImage: ComputedRef<string | null> = computed(() => prefs.value.wallpaperImage)
/** 当前遮罩强度（0–70） */
const wallDim: ComputedRef<number> = computed(() => prefs.value.wallDim)
/** 当前主题 id */
const theme: ComputedRef<string> = computed(() => prefs.value.theme)
/** 悬浮导航开关（默认关闭） */
const floatingNav: ComputedRef<boolean> = computed(() => prefs.value.floatingNav)
/** 悬浮导航位置（归一化比例） */
const floatingNavPos: ComputedRef<FloatingNavPosition> = computed(() => prefs.value.floatingNavPos)

function setWallpaper(next: ShellWallpaper): void {
  prefs.value = { ...prefs.value, wallpaper: next }
}

/**
 * 记下自定义壁纸路径并切到 custom 档
 *
 * 路径由宿主命令（选图 + 落盘）给出；传 null 表示移除自定义图，此时若正停在
 * custom 档则回落到内置默认，避免「选了自定义却没有图」的空档。
 */
function setWallpaperImage(next: string | null): void {
  const image = next && next.length > 0 ? next : null
  if (image !== null) {
    prefs.value = { ...prefs.value, wallpaperImage: image, wallpaper: WALLPAPER_CUSTOM }
    return
  }
  // 移除自定义图：正停在 custom 档时回落到默认内置壁纸，避免「选了自定义却没有图」的空档
  prefs.value = {
    ...prefs.value,
    wallpaperImage: null,
    wallpaper:
      prefs.value.wallpaper === WALLPAPER_CUSTOM ? WALLPAPER_DEFAULT : prefs.value.wallpaper,
  }
}

/** 设置遮罩强度；越界值钳制到 [0, WALL_DIM_MAX]，不抛错（滑杆可能给出小数） */
function setWallDim(next: number): void {
  const clamped = Math.min(WALL_DIM_MAX, Math.max(0, Math.round(next)))
  prefs.value = { ...prefs.value, wallDim: clamped }
}

/**
 * 切换主题
 *
 * 只写偏好，不在这里碰 DOM：落地由 `useShellTheme` 的 watcher 与
 * `useTheme` 的首帧预应用负责（同一时刻只有一个写入口，避免两处时序打架）。
 */
function setTheme(next: string): void {
  const id = next.trim()
  if (id === '') return
  prefs.value = { ...prefs.value, theme: id }
}

/** 开关悬浮导航（默认关闭；开启后由 App 根常驻渲染） */
function setFloatingNav(enabled: boolean): void {
  prefs.value = { ...prefs.value, floatingNav: enabled }
}

/** 记录悬浮导航位置；越界 / 非有限值按轴归一，不抛错（拖拽可能给出小数） */
function setFloatingNavPos(next: Partial<FloatingNavPosition>): void {
  prefs.value = { ...prefs.value, floatingNavPos: normalizeFloatingNavPos(next) }
}

/** 壁纸选择器直接消费的档位清单（id + i18n key 由调用方拼） */
export const SHELL_WALLPAPER_IDS: readonly ShellWallpaper[] = SHELL_WALLPAPERS

export interface ShellPreferences {
  wallpaper: ComputedRef<ShellWallpaper>
  wallpaperImage: ComputedRef<string | null>
  wallDim: ComputedRef<number>
  theme: ComputedRef<string>
  floatingNav: ComputedRef<boolean>
  floatingNavPos: ComputedRef<FloatingNavPosition>
  setWallpaper: typeof setWallpaper
  setWallpaperImage: typeof setWallpaperImage
  setWallDim: typeof setWallDim
  setTheme: typeof setTheme
  setFloatingNav: typeof setFloatingNav
  setFloatingNavPos: typeof setFloatingNavPos
}

/** 获取壳 UI 偏好句柄（模块级单例，与壳内其它机制一致） */
export function useShellPreferences(): ShellPreferences {
  return {
    wallpaper,
    wallpaperImage,
    wallDim,
    theme,
    floatingNav,
    floatingNavPos,
    setWallpaper,
    setWallpaperImage,
    setWallDim,
    setTheme,
    setFloatingNav,
    setFloatingNavPos,
  }
}
