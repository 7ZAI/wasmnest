<template>
  <!-- 应用挂载槽（与宿主 AppMountSlot 同构）：
       槽只占壳标题栏（ShellToolbar，固定常驻）以下的区域——app 不入侵标题栏；
       装载失败 / 契约不匹配 → 显性报错面（fail-visible，不白屏）；
       挂载中 → 加载面。 -->
  <div ref="slotEl" class="app-mount-slot">
    <div v-if="status === 'loading'" class="app-mount-status" role="status">
      <span class="app-mount-spinner"></span>
      <span>{{ t('devshell.apps.loading') }}</span>
    </div>
    <div v-else-if="status === 'error'" class="app-mount-status app-mount-error" role="alert">
      <p>{{ t('devshell.apps.mountFailed') }}</p>
      <p class="app-mount-error-detail">{{ errorDetail }}</p>
      <button class="app-mount-retry" @click="retry">{{ t('devshell.apps.retry') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * AppMountSlot — dev-shell 应用挂载槽（与宿主 `src/shell/mount/AppMountSlot.vue` 同构）
 *
 * 生命周期（与宿主同）：
 * - **换 app**（props.appId 变化）→ 卸载旧实例 + 重挂新实例（组件实例会被复用，
 *   只改 props，onMounted 不再跑——所以 appId 必须有自己的 watcher）；
 * - **离开应用面**（组件卸载）→ 卸载实例；
 * - **宿主面事实变化**（语言 / 主题）→ 通知已挂载 app（handle.setLocale / setTheme），
 *   与真机同一条通知路径。
 *
 * 与宿主的差别只有一处：装载源。宿主动态 import 产物整包，dev-shell 拿的是
 * app 的**源码**模块（vite 已解析进构建图，改代码即 HMR）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { mountAppSource, notifyAppFact, notifyAppRoute, unmountApp } from '../mount/devAppMount'
import { rememberAppRoute } from '../mount/appSession'
import { createMockEnv } from '../../mock/app-env'
import { prepareAppMocks } from '../../loader'
import { getAppRecord, pushLog } from '../../registry'
import { useHostUi } from '../../theme'

const props = defineProps<{
  /** 被调试 app 的 id（空串 = 没有选中 app） */
  appId: string
  /** 宿主路由（dev-shell 无宿主路由表，恒为 '/'） */
  route: string
}>()

const { t, locale } = useI18n()
const { theme } = useHostUi()

const slotEl = ref<HTMLElement | null>(null)
const status = ref<'idle' | 'loading' | 'mounted' | 'error'>('idle')
const errorDetail = ref('')
let handle: { unmount(): Promise<void> } | null = null
/** 领域 mock 句柄（切 app 时先拆上一份） */
let mockHandle: { dispose(): void } | null = null

/**
 * 装载代次：连续切 app 时会有并发装载，旧代次的装载结果必须丢弃——否则晚回来的
 * 旧 app 会盖住新 app 的界面。
 */
let loadSeq = 0

async function mount(route: string): Promise<void> {
  if (!slotEl.value || !props.appId) return
  const seq = ++loadSeq
  // 捕获本次装载的 appId：await 期间 props 可能已经换成另一个 app
  const appId = props.appId
  const record = getAppRecord(appId)
  status.value = 'loading'
  errorDetail.value = ''
  try {
    // 领域 mock 在挂载前重新注册：app 的事件订阅发生在挂载后的组件里，
    // 提前推送的种子事件会被错过
    mockHandle?.dispose()
    mockHandle = prepareAppMocks(appId)

    const env = createMockEnv({
      appId,
      locale: locale.value,
      theme: theme.value,
      initialRoute: route,
      onEvent: (type, payload) => {
        // 'route'：应用自报内部当前页 → 记成「回来时那一页」（与宿主同口径）
        if (type === 'route') {
          const path = (payload as { path?: unknown } | null)?.path
          if (typeof path === 'string') rememberAppRoute(appId, path)
        }
      },
    })
    if (seq !== loadSeq) return // 期间已切到别的 app：本次装载作废
    const next = await mountAppSource(appId, record?.module, slotEl.value, env)
    if (seq !== loadSeq) {
      // 挂载完成时才发现过期：把刚挂上的实例卸掉，别让它盖住新 app
      await unmountApp(appId)
      return
    }
    handle = next
    status.value = 'mounted'
    pushLog('info', appId, '已挂载（机制 B 挂载包）')
  } catch (e: any) {
    if (seq === loadSeq) {
      status.value = 'error'
      errorDetail.value = e?.message || String(e)
    }
    pushLog('error', appId, `挂载失败：${e?.message || e}`)
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

/** 换 app：卸载旧实例 + 装载新实例（组件实例会被复用，onMounted 不再跑） */
watch(
  () => props.appId,
  async (newId, oldId) => {
    if (!oldId || newId === oldId) return
    if (handle) {
      handle = null
      await unmountApp(oldId)
    }
    mockHandle?.dispose()
    mockHandle = null
    // 领域种子**不**随切换释放：种子是 app 工程的静态演示数据（装载时登记一次），
    // 释放了就再也回不来——切回该 app 时领域 mock 会拿不到种子而返回空态
    await mount(props.route)
  },
)

/** 宿主面事实变化：语言 / 主题 → 通知已挂载 app（与真机同一条路径） */
watch(
  () => locale.value,
  (next) => {
    void notifyAppFact(props.appId, 'locale', next)
  },
)
watch(
  () => theme.value,
  (next) => {
    void notifyAppFact(props.appId, 'theme', next)
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
  mockHandle?.dispose()
  mockHandle = null
  if (handle) {
    const appId = props.appId
    handle = null
    void unmountApp(appId)
  }
})

defineExpose({ status })
</script>

<style scoped>
.app-mount-slot {
  position: relative;
  width: 100%;
  /* 壳根是定高纵向 flex（.shell-root），上方还有一行常驻标题栏（height = --toolbar-h）：
     槽只吃**剩余**高度（flex: 1 1 0 + min-height: 0）。 */
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 壳根统一关掉文本选中（误拖会把整屏文字染成蓝底）；应用内容仍要可选/可复制 */
  user-select: text;
}

/* app 挂载包根元素是另一个 Vue 实例挂进来的（不带本组件的 scoped 属性），必须显式拉满
   槽高：app 侧的 height: 100% / h-full 才有确定参照，不必各自写 100vh。 */
.app-mount-slot > :deep(*) {
  flex: 1 1 auto;
  min-height: 0;
}
.app-mount-status {
  height: 100%;
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
  border: 1px solid var(--border-strong);
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: calc(12px * var(--ui-scale, 1));
  cursor: pointer;
}
.app-mount-retry:hover {
  background: var(--bg-hover);
}
/* 装载失败详情：技术原因（契约不匹配 / 缺 mountApp）必须写出来，否则开发者只看到
   一句「挂载失败」，无从判断是自己的哪一行错了 */
.app-mount-error-detail {
  max-width: 70ch;
  text-align: center;
  color: var(--text-tertiary);
  font-size: calc(12px * var(--ui-scale, 1));
  font-family: Consolas, Monaco, monospace;
  word-break: break-all;
}
</style>
