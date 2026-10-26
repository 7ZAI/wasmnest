/**
 * Dev Shell 入口（桌面端 · 挂载包形态）
 *
 * 初始化顺序：主题/字号 → i18n → Tauri IPC 垫片 → 装载 app → 挂载壳。
 *
 * 主题/字号先于 i18n：壳的深浅色类必须在首帧就位（app 的挂载面要按同一套
 * token 渲染，先挂后设会出现一帧错色）。
 */
import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import App from './App.vue'
import { initHostUi } from './theme'
import { readSavedLocale } from './locale'
import { zhCN, en } from './locales'
import { installTauriIpcShim } from './mock/tauri-ipc'
import { loadApps } from './loader'
import 'vue-sonner/style.css'
// 设计 token 单一真源：monorepo 内直接指向宿主 `src/style.css`（跟随宿主更新，
// 零维护）；npm 包内没有宿主，退回自带副本（`files` 白名单携带），副本与宿主的
// 一致性由 `dev-shell/__tests__/visualParity.test.ts` 钉住。
import '@wasmnest/desktop-styles/style.css'
import '@wasmnest/desktop-shell-styles/shell.css'
import './styles/dev.css'

// 恢复持久化的宿主界面设置（主题模式 / 字体大小），与宿主 useTheme/useFontSize 同语义
initHostUi()

const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: readSavedLocale(),
  fallbackLocale: 'en',
  messages: { 'zh-CN': zhCN, en },
  missingWarn: false,
  fallbackWarn: false,
})

// Tauri IPC 垫片：app 的事件订阅（listen）走这条通道，浏览器里没有 Tauri 运行时
installTauriIpcShim()

const app = createApp(App)
app.use(i18n)

await loadApps()

app.mount('#app')
