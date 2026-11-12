<template>
  <!-- 平台状态栏：常驻壳底（独立窗口除外）。左区 = 运行时就绪 + 扩展项；
       右区 = 待审批 / 应用数 + 扩展项。扩展项由 shell/extensions 注册，宿主只
       提供容器、排序与左右分区，不解释扩展内容的业务语义。 -->
  <footer class="shell-statusbar" data-shell-status-bar :aria-label="t('shell.statusBar.aria')">
    <div class="sb-side">
      <span class="sb-host" role="status" aria-atomic="true">
        <span class="sb-dot" :class="{ ok: ready }" aria-hidden="true"></span>
        {{ ready ? t('shell.statusBar.ready') : t('shell.statusBar.loading') }}
      </span>
      <template v-for="item in startItems" :key="item.id">
        <ShellExtBoundary v-if="item.component">
          <component :is="item.component" :data-ext-id="item.id" />
        </ShellExtBoundary>
        <button
          v-else-if="item.onSelect"
          type="button"
          class="sb-item"
          :data-ext-id="item.id"
          @click="run(item)"
        >
          <ShellIcon v-if="item.icon" :name="item.icon" :size="12" />
          <span>{{ item.label }}</span>
        </button>
        <span v-else class="sb-item sb-static" :data-ext-id="item.id">
          <ShellIcon v-if="item.icon" :name="item.icon" :size="12" />
          <span>{{ item.label }}</span>
        </span>
      </template>
    </div>

    <div class="sb-side sb-end">
      <button
        v-if="approvalCount > 0"
        type="button"
        class="sb-item sb-warn"
        :title="t('shell.statusBar.openPerms')"
        @click="openPerms"
      >
        <ShellIcon name="shield" :size="12" />
        <span>{{ t('shell.statusBar.approvals', { count: approvalCount }) }}</span>
      </button>
      <span v-if="ready" class="sb-host">
        {{ t('shell.statusBar.apps', { count: appCount }) }}
      </span>
      <template v-for="item in endItems" :key="item.id">
        <ShellExtBoundary v-if="item.component">
          <component :is="item.component" :data-ext-id="item.id" />
        </ShellExtBoundary>
        <button
          v-else-if="item.onSelect"
          type="button"
          class="sb-item"
          :data-ext-id="item.id"
          @click="run(item)"
        >
          <ShellIcon v-if="item.icon" :name="item.icon" :size="12" />
          <span>{{ item.label }}</span>
        </button>
        <span v-else class="sb-item sb-static" :data-ext-id="item.id">
          <ShellIcon v-if="item.icon" :name="item.icon" :size="12" />
          <span>{{ item.label }}</span>
        </span>
      </template>
    </div>
  </footer>
</template>

<script setup lang="ts">
/**
 * ShellStatusBar — 平台状态栏（壳常驻 chrome）
 *
 * 归属（AGENTS §2）：只承载宿主机制事实（运行时就绪 / 待审批 / 应用数）与
 * 扩展注册项；不解析、不翻译扩展的业务状态，也不主动轮询应用数据。
 *
 * 扩展项分左右两区（align: start / end），按 order 排序；文本项有 onSelect
 * 才渲染成按钮，没有动作时是静态文本——不留点了没反应的死按钮。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useShellApps } from '../composables/useShellApps'
import { useShellState } from '../composables/useShellState'
import { useShellExtensions } from '../extensions'
import type { ShellStatusBarItem } from '../extensions/types'
import { logger } from '@/utils/frontendLogger'
import ShellIcon from './ShellIcon.vue'
import ShellExtBoundary from './ShellExtBoundary.vue'

const { t } = useI18n()
const appsStore = useShellApps()
const state = useShellState()
const { statusBarItems } = useShellExtensions()

const ready = computed(() => appsStore.listReady.value)
const appCount = computed(() => appsStore.plugins.value.length)
const approvalCount = computed(() => appsStore.approvalApps.value.length)

const startItems = computed(() =>
  statusBarItems.value.filter((item) => (item.align ?? 'start') === 'start'),
)
const endItems = computed(() =>
  statusBarItems.value.filter((item) => (item.align ?? 'start') === 'end'),
)

function openPerms(): void {
  state.openSys('perms')
}

async function run(item: ShellStatusBarItem): Promise<void> {
  if (!item.onSelect) return
  try {
    await item.onSelect()
  } catch (e) {
    // 扩展动作失败不拖垮状态栏：技术详情进日志，状态栏保持可用
    logger.error(`[Shell] status bar action failed: ${item.id}`, e)
  }
}
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
/* 壁纸开启时与工具栏同档轻透（内容面；背后只有壳根壁纸） */
.shell-wall .shell-statusbar {
  background: var(--bg-veil);
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
.sb-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-button);
  color: var(--text-secondary);
  font-size: inherit;
  white-space: nowrap;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease),
    color var(--motion-duration-fast) var(--motion-ease);
}
.sb-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.sb-item:active {
  background: var(--border);
}
.sb-static {
  cursor: default;
}
.sb-static:hover {
  background: none;
  color: var(--text-secondary);
}
.sb-warn {
  color: var(--color-warning-ink);
}
.sb-warn:hover {
  color: var(--color-warning-ink);
}
</style>
