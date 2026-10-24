<template>
  <!-- mobile-app / mobile-ui：这两个类是既有 CSS 的祖先选择器口径（流式排版、按类命中的移动端规则）。
       旧宿主 MobileLayout 退役时它一度只在壳内（ShellView）挂着，导致旧路由（设置二级页 / 文件浏览器）
       拿不到那套排版——现在回到全局容器上，与旧布局同口径。 -->
  <div :class="['mobile-app mobile-ui', themeClasses.container]">
    <!-- 路由出口：旧宿主布局（MobileLayout + MobileNav）随阶段 B 退役，
         壳自行承担布局框与安全区（见 src/shell/views/ShellView.vue） -->
    <router-view />

    <!-- Global Toast Container（vue-sonner，richColors 区分等级） -->
    <Toaster
      :theme="toasterTheme"
      position="top-center"
      rich-colors
      :mobile-offset="{ top: safeArea.top, bottom: safeArea.bottom }"
    />

    <!-- Plugin Dialog Host -->
    <PluginDialogHost />

    <!-- 插件全局弹窗（宿主统一渲染，文件传输等插件经 context.ui.showDialog 触发） -->
    <PluginGlobalDialog />

    <!-- 文件系统授权弹窗（插件目录授权，全局挂载） -->
    <FsAuthDialog />

    <!-- 外网访问授权弹窗（Egress L3，请求时懒触发，全局挂载） -->
    <EgressConsentDialog />

    <!-- 开屏组件已禁用（2026-09-13 排查：启动期存在两层前端开屏——index.html 静态首屏
         与本处的 Vue 开屏组件，现仅保留静态首屏 + Android 原生纯色开屏底）。
         恢复方式：取消下方两个组件标签的注释，并同步恢复 script 中的
         SplashScreen / SplashScreenNative / ACTIVE_SPLASH_CANDIDATE 导入、
         showSplash / splashIsNative 声明及 vue 导入里的 ref；
         渲染候选页仍由 config/splash.ts 的 ACTIVE_SPLASH_CANDIDATE 决定。
    <SplashScreen v-if="!splashIsNative && showSplash" @closed="showSplash = false" />
    <SplashScreenNative v-else-if="showSplash" @closed="showSplash = false" />
    -->
  </div>
</template>

<script setup lang="ts">
import { provide, computed, onMounted, onUnmounted } from 'vue'
import { logger } from '@/utils/frontendLogger'
import { Toaster } from 'vue-sonner'
// 开屏组件已禁用（恢复说明见模板注释块）
// import SplashScreen from '@/components/SplashScreen.vue'
// import SplashScreenNative from '@/components/SplashScreenNative.vue'
// import { ACTIVE_SPLASH_CANDIDATE } from '@/config/splash'
import { usePlatform } from '@/composables/usePlatform'
import { useOrientation } from '@/composables/useOrientation'
import { useEdgeToEdge } from '@/composables/useEdgeToEdge'
import PluginDialogHost from '@/plugin/components/PluginDialogHost.vue'
import PluginGlobalDialog from '@binblink/wasmnest-plugin-sdk-mobile/ui/plugin-global-dialog'
import FsAuthDialog from '@/components/FsAuthDialog.vue'
import EgressConsentDialog from '@/components/EgressConsentDialog.vue'
import { useTheme } from '@/composables/useTheme'
import { syncLinkCryptoContextToNative, initLinkCryptoPinSync } from '@/composables/useLinkEncryption'
import { useFontSize } from '@/composables/useFontSize'
import { useSettingsStore } from '@/stores/settings'
import { completeStartupTask } from '@/composables/useAppStartup'
// mDNS 广播暂时禁用：移动端目前不需要被发现，避免扫描到自身
// import { useMdnsAdvertiser } from '@/composables/useMdnsAdvertiser'

const { platformInfo } = usePlatform()
const { isLandscape, orientation } = useOrientation()
const { safeArea, keyboardInfo, isReady } = useEdgeToEdge()

// 主题与字体管理
const { themeClasses, setupTheme, cleanupTheme } = useTheme()
const { setupFontSize } = useFontSize()

// Toaster 主题跟随应用设置（'system' 时由 sonner 自身监听系统偏好）
const settingsStore = useSettingsStore()
const toasterTheme = computed(() => settingsStore.settings.ui.theme as 'light' | 'dark' | 'system')

// 开屏动画状态已随组件一并禁用（恢复说明见模板注释块）
// const showSplash = ref(true)
// /** 当前候选是否为原生系统开屏样式复刻(候选 2);false 即终端叙事动画(候选 1) */
// const splashIsNative = ACTIVE_SPLASH_CANDIDATE === 'native'
// const { startAdvertise, stopAdvertise } = useMdnsAdvertiser()

onMounted(async () => {
  setupTheme()
  setupFontSize()
  // 开屏启动任务打点:主题/字体/安全区等 UI 子系统就绪
  completeStartupTask('ui')
  // 链路加密上下文启动同步（issue 09）：Rust 侧事件 WS 建连前需要拿到
  // 当前开关与 pin；失败静默（默认全关，不影响明文现状）
  void syncLinkCryptoContextToNative()
  // 监听认证成功时 Rust 广播的 pin（配对码/QR/reauth/生物认证统一出口）：
  // 写入 localStorage 供 HTTP/终端 WS 通道与设置页指纹展示（修复 pin 断链）
  try {
    const unlisten = await initLinkCryptoPinSync()
    unlistenQueue.push(unlisten)
  } catch (e) {
    logger.error('[App] initLinkCryptoPinSync failed:', e)
  }
  // mDNS 广播暂时禁用
  // try {
  //   const deviceName = `WasmNest-Mobile-${Math.random().toString(36).slice(2, 6)}`
  //   await startAdvertise(0, deviceName)
  // } catch (e) {
  //   logger.warn('[App] mDNS advertise failed:', e)
  // }
})

// pin 事件监听器句柄（onUnmounted 释放，避免 HMR/测试重复注册泄漏）
const unlistenQueue: Array<() => void> = []

onUnmounted(async () => {
  cleanupTheme()
  for (const unlisten of unlistenQueue.splice(0)) {
    try {
      unlisten()
    } catch (e) {
      logger.error('[App] unlisten failed:', e)
    }
  }
  // await stopAdvertise()
})

// Provide to child components
provide('platformInfo', platformInfo)
provide('isLandscape', isLandscape)
provide('orientation', orientation)
provide('safeArea', safeArea)
provide('keyboardInfo', keyboardInfo)
provide('safeAreaReady', isReady)

// 宿主提供组件面（wasmnestHostComponents）已整面退役（issue #24）：FileExplorer /
// FileSidebar 五件套随唯一消费者 bedcode 迁入应用仓 fileExplorer 域，应用侧直接
// import 渲染，宿主不再 provide（详见 docs/host-exceptions.md §4.2 处置行）。
</script>
