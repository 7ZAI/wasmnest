<template>
  <span
    class="inline-flex items-center justify-center flex-shrink-0 rounded-[12px] border border-[var(--mobile-border)]"
    :style="{
      width: `${size}px`,
      height: `${size}px`,
      background: 'linear-gradient(135deg, var(--shell-brand-ink), var(--shell-brand-ink-deep))',
    }"
    role="img"
    :aria-label="BRAND_NAME"
  >
    <svg :width="size * 0.62" :height="size * 0.62" viewBox="0 0 100 100" aria-hidden="true">
      <!-- 标志几何与应用图标逐字同源（src-tauri/icons/icon.svg）：编织 W 实心态
           （小尺寸档，见品牌 spec §2.3）。底板色由外层 style 提供（品牌 ink 渐变），
           股线用品牌固定纸白、棒料用品牌琥珀——两者都取自 shell.css 的品牌 token
           （壳内禁硬编码色值的锁仍生效，品牌层不是例外面）。
           translate/scale 与 wasmnest-icon-simple.svg 一致，图形约占底板 68%。 -->
      <g transform="translate(15.855,17.193) scale(0.68289)">
        <polygon points="4.54,22.28 26.06,92.71 32.32,59.81 19.46,17.72" fill="var(--shell-brand-stripe)" />
        <polygon points="24.22,90.61 51.10,56.86 51.10,34.38 29.84,61.08" fill="var(--shell-brand-glyph)" />
        <polygon points="48.90,56.86 75.78,90.61 70.16,61.08 48.90,34.38" fill="var(--shell-brand-glyph)" />
        <polygon points="73.94,92.71 95.46,22.28 80.54,17.72 67.68,59.81" fill="var(--shell-brand-glyph)" />
      </g>
    </svg>
  </span>
</template>

<script setup lang="ts">
/**
 * 品牌标志底板
 *
 * 品牌层与 UI 层分离：底板恒为品牌暖炭、图形恒为白，两者都不跟 --mobile-accent /
 * data-palette 走——用户把主色换成海蓝时标志仍是暖炭 + 白。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 38 })

/** 品牌名是专有名词，不做本地化 */
const BRAND_NAME = 'WasmNest'
</script>
