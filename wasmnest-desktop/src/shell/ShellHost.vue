<template>
  <!-- 启动画面：z-[100] 覆盖一切，壳初始化完成后淡出（壳 BootScreen 承担启动屏步骤） -->
  <SplashLoading :visible="showSplash" />

  <div :class="[themeClasses.container, 'shell-root']">
    <!-- ============ 壳态 / 应用态分流（路由为事实源） ============ -->
    <!-- 主屏（'/'）：ShellToolbar + ShellHome + 覆层 -->
    <ShellView v-if="isHome" />

    <!-- 系统页（/sys/*）：壳标题栏 + 系统页卡（页头 + tabs + 三页互切）。
         此前系统页用一颗 position:fixed 的悬浮返回胶囊当导航——胶囊压在页头左上角，
         正好盖住系统页图标与标题（用户反馈的「图标被入侵/显示不全」根因）。
         现在三种面（主屏 / 系统页 / 应用态）共用同一行常驻标题栏，页体永远从
         标题栏**以下**开始，不再有任何浮层叠在页面上。 -->
    <template v-else-if="isSysPage">
      <ShellToolbar v-if="!isBareWindow" />
      <ShellCardScreen />
    </template>

    <!-- 应用界面（app 路由）：壳标题栏 + 应用挂载槽（机制 B：装载独立构建的 app 整包）。
         标题栏是壳的固定 chrome——wasm-app 的每一页都只占标题栏**以下**的区域，
         不得自绘标题栏 / 窗口控制（2026-10-17 用户裁决）。唯一例外是终端独立窗口
         （bareWindow：该路由由宿主另开窗口装载，窗口 chrome 由应用自持）。 -->
    <template v-else>
      <ShellToolbar v-if="!isBareWindow" />
      <AppMountSlot :app-id="currentAppId" :route="route.fullPath" />
    </template>

    <!-- ============ 全局覆层（任何面可用；Esc 逐层收） ============ -->
    <ShellTaskSwitcher />
    <ShellNotificationPanel />
    <ShellContextMenu />
    <ShellDialogLayer />
    <ShellBootScreen />

    <!-- ============ 安全闸门弹窗（fail-closed 的闭环入口，ADR 0007 / 票 05） ============
         这两条授权询问是宿主事件（plugin:fs-auth-request / plugin:network-auth-request），
         必须有进程级常驻消费者：插件激活期的目录授权在无人应答时按 30s 超时**拒绝**
         （fail-closed 本身正确，但没有弹窗就等于「一律拒绝」）。壳恢复后一度漏挂，
         表现为 ai-chatbox 激活必失败且用户无法自救（2026-10-17 实机验证 P1-6）。
         两者均自监听、无请求时不渲染，放在全局覆层里与具体面无关。 -->
    <FsAuthDialog />
    <NetworkAuthDialog />

    <!-- 全局 Toast（vue-sonner，richColors 区分等级） -->
    <Toaster
      :theme="toasterTheme"
      position="top-center"
      rich-colors
      expand
      :visible-toasts="6"
      :toast-options="toastOptions"
    />

    <!-- type-to-search 隐藏输入（IME 合成中的 CJK 经真实输入框承接，spec-c 待决策 7）
         位置见 scoped 样式：必须落在可见区域内（屏幕外输入框会拖走 IME 候选窗）。 -->
    <input
      ref="searchInput"
      class="type-search-input"
      :value="state.homeQ.value"
      :aria-label="t('shell.home.searchAria')"
      @input="onSearchInput"
    />
  </div>

  <!-- 无边框窗口的边缘 resize 热区（与旧宿主 App.vue 同源）：4 条边各 6px，
       decorations:false 后 Linux 失去 GTK 原生边框拖拽，Tauri 用
       data-tauri-resize-handle 属性接管。仅桌面端渲染。 -->
  <template v-if="isDesktop">
    <div data-tauri-resize-handle class="resize-handle resize-top"></div>
    <div data-tauri-resize-handle class="resize-handle resize-bottom"></div>
    <div data-tauri-resize-handle class="resize-handle resize-left"></div>
    <div data-tauri-resize-handle class="resize-handle resize-right"></div>
  </template>
</template>

<script setup lang="ts">
/**
 * ShellHost — 桌面宿主根组件（方案 C 壳恢复后，2026-10-17 用户裁决）
 *
 * 分层：
 * - 壳态 = 主屏（/）+ 系统页（/sys/*）：ShellView / ShellCardScreen，两种面都由
 *   常驻 ShellToolbar 提供导航（系统页不再用悬浮返回胶囊——它会盖住页头图标）
 * - 应用态（app 路由）= 固定标题栏（ShellToolbar）+ 应用挂载槽：AppMountSlot
 *   装载该 app 独立构建的挂载包（ADR 0057 机制 B），宿主不 import 任何 app 源码。
 *   标题栏在应用态也常驻（wasm-app 只占其下方区域），终端独立窗口（bareWindow）
 *   除外——它由宿主另开窗口，窗口 chrome 归应用自持。
 * - 全局机制：启动画面 / 主题 / 字号 / Toaster / 热区 / 覆层（多任务·通知·右键·弹窗·
 *   启动屏·**授权询问**）/ type-to-search / 键盘（Esc 逐层收 → 返回主屏）。
 *
 * 路由是唯一事实源：route.path 变化 → useShellState.syncFromRoute 同步面态
 * （主屏 / 系统页卡 / 应用卡 MRU）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Toaster, type ToasterProps } from 'vue-sonner'
import SplashLoading from '@/components/SplashLoading.vue'
import AppMountSlot from '@/components/AppMountSlot.vue'
import { useTheme } from '@/composables/useTheme'
import { useFontSize } from '@/composables/useFontSize'
import { usePlatform } from '@/composables/usePlatform'
import { useSettingsStore } from '@/stores/settings'
import { useShellState } from './useShellState'
import { useShellApps, pluginIdOfAppRoute } from './useShellApps'
import ShellView from './ShellView.vue'
import ShellCardScreen from './components/ShellCardScreen.vue'
import ShellToolbar from './components/ShellToolbar.vue'
import ShellNotificationPanel from './components/ShellNotificationPanel.vue'
import ShellTaskSwitcher from './components/ShellTaskSwitcher.vue'
import ShellContextMenu from './components/ShellContextMenu.vue'
import ShellDialogLayer from './components/ShellDialogLayer.vue'
import ShellBootScreen from './components/ShellBootScreen.vue'
import FsAuthDialog from '@/components/FsAuthDialog.vue'
import NetworkAuthDialog from '@/components/NetworkAuthDialog.vue'
import { useHomeSearch } from './useHomeSearch'

const { t } = useI18n()
const route = useRoute()
const state = useShellState()
const appsStore = useShellApps()

const settingsStore = useSettingsStore()
const { platformInfo } = usePlatform()
const isDesktop = computed(() => platformInfo.value.isDesktop)

// 主题与字号（全局一次；AppContent 不再自设）
const { themeClasses, setupTheme, cleanupTheme } = useTheme()
const { setupFontSize } = useFontSize()

// Toaster 主题跟随应用设置（'system' 时由 sonner 自身监听系统偏好）
const toasterTheme = computed(() => settingsStore.settings.ui.theme as ToasterProps['theme'])
const toastOptions: ToasterProps['toastOptions'] = {
  classes: {
    toast: '!rounded-[10px] !shadow-lg',
    title: '!text-[calc(13px*var(--ui-scale))] !font-medium',
    description: '!text-[var(--text-secondary)]',
    actionButton: '!bg-[var(--color-primary)]',
    cancelButton: '!bg-[var(--bg-hover)]',
    closeButton:
      '!bg-transparent !border-transparent !text-[var(--text-secondary)] hover:!text-[var(--text-primary)]',
  },
}

// 启动画面：保证最低展示时长避免闪烁（ShellBootScreen 负责步骤屏，这里兜底淡出）
const showSplash = ref(true)
let splashTimer: ReturnType<typeof setTimeout> | null = null

// ==================== 路由分流 ====================

const path = computed(() => route.path)
const isHome = computed(() => path.value === '/')
const isSysPage = computed(() => path.value.startsWith('/sys/'))
const isBareWindow = computed(() => route.meta.bareWindow === true)

/** 应用面标题（当前路由属主的显示名；缺省回落主屏名） */
const currentAppId = computed(() => pluginIdOfAppRoute(path.value) ?? '')

