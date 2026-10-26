<template>
  <div class="flex items-center justify-between gap-2 min-w-0 px-4 pt-4 pb-2">
    <!-- 标题 + 可选内联说明：inlineNote 时计数紧跟标题（如「应用 3 个已安装」），
         不再推到行尾——行尾留给动作按钮；无动作时右侧保持留白。 -->
    <div class="flex items-baseline gap-2 min-w-0">
      <h2 class="shell-type-section truncate">
        {{ title }}
      </h2>
      <span
        v-if="note && inlineNote"
        class="shell-type-caption text-[var(--mobile-text-secondary)] truncate"
      >
        {{ note }}
      </span>
    </div>
    <div class="flex items-center gap-2 flex-shrink-0 min-w-0">
      <span
        v-if="note && !inlineNote"
        class="shell-type-caption text-[var(--mobile-text-secondary)] truncate"
      >
        {{ note }}
      </span>
      <slot name="action" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 分组标题行
 *
 * 标题 + 可选说明 + 右侧动作插槽。壳内所有「分组头」都走这一个组件，
 * 保证标题层级与右侧动作的对齐方式全平台一致。
 */
defineProps<{
  title: string
  /** 说明（如「3 项」「3 个已安装」）；默认靠右，inlineNote 时紧跟标题 */
  note?: string
  /** 说明紧跟标题而非推到行尾：用于标题本身带计数、且行尾不再放动作的分组头 */
  inlineNote?: boolean
}>()
</script>
