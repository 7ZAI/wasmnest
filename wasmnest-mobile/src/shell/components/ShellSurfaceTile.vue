<template>
  <!-- 多任务卡缩略区：真实实例的当前页面 + 品牌卡 fallback。
       运行中的卡片把保活实例容器搬进来（等比缩放），首帧就是完整品牌卡；
       实例在场才淡入真实画面，缺失则停在图标 + 元信息。 -->
  <div class="shell-live" :data-live-state="phase">
    <div class="shell-live-fallback" :class="{ 'is-hidden': phase === 'live' }">
      <ShellAppIcon :app="app" :size="64" />
      <span v-if="meta" class="shell-recents-thumb-meta">{{ meta }}</span>
    </div>
    <!-- 实例容器挂载点：装饰层，永远不可交互 / 不可聚焦 / 不进无障碍树 -->
    <div ref="boxEl" class="shell-live-surface" inert aria-hidden="true"></div>
  </div>
</template>

<script setup lang="ts">
/**
 * ShellSurfaceTile — 多任务卡里的真实应用实例（2026-10-30 用户裁决，与桌面同口径）
 *
 * 缩略区展示的是**保活实例本身**：注册表把该应用的容器搬进来，按上次实测的整幅
 * 尺寸等比缩放（布局不重排、滚动 / 输入 / 打开的弹层原样），不是截图、不是 DOM
 * 克隆、不是自绘预览面。卡片里的实例 inert（不可交互 / 不可聚焦），卡片手势仍由
 * 外层网格承接。层收起时容器摘回后台（脱文档不渲染，实例保留）。
 *
 * 未运行的最近使用卡、或实例缺失（未打开过 / 装载失败）→ 停在品牌卡「图标 + 真实
 * 元信息」fallback，平台不伪造应用画面。
 *
 * 已知边界：应用若把弹层 Teleport 到 body，不在缩放容器内（与多任务屏同层）；
 * 普通 fixed / absolute 弹层会被 transform 包含块留在卡片里。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { fitSurfacePreview, leaveSurfacePreview, presentSurfaceInPreview } from '../surfaceRuntime'
import type { ShellApp } from '../types'
import ShellAppIcon from './ShellAppIcon.vue'

const props = defineProps<{
  app: ShellApp
  /** 运行中才尝试搬运实例；未运行的最近使用卡只有品牌卡 */
  live: boolean
}>()

const { t } = useI18n()

/** 缩略区元信息：版本 + 权限数，取不到就不留空行 */
const meta = computed(() => {
  const parts: string[] = []
  if (props.app.version) parts.push(`v${props.app.version}`)
  if (props.app.permissions.length > 0) {
    parts.push(t('shell.apps.permissionCount', { count: props.app.permissions.length }))
  }
  return parts.join(' · ')
})

type LivePhase = 'fallback' | 'live'
const phase = ref<LivePhase>('fallback')
const boxEl = ref<HTMLElement | null>(null)

/** 卡片尺寸随旋转 / 分屏 / 卡片数变化：容器尺寸变了就重算缩放（实例布局尺寸不变） */
let observer: ResizeObserver | null = null

function observe(box: HTMLElement): void {
  if (typeof ResizeObserver === 'undefined') return
  observer?.disconnect()
  observer = new ResizeObserver(() => {
    fitSurfacePreview(props.app.id)
  })
  observer.observe(box)
}

/** 运行中才尝试搬运；实例缺失（未打开过 / 装载失败）保持品牌卡 */
function present(): void {
  const box = boxEl.value
  if (!box || !props.live) {
    phase.value = 'fallback'
    return
  }
  if (!presentSurfaceInPreview(props.app.id, box)) {
    phase.value = 'fallback'
    return
  }
  phase.value = 'live'
  observe(box)
}

/** 卡片卸载 / 应用转未运行：实例回后台（保留实例，不销毁）；已停用时是 no-op */
function unpresent(): void {
  observer?.disconnect()
  observer = null
  leaveSurfacePreview(props.app.id)
  phase.value = 'fallback'
}

onMounted(present)

watch(
  () => props.live,
  (live) => {
    if (live) present()
    else unpresent()
  },
)

onBeforeUnmount(unpresent)
</script>
