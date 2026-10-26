<template>
  <!-- 品牌标志直接取应用图标真源（src-tauri/icons/icon.svg，与桌面端最新重建的图标逐字同源）：
       同一 100×100 画框、同一 rx=22.5 圆角底、同一镂空编织 W（124 条描边曲线）。
       前端不复制第二份图形，避免图标与壳内品牌位再次漂移；尺寸只缩放整张 SVG。 -->
  <img
    class="flex-shrink-0"
    :src="brandLogo"
    :width="size"
    :height="size"
    :alt="BRAND_NAME"
    draggable="false"
  />
</template>

<script setup lang="ts">
/**
 * 品牌标志
 *
 * 真源 = 应用图标 wasmnest-mobile/src-tauri/icons/icon.svg（与桌面端
 * d8a5de5 重新生成的应用图标一致：四根圆柱同一套螺旋线框的镂空 W）。
 * 品牌层与 UI 层分离：底色与图形都为品牌固定值，不跟 --mobile-accent /
 * data-palette 走——用户把主色换成海蓝时标志仍是暖炭 + 白。
 * 直接引用图标文件而非内联第二份路径，杜绝“图标已更新、壳内还是旧标志”。
 */
import brandLogo from '../../../src-tauri/icons/icon.svg'

withDefaults(defineProps<{ size?: number }>(), { size: 38 })

/** 品牌名是专有名词，不做本地化 */
const BRAND_NAME = 'WasmNest'
</script>
