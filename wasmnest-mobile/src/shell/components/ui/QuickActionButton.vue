<template>
  <div class="quick-action" @click="$emit('click')">
    <div
      class="aspect-square rounded-2xl flex flex-col items-center justify-center gap-2 p-4 transition-[border-color,background-color,opacity] duration-150 active:opacity-80 border border-[var(--mobile-border)] hover:border-[var(--mobile-border-hover)] bg-[var(--mobile-bg-card)]"
      :style="{ backgroundColor: `color-mix(in srgb, ${color} 6%, transparent)`, borderColor: `color-mix(in srgb, ${color} 20%, transparent)` }"
    >
      <span class="text-2xl">{{ icon }}</span>
      <span class="text-sm font-medium text-center text-[var(--mobile-text-secondary)]">{{ name }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * QuickActionButton — 快捷操作磁贴（图标 + 名称 + 主题色淡底）
 *
 * 迁移自旧公共组件 `src/components/QuickActionButton.vue`（壳内自足化）。
 * 2026-11-05 unslop 审核：hover 光晕与按压缩放退役——磁贴的强调已经由
 * color prop 派生的底色 / 描边承担；悬停只改描边，按压只改透明度。 */
defineProps<{
  name: string
  content: string
  icon?: string
  color?: string
}>()

defineEmits<{
  click: []
}>()
</script>
