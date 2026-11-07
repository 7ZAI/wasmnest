<template>
  <!-- 多任务卡片缩略区：真实实例的当前页面 + 品牌卡 fallback。
       实例容器由宿主挂载层搬进来（等比缩放），首帧就是完整品牌卡；
       实例在场才淡入真实画面，缺失（装载失败 / 已停用）则停在 fallback。 -->
  <div class="app-live" :data-live-state="phase">
    <!-- 不能挂 tone-* 类：tone 类带 1px 边框，渐变背景会在边框环里按
         background-origin（padding-box）重绘，卡片底部会露出渐变起点色的细线。
         品牌渐变统一走 fallbackStyle 的 inline background。 -->
    <div
      class="app-live-fallback"
      :class="{ 'is-hidden': phase === 'live' }"
      :style="fallbackStyle"
    >
      <ShellAppTile :icon="icon" :plugin-id="appId" :icon-file="iconFile" :tone="tone" :size="92" />
    </div>
    <!-- 实例容器挂载点：装饰层，永远不可交互 / 不可聚焦 / 不进无障碍树
         （挂载层还会给实例容器本身加 inert；这里只是兜底） -->
    <div ref="surfaceEl" class="app-live-surface" inert aria-hidden="true"></div>
  </div>
</template>

<script setup lang="ts">
/**
 * AppSurfaceTile — 多任务卡片里的真实应用实例（2026-10-30 用户裁决）
 *
 * 卡片展示的是**保活实例本身**：挂载层把 `.app-instance-host` 搬进本组件的容器，
 * 按实例上次实测的整幅尺寸等比缩放（布局不重排、终端不 resize、滚动 / 输入 /
 * 打开的弹层原样），不是截图、不是 DOM 克隆、不是应用自绘的预览面。
 *
 * 本组件只负责：给容器、请求搬运、容器尺寸变化时重算缩放、卸载时把实例摘回后台。
 * 实例缺失（装载失败 / 已被停用）→ 停在品牌卡 fallback，不空白、不报错。
 *
 * 已知边界：应用若把弹层 Teleport 到 body，不在缩放容器内（与多任务层同层），
 * 可能盖在卡片之上；普通 fixed / absolute 弹层会被 transform 包含块留在卡片里。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  fitAppSurfacePreview,
  leaveAppSurfacePreview,
  presentAppSurfaceInPreview,
} from '@/shell/mount/useAppMount'
import ShellAppTile from '../components/ShellAppTile.vue'
import type { AppTone } from '../composables/state'

const props = defineProps<{
  /** 应用 id（= 插件 id）；实例按它从表面注册表取 */
  appId: string
  /** 回退图标：壳内 glyph 名（应用自带图标不可用时显示） */
  icon: string
  /** manifest.icon 里的文件名（缺省 icon.svg） */
  iconFile?: string
  tone: AppTone | 'system'
  /**
   * 缩略区尺寸（px，可选）：由 `recentsLayout` 的解算结果给出。
   *
   * 首帧按它算缩放，避免卡片带还没写成 `--ts-card-w` 时先按兜底三等分缩一次再跳。
   * 但它不是唯一依据：实例容器自己的尺寸仍在变（窗口缩放 / 卡片数变化 / 字号档位
   * 动了信息条高度），所以 ResizeObserver 必须常驻，尺寸变化时**以 DOM 实测为准**
   * 重新校正。0 / 缺省 → 直接量容器。
   */
  thumbWidth?: number
  thumbHeight?: number
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

type LivePhase = 'fallback' | 'live'

const phase = ref<LivePhase>('fallback')
const surfaceEl = ref<HTMLElement | null>(null)

/** 解算给的缩略区尺寸；0 / 缺省 → 回退到量容器 */
function solvedBox(): { width: number; height: number } | null {
  const width = props.thumbWidth ?? 0
  const height = props.thumbHeight ?? 0
  return width > 0 && height > 0 ? { width, height } : null
}

/** 重算缩放：优先用解算尺寸（首帧即准），没有就让它量容器 */
function fit(): void {
  const box = solvedBox()
  if (box) fitAppSurfacePreview(props.appId, box)
  else fitAppSurfacePreview(props.appId)
}

/** 卡片尺寸随窗口 / 卡片数变化：容器尺寸变了就重算缩放（实例布局尺寸不变） */
let observer: ResizeObserver | null = null

onMounted(() => {
  const box = surfaceEl.value
  if (!box) return
  if (!presentAppSurfaceInPreview(props.appId, box, solvedBox() ?? undefined)) return
  phase.value = 'live'
  if (typeof ResizeObserver === 'undefined') return
  // 解算尺寸只保证**首帧**：它来自卡片带的测量结果，而卡片盒子的真实尺寸还会因
  // 窗口缩放 / 卡片增减 / 字号档位（信息条高度）变化。观察器必须常驻，并用 DOM
  // 实测值重算（fit() 走解算值，观察器走实测值）——否则首帧算错一次就永久错下去。
  observer = new ResizeObserver(() => fitAppSurfacePreview(props.appId))
  observer.observe(box)
})

// 卡片数 / 窗口尺寸变化 → 解算结果变化 → 重算缩放（不必等 ResizeObserver）
watch(
  () => [props.thumbWidth, props.thumbHeight] as const,
  () => {
    if (phase.value === 'live') fit()
  },
)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  // 卡片卸载 = 实例回后台（保留实例，不销毁）；已切到挂载槽 / 已停用时是 no-op
  leaveAppSurfacePreview(props.appId)
})
</script>

<style scoped>
/* 预览容器：填满卡片缩略区（父级 .ts-thumb 是 position:relative）。
   contain: layout paint 把实例的布局与绘制关在卡片盒子里——应用内的
   position:fixed / 绝对定位弹层不会逃出卡片，也不会反过来撑高卡片。 */
.app-live {
  position: absolute;
  inset: 0;
  overflow: hidden;
  contain: layout paint;
}

/* 品牌卡 fallback：与真实画面对齐同一盒子，切换不引起任何布局变化 */
.app-live-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  transition: opacity var(--motion-duration-fast) var(--motion-ease);
}
.app-live-fallback.is-hidden {
  opacity: 0;
}

/* 实例容器挂载点：填满容器 + 裁切；就绪后短淡入（只动 opacity） */
.app-live-surface {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--motion-duration-fast) var(--motion-ease);
}
.app-live[data-live-state='live'] .app-live-surface {
  opacity: 1;
}

/* 多任务层 Teleport 到 body、不在 .shell-root 内——shell.css 的系统级减弱动态
   规则够不到这里，本组件自己尊重 prefers-reduced-motion（无淡入 / 无过渡） */
@media (prefers-reduced-motion: reduce) {
  .app-live-fallback,
  .app-live-surface {
    transition: none;
  }
}
</style>