/** 壳覆层是否开着（Esc 先收覆层的判据；应用态下也生效——覆层属壳 chrome） */
const hasOverlay = computed(
  () =>
    state.dialog.value !== null ||
    state.ctxMenu.value !== null ||
    state.panelOpen.value ||
    state.recentsOpen.value,
)

// 路由 → 壳面态同步（主屏 / 系统页卡 / 应用卡；MRU 幂等）
watch(path, (p) => state.syncFromRoute(p), { immediate: true })

// ==================== type-to-search（隐藏 input） ====================

// 输入链的完整语义（含「焦点丢失也照样成串」的兜底）在 useHomeSearch 里，
// 本组件只持有元素与 shell 状态，并保证「只有主屏接管按键」。
const searchInput = ref<HTMLInputElement | null>(null)
const { onSearchInput, clearSearch, handleSearchKeydown } = useHomeSearch({
  inputEl: searchInput,
  query: state.homeQ,
  active: () => state.screen.value === 'home',
})

/** Enter：打开首个匹配（应用优先，其次系统页） */
function openFirstMatch() {
  const q = state.homeQ.value.trim().toLowerCase()
  if (!q) return
  const hitApp = appsStore.plugins.value.find(
    (a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q),
  )
  const hitSys = ['apps', 'perms', 'settings'].find((id) => id.includes(q))
  clearSearch()
  if (hitApp) state.openApp(hitApp.id)
  else if (hitSys) state.openSys(hitSys)
}

