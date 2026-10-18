<template>
  <header
    class="shell-toolbar flex items-center gap-2 px-2 pl-3 select-none flex-shrink-0"
    data-tauri-drag-region
  >
    <!-- 品牌 + 当前位置（role=status 播报当前位置，不播报裸指标——spec-c §2） -->
    <div class="flex items-center gap-2 min-w-0 shrink-0" data-tauri-drag-region>
      <!-- 品牌标志：与应用图标（src-tauri/icons/icon.svg）逐字同源——品牌 ink 斜向
           渐变底 + 编织 W（小尺寸走实心态）。品牌固定色，不跟主题反色。 -->
      <svg
        class="w-[19px] h-[19px] shrink-0"
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="shell-toolbar-logo-bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#16181C" />
            <stop offset="100%" stop-color="#08090B" />
          </linearGradient>
        </defs>
        <rect width="100" height="100" rx="22.5" fill="url(#shell-toolbar-logo-bg)" />
        <g transform="translate(15.855,17.193) scale(0.68289)">
          <polygon points="4.54,22.28 26.06,92.71 32.32,59.81 19.46,17.72" fill="#FF9E2C" />
          <polygon points="24.22,90.61 51.10,56.86 51.10,34.38 29.84,61.08" fill="#F5F7F9" />
          <polygon points="48.90,56.86 75.78,90.61 70.16,61.08 48.90,34.38" fill="#F5F7F9" />
          <polygon points="73.94,92.71 95.46,22.28 80.54,17.72 67.68,59.81" fill="#F5F7F9" />
        </g>
      </svg>
      <b
        class="text-[calc(13px*var(--ui-scale))] font-semibold tracking-tight text-[var(--text-primary)]"
        >WasmNest</b
      >
      <span
        class="tb-where text-[calc(11px*var(--ui-scale))] text-[var(--text-tertiary)] whitespace-nowrap overflow-hidden text-ellipsis min-w-0"
        role="status"
        aria-atomic="true"
      >
        {{ where }}
      </span>
    </div>

    <!-- 导航（可在设置隐藏；Esc 始终等效返回——spec-c §6） -->
    <nav v-if="prefs.showNav" class="flex items-center gap-0.5 ml-2.5 shrink-0" aria-label="导航">
      <button
        class="tb-btn"
        :disabled="!canBack"
        :title="t('shell.nav.backTitle')"
        :aria-label="t('shell.nav.back')"
        @click="state.goBack()"
      >
        <ShellIcon name="back" :size="15" />
        {{ t('shell.nav.back') }}
      </button>
      <!-- 多任务：紧贴「返回」右侧（导航区），全屏切换层由它开合 -->
      <button
        class="tb-btn"
        :class="{ on: state.recentsOpen.value }"
        :title="t('shell.nav.tasksTitle', { count: state.cards.value.length })"
        :aria-label="t('shell.nav.tasksTitle', { count: state.cards.value.length })"
        @click="state.toggleRecents()"
      >
        <ShellIcon name="recents" :size="15" />
        {{ t('shell.nav.tasks') }}
        <span v-if="state.cards.value.length > 0" class="tb-n">
          {{ state.cards.value.length }}
        </span>
      </button>
      <button
        class="tb-btn"
        :class="{ on: state.screen.value === 'home' }"
        :title="t('shell.nav.homeTitle')"
        :aria-label="t('shell.nav.home')"
        @click="state.goHome()"
      >
        <ShellIcon name="home" :size="15" />
        {{ t('shell.nav.home') }}
      </button>
    </nav>

    <!-- 全局入口 + 窗口控制 -->
    <div class="flex items-center gap-0.5 ml-auto shrink-0">
      <button
        class="tb-btn"
        :class="{ on: state.panelOpen.value }"
        data-shell-panel-trigger
        :title="t('shell.toolbar.notifsTitle', { count: state.notifCountTotal.value })"
        :aria-label="t('shell.toolbar.notifs', { count: state.notifCountTotal.value })"
        @click="toggleNotifs"
      >
        <ShellIcon name="bell" :size="15" />
        <span v-if="state.notifCountTotal.value > 0" class="bdg">
          {{ state.notifCountTotal.value }}
        </span>
      </button>
      <!-- 主题切换：图标反映**当前**主题（深色=月亮 / 浅色=太阳），文案给点击后的动作 -->
      <button
        class="tb-btn"
        :title="themeActionLabel"
        :aria-label="themeActionLabel"
        @click="toggleTheme"
      >
        <ShellIcon :name="isDark ? 'theme' : 'sun'" :size="15" />
      </button>
      <span class="tb-sep mx-[5px]" aria-hidden="true"></span>
      <button
        class="tb-win"
        :title="t('shell.toolbar.minimize')"
        :aria-label="t('shell.toolbar.minimize')"
        @click="minimize"
      >
        <ShellIcon name="minus" :size="13" />
      </button>
      <button
        class="tb-win"
        :title="t('shell.toolbar.maximize')"
        :aria-label="t('shell.toolbar.maximize')"
        @click="toggleMaximize"
      >
        <ShellIcon name="square" :size="11" />
      </button>
      <button
        class="tb-win close"
        :title="t('shell.toolbar.close')"
        :aria-label="t('shell.toolbar.close')"
        @click="requestClose"
      >
        <ShellIcon name="x" :size="13" />
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
/**
 * ShellToolbar — 壳顶部工具栏
 *
 * 结构（spec-c §1 布局）：品牌 · 当前位置 │ 返回/主屏（可隐藏）│ 多任务 · 通知 · 主题 │ 窗口控制。
 * 窗口控制与 TitleBar 同源（getCurrentWindow）；关闭走退出确认弹窗（壳内 dialog）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useSettingsStore } from '@/stores/settings'
import { useTheme } from '@/composables/useTheme'
import { useShellState } from '../useShellState'
import { useShellSettings } from '../useShellSettings'
import ShellIcon from './ShellIcon.vue'

const { t } = useI18n()
const state = useShellState()
const { prefs } = useShellSettings()
const settingsStore = useSettingsStore()
const { isSystemDark } = useTheme()

// 窗口控制：Tauri 环境取真窗口；浏览器预览（无 __TAURI_INTERNALS__）时降级空操作，
// 工具栏不因窗口 API 缺失而整体挂掉（TitleBar 同源 API，此处显式兜底）
const appWindow = (() => {
  try {
    return getCurrentWindow()
  } catch {
    return null
  }
})()
const isMaximized = ref(false)

/** 当前所在位置（role=status 播报） */
const where = computed(() =>
  state.screen.value === 'card' && state.activeCard.value
    ? state.cardTitleOf(state.activeCard.value)
    : t('shell.home.where'),
)

