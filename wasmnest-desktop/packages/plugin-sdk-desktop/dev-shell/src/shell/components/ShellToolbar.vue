<template>
  <!-- 壳标题栏（与宿主 ShellToolbar 同构：品牌 · 当前位置 │ app 切换 · 主题 · 语言 · 日志） -->
  <header class="shell-toolbar flex items-center gap-2 px-2 pl-3 select-none flex-shrink-0">
    <!-- 品牌标志：与应用图标（src-tauri/icons/icon.svg）逐字同源——品牌 ink 斜向
         渐变底 + 编织 W。品牌固定色，不跟主题反色。 -->
    <div class="flex items-center gap-2 min-w-0 shrink-0">
      <svg class="w-[19px] h-[19px] shrink-0" viewBox="0 0 100 100" aria-hidden="true">
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
      <b class="text-[calc(13px*var(--ui-scale))] font-semibold tracking-tight text-[var(--text-primary)]"
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

    <!-- 右侧：app 切换 · 主题 · 语言 · 日志 -->
    <div class="flex items-center gap-0.5 ml-auto shrink-0">
      <!-- app 切换：多于一个被调试 app 时出现（宿主同形态是多任务面板，
           dev-shell 无多任务层，这里用下拉直切） -->
      <div v-if="apps.length > 1" class="relative shrink-0">
        <button
          class="tb-btn"
          :aria-expanded="switcherOpen"
          :title="t('devshell.toolbar.switchApp')"
          @click="switcherOpen = !switcherOpen"
        >
          <ShellIcon name="layers" :size="15" />
          {{ currentApp?.name ?? t('devshell.toolbar.noApp') }}
        </button>
        <div v-if="switcherOpen" class="tb-menu" role="menu">
          <button
            v-for="app in apps"
            :key="app.id"
            class="tb-menu-item"
            role="menuitem"
            :class="{ on: app.id === currentAppId }"
            @click="pick(app.id)"
          >
            <ShellIcon :name="app.id === currentAppId ? 'check' : 'file'" :size="13" />
            <span class="truncate">{{ app.name }}</span>
          </button>
        </div>
      </div>

      <!-- 主题切换：图标反映**当前**主题（深色=月亮 / 浅色=太阳），文案给点击后的动作 -->
      <button class="tb-btn" :title="themeActionLabel" :aria-label="themeActionLabel" @click="toggleTheme">
        <ShellIcon :name="isDark ? 'theme' : 'sun'" :size="15" />
      </button>

      <!-- 语言切换（中 / EN 分段按钮） -->
      <div class="flex items-center rounded-btn bg-[var(--bg-hover)] p-0.5 shrink-0">
        <button
          v-for="opt in localeOptions"
          :key="opt.value"
          class="px-2 py-0.5 rounded text-xs transition-colors duration-200"
          :class="
            locale === opt.value
              ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          "
          @click="setLocale(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>

      <span class="tb-sep mx-[5px]" aria-hidden="true"></span>

      <!-- 日志面板开关（dev-shell 专有：命令 mock 命中情况都在这里） -->
      <button
        class="tb-btn"
        :class="{ on: logOpen }"
        :aria-pressed="logOpen"
        :title="t('devshell.logs.title')"
        :aria-label="t('devshell.logs.title')"
        @click="emit('toggle-log')"
      >
        <ShellIcon name="info" :size="15" />
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
/**
 * ShellToolbar — dev-shell 壳标题栏（与宿主 `src/shell/components/ShellToolbar.vue` 同构）
 *
 * 与宿主的差异（都是「宿主面在浏览器里不存在」这一条原因，不是偷懒）：
 * - 裁掉**窗口控制**（最小化 / 最大化 / 关闭）：浏览器没有宿主窗口；
 * - 裁掉**通知中心 / 快捷设置 / 多任务面板**入口：它们是宿主覆层，dev-shell
 *   不复刻宿主的应用管理面（那不是 app 开发者要调的界面）；
 * - 「返回 / 主屏」导航同样裁掉：dev-shell 没有主屏，界面就是被调试 app 本身。
 *
 * 保留的是**影响 app 观感的部分**：品牌标志、当前位置、主题切换（深浅色直接
 * 决定 app 的配色验证结果）、工具栏高度（`--toolbar-h`，app 的可用高度与真机
 * 一致）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ShellIcon from './ShellIcon.vue'
import { useHostUi } from '../../theme'
import { saveLocale, type DevLocale } from '../../locale'
import type { DevAppRecord } from '../../registry'

const props = defineProps<{
  /** 被调试 app 列表 */
  apps: DevAppRecord[]
  /** 当前被调试 app 的 id */
  currentAppId: string
  /** 日志面板是否开着 */
  logOpen: boolean
}>()

