<template>
  <section class="card-screen" :aria-label="t(sys.nameKey)">
    <!-- 系统页卡：页头 + 三页互切 tab（切换 = 激活另一张系统页卡，不弹栈——spec-c §1） -->
    <div class="sysframe">
      <div class="sys-head">
        <span class="glyph-box tone-system" style="width: 34px; height: 34px">
          <ShellIcon :name="sys.icon" :size="17" :stroke-width="1.7" />
        </span>
        <div class="min-w-0">
          <div class="sys-t">{{ t(sys.nameKey) }}</div>
          <div class="note">{{ t(sys.descKey) }}</div>
        </div>
        <span class="grow"></span>
        <span class="shell-chip">{{ t('shell.sys.chip') }}</span>
      </div>
      <div class="sys-tabs" role="tablist">
        <button
          v-for="page in SYS_PAGES"
          :key="page.id"
          class="sys-tab"
          :class="{ on: page.id === sysPageId }"
          role="tab"
          :aria-selected="page.id === sysPageId"
          @click="state.openSys(page.id)"
        >
          <ShellIcon :name="page.icon" :size="14" /> {{ t(page.nameKey) }}
        </button>
      </div>
      <div class="sys-body">
        <div class="sys-wrap">
          <SysAppsView v-if="sysPageId === 'apps'" />
          <SysPermsView v-else-if="sysPageId === 'perms'" />
          <SysSettingsView v-else />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * ShellCardScreen — 系统页全屏承载（应用管理 / 权限与授权 / 设置）
 *
 * 2026-10-17 壳恢复后：应用面（bedcode 界面）由 ShellHost 直接渲染 AppContent
 * （侧边栏工作台形态），本组件只承载系统页卡——页头 + 三页互切 tab + 页体。
 * 当前页取自路由（/sys/:pageId），与 ShellHost 的分流一致。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { SYS_PAGES } from '../state'
import { useShellState } from '../useShellState'
import ShellIcon from './ShellIcon.vue'
import SysAppsView from '../sys/SysAppsView.vue'
import SysPermsView from '../sys/SysPermsView.vue'
import SysSettingsView from '../sys/SysSettingsView.vue'

const { t } = useI18n()
const route = useRoute()
const state = useShellState()

const sysPageId = computed(() => route.params.pageId as string)
const sys = computed(() => SYS_PAGES.find((s) => s.id === sysPageId.value) ?? SYS_PAGES[0])
</script>

<style scoped>
.card-screen {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}
.sysframe {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.sys-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--border);
}
.sys-t {
  font-size: calc(15px * var(--ui-scale));
  font-weight: 600;
  color: var(--text-primary);
}
.sys-head .note {
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-tertiary);
  margin-top: 2px;
}
.sys-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 16px 0;
  border-bottom: 1px solid var(--border);
}
.sys-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  /* token 名以 style.css 为准（--radius-btn 全仓零定义，此前全靠浏览器忽略） */
  border-radius: var(--radius-button);
  border: 1px solid transparent;
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    color 0.15s,
    background-color 0.15s;
}
.sys-tab:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.sys-tab.on {
  background: var(--color-primary-light);
  color: var(--color-primary);
  border-color: color-mix(in srgb, var(--color-primary) 30%, transparent);
}
.sys-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.sys-wrap {
  max-width: 980px;
  margin: 0 auto;
  padding: 18px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
</style>
