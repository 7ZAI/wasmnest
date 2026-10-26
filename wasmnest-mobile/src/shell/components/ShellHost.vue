<template>
  <!-- 高度用 h-full 而非 100dvh：壳挂在 ShellView 的 100dvh 容器内（该容器已承担
       顶部安全区），再用 100dvh 会多出一段安全区高度的溢出 -->
  <div
    class="shell-ui relative isolate flex flex-col h-full overflow-hidden bg-[var(--mobile-bg-primary)] text-[var(--mobile-text-primary)]"
    :class="wallRootClass"
    :style="{ '--wall-dim': String(wallDim), paddingTop: 'var(--shell-safe-top, 0px)' }"
  >
    <!-- 宿主壁纸层（主屏 / 系统屏共用；应用运行面见下方底色层）。
         负层序落在壳根底色之上、全部内容之下；none 档不渲染空装饰层。 -->
    <div v-if="wallClass" class="shell-wallpaper" aria-hidden="true" :style="wallImageStyle" />

    <!-- 应用运行面底色层：进入应用时整个运行面（含顶部状态栏带）回落到默认
         页面底色，平台顶栏与应用界面因此处在同一层布局里，不再透出宿主壁纸。 -->
    <div class="shell-run-backdrop" :class="{ 'is-active': isAppRun }" aria-hidden="true" />

    <ShellStatusbar />

    <!-- 屏幕栈容器：进出场期间两屏共存（CSS 里 leave-active 用绝对定位），
         因此这里必须 overflow-hidden + relative，否则会被撑高 -->
    <div class="relative flex-1 min-h-0 overflow-hidden">
      <Transition :name="transitionName">
        <!-- key 带 appId：切换应用时强制重挂载，避免复用上一个应用的运行面 -->
        <component :is="screenComponent" :key="screenKey" />
      </Transition>
    </div>

    <!-- 平台级覆盖层：固定在壳根渲染，与当前屏幕无关 -->
    <ShellCapsuleMenu />
    <ShellPermissionPrompt />
    <ShellNotificationShade />
  </div>
</template>

<script setup lang="ts">
/**
 * 宿主壳根组件
 * -----------------------------------------------------------------------------
 * 职责：宿主壁纸 + 状态条 + 屏幕栈 + 平台级覆盖层 + 运行面对账 + 宿主事件桥 +
 * 系统返回键平台兜底。就这些。
 * 壁纸挂在壳根：主屏 / 应用管理 / 权限 / 设置共用同一背景（与桌面壳同口径）。
 * 应用运行面例外：它是应用自己的窗口，壳根另铺一层默认底色（含状态栏带），
 * 平台顶栏与应用界面同底色，不把宿主壁纸透成平台控件的背景。
 * 顶部安全区 padding 也由本壳根承接（变量来自 ShellView）：绝对层铺满 padding box，
 * 壁纸因此延伸到 Android 状态栏后方，内容仍从安全区之下开始。
 *
 * 底部系统条（返回 / 主屏 / 多任务）已于 2026-10-14 整条退役：常驻导航条
 * 会永久占掉一截应用可视高度，且与 Android 系统手势条重复；导航入口改为
 * ① 各非根屏页头自持返回键 ② 应用运行页胶囊里的多任务 / 回主屏。
 *
 * 运行面承载（Level 1，2026-10-24）：每应用一个**独立 Vue 应用**，由注册表
 * （surfaceRuntime → surfaceAppRegistry，模块级单例）记账。本组件不再渲染
 * Teleport 保活池，改为**对账**：所有「打开过 ∩ 运行中 ∩ 有运行面」的应用都
 * ensure 出实例（后台应用也建，保持 detached）；当前应用的 attach 由运行屏
 * 适配器（ShellAppSurface）负责。壳卸载只 detach 全部容器、不 dispose——
 * 注册表与实例都随模块存活，壳重挂后对账重新补建 attach 面。
 *
 * 不含的东西（都是刻意的）：
 *   · 不含任何应用业务——应用界面由其独立运行面自持（见 ShellAppSurface）
 *   · 不含应用清单的获取逻辑——由 ShellView 注册数据源后 refresh
 *   · 不含主题配置——沿用既有 --mobile-* token 与设置页
 *
 * 屏幕表是「屏幕 id → 组件」的纯映射：新增一个屏只需在表里加一行，
 * 导航与过渡机制不动。
 */
