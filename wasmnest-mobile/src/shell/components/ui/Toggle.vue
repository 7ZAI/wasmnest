<template>
  <label class="flex items-center gap-3 cursor-pointer">
    <div class="relative">
      <input
        type="checkbox"
        :checked="modelValue"
        :disabled="disabled"
        class="sr-only"
        :aria-label="ariaLabel || undefined"
        @change="$emit('update:modelValue', !modelValue)"
      />
      <!-- 开关样式与桌面端 SettingsView 对齐：方形墨色轨道 + 方形滑块 -->
      <div
        class="w-10 h-5 rounded-[4px] border transition-colors"
        :class="[
          modelValue
            ? 'bg-[var(--mobile-accent)] border-[var(--mobile-accent)]'
            : 'bg-[var(--mobile-bg-primary)] border-[var(--mobile-border-hover)]',
          { 'opacity-50 cursor-not-allowed': disabled }
        ]"
      ></div>
      <div
        class="absolute top-[3px] w-3 h-3 rounded-[2px] transition-all"
        :class="[
          modelValue
            ? 'left-[22px] bg-[var(--mobile-text-on-accent)]'
            : 'left-[3px] bg-[var(--mobile-bg-tertiary)]'
        ]"
      ></div>
    </div>
    <span v-if="label" class="text-sm text-[var(--mobile-text-secondary)]">{{ label }}</span>
  </label>
</template>

<script setup lang="ts">
/**
 * Toggle — 开关（方形墨色轨道 + 方形滑块）
 *
 * 迁移自旧公共组件 `src/components/Toggle.vue`（壳内自足化），契约与旧实现
 * 逐字一致；壳内消费方（应用详情权限开关）与将来迁移的旧页面共用同一形状。
 *
 * `ariaLabel`：不传 `label` 时开关没有可见文字，必须给输入框一个可读名
 * （设置行把标题放在开关左侧、由行自己排版，不能塞进 label 的尾随文案）。
 */
interface Props {
  modelValue: boolean
  label?: string
  disabled?: boolean
  ariaLabel?: string
}

withDefaults(defineProps<Props>(), {
  label: '',
  disabled: false,
  ariaLabel: '',
})

defineEmits(['update:modelValue'])
</script>
