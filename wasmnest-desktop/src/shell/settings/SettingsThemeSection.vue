<template>
  <!-- ==================== 主题（全局外观预设；应用配色仍归应用） ==================== -->
  <ShellCard
    :title="t('shell.settings.themes.title')"
    :desc="t('shell.settings.themes.desc')"
    icon="theme"
    data-testid="settings-themes"
  >
    <div class="theme-grid" role="group" :aria-label="t('shell.settings.themes.title')">
      <button
        v-for="theme in themes"
        :key="theme.id"
        type="button"
        class="theme-card"
        :class="{ on: theme.id === activeTheme.id }"
        :aria-pressed="theme.id === activeTheme.id"
        :data-theme-id="theme.id"
        @click="setTheme(theme.id)"
      >
        <!-- 预览是「活的」：内置主题挂同一个 data-theme 属性即可吃到 theme-presets.css
             的真配色，扩展主题则把注册时那份 token 表内联上来——两种来源同一块 DOM。
             默认主题不挂 data-theme（它就是基线本身），改挂 .theme-base 复用基础档
             token——否则它会继承当前主题的变量，长成当前主题的样子。 -->
        <span
          class="theme-preview"
          :class="{ 'theme-base': theme.id === defaultThemeId }"
          :data-theme="theme.id === defaultThemeId ? undefined : theme.id"
          :style="resolvedTokens(theme)"
          aria-hidden="true"
        >
          <span class="pv-page">
            <span class="pv-icon"></span>
            <span class="pv-card"></span>
            <span class="pv-card short"></span>
          </span>
        </span>
        <span class="theme-meta">
          <span class="theme-name">
            {{ theme.label }}
            <span v-if="theme.dynamic" class="theme-badge">
              {{ t('shell.settings.themes.dynamic') }}
            </span>
          </span>
          <span v-if="theme.description" class="theme-desc">{{ theme.description }}</span>
        </span>
        <span v-if="theme.id === activeTheme.id" class="theme-check" aria-hidden="true">
          <ShellIcon name="check" :size="10" :stroke-width="2.8" />
        </span>
      </button>
    </div>
    <p class="theme-hint">{{ t('shell.settings.themes.hint') }}</p>
  </ShellCard>
</template>

<script setup lang="ts">
/**
 * 设置页 — 主题分组
 *
 * 主题是壳扩展点（docs/frontend.md §6）：内置主题的 token 表在
 * `src/styles/theme-presets.css`，扩展主题经 `registerTheme` 注册 token / glyph。
 * 本组件只负责选择与预览，不解释任何颜色语义。
 *
 * 预览不用手画假色块：给预览容器挂上与主题相同的 `data-theme` 属性，CSS 侧的
 * 主题选择器会照常命中（选择器刻意不写 `:root`），所以预览里的圆角、玻璃、硬阴影、
 * 饱和图标井全是真实效果——样式改了预览不会说谎。
 */
import { useI18n } from 'vue-i18n'
import { useShellTheme } from '../composables/useShellTheme'
import ShellCard from '../components/ShellCard.vue'
import ShellIcon from '../components/ShellIcon.vue'

const { t } = useI18n()
const { themes, activeTheme, resolvedTokens, setTheme, defaultThemeId } = useShellTheme()
</script>

<style scoped>
.theme-grid {
  display: grid;
  /* auto-fit 而非 auto-fill：4 张卡要铺满内容宽，auto-fill 会在右侧留一排空轨道，
     主题卡缩在左半边（1440 下实测右侧空 200px）。 */
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 8px;
}
.theme-card {
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
.theme-card:hover {
  background: var(--bg-hover);
}
/* 选中态只换表面色阶（与壁纸卡同一条视觉语言），边框保持中性 */
.theme-card.on {
  background: var(--selection-tint);
}
.theme-preview {
  display: block;
  padding: 6px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--theme-ambient, none), var(--bg-page);
  background-size: cover;
  overflow: hidden;
}
.pv-page {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 40px;
}
.pv-icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  border-radius: var(--theme-icon-radius, var(--radius-app-icon));
  background: color-mix(in srgb, var(--color-info) 82%, var(--bg-card));
  box-shadow: var(--theme-icon-shadow, none);
}
.pv-card {
  flex: 1;
  align-self: stretch;
  border-radius: var(--radius-card);
  border: 1px solid var(--border);
  /* 预览卡走真表面 token：磨砂 / 棱线 / 硬边由主题自己的规则加（见 theme-presets.css），
     这里不写死 backdrop-filter——默认档的卡片本就不叠模糊，写死会让预览比真卡片更"玻璃"。 */
  background: var(--bg-veil);
  box-shadow: var(--shadow-card);
}
.pv-card.short {
  flex: 0 0 34%;
  align-self: center;
  height: 22px;
}
.theme-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.theme-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(12px * var(--ui-scale));
  font-weight: 600;
  color: var(--text-primary);
}
/* 动态标记：主题自带缓慢动效（可在系统「动画效果」关掉） */
.theme-badge {
  padding: 1px 5px;
  border-radius: var(--radius-tag);
  background: var(--color-info-light);
  color: var(--color-info-ink);
  font-size: calc(10px * var(--ui-scale));
  font-weight: 500;
  line-height: 1.5;
}
.theme-desc {
  font-size: calc(11px * var(--ui-scale));
  line-height: 1.4;
  color: var(--text-tertiary);
}
/* 选中勾章：与壁纸卡同形（固定实心圆 + 白勾，不随明暗反转） */
.theme-check {
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
.theme-hint {
  margin: 0;
  font-size: calc(11px * var(--ui-scale));
  line-height: 1.45;
  color: var(--text-tertiary);
}
</style>
