<template>
  <section class="shell-card card-frame">
    <h3 class="shell-card-title">
      <ShellIcon :name="icon" :size="14" />
      <span>{{ title }}</span>
    </h3>
    <p v-if="desc" class="shell-card-desc">{{ desc }}</p>
    <slot />
  </section>
</template>

<script setup lang="ts">
/**
 * ShellCard — 壳内统一卡片容器（系统页 / 应用详情通用）
 * 标准 --radius-card 圆角 + 分组标题 + 描述 + 内容插槽。
 */
import ShellIcon from './ShellIcon.vue'

withDefaults(
  defineProps<{
    title: string
    desc?: string
    icon?: string
  }>(),
  { icon: '', desc: '' },
)
</script>

<style scoped>
.shell-card {
  display: flex;
  flex-direction: column;
  gap: 11px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 14px 16px;
}
.shell-card-title {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: calc(14px * var(--ui-scale));
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}
/* 卡头图标降一档灰：标题是主语，图标是识别锚点 */
.shell-card-title svg {
  color: var(--text-secondary);
  flex-shrink: 0;
}
.shell-card-desc {
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-tertiary);
  line-height: 1.55;
  margin-top: -5px;
}
</style>
