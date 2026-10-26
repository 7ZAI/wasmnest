<template>
  <!-- 平台状态栏（与宿主 ShellStatusBar 同构）：左区 = 运行时就绪；右区 = 应用数。
       宿主侧还有「待审批」与扩展注册项——dev-shell 无宿主运行时（没有审批 /
       扩展机制），故只留机制事实。 -->
  <footer class="shell-statusbar" data-shell-status-bar :aria-label="t('devshell.statusBar.aria')">
    <div class="sb-side">
      <span class="sb-host" role="status" aria-atomic="true">
        <span class="sb-dot" :class="{ ok: ready }" aria-hidden="true"></span>
        {{ ready ? t('devshell.statusBar.ready') : t('devshell.statusBar.loading') }}
      </span>
    </div>

    <div class="sb-side sb-end">
      <span v-if="ready" class="sb-host">
        {{ t('devshell.statusBar.apps', { count: appCount }) }}
      </span>
    </div>
  </footer>
</template>

<script setup lang="ts">
/**
 * ShellStatusBar — dev-shell 平台状态栏（与宿主 `src/shell/components/ShellStatusBar.vue` 同构）
 *
 * 归属：只承载机制事实（运行时就绪 / 应用数）；不解析业务状态、不主动轮询。
 * 宿主侧的状态栏还挂「待审批数」与扩展注册项——dev-shell 没有宿主运行时，
 * 两者都不存在，故不设（不留点了没反应的死项）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  /** 被调试 app 列表（数量在状态栏右区显示） */
  apps: unknown[]
  /** 运行时就绪 */
  ready: boolean
}>()

const { t } = useI18n()

const appCount = computed(() => props.apps.length)
</script>

<style scoped>
.shell-statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 26px;
  flex-shrink: 0;
  padding: 0 10px;
  background: var(--bg-card);
  border-top: 1px solid var(--border);
  color: var(--text-tertiary);
  font-size: calc(11px * var(--ui-scale));
  position: relative;
  z-index: 20;
}
.sb-side {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.sb-end {
  margin-left: auto;
  justify-content: flex-end;
}
.sb-host {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.sb-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-warning);
}
.sb-dot.ok {
  background: var(--color-success);
}
</style>