import { computed, onMounted, onUnmounted, watch, type Component } from 'vue'
import { logger } from '@/utils/frontendLogger'
import { toFileAssetUrl } from '@/plugin/assets'
import { useShellPreferences } from '../composables/useShellPreferences'
import { useShellApps } from '../composables/useShellApps'
import { useAppSurfaces } from '../composables/useAppSurfaces'
import { useShellNavigation, type ShellScreenId } from '../composables/useShellNavigation'
import { useShellSystemBack } from '../composables/useShellSystemBack'
import { startShellHostEvents } from '../composables/useShellHostEvents'
import { getSurfaceAppRegistry, reconcileSurfaceApps } from '../surfaceRuntime'
import ShellCapsuleMenu from './ShellCapsuleMenu.vue'
import ShellNotificationShade from './ShellNotificationShade.vue'
import ShellPermissionPrompt from './ShellPermissionPrompt.vue'
import ShellStatusbar from './ShellStatusbar.vue'
import ShellAppRunScreen from './screens/ShellAppRunScreen.vue'
import ShellAppDetailScreen from './screens/ShellAppDetailScreen.vue'
import ShellAppsScreen from './screens/ShellAppsScreen.vue'
import ShellHomeScreen from './screens/ShellHomeScreen.vue'
import ShellPermissionsScreen from './screens/ShellPermissionsScreen.vue'
import ShellSettingsScreen from './screens/ShellSettingsScreen.vue'
import ShellSwitcherScreen from './screens/ShellSwitcherScreen.vue'

/** 屏幕表：新增屏幕只改这里 */
const SCREENS: Record<ShellScreenId, Component> = {
  home: ShellHomeScreen,
  apps: ShellAppsScreen,
  'app-detail': ShellAppDetailScreen,
  'app-run': ShellAppRunScreen,
  switcher: ShellSwitcherScreen,
  permissions: ShellPermissionsScreen,
  settings: ShellSettingsScreen,
}

const nav = useShellNavigation()
const { transitionName } = nav
const { wallpaper, wallpaperImage, wallDim } = useShellPreferences()

// ==================== 运行面对账（注册表承载） ====================

const { apps, resolveSurface } = useShellApps()
const { opened } = useAppSurfaces()
const surfaceRegistry = getSurfaceAppRegistry()

/**
 * 对账触发面：应用清单 / 运行态 / 打开记录变化，或运行面注册变化
 * （resolveSurface 的响应式依赖——注册、晚到、身份替换都会推动重算）。
 * reconcileSurfaceApps 幂等（ensure 对同组件身份直接返回既有实例），重复触发无代价。
 */
watch(
  () => [
    apps.value.map((a) => `${a.id}:${a.state}:${opened.value.has(a.id) ? 1 : 0}`).join('|'),
    apps.value.map((a) => resolveSurface(a.id)),
  ],
  () => void reconcileSurfaceApps({ apps: apps.value, opened: opened.value, resolveSurface }),
  { immediate: true },
)

/** 当前是否在应用运行面：其底色层盖住壁纸（含状态栏带），只留默认页面底色 */
const isAppRun = computed(() => nav.current.value.id === 'app-run')

/** 壁纸档位类（none → 只保留壳根类；值与 shell.css / wallpaper.css 的 --wall-* 同源） */
const wallClass = computed(() => (wallpaper.value === 'none' ? '' : `wall-${wallpaper.value}`))
const wallRootClass = computed(() => ['shell-wall', wallClass.value].filter(Boolean).join(' '))

/** 自定义壁纸图片层：路径来自宿主落盘结果，经 asset 协议取图（壳不直接读盘） */
const wallImageStyle = computed(() => {
  if (wallpaper.value !== 'custom' || !wallpaperImage.value) return undefined
  return { backgroundImage: `url("${toFileAssetUrl(wallpaperImage.value)}")` }
})

const screenComponent = computed<Component>(() => SCREENS[nav.current.value.id] ?? ShellHomeScreen)
const screenKey = computed(() => `${nav.current.value.id}:${nav.params.value.appId ?? ''}`)

// Android 系统返回键平台兜底（覆盖层 → 屏栈回退 → 回主屏；都轮不到时不消费）。
// 按需订阅的理由与优先规则见 composable 头注。
const systemBack = useShellSystemBack()

/**
 * 宿主事件 → 通知栏桥
 *
 * 生命周期与壳同长：壳在则监听在，壳卸载则解绑（避免热重载 / 重复挂载后事件被处理多次）。
 * 注册失败（浏览器预览等无事件总线环境）只记录，不影响壳启动。
 */
let stopHostEvents: (() => void) | null = null

onMounted(async () => {
  try {
    stopHostEvents = await startShellHostEvents()
  } catch (e) {
    logger.warn('[Shell] host event bridge unavailable; notifications stay shell-local', e)
  }
})

onUnmounted(() => {
  stopHostEvents?.()
  stopHostEvents = null
  // 壳卸载（如进入插件整页路由）只 detach 运行面容器、**不 dispose**：
  // 注册表与实例随模块存活，壳重挂后对账重建 attach 面，后台状态原样保留
  for (const appId of surfaceRegistry.list()) surfaceRegistry.detach(appId)
  // 摘掉返回兜底：此时壳没有任何可退的屏，系统返回应交回默认行为 /
  // 由当前整页路由自己的历史承担
  systemBack.dispose()
})
</script>
