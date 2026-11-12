import { ref, watch, computed } from 'vue'
import { useSettingsStore } from '@/stores/settings'

const isSystemDark = ref(false)
let systemThemeQuery: MediaQueryList | null = null

const systemThemeHandler = (e: MediaQueryListEvent) => {
  document.documentElement.classList.toggle('dark', e.matches)
  isSystemDark.value = e.matches
}

function applyTheme(theme: string) {
  const root = document.documentElement
  const isDark = theme === 'system' ? isSystemDark.value : theme === 'dark'

  if (isDark) {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

/*
 * 色板（warm/cool/forest…）不再由宿主应用到 documentElement：它是各 wasm-app 的
 * 样式主题（应用自己设置页持有，作用域限定在应用根容器）。宿主壳固定用默认色板
 * （:root 的 warm 变量组），只掌握深浅色。
 */

function setupTheme() {
  const settingsStore = useSettingsStore()
  const theme = settingsStore.settings.ui.theme

  if (theme === 'system') {
    isSystemDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches
    systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
    systemThemeQuery.addEventListener('change', systemThemeHandler)
  }

  applyTheme(theme)
}

function cleanupTheme() {
  if (systemThemeQuery) {
    systemThemeQuery.removeEventListener('change', systemThemeHandler)
    systemThemeQuery = null
  }
}

/**
 * 当前生效的暗色状态（**纯读，不注册 watcher**）
 *
 * 供「无组件作用域」的动作路径使用：壳快捷键的 `theme.toggle` 此前在 keydown
 * 回调里现调 `useTheme()`，每按一次就多注册一个永不销毁的主题 watcher，此后每次
 * 切主题都会重复 `cleanupTheme + setupTheme`（重挂 matchMedia + 写 DOM）。
 * 组件里照旧用 `useTheme().isDark`（computed 复用本函数，判据只有一份）。
 */
export function currentThemeIsDark(): boolean {
  const theme = useSettingsStore().settings.ui.theme
  return theme === 'dark' || (theme === 'system' && isSystemDark.value)
}

export function useTheme() {
  const settingsStore = useSettingsStore()

  // 监听主题设置变化
  //
  // 只调 setupTheme：它内部先重读系统态（system 时）并重挂监听，最后才落 DOM。
  // 原实现是「先 applyTheme(newTheme) 再 setupTheme()」——applyTheme 读的是**上一轮**
  // 的 isSystemDark，从 dark/light 切回 system 时必现错误深浅色（OS 深色 + 曾选深色：
  // 先按 false 去掉 .dark 变浅，随后 setupTheme 把 isSystemDark 更正为 true 却不再落
  // DOM，且此后只要有系统主题变化才会被纠正）。applyTheme 本次只跑一次也更省。
  watch(() => settingsStore.settings.ui.theme, () => {
    // 先摘掉旧监听（否则每切一次主题就多挂一个 media query 监听），再交给 setupTheme
    cleanupTheme()
    setupTheme()
  })

  /** 当前生效的暗色状态（system 时跟随系统偏好；主题据此合并 darkTokens） */
  const isDark = computed(currentThemeIsDark)

  // 主题切换通过 :root.dark CSS 变量自动生效，无需 dark: 前缀
  const themeClasses = computed(() => ({
    container: 'min-h-screen bg-page text-[var(--text-primary)]',
  }))

  return {
    isSystemDark,
    isDark,
    themeClasses,
    setupTheme,
    cleanupTheme,
  }
}
