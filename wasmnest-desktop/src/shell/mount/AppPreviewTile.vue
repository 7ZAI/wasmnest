<template>
  <!-- 多任务卡片缩略区：app 自绘只读预览面 + 品牌卡 fallback。
       首帧就是完整品牌卡（渐变 + 92px 图标），不空白、不 spinner；
       预览挂载成功才淡入盖住 fallback，失败 / 超时 / 未导出则停在 fallback。 -->
  <div class="app-preview" :data-preview-state="phase">
    <!-- 品牌渐变 fallback（初始 / 失败 / 不支持）；ready 后淡出隐藏。
         纯视觉层：不可点击（卡片唯一打开动作是外层覆盖按钮）。 -->
    <div
      class="app-preview-fallback"
      :class="[{ 'is-hidden': phase === 'ready' }, 'tone-' + tone]"
      :style="fallbackStyle"
    >
      <ShellAppTile
        :icon="icon"
        :plugin-id="appId"
        :icon-file="iconFile"
        :tone="tone"
        :size="92"
      />
    </div>
    <!-- 应用自绘预览面挂载点：装饰层，永远不可交互 / 不可聚焦 / 不进无障碍树
         （应用侧契约要求预览 DOM 无可聚焦控件；inert 只是兜底，不是放行） -->
    <div
      ref="previewEl"
      class="app-preview-surface"
      inert
      aria-hidden="true"
      style="pointer-events: none; user-select: none"
    ></div>
  </div>
</template>

<script setup lang="ts">
/**
 * AppPreviewTile — 多任务卡片里的应用预览容器（规格：CONTRACT.md §3）
 *
 * 预览面由应用**自绘**：bundle 可选导出 `mountPreview(root, env)`，在自己的 Vue
 * 实例里画一张只读、点时刻的缩略视图（不是截图 / 不是 DOM 克隆——离开应用面即
 * 卸载实例，后台没有可抓取的 DOM，见 .scratch/2026-10-20-app-preview-contract）。
 * 本组件只负责：给容器、构建收窄的只读环境、装载、3s 超时、卸载、回退品牌卡。
 *
 * 状态机（`data-preview-state`，测试依赖）：
 * - `fallback`：初始 / 未导出 `mountPreview` / 装载失败 / 超时 → 永远一张完整品牌卡；
 * - `loading`：装载中，仍显示 fallback（不闪烁、不空白）；
 * - `ready`：应用预览面已挂上，短淡入。
 *
 * 失败语义（D7）：回退是设计的一部分——不弹 toast、不显示错误、不重试、不影响
 * 卡片打开 / 关闭；技术原因只进日志（带 appId）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  mountAppPreview,
  PREVIEW_MOUNT_TIMEOUT_MS,
  type AppPreviewEnv,
  type AppPreviewHandle,
} from '@/shell/mount/useAppMount'
import { appInvoke, appStorageGet } from '@/utils/appCommands'
import { useSettingsStore } from '@/stores/settings'
import { usePlatform } from '@/composables/usePlatform'
import { logger } from '@/utils/frontendLogger'
import ShellAppTile from '../components/ShellAppTile.vue'
import type { AppTone } from '../composables/state'

const props = defineProps<{
  /** 应用 id（= 插件 id）；预览环境按它绑定命令通道 / KV 命名空间 */
  appId: string
  /** 应用上次自报的内部路径；无记录 = undefined（应用自行回落落地页） */
  lastRoute?: string
  /** 回退图标：壳内 glyph 名（应用自带图标不可用时显示） */
  icon: string
  /** manifest.icon 里的文件名（缺省 icon.svg） */
  iconFile?: string
  tone: AppTone | 'system'
}>()

/** 缩略区品牌渐变底：tone 档 → 语义色 token（与 shell.css 的 tone-* 同源） */
const TONE_ACCENTS: Record<AppTone | 'system', string> = {
  primary: 'var(--color-primary)',
  info: 'var(--color-info)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  mix: 'var(--color-info)',
  system: 'var(--color-info)',
}

/** fallback 品牌渐变（沿用多任务卡既有观感：主题色 → 14% 混入侧栏底色 → 侧栏底色） */
const fallbackStyle = computed<Record<string, string>>(() => {
  const accent = TONE_ACCENTS[props.tone] ?? TONE_ACCENTS.system
  return {
    background: `linear-gradient(160deg, ${accent} 0%, color-mix(in srgb, ${accent} 14%, var(--bg-sidebar)) 55%, var(--bg-sidebar) 100%)`,
  }
})

type PreviewPhase = 'fallback' | 'loading' | 'ready'

const phase = ref<PreviewPhase>('fallback')
const previewEl = ref<HTMLElement | null>(null)

const settingsStore = useSettingsStore()
const { platformInfo } = usePlatform()

/** 已挂载的预览句柄（卸载卡片 / 卸载完成时收尾）；未挂上 = null */
let handle: AppPreviewHandle | null = null
/** 组件已卸载：作废在途装载，晚到的 handle 立刻卸载，不写已卸载的 DOM */
let disposed = false
/** 装载代次（只用于迟到结果判定；本组件不换 appId，保留作为显式生命周期标记） */
let mountSeq = 0
/** 已经 unmount 过的句柄：同一 handle 只卸载一次（超时 + 卸载等路径可能重叠） */
const unmountedHandles = new WeakSet<AppPreviewHandle>()

/** 超时哨兵（与 `null` = 未导出区分：后者是正常的不支持，不告警） */
const TIMEOUT = Symbol('app-preview-mount-timeout')

