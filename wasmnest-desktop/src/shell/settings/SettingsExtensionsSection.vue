<template>
  <!-- ==================== 扩展设置（平台级扩展预留位：只渲染注册描述符） ==================== -->
  <ShellCard
    :title="t('shell.settings.extensions.title')"
    :desc="t('shell.settings.extensions.desc')"
    icon="sliders"
    data-testid="settings-extensions"
  >
    <div v-if="settingsEntries.length > 0" class="ext-list">
      <!-- 有动作 = 按钮；无动作 = 静态行（不造点了没反应的死按钮） -->
      <component
        :is="entry.onSelect ? 'button' : 'div'"
        v-for="entry in settingsEntries"
        :key="entry.id"
        class="ext-row"
        :class="{ action: !!entry.onSelect }"
        :type="entry.onSelect ? 'button' : undefined"
        :data-entry-id="entry.id"
        @click="entry.onSelect ? run(entry) : undefined"
      >
        <span class="ext-ico">
          <ShellIcon :name="entry.icon || 'gear'" :size="13" />
        </span>
        <span class="ext-text">
          <b>{{ entry.label }}</b>
          <span v-if="entry.hint" class="ext-sub">{{ entry.hint }}</span>
        </span>
        <ShellIcon v-if="entry.onSelect" name="back" :size="12" class="ext-go" />
      </component>
    </div>

    <!-- 空态 = 预留区可见：扩展注册后同一位置自动出现设置行 -->
    <div v-else class="ext-empty">
      <ShellIcon name="sliders" :size="15" />
      <span>{{ t('shell.settings.extensions.empty') }}</span>
    </div>

    <p class="ext-hint">{{ t('shell.settings.extensions.hint') }}</p>
  </ShellCard>
</template>

<script setup lang="ts">
/**
 * 设置页 — 扩展设置分组
 *
 * 平台级扩展点（docs/frontend.md §6）：扩展经 registerSettingsEntry 贡献
 * 「标题 + 摘要 + 可选动作」描述符，壳统一渲染成设置行。宿主不感知扩展从哪来，
 * 也不解释 label / hint 的业务含义；无注册时保留一个可见的空态占位。
 */
import { useI18n } from 'vue-i18n'
import { useShellExtensions } from '../extensions'
import type { ShellSettingsEntry } from '../extensions/types'
import { logger } from '@/utils/frontendLogger'
import ShellCard from '../components/ShellCard.vue'
import ShellIcon from '../components/ShellIcon.vue'

const { t } = useI18n()
const { settingsEntries } = useShellExtensions()

async function run(entry: ShellSettingsEntry): Promise<void> {
  if (!entry.onSelect) return
  try {
    await entry.onSelect()
  } catch (e) {
    // 扩展动作失败不拖垮设置页：详情进日志，静态界面保持可用
    logger.error(`[Shell] settings extension action failed: ${entry.id}`, e)
  }
}
</script>

<style scoped>
.ext-list {
  display: flex;
  flex-direction: column;
}
.ext-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 2px;
  border: none;
  background: none;
  color: inherit;
  text-align: left;
  font: inherit;
}
.ext-row + .ext-row {
  border-top: 1px solid var(--border);
}
.ext-row.action {
  cursor: pointer;
  border-radius: var(--radius-button);
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease),
    color var(--motion-duration-fast) var(--motion-ease);
}
.ext-row.action:hover {
  background: var(--bg-hover);
}
.ext-ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: var(--radius-button);
  background: var(--bg-hover);
  color: var(--text-secondary);
}
.ext-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.ext-text b {
  font-size: calc(12.5px * var(--ui-scale));
  font-weight: 600;
  letter-spacing: -0.005em;
  color: var(--text-primary);
}
.ext-sub {
  font-size: calc(11.5px * var(--ui-scale));
  line-height: 1.45;
  color: var(--text-tertiary);
}
/* 右侧指示箭头：复用返回箭头旋转 180°，不新增图标路径 */
.ext-go {
  flex-shrink: 0;
  color: var(--text-tertiary);
  transform: rotate(180deg);
}
.ext-row.action:hover .ext-go {
  color: var(--text-primary);
}
.ext-empty {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-button);
  color: var(--text-tertiary);
  font-size: calc(11.5px * var(--ui-scale));
  line-height: 1.45;
}
.ext-hint {
  margin: 0;
  font-size: calc(11px * var(--ui-scale));
  line-height: 1.45;
  color: var(--text-tertiary);
}
</style>
