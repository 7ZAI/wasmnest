/**
 * 宿主界面设置（桌面端 dev-shell）——与宿主 `useTheme` / `useFontSize` 同语义
 * -----------------------------------------------------------------------------
 * - 主题模式：light / dark / system，切换 <html> 的 .dark 类（style.css 的
 *   :root.dark 变量组生效）。
 * - 字体大小：以 px 存储（12 = "正常"档位），实际生效为 :root 的 `--ui-scale`
 *   缩放因子（所有界面文字尺寸都写成 calc(基准px * var(--ui-scale))，等比缩放）。
 * - 全部持久化到 localStorage，启动时由 initHostUi() 恢复，避免刷新回退。
 *
 * 与宿主的两处**刻意一致**（不是简化）：
 * - **色板不再落到 documentElement**：宿主 `useTheme` 已明确「色板是各 wasm-app
 *   自己的样式主题，宿主壳固定用默认色板」，dev-shell 曾自行给 <html> 写
 *   data-palette —— 那会让预览与真机呈现两套配色，故一并退役。
 * - **Linux 基线缩放**：`--ui-scale` 的换算与宿主 `computeUiScale` 逐字同式
 *   （Linux 额外 ×1.15），且给 <html> 加 `platform-linux` 类（宿主 style.css 的
 *   `html.platform-linux` 规则需要它：根字号 115% + rem 间距同比例放大）。
 */
import { ref } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'system'

/** "正常"档位对应的基准字号（px），即默认界面文字大小 */
export const NORMAL_FONT_SIZE = 12
/** 滑杆档位范围：小(10) / 正常(12) / 大(14) / 超大(16) */
export const MIN_FONT_SIZE = 10
export const MAX_FONT_SIZE = 16
/** Linux 平台基线 UI 缩放因子（与宿主 useFontSize.PLATFORM_UI_SCALE 同值） */
export const PLATFORM_UI_SCALE = 1.15

const THEME_KEY = 'wasmnest-dev-shell:theme'
const FONT_SIZE_KEY = 'wasmnest-dev-shell:font-size'

const theme = ref<ThemeMode>('system')
const fontSize = ref<number>(NORMAL_FONT_SIZE)

let systemQuery: MediaQueryList | null = null

/**
 * 是否 Linux 桌面（宿主经 Tauri 平台信息判定；dev-shell 在浏览器里只能看 UA）
 *
 * Android 的 UA 同样含 "Linux"，需排除——宿主那边 Android 走移动端路径，
 * 不叠这层基线缩放。
 */
export function isLinuxDesktop(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return false
  return /Linux|X11/i.test(ua)
}

/**
 * 档位字号 → --ui-scale 换算（纯函数，与宿主 `computeUiScale` 同式）
 *
 * scale = 设置档位 / 正常档位 × (Linux ? PLATFORM_UI_SCALE : 1)。
 * Linux 基线因子只对 Linux 生效——Windows/macOS 必须返回 1.0，
 * 否则为 Linux 调整的字号会泄漏到其他平台。
 */
export function computeUiScale(size: number, isLinux: boolean): number {
  const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size))
  return (clamped / NORMAL_FONT_SIZE) * (isLinux ? PLATFORM_UI_SCALE : 1)
}

/** 按当前模式 + 系统偏好应用 .dark 类（与宿主 useTheme.applyTheme 同逻辑） */
function applyTheme(): void {
  const isDark = theme.value === 'system' ? (systemQuery?.matches ?? false) : theme.value === 'dark'
  document.documentElement.classList.toggle('dark', isDark)
}

/** 应用字体大小：字号 / 基准 得 --ui-scale 缩放因子（与宿主 applyFontSize 同式） */
function applyFontSize(): void {
  const scale = computeUiScale(fontSize.value, isLinuxDesktop())
  document.documentElement.style.setProperty('--ui-scale', String(scale), 'important')
}

function setupSystemListener(): void {
  systemQuery?.removeEventListener('change', applyTheme)
  systemQuery = window.matchMedia('(prefers-color-scheme: dark)')
  systemQuery.addEventListener('change', applyTheme)
}

function teardownSystemListener(): void {
  systemQuery?.removeEventListener('change', applyTheme)
  systemQuery = null
}

/** 启动时调用（main.ts）：恢复持久化的主题模式 / 字体大小并应用 */
export function initHostUi(): void {
  try {
    const savedTheme = localStorage.getItem(THEME_KEY)
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
      theme.value = savedTheme
    }
    const savedSize = Number(localStorage.getItem(FONT_SIZE_KEY))
    if (Number.isFinite(savedSize) && savedSize >= MIN_FONT_SIZE && savedSize <= MAX_FONT_SIZE) {
      fontSize.value = savedSize
    }
  } catch {
    // 隐私模式等场景使用默认值
  }
  // Linux 基线：宿主 main.ts 的 initPlatform() 之后给 <html> 加同名类，
  // style.css 的 `html.platform-linux` 规则（根字号 115%）据此生效
  if (isLinuxDesktop()) {
    document.documentElement.classList.add('platform-linux')
  }
  if (theme.value === 'system') setupSystemListener()
  applyTheme()
  applyFontSize()
}

/** 切换主题模式（持久化；system 时建立系统偏好监听） */
export function setTheme(mode: ThemeMode): void {
  theme.value = mode
  try {
    localStorage.setItem(THEME_KEY, mode)
  } catch {
    // 忽略持久化失败
  }
  if (mode === 'system') {
    setupSystemListener()
  } else {
    teardownSystemListener()
  }
  applyTheme()
}

/** 切换字体大小（px，持久化，即时生效） */
export function setFontSize(size: number): void {
  fontSize.value = size
  try {
    localStorage.setItem(FONT_SIZE_KEY, String(size))
  } catch {
    // 忽略持久化失败
  }
  applyFontSize()
}

/** 供设置页读取/切换（响应式） */
export function useHostUi() {
  return { theme, fontSize, setTheme, setFontSize }
}
