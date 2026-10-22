<template>
  <!-- 应用挂载槽（机制 B：同窗口挂载独立构建的 app 整包）：
       槽只占壳标题栏（ShellToolbar，固定常驻）以下的区域——wasm-app 不入侵标题栏；
       装载失败 / 契约不匹配 → 显性报错面（fail-visible，不白屏）；
       挂载中 → 加载面（壳主屏同款骨架，不闪烁）。

       **DOM 所有权分层（2026-10-21 修）**：应用的挂载容器与宿主的状态层必须分开。
       Vue 的 `app.mount(container)` 会先 `container.innerHTML = ''`——若状态层也在
       同一个容器里，挂载瞬间宿主自己的 DOM 会被清空（vdom 仍引用着它们），宿主随后
       patch 该容器时拿到失效容器 → `TypeError: null is not an object (evaluating
       't.insertBefore')` → 壳弹「发生了未知错误，详见日志」（dev:host 实测）。
       故：容器只放应用自己的 DOM，状态层是它的兄弟节点（覆在其上）。 -->
  <div class="app-mount-wrap">
    <!-- 应用整包的专用挂载容器（宿主不在里面放任何自己的 DOM） -->
    <div ref="slotEl" class="app-mount-slot"></div>
    <div v-if="status === 'loading'" class="app-mount-status" role="status">
      <span class="app-mount-spinner"></span>
      <span>{{ t('shell.apps.loading') }}</span>
    </div>
    <div v-else-if="status === 'error'" class="app-mount-status app-mount-error" role="alert">
      <p>{{ t('shell.apps.mountFailed') }}</p>
      <button class="app-mount-retry" @click="retry">{{ t('errors.retry') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * AppMountSlot — 宿主应用挂载槽（内容区在壳标题栏之下）
 *
 * 生命周期（两种变化必须分开处理，混在一起就会出现「切了应用还是旧界面」）：
 * - **同一 app 内换页**（/sessions → /tasks）：props.route 变化 → notifyAppRoute →
 *   应用内存路由自己消化，实例不重建；
 * - **换 app**（bedcode ↔ ai-chatbox 等）：props.**appId** 变化 → 卸载旧实例 + 重挂新实例。
 *   注意壳里本组件只渲染一次（ShellHost 的应用分支），路由切换只换 props，**组件实例
 *   会被复用、onMounted 不会再跑**——所以 appId 必须有自己的 watcher；只靠路由 watcher
 *   会把旧 app 的 DOM 留在槽里、新 app 从未 mount。
 * - 离开应用面（回主屏 / 进系统页）→ 组件卸载 → onBeforeUnmount 卸载实例。
 *
 * 布局：壳标题栏是常驻 chrome，槽只吃它以下的剩余高度（见 style 注释）；应用包
 * 的根元素由槽拉满，app 侧不应再按 100vh 定高，也不应自绘标题栏 / 窗口控制。
 *
 * DOM 所有权：应用前端由**另一个 Vue 实例**挂进来（`app.mount(container)`），而
 * Vue 的 mount 会先 `container.innerHTML = ''`。故挂载容器（`.app-mount-slot`）里
 * 只放应用自己的 DOM，宿主的状态层（加载 / 失败）是它的兄弟节点——两者同层时，
 * 挂载瞬间宿主 DOM 会被清空而 vdom 仍引用着它们，宿主随后 patch 拿到失效容器 →
 * TypeError（2026-10-21 dev:host 实测）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  useAppMount,
  MOUNT_CONTRACT,
  mountAppMonitorPanel,
  type AppMountEnv,
  type AppMountHandle,
  type MonitorPanelEnv,
} from '@/shell/mount/useAppMount'
import { MONITOR_PLUGIN_ID } from '@/shell/composables/useShellApps'
import { rememberAppRoute } from '@/shell/mount/appSession'
import { useSettingsStore } from '@/stores/settings'
import { usePlatform } from '@/composables/usePlatform'
import { appInvoke, appStorageGet, appStorageSet, appStorageDelete, refreshChannelToken } from '@/utils/appCommands'
import { invoke } from '@/utils/invoke'
import { logger } from '@/utils/frontendLogger'

const props = defineProps<{
  appId: string
  route: string
}>()

const { t } = useI18n()
const router = useRouter()
const { mountAppBundle, unmountAppBundle, notifyAppRoute } = useAppMount()

const slotEl = ref<HTMLElement | null>(null)
const status = ref<'idle' | 'loading' | 'mounted' | 'error'>('idle')
let handle: AppMountHandle | null = null

/**
 * 装载代次：连续切应用（多任务面板连点两张卡）时会有并发装载，
 * 旧代次的装载结果必须丢弃——否则晚回来的旧 app 会盖住新 app 的界面。
 */
let loadSeq = 0

/** 构建挂载环境：令牌一次性获取；失败 = 显性报错（fail-closed） */
async function buildEnv(initialRoute: string, appId: string): Promise<AppMountEnv> {
  const settingsStore = useSettingsStore()
  const { platformInfo } = usePlatform()
  // 插件面令牌（挂载 = 身份重绑点：一律换发，不信任页面内存里的旧缓存——
  // 插件停用再启用后旧令牌已被宿主回收，复用会让进入应用的第一批命令全被拒）；
  // app 未运行 / 未授权时取不到 → 显性报错，不静默降级
  await refreshChannelToken(appId)
  return {
    appId,
    mountContract: MOUNT_CONTRACT,
    invoke: (command, args) => invoke(command, args ?? {}),
    appInvoke: (command, ...args) => appInvoke(appId, command, ...args),
    appStorageGet: (key) => appStorageGet(appId, key),
    appStorageSet: (key, value) => appStorageSet(appId, key, value),
    appStorageDelete: (key) => appStorageDelete(appId, key),
    locale: settingsStore.settings.ui.language || 'zh-CN',
    theme: settingsStore.settings.ui.theme || 'dark',
    platform: platformInfo.value.isDesktop ? 'desktop' : 'mobile',
    initialRoute,
    // 自定义监控面板装载：只对 monitor 注入；面板实现住提供方 app bundle。
    // monitor 只拿容器 + 句柄，不直接 import 他人 bundle / 不拼 asset URL。
    mountMonitorPanel:
      appId === MONITOR_PLUGIN_ID
        ? async (root, targetAppId, panelId) => {
            // 面板用提供方自己的通道；提供方未运行 / 无令牌时**不阻断装载**：
            // 面板元数据不依赖激活（未运行的应用也要能列出面板），面板自己渲染
            // 「应用未运行」态；命令面失败由面板的 appInvoke 拒绝暴露，宿主不代猜。
            // 只 warn 留痕，不像挂载主界面那样把宿主面凭证缺失升为装载失败。
            try {
              await refreshChannelToken(targetAppId)
            } catch (e) {
              logger.warn(
                `[AppMount] panel provider channel token unavailable (${targetAppId}), ` +
                  `mounting panel anyway: ${panelId}`,
                e,
              )
            }
            const panelEnv: MonitorPanelEnv = {
              appId: targetAppId,
              panelId,
              appInvoke: (command, ...args) => appInvoke(targetAppId, command, ...args),
              appStorageGet: (key) => appStorageGet(targetAppId, key),
              locale: settingsStore.settings.ui.language || 'zh-CN',
              theme: settingsStore.settings.ui.theme || 'dark',
              platform: platformInfo.value.isDesktop ? 'desktop' : 'mobile',
            }
            return await mountAppMonitorPanel(root, panelEnv)
          }
        : undefined,
    onEvent: (type, payload) => {
      // 'navigate'：应用请求宿主导航（壳路由跳转 / 深链开面）
      if (type === 'navigate' && typeof payload === 'string') {
        void router.push(payload)
      }
      // 'route'：应用自报内部当前页 → 记成「回来时那一页」。应用跑内存路由，
      // 宿主 history 看不到它的内部跳转，只能由应用上报；记录归 shell/mount/appSession，
      // 回主屏保留、停用 / 卸载时清掉（见 useShellState 的关闭路径）。
      if (type === 'route') {
        const path = (payload as { path?: unknown } | null)?.path
        if (typeof path === 'string') rememberAppRoute(appId, path)
      }
    },
  }
}

async function mount(initialRoute: string): Promise<void> {
  if (!slotEl.value) return
  const seq = ++loadSeq
  // 捕获本次装载的 appId：await 期间 props 可能已经换成另一个应用
  const appId = props.appId
  status.value = 'loading'
  try {
    const env = await buildEnv(initialRoute, appId)
    if (seq !== loadSeq) return // 期间已切到别的应用：本次装载作废
    const next = await mountAppBundle(slotEl.value, env)
    if (seq !== loadSeq) {
      // 挂载完成时才发现过期：把刚挂上的实例卸掉，别让它盖住新应用
      await unmountAppBundle(appId)
      return
    }
    handle = next
    status.value = 'mounted'
  } catch (e) {
    if (seq === loadSeq) status.value = 'error'
    // ADR 0030：技术详情只进日志。此前把 `e.message` 直接铺在界面上，用户看到的是
    // 浏览器原文（`Importing a module script failed.`）与 ABI/linker 错误——既不可读，
    // 也让「哪个环节坏了」无处可查（日志里带 appId，排障看这里）。
    logger.error(`[AppMount] mount failed: appId=${appId} route=${initialRoute}`, e)
  }
}

/** 宿主路由变化：同一 app 内换页 → 通知应用消化（实例不重建） */
watch(
  () => props.route,
  (r) => {
    if (status.value === 'mounted' && handle) {
      void notifyAppRoute(props.appId, r)
    }
  },
)

/**
 * 换应用：卸载旧实例 + 装载新实例。
 *
 * 必须单独盯 `props.appId`：ShellHost 里本组件只渲染一次，两个应用路由之间切换时
 * Vue 会**复用同一个实例**（只改 props，onMounted 不再触发）。此前把换应用交给
 * 「组件重建」处理，实际什么也没发生——旧 app 的 DOM 留在槽里、新 app 从未 mount，
 * 表现就是「在多任务里点了 ai-chatbox，界面还是 bedcode」。
 */
watch(
  () => props.appId,
  async (newId, oldId) => {
    if (!oldId || newId === oldId) return
    if (handle) {
      handle = null
      await unmountAppBundle(oldId)
    }
    await mount(props.route)
  },
)

function retry(): void {
  void mount(props.route)
}

onMounted(() => {
  void mount(props.route)
})

onBeforeUnmount(() => {
  // 作废在途装载：卸载后再落地的 mount 会把实例挂到一个已经不存在的槽上
  loadSeq += 1
  // 卸载实例（离开应用面 / 关卡片）
  if (handle) {
    const appId = props.appId
    handle = null
    void unmountAppBundle(appId)
  }
})

defineExpose({ status })
</script>

<style scoped>
/* 槽的外壳：壳根 flex 里的那一个可伸缩项（槽本体降为它的子项，状态层是槽的兄弟） */
.app-mount-wrap {
  position: relative;
  width: 100%;
  /* 壳根是定高纵向 flex（.shell-root），上方还有一行常驻标题栏（height = --toolbar-h）：
     槽只吃**剩余**高度（flex: 1 1 0 + min-height: 0）。此前写 height: 100% 是按壳根
     整高算的，加标题栏后应用界面会整体下沉 44px、底边被窗口裁掉。 */
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 壳根统一关掉文本选中（误拖会把整屏文字染成蓝底）；应用内容仍要可选/可复制 */
  user-select: text;
}

.app-mount-slot {
  position: relative;
  width: 100%;
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 应用包根元素是另一个 Vue 实例挂进来的（不带本组件的 scoped 属性），必须显式拉满
   槽高：app 侧的 height: 100% / h-full 才有确定参照，不必各自写 100vh（写了就
   溢出到标题栏下方的窗口外）。 */
.app-mount-slot > :deep(*) {
  flex: 1 1 auto;
  min-height: 0;
}
/* 状态层（加载 / 失败）：覆在槽之上而非占布局（占了就与应用容器抢高度）。
   绝对定位的父级是 .app-mount-wrap（position: relative）。 */
.app-mount-status {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
  font-size: calc(14px * var(--ui-scale, 1));
}
.app-mount-spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--bg-hover);
  border-top-color: var(--color-primary);
  animation: app-mount-spin 0.8s linear infinite;
}
@keyframes app-mount-spin {
  to {
    transform: rotate(360deg);
  }
}
.app-mount-retry {
  padding: 6px 16px;
  border-radius: var(--radius-button);
  /* token 必须是 style.css 里真实存在的（此前写的 --border-color / --bg-elevated
     全仓零定义，浏览器静默回退成透明边框 + 无底色） */
  border: 1px solid var(--border-strong);
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: calc(12px * var(--ui-scale, 1));
  cursor: pointer;
}
.app-mount-retry:hover {
  background: var(--bg-hover);
}
</style>
