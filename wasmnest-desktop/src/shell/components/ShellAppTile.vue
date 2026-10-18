<template>
  <span
    class="glyph-box"
    :class="logo ? 'has-logo' : ['tone-' + tone, { 'cursor-pointer': clickable }]"
    :style="boxStyle"
    :aria-hidden="decorative ? 'true' : undefined"
  >
    <!-- 应用图标优先用应用包自带的那张（manifest.icon，经 asset 协议加载）；
         加载不出来（未声明 / 文件缺失 / 无 asset 协议）→ 回退壳内通用图标 -->
    <img
      v-if="logo"
      class="logo"
      :src="logo"
      alt=""
      draggable="false"
      @error="logoFailed = true"
    />
    <ShellIcon v-else :name="icon" :size="iconSize" :stroke-width="1.7" />
  </span>
</template>

<script setup lang="ts">
/**
 * ShellAppTile — 应用图标块
 *
 * 两种形态：
 * - **应用自带图标**（给了 `pluginId`）：`<asset>/<appId>/<manifest.icon>`，是各个
 *   wasm-app 原本那张图标（彩色底 + 自己的图形），不再由宿主哈希派一个通用 glyph；
 * - **回退**（无 pluginId / 解析失败 / 图片加载失败）：tone 底色 + 壳图标 glyph。
 *
 * 尺寸按 CSS 变量注入（组件自身不决定业务尺寸）：调用方给 width/height（px
 * 或 CSS 值），glyph 大小按 0.46 比例派生；图标图按整块铺满（自带圆角底板）。
 */
import { computed, ref, watch } from 'vue'
import ShellIcon from './ShellIcon.vue'
import { appIconUrl } from '../appIcons'
import type { AppTone } from '../state'

const props = withDefaults(
  defineProps<{
    /** 回退用的壳图标名（应用自带图标不可用时显示） */
    icon: string
    /** 应用 id（= pluginId）；给了才尝试加载应用自带图标 */
    pluginId?: string
    /** manifest.icon 里的文件名（缺省 icon.svg） */
    iconFile?: string
    tone?: AppTone | 'system'
    size?: number
    /** 图标是否纯装饰（aria-hidden） */
    decorative?: boolean
    clickable?: boolean
  }>(),
  // pluginId / iconFile 缺省空串 = 「不尝试加载应用自带图标」（纯壳图标形态）
  { pluginId: '', iconFile: '', tone: 'system', size: 52, decorative: true },
)

const boxStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
}))
const iconSize = computed(() => Math.round(props.size * 0.46))

/** 已解析的应用图标 URL（null = 尚未解析 / 解析失败） */
const logoUrl = ref<string | null>(null)
/** 图片本身加载失败（路径对但文件坏 / 缺文件）：本次挂载内不再重试 */
const logoFailed = ref(false)

const logo = computed(() => (logoFailed.value ? null : logoUrl.value))

// 同一图块换绑不同应用（如多任务列表复用节点）时重新解析；旧结果不得串到新 id
watch(
  () => [props.pluginId, props.iconFile] as const,
  async ([pluginId, iconFile]) => {
    logoUrl.value = null
    logoFailed.value = false
    if (!pluginId) return
    const url = await appIconUrl(pluginId, iconFile)
    // 异步回来时目标可能已经变了（快速切应用）：只接受仍是当前 id 的结果
    if (props.pluginId === pluginId) logoUrl.value = url ?? null
  },
  { immediate: true },
)
</script>

<style scoped>
/* .glyph-box 的基规则（flex 居中 / 圆角 / shrink-0）在 shell.css：系统页页头、主屏
   系统网格、多任务系统卡也用这个类，写在 scoped 里只对应用图标生效（且那几处会
   完全没有样式）。这里只留「应用自带图标」的裁剪规则。 */

/* 应用自带图标：SVG 自带底板与圆角，宿主不再叠 tone 底/描边，只负责裁剪圆角 */
.glyph-box.has-logo {
  overflow: hidden;
  background: none;
  border: none;
}
.glyph-box .logo {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  border-radius: inherit;
}
</style>