// ==================== 全局键盘 ====================

function onKeydown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey

  // 启动屏：任意键跳过
  if (state.boot.value) {
    if (e.key === 'Escape' || e.key === 'Enter') state.boot.value = false
    return
  }

  // 应用态：键盘归应用界面（终端 Esc / 应用内快捷键都由 app 自己处理），壳不抢。
  // 唯一例外是壳覆层开着时的 Esc：通知中心 / 多任务 / 弹窗是壳 chrome，没有别的
  // 退出入口（面板盖住工具栏按钮时也必须收得掉）；无覆层时 Esc 完全让给应用。
  if (!isHome.value && !isSysPage.value) {
    if (e.key === 'Escape' && hasOverlay.value) {
      e.preventDefault()
      state.goBack()
    }
    return
  }

  // Ctrl+,：设置卡（壳态）
  if (mod && e.key === ',') {
    e.preventDefault()
    state.openSys('settings')
    return
  }

  if (e.key === 'Escape') {
    e.preventDefault()
    // 主屏搜索优先清查询（不清查询的 Esc 对主屏是死键）
    if (state.screen.value === 'home' && state.homeQ.value) {
      clearSearch()
    } else {
      state.goBack()
    }
    return
  }

  // 覆层打开时不再进入主屏搜索
  if (state.dialog.value || state.ctxMenu.value || state.panelOpen.value || state.recentsOpen.value)
    return

  // 主屏搜索的 Enter（输入框失焦时也能命中首个匹配）
  if (state.screen.value === 'home' && state.homeQ.value && e.key === 'Enter') {
    e.preventDefault()
    openFirstMatch()
    return
  }

  // 主屏 type-to-search：可打印字符 / 退格 / IME 合成承接。只问一句「本层消费了吗」，
  // 字符如何落进查询串（浏览器插入 or 本地追加）由 useHomeSearch 决定。
  handleSearchKeydown(e)
}

// ==================== 点外部关闭覆层（面板 / 右键菜单） ====================

function onWindowClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (state.ctxMenu.value && !target.closest('.shell-ctx-root')) {
    state.ctxMenu.value = null
  }
  if (
    state.panelOpen.value &&
    !target.closest('.shell-notif-panel') &&
    !target.closest('[data-shell-panel-trigger]')
  ) {
    state.panelOpen.value = false
  }
}

onMounted(() => {
  setupTheme()
  setupFontSize()
  void appsStore.load()
  splashTimer = setTimeout(() => {
    showSplash.value = false
    splashTimer = null
  }, 900)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('click', onWindowClick)
})

onUnmounted(() => {
  if (splashTimer) clearTimeout(splashTimer)
  cleanupTheme()
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('click', onWindowClick)
})
</script>

<style scoped>
/* 隐藏输入框必须落在**可见区域**（顶栏下方居中）：IME 候选窗按光标的屏幕矩形定位，
   放在 left:-9999px 时候选窗整块跑到窗口外（本机 Fcitx5 实测），合成串随之中断。
   视觉上保持不可见（opacity 0 + 指针穿透），查询串仍由主屏 `.qhint` 呈现。 */
.type-search-input {
  position: fixed;
  top: calc(var(--toolbar-h, 44px) + 14px);
  left: 50%;
  transform: translateX(-50%);
  width: 240px;
  height: 20px;
  opacity: 0;
  border: none;
  outline: none;
  background: transparent;
  color: transparent;
  pointer-events: none;
}
</style>