const emit = defineEmits<{
  (e: 'select-app', appId: string): void
  (e: 'toggle-log'): void
}>()

const { t, locale } = useI18n()
const { theme, setTheme } = useHostUi()

const switcherOpen = ref(false)

const currentApp = computed(() => props.apps.find((a) => a.id === props.currentAppId) ?? null)

/** 当前位置（role=status 播报）：dev-shell 的「当前面」= 正在调试的 app */
const where = computed(() =>
  currentApp.value
    ? t('devshell.toolbar.debugging', { name: currentApp.value.name })
    : t('devshell.toolbar.noApp'),
)

/** 当前生效暗色（system 跟随系统偏好） */
const isDark = computed(() => {
  const mode = theme.value
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
})

/**
 * 主题按钮文案：说「点一下会变成什么」。
 *
 * 与图标互补——图标画的是**当前**状态（深色=月亮 / 浅色=太阳），文案给动作方向；
 * 两者都跟着 isDark 变，避免"图标永远一个月亮、看不出深浅"的哑按钮。
 */
const themeActionLabel = computed(() =>
  isDark.value ? t('devshell.toolbar.themeToLight') : t('devshell.toolbar.themeToDark'),
)

function toggleTheme() {
  setTheme(isDark.value ? 'light' : 'dark')
}

// 语言切换选项（语言名用自身文字展示，无需翻译）
const localeOptions: { value: DevLocale; label: string }[] = [
  { value: 'zh-CN', label: '中' },
  { value: 'en', label: 'EN' },
]

function setLocale(next: DevLocale) {
  locale.value = next
  saveLocale(next)
}

function pick(appId: string) {
  switcherOpen.value = false
  emit('select-app', appId)
}

// 切换 app 后收起下拉（否则菜单悬在旧 app 名旁）
watch(
  () => props.currentAppId,
  () => {
    switcherOpen.value = false
  },
)
</script>

<style scoped>
.shell-toolbar {
  height: var(--toolbar-h);
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
  position: relative;
  z-index: 30;
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
    background-color var(--motion-duration-fast) var(--motion-ease),
    color var(--motion-duration-fast) var(--motion-ease);
}
.tb-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.tb-btn:active:not(:disabled) {
  background: var(--border);
}
.tb-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.tb-btn:disabled:hover {
  background: none;
  color: var(--text-secondary);
}
/* 当前面（选中态）：实底而不是 12% 主色淡染——淡染在浅色主题下几乎与卡片底同色，
   开合状态看不出来 */
.tb-btn.on {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.tb-sep {
  width: 1px;
  height: 18px;
  background: var(--border-strong);
  flex-shrink: 0;
}
/* app 切换下拉：贴工具栏右缘的浮层（与宿主覆层同一层级，Esc 之外的点外部关闭
   由 App.vue 统一处理） */
.tb-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 200px;
  max-height: 320px;
  overflow-y: auto;
  padding: 4px;
  border-radius: var(--radius-card);
  border: 1px solid var(--border);
  background: var(--bg-card);
  box-shadow: var(--shadow-card-hover);
  z-index: 40;
}
.tb-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-button);
  color: var(--text-secondary);
  font-size: calc(12px * var(--ui-scale));
  text-align: left;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease),
    color var(--motion-duration-fast) var(--motion-ease);
}
.tb-menu-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.tb-menu-item.on {
  color: var(--text-primary);
  font-weight: 500;
}
</style>
