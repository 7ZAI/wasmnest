<template>
  <!--
    快捷卡片（应用贡献给宿主壳首页的公共卡片外观）

    只负责「卡片长什么样」：应用填内容（label / value / hint 或默认插槽），
    点击与跳转由宿主壳接管——宿主把整张卡渲染成按钮并打开贡献方应用。
    因此卡片内不得再放按钮 / 链接等交互控件（会与宿主按钮形成嵌套交互）。
  -->
  <article class="quick-card" :data-tone="tone">
    <header v-if="label || iconPaths.length > 0 || tone !== 'neutral'" class="quick-card__head">
      <span
        v-if="tone !== 'neutral'"
        class="quick-card__tone"
        :data-tone="tone"
        aria-hidden="true"
      />
      <span v-if="label" class="quick-card__label">{{ label }}</span>
      <span v-if="iconPaths.length > 0" class="quick-card__icon" aria-hidden="true">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path v-for="d in iconPaths" :key="d" :d="d" />
        </svg>
      </span>
    </header>

    <div class="quick-card__body">
      <slot>
        <span v-if="hasValue" class="quick-card__value">{{ value }}</span>
        <span v-if="hint" class="quick-card__hint">{{ hint }}</span>
      </slot>
    </div>
  </article>
</template>

<script setup lang="ts">
/**
 * QuickCard — SDK 公共快捷卡片
 *
 * 内容由应用自持（活跃会话数 / 传输任务数 / 最近对话……），宿主不解释字段语义；
 * 卡片固定外观由 --mobile-* + --shell-radius-* token 驱动，随宿主主题 / 明暗 /
 * 用户字号偏好自动适配。跨应用等宽靠宿主轨道 item 的定宽约束，本组件铺满 item。
 */
import { computed } from 'vue'

type QuickCardTone = 'neutral' | 'success' | 'warning' | 'danger'

const props = withDefaults(
  defineProps<{
    /** 顶部标签（如「活跃会话」）；留空则只显示主体 */
    label?: string
    /** 主体数值 / 主文案（等宽数字排版） */
    value?: string | number
    /** 数值下方的一行状态说明（零值提示、补充信息等） */
    hint?: string
    /** 右上角装饰图标：24×24 视框的 SVG path d，可多条 */
    iconPath?: string | string[]
    /** 状态点语义：neutral 不显示；其余取对应语义色 */
    tone?: QuickCardTone
  }>(),
  { tone: 'neutral', label: '', value: '', hint: '', iconPath: '' },
)

const iconPaths = computed(() => {
  const raw = props.iconPath
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
})

const hasValue = computed(() => props.value !== undefined && props.value !== null && props.value !== '')
</script>

<style scoped>
.quick-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  height: 100%;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--mobile-border);
  border-radius: var(--shell-radius-card, 12px);
  background: var(--mobile-bg-card);
  box-shadow: var(--mobile-card-shadow);
  color: var(--mobile-text-primary);
}

.quick-card__head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.quick-card__label {
  min-width: 0;
  overflow: hidden;
  color: var(--mobile-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quick-card__icon {
  display: flex;
  flex-shrink: 0;
  margin-left: auto;
  color: var(--mobile-accent);
  opacity: 0.85;
}

.quick-card__tone {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--mobile-text-secondary);
}

.quick-card__tone[data-tone='success'] {
  background: var(--mobile-success);
}

.quick-card__tone[data-tone='warning'] {
  background: var(--mobile-warning);
}

.quick-card__tone[data-tone='danger'] {
  background: var(--mobile-error);
}

.quick-card__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin-top: auto;
}

.quick-card__value {
  font-size: var(--font-size-2xl);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 1.15;
}

.quick-card__hint {
  display: -webkit-box;
  overflow: hidden;
  color: var(--mobile-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.45;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
</style>