/**
 * 卸载句柄（幂等 + 吞异常）。
 *
 * `unmount()` 抛错只记日志、不阻断多任务关闭（D7）：卡片已经消失，用户不该因为
 * 应用预览清理失败而卡住。
 */
function unmountOnce(target: AppPreviewHandle): void {
  if (unmountedHandles.has(target)) return
  unmountedHandles.add(target)
  try {
    void Promise.resolve(target.unmount()).catch((e) => {
      logger.error(`[AppPreview] unmount failed: appId=${props.appId}`, e)
    })
  } catch (e) {
    logger.error(`[AppPreview] unmount failed: appId=${props.appId}`, e)
  }
}

/**
 * 构建预览环境：只读收窄面（无宿主命令 / 无写存储 / 无事件出口）。
 *
 * 不主动做身份重绑——预览是旁路展示，主实例可能正在遮罩后运行；命令自身按需
 * 取已有通道凭证即可（缓存命中优先）。
 */
function buildEnv(appId: string): AppPreviewEnv {
  return {
    appId,
    lastRoute: props.lastRoute,
    appInvoke: (command, ...args) => appInvoke(appId, command, ...args),
    appStorageGet: (key) => appStorageGet(appId, key),
    locale: settingsStore.settings.ui.language || 'zh-CN',
    theme: settingsStore.settings.ui.theme || 'dark',
    platform: platformInfo.value.isDesktop ? 'desktop' : 'mobile',
  }
}

/** 回退品牌卡：先清掉半挂载内容（有句柄的路径由调用方先卸载），再让日志说话 */
function fallbackWith(reason: unknown): void {
  phase.value = 'fallback'
  previewEl.value?.replaceChildren()
  logger.warn(`[AppPreview] mount failed: appId=${props.appId}`, reason)
}

/**
 * 装载预览面（onMounted 唯一入口）。
 *
 * 3s 超时只覆盖 `mountPreview` 返回句柄，不覆盖预览内部取数（应用应先挂骨架 /
 * 空态并立即 resolve）。超时 / 卸载后才 resolve 的 handle 必须立即 unmount，
 * 不能把 DOM 留在已消失的卡片上。
 */
async function mountPreview(): Promise<void> {
  const root = previewEl.value
  if (!root) return
  const appId = props.appId
  const seq = ++mountSeq
  phase.value = 'loading'

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutSignal = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), PREVIEW_MOUNT_TIMEOUT_MS)
  })
  const pending = mountAppPreview(root, buildEnv(appId))

  try {
    const result = await Promise.race([pending, timeoutSignal])
    if (timer !== undefined) clearTimeout(timer)
    const stale = disposed || seq !== mountSeq

    if (result === TIMEOUT) {
      // 超时：清掉半挂载内容 → 回退；晚到的句柄立即卸载（应用可能先写 DOM 再返回）
      if (stale) root.replaceChildren()
      else fallbackWith(`timed out after ${PREVIEW_MOUNT_TIMEOUT_MS}ms`)
      void pending
        .then((late) => {
          if (late) unmountOnce(late)
        })
        .catch(() => {
          // 超时后才失败的装载同样只回退：这里已无界面可改，异常只由上面的日志说明
        })
      return
    }

    if (!result) {
      // bundle 未导出 mountPreview：正常的不支持，不报错、不 warn
      if (!stale) phase.value = 'fallback'
      return
    }

    if (stale) {
      unmountOnce(result)
      return
    }
    handle = result
    phase.value = 'ready'
  } catch (e) {
    if (timer !== undefined) clearTimeout(timer)
    // 已卸载 / 已作废的装载不再改界面（晚到失败没有可显示的 fallback）
    if (!(disposed || seq !== mountSeq)) fallbackWith(e)
  }
}

onMounted(() => {
  void mountPreview()
})

onBeforeUnmount(() => {
  // 作废在途装载：之后 resolve 的 handle 立刻卸载，不得挂到已卸载的卡片上
  disposed = true
  mountSeq += 1
  const current = handle
  handle = null
  if (current) unmountOnce(current)
})
</script>

<style scoped>
/* 预览容器：填满卡片缩略区（父级 .ts-thumb 是 position:relative）。
   contain: layout paint 把应用预览面的布局与绘制关在卡片盒子里——应用内的
   position:fixed / 绝对定位弹层不会逃出卡片，也不会反过来撑高卡片（不跳动）。 */
.app-preview {
  position: absolute;
  inset: 0;
  overflow: hidden;
  contain: layout paint;
}

/* 品牌卡 fallback：与预览面占同一个盒子，切换不引起任何布局变化 */
.app-preview-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  transition: opacity var(--motion-duration-fast) var(--motion-ease);
}
.app-preview-fallback.is-hidden {
  opacity: 0;
}

/* 应用自绘预览面挂载点：填满容器 + 裁切；ready 后短淡入（只动 opacity） */
.app-preview-surface {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  opacity: 0;
  transition: opacity var(--motion-duration-fast) var(--motion-ease);
}
.app-preview[data-preview-state='ready'] .app-preview-surface {
  opacity: 1;
}

/* 多任务层 Teleport 到 body、不在 .shell-root 内——shell.css 的系统级减弱动态
   规则够不到这里，本组件自己尊重 prefers-reduced-motion（无淡入 / 无过渡） */
@media (prefers-reduced-motion: reduce) {
  .app-preview-fallback,
  .app-preview-surface {
    transition: none;
  }
}
</style>
