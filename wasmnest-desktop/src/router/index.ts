/**
 * 宿主路由表（新 UI 宿主 = 方案 C 壳；桌面 UI 宿主修正 2026-10-17）
 *
 * 路由归属（§5.1.1 工程设计）：**宿主持有 history 路由表**，应用界面由挂载槽
 * （AppMountSlot）装载各 wasm app 独立构建的前端整包：
 * - 壳路由：'/' 主屏、'/sys/:pageId' 系统页全屏；
 * - 应用路由：按「应用路由目录」（useShellApps SURFACE_ROUTES 前缀集）逐条声明，
 *   指向 AppMountSlot（props: appId + route），路由变化 → handle.setRoute 通知应用
 *   内存路由消化；应用包不存在/装载失败 → 挂载槽显性报错（fail-visible）；
 * - 未匹配路由 → 显性 not-found（退役面 /plugins 等直达时兜底，不白屏）。
 *
 * 应用路由前缀（bedcode 保持既有路径，深链 /terminal-window/:id 语义不变）：
 * - com.wasmnest.bedcode：/pairing /sessions /tasks /settings(.*)?
 *   /server /history /terminal-window/:id
 * - com.wasmnest.agent-hub：/hub
 * - com.wasmnest.ai-chatbox：/chat
 * - com.wasmnest.file-transfer：/transfer
 * - com.wasmnest.monitor：/monitor
 * - com.wasmnest.auth-center：/auth（服务型 wasm，应用仓 servers/auth-center）
 */
import { createRouter, createWebHistory } from 'vue-router'

import AppMountSlot from '@/shell/mount/AppMountSlot.vue'
import {
  TERMINAL_PLUGIN_ID,
  AGENT_HUB_PLUGIN_ID,
  AI_CHATBOX_PLUGIN_ID,
  FILE_TRANSFER_PLUGIN_ID,
  MONITOR_PLUGIN_ID,
  AUTH_CENTER_PLUGIN_ID,
} from '@/shell/composables/useShellApps'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    // ==================== 壳路由 ====================
    {
      path: '/',
      name: 'shell-home',
      component: () => import('@/shell/views/ShellView.vue'),
    },
    {
      // 系统页（宿主自有管理面）：设置 / 应用管理 / 权限与授权，与业务应用同构产卡；
      // :sub = 系统页二级页（如 /sys/settings/appearance 外观）——同一张系统页卡内
      // 切子路由（faceOfRoute 仍按 [2] 段归到父页卡），不另产卡
      path: '/sys/:pageId/:sub',
      name: 'shell-sys-sub',
      component: () => import('@/shell/components/ShellCardScreen.vue'),
    },
    {
      path: '/sys/:pageId',
      name: 'shell-sys',
      component: () => import('@/shell/components/ShellCardScreen.vue'),
    },

    // ==================== bedcode 应用面（保持既有路径与深链语义） ====================
    {
      path: '/pairing',
      name: 'pairing',
      component: AppMountSlot,
      props: { appId: TERMINAL_PLUGIN_ID, route: '/pairing' },
    },
    {
      path: '/sessions',
      name: 'sessions',
      component: AppMountSlot,
      props: { appId: TERMINAL_PLUGIN_ID, route: '/sessions' },
    },
    {
      path: '/tasks',
      name: 'tasks',
      component: AppMountSlot,
      props: { appId: TERMINAL_PLUGIN_ID, route: '/tasks' },
    },
    {
      // 连接历史：设备列表「历史」按钮 query 深链直达
      path: '/history',
      name: 'history',
      component: AppMountSlot,
      props: { appId: TERMINAL_PLUGIN_ID, route: '/history' },
    },
    {
      // 设置（业务分组：配对 / 会话；平台分组在系统页 /sys/settings）
      path: '/settings',
      name: 'settings',
      component: AppMountSlot,
      props: { appId: TERMINAL_PLUGIN_ID, route: '/settings' },
    },
    {
      path: '/settings/:sub(.*)?',
      name: 'settings-sub',
      component: AppMountSlot,
      props: (route) => ({ appId: TERMINAL_PLUGIN_ID, route: route.fullPath }),
    },
    {
      // 服务器诊断页：URL 直达、不进导航（产品决策不变）
      path: '/server',
      name: 'server',
      component: AppMountSlot,
      props: { appId: TERMINAL_PLUGIN_ID, route: '/server' },
    },
    {
      // 独立终端窗口：bareWindow（不套侧边栏外壳），深链开窗语义不变
      path: '/terminal-window/:id',
      name: 'terminal-window',
      component: AppMountSlot,
      props: (route) => ({
        appId: TERMINAL_PLUGIN_ID,
        route: route.fullPath,
      }),
      meta: { bareWindow: true },
    },

    // ==================== 其余 wasm app 应用面（独立界面，挂载整包） ====================
    {
      path: '/hub',
      name: 'app-agent-hub',
      component: AppMountSlot,
      props: { appId: AGENT_HUB_PLUGIN_ID, route: '/hub' },
    },
    {
      path: '/chat',
      name: 'app-ai-chatbox',
      component: AppMountSlot,
      props: { appId: AI_CHATBOX_PLUGIN_ID, route: '/chat' },
    },
    {
      path: '/transfer',
      name: 'app-file-transfer',
      component: AppMountSlot,
      props: { appId: FILE_TRANSFER_PLUGIN_ID, route: '/transfer' },
    },
    {
      path: '/monitor',
      name: 'app-monitor',
      component: AppMountSlot,
      props: { appId: MONITOR_PLUGIN_ID, route: '/monitor' },
    },
    {
      // 认证中心（服务型 wasm，应用仓 `servers/auth-center`）：系统服务面
      path: '/auth',
      name: 'app-auth-center',
      component: AppMountSlot,
      props: { appId: AUTH_CENTER_PLUGIN_ID, route: '/auth' },
    },

    // ==================== 兜底 ====================
    {
      // 未匹配路由兜底（fail-visible）：退役面（/plugins /plugin/*）与拼错路径
      // 统一落显性 not-found 页，不白屏
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/shell/views/NotFoundView.vue'),
    },
  ],
})

export default router
