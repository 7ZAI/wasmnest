<template>
  <!-- ==================== 主题皮肤（壳 chrome 的 token 覆盖；应用配色仍归应用） ==================== -->
  <ShellCard
    :title="t('shell.settings.skins.title')"
    :desc="t('shell.settings.skins.desc')"
    icon="theme"
    data-testid="settings-skins"
  >
    <div class="skin-grid" role="group" :aria-label="t('shell.settings.skins.title')">
      <button
        v-for="skin in skins"
        :key="skin.id"
        type="button"
        class="skin-card"
        :class="{ on: skin.id === activeSkin.id }"
        :aria-pressed="skin.id === activeSkin.id"
        :data-skin-id="skin.id"
        @click="setSkin(skin.id)"
      >
        <!-- 预览块自身挂皮肤 token：子元素用 var(--bg-page) 等读取，未定义的键自然继承壳根 -->
        <span class="skin-preview" :style="resolvedTokens(skin)" aria-hidden="true">
          <span class="pv-card"></span>
          <span class="pv-accent"></span>
        </span>
        <span class="skin-meta">
          <span class="skin-name">{{ skin.label }}</span>
          <span v-if="skin.description" class="skin-desc">{{ skin.description }}</span>
        </span>
        <span v-if="skin.id === activeSkin.id" class="skin-check" aria-hidden="true">
          <ShellIcon name="check" :size="10" :stroke-width="2.8" />
        </span>
      </button>
    </div>
    <p class="skin-hint">{{ t('shell.settings.skins.hint') }}</p>
  </ShellCard>
</template>

<script setup lang="ts">
/**
 * 设置页 — 主题皮肤分组
 *
 * 皮肤是壳扩展点（docs/frontend.md §6）：只提供 CSS 自定义属性覆盖，由
 * useShellThemeSkin 合并浅色 / 深色 token 后挂到壳根。内置 `default` 恒在首位，
 * 扩展皮肤经 registerThemeSkin 注册；本组件只负责选择，不解释任何颜色语义。
 */
import { useI18n } from 'vue-i18n'
import { useShellThemeSkin } from '../composables/useShellThemeSkin'
import ShellCard from '../components/ShellCard.vue'
import ShellIcon from '../components/ShellIcon.vue'

const { t } = useI18n()
const { skins, activeSkin, resolvedTokens, setSkin } = useShellThemeSkin()
</script>

<style scoped>
.skin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}
.skin-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border-radius: var(--radius-button);
  border: 1px solid var(--border);
  background: var(--bg-card);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease),
    border-color var(--motion-duration-fast) var(--motion-ease);
}
.skin-card:hover {
  background: var(--bg-hover);
}
/* 选中态只换表面色阶（与壁纸卡同一条视觉语言），边框保持中性 */
.skin-card.on {
  background: var(--selection-tint);
  border-color: var(--border);
}
.skin-preview {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 5px 7px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-page);
  overflow: hidden;
}
.pv-card {
  flex: 1;
  align-self: stretch;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-card);
}
.pv-accent {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-primary);
}
.skin-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.skin-name {
  font-size: calc(12px * var(--ui-scale));
  font-weight: 600;
  color: var(--text-primary);
}
.skin-desc {
  font-size: calc(11px * var(--ui-scale));
  line-height: 1.4;
  color: var(--text-tertiary);
}
/* 选中勾章：与壁纸卡同形（固定实心圆 + 白勾，不随明暗反转） */
.skin-check {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--selection-solid);
  color: var(--selection-solid-ink);
  box-shadow:
    0 0 0 2px var(--selection-halo),
    0 1px 4px color-mix(in srgb, var(--text-primary) 24%, transparent);
}
.skin-hint {
  margin: 0;
  font-size: calc(11px * var(--ui-scale));
  line-height: 1.45;
  color: var(--text-tertiary);
}
</style>
