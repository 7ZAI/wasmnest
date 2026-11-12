<template>
  <div
    class="icon-tile shell-avatar-tint font-semibold select-none"
    :class="size === 'lg' ? 'w-16 h-16 rounded-2xl text-2xl' : 'w-12 h-12 rounded-xl text-lg'"
  >
    {{ letter }}
  </div>
</template>

<script setup lang="ts">
/**
 * LetterAvatar — 中性字母头像（无图标应用的兜底）
 *
 * 2026-11-05 unslop 审核：六组彩虹渐变退役。头像不是主题语义面，但仍是宿主
 * chrome——统一用 `.shell-avatar-tint`（accent tint 底 + secondary 字 + hairline），
 * 与桌面端收敛后的做法一致。首字母仍按名称取，不再按 seed 选色相。
 *
 * `seed` 保留为调用方身份参数（现有调用点不受影响），但不再参与视觉。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    name: string
    /** 身份种子；保留参数兼容，视觉不再随 seed 变化 */
    seed?: string
    size?: 'md' | 'lg'
  }>(),
  { seed: '', size: 'md' }
)

const letter = computed(() => (props.name?.trim().charAt(0) || '?').toUpperCase())
</script>

<style scoped>
.icon-tile {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
</style>
