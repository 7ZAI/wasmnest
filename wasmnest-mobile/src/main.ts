import { createApp } from 'vue'
import { logger } from '@/utils/frontendLogger'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import i18n from './locales'
import { initPlatform } from '@/composables/usePlatform'
import { useSettingsStore } from '@/stores/settings'
import { useI18nStore } from '@/stores/i18n'
import { initPluginSystem } from './plugin'
import { completeStartupTask } from '@/composables/useAppStartup'
import { initFrontendLogger } from '@/utils/frontendLogger'
import { presetThemeBeforeMount } from '@/composables/useTheme'
import './style.css'
import './styles/mobile.css'
// 壳层 token / 品牌色：SplashLoading 在壳路由挂载前就要用（teleport 到 body），
// 不能等 ShellView 的懒加载导入。
import './shell/styles/shell.css'
// 终端内置 CJK 等宽字体的 @font-face 声明（src/styles/terminal-font.css）：
// 声明全局引入，使任意页面都能经 ensureTerminalFontLoaded 预热（会话页的网格预算、
// 终端页的首次测量）；woff2 本体仍只在终端首次渲染时按需下载
import './styles/terminal-font.css'
// 主题预设（内置主题 token 表 + 结构性规则）：必须排在 mobile.css / shell.css 之后，
// 同特异度时后写者胜；主题选择器本身也带 `[data-theme]` 前缀，多数规则不依赖顺序。
import './styles/theme-presets.css'
import 'vue-sonner/style.css'

const app = createApp(App)

// 尽早初始化（debug 构建专属）：把前端日志经 frontendLogger 批量转发到 Rust（tracing → logcat），
// AI agent 通过 tauri:android:dev:log 落盘文件 grep `frontend` 获取；release 两端 logger 均为空函数
initFrontendLogger()
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.use(i18n)

// 预初始化：并行执行平台检测和设置加载
const settingsStore = useSettingsStore()
const i18nStore = useI18nStore()

// 异步初始化流程：设置加载 → 语言初始化 → 主题预设 → 挂载应用（首帧）→ 后台插件初始化
// 插件系统必须在设置加载后初始化，因为插件的启用状态依赖设置
Promise.all([
  initPlatform(),
  settingsStore.loadSettings(),
]).then(async () => {
  // 设置加载完成后初始化语言偏好
  i18nStore.initLanguage()
  // 开屏启动任务打点:平台检测与设置加载均已完成
  completeStartupTask('platform')
  completeStartupTask('settings')
  logger.log('[Init] Platform and settings pre-loaded')

  // 首次渲染前预应用主题（.dark 类 + isSystemDark；主色色板归各 app 自持，此处不预挂）：
  // 消除深色用户「首帧浅色 → onMounted 后深色」的启动闪变
  presetThemeBeforeMount()

  // 设置就绪后初始化插件系统——**先挂载、再后台初始化**
  //
  // 插件初始化主链是「宿主凭证 + 清单 + 逐插件前端 import」，全程 await；放在
  // mount 之前等于让首帧白等整条链（后端还在异步解压内置插件 / 编译 WASM）。
  // 壳首屏的数据来源是宿主命令面（清单），不依赖前端插件注册表；插件注册的
  // 扩展点（工具箱 / 导航 / 设置 / 终端）在就绪后经响应式注册表自动上线。
  app.mount('#app')

  void (async () => {
    try {
      await initPluginSystem(app, pinia, router, i18n)
      logger.log('[Init] Plugin system initialized')
    } catch (e) {
      logger.error('[Init] Plugin system init failed:', e)
    } finally {
      // 插件初始化结束即打点（失败不卡开屏，交给兜底时长）
      completeStartupTask('plugins')
    }
  })()
})