/** 有可收的覆层或不在主屏 → 返回可用 */
const canBack = computed(
  () =>
    state.screen.value !== 'home' ||
    state.dialog.value !== null ||
    state.ctxMenu.value !== null ||
    state.panelOpen.value ||
    state.recentsOpen.value,
)

/** 当前生效暗色（system 跟随系统偏好） */
const isDark = computed(() =>
  settingsStore.settings.ui.theme === 'dark'
    ? true
    : settingsStore.settings.ui.theme === 'light'
      ? false
      : isSystemDark.value,
)

/**
 * 主题按钮文案：说「点一下会变成什么」。
 *
 * 与图标互补——图标画的是**当前**状态（深色=月亮 / 浅色=太阳），文案给动作方向；
 * 两者都跟着 isDark 变，避免"图标永远一个月亮、看不出深浅"的哑按钮。
 */
const themeActionLabel = computed(() =>
  isDark.value ? t('shell.toolbar.themeToLight') : t('shell.toolbar.themeToDark'),
)

function toggleTheme() {
  settingsStore.settings.ui.theme = isDark.value ? 'light' : 'dark'
  // 保存走整表回传（settings store 已有编排）；useTheme watch 会即时应用
  void settingsStore.saveSettings({ ui: settingsStore.settings.ui })
}

/**
 * 通知中心 / 多任务层互斥：两个都是占满视野的浏览面，同时开只会互相遮挡
 * （打开一个即收起另一个；多任务侧的互斥在 toggleRecents 里）。
 */
function toggleNotifs() {
  state.panelOpen.value = !state.panelOpen.value
  if (state.panelOpen.value) {
    state.recentsOpen.value = false
  }
}

async function checkMaximized() {
  if (!appWindow) return
  try {
    isMaximized.value = await appWindow.isMaximized()
  } catch {
    /* 非 Tauri 环境（浏览器预览）时静默 */
  }
}

async function minimize() {
  if (!appWindow) return
  try {
    await appWindow.minimize()
  } catch {
    /* 预览环境忽略 */
  }
}

async function toggleMaximize() {
  if (!appWindow) return
  try {
    await appWindow.toggleMaximize()
    setTimeout(checkMaximized, 100)
  } catch {
    /* 预览环境忽略 */
  }
}

/** 关窗：走退出确认弹窗（有运行中应用时给确认） */
function requestClose() {
  state.dialog.value = 'exit'
}

onMounted(checkMaximized)
window.addEventListener('resize', checkMaximized)
onUnmounted(() => window.removeEventListener('resize', checkMaximized))
</script>

<style scoped>
.shell-toolbar {
  height: var(--toolbar-h);
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
  position: relative;
  z-index: 30;
  -webkit-app-region: drag;
}
.tb-btn,
.tb-win {
  -webkit-app-region: no-drag;
}
.tb-btn {
  min-width: 32px;
  height: 28px;
  padding: 0 7px;
  border-radius: var(--radius-button);
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: calc(12px * var(--ui-scale));
  position: relative;
  transition:
    background-color 0.15s,
    color 0.15s;
}
.tb-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.tb-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.tb-btn:disabled:hover {
  background: none;
  color: var(--text-secondary);
}
.tb-btn.on {
  background: var(--color-primary-light);
  color: var(--text-primary);
}
.tb-btn .bdg {
  position: absolute;
  top: 0;
  right: 0;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--color-danger);
  color: var(--color-primary-contrast);
  font-size: calc(9px * var(--ui-scale));
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}
.tb-sep {
  width: 1px;
  height: 16px;
  background: var(--border-strong);
  flex-shrink: 0;
}
/* 导航按钮内的计数（多任务：有后台应用时显示，位置在文字之后而非压在字上） */
.tb-n {
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--color-primary-light);
  color: var(--text-secondary);
  font-size: calc(9.5px * var(--ui-scale));
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tb-win {
  width: 34px;
  height: 28px;
  border-radius: var(--radius-button);
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    background-color 0.15s,
    color 0.15s;
  -webkit-app-region: no-drag;
}
.tb-win:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.tb-win.close:hover {
  background: var(--color-danger);
  color: var(--color-primary-contrast);
}
</style>
