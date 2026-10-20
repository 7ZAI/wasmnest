/**
 * 宿主前端入口（新 UI 宿主 = 方案 C 壳；桌面 UI 宿主修正 2026-10-17）
 *
 * 用户裁决（2026-10-17 12:35）：ADR 0055「宿主前端整面下沉」做法撤销——**新的
 * UI 宿主（壳）替换旧的**，恢复 `wasmnest-desktop/src/`；旧 UI（侧边栏工作台
 * 形态）下沉为 bedcode 应用的独立界面。宿主只承载壳机制与安全闸门（§5.1
 * ①②③），零业务状态。
 *
 * 启动链：建 i18n / router / pinia → mount 壳根 ShellHost → 后台预初始化平台 /
 * 设置（语言 / 主题）。app 前端（应用仓 apps/<slug>/desktop）是独立构建的挂载包，
 * 由 AppMountSlot 按路由装载（useAppMount），宿主不 import 任何 app 源码。
 */
// WDIO E2E 测试探针：暴露 window.wdioTauri（execute/mock/log），无 Rust wdio 插件配合时静默空转
import '@wdio/tauri-plugin'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'vue-sonner/style.css'
import './style.css'
// 壳共享样式（`.tone-*` / `.sdot` / `.shell-btn` / `.shell-chip` / `.shell-wall` 等，
// `src/shell/**` 组件按类名消费）。必须在这里接线：这些类跨 9 个组件复用，只能放全局
// 样式表；漏掉这行 import 时类名全部无样式（图标无底色、状态点塌成 0×0、壁纸失效），
// 而组件侧看不出任何异常——2026-10-17 实机验证 P0-2 即如此。
import './shell/styles/shell.css'

import ShellHost from './shell/ShellHost.vue'
import router from './router'
import i18n from './i18n'
import { initFrontendLogger, logger } from './utils/frontendLogger'
import { initPlatform } from './composables/usePlatform'
import { useSettingsStore } from './stores/settings'
import { useI18nStore } from './stores/i18n'
import { useToast } from './composables/useToast'
import { applyPageTransitionEffect, DEFAULT_PAGE_TRANSITION_EFFECT } from './utils/pageTransition'

const app = createApp(ShellHost)

// 尽早初始化（dev 专属）：把前端日志经 frontendLogger 批量转发到 Rust 落盘
initFrontendLogger()

// 全局异常处理：Vue 组件渲染/生命周期错误与未捕获的 Promise 拒绝统一提示，
// 避免静默失败。细节全量进 console，toast 只做用户可见的「发生了未知错误」提示
app.config.errorHandler = (err, _instance, info) => {
  logger.error(`[GlobalError] ${info || 'render'}:`, err)
  useToast().error(i18n.global.t('desktop.runtimeUnexpected'))
}

window.addEventListener('unhandledrejection', (event) => {
  logger.error('[GlobalError] unhandledrejection:', event.reason)
  useToast().error(i18n.global.t('desktop.runtimeUnexpected'))
})

// 正式版（release）禁用右键默认菜单：Windows WebView2 / macOS WKWebView 可由 JS
// preventDefault 抑制；Linux 由 Rust 端 GTK context-menu 信号处理。dev 保留右键
// 便于调试。capture 阶段确保先于页面内任意处理器执行。
if (!import.meta.env.DEV) {
  window.addEventListener('contextmenu', (event) => event.preventDefault(), { capture: true })
}

app.use(createPinia())
app.use(router)
app.use(i18n)

// 预初始化：并行执行平台检测与设置加载（壳主题 / 语言 / 字号依赖）
const settingsStore = useSettingsStore()
const i18nStore = useI18nStore()
Promise.all([initPlatform(), settingsStore.loadSettings()]).then(([platformInfo]) => {
  // 平台标记：<html> 上加平台专属 class，供 CSS 做平台条件样式
  // （platform-desktop / platform-mobile / platform-linux 缩放体系）
  if (platformInfo.isDesktop) {
    document.documentElement.classList.add('platform-desktop')
  } else if (platformInfo.isMobile) {
    document.documentElement.classList.add('platform-mobile')
  }
  if (platformInfo.isLinux) {
    document.documentElement.classList.add('platform-linux')
  }

  // 设置加载完成后初始化语言偏好
  i18nStore.initLanguage()
  logger.log('[Init] Platform and settings pre-loaded')
})

// 页面过渡效果写到根元素：必须在 app.mount 之前，否则首屏先按 CSS 缺省效果渲染一帧。
// 拼错 → 记一条 error 并回落默认效果（测试路径仍保留 throw 做精确断言）。
try {
  applyPageTransitionEffect(document.documentElement)
} catch (e) {
  console.error('[Init] page transition effect invalid, falling back to default', e)
  document.documentElement.dataset.pageFx = DEFAULT_PAGE_TRANSITION_EFFECT
}

app.mount('#app')
