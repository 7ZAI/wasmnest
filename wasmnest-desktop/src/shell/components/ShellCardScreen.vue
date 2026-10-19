<template>
  <section class="card-screen" :aria-label="t(sys.nameKey)">
    <!-- 系统页卡：页头 + 页体（2026-10-19 用户裁决：撤掉三页互切 tab——
         设置页只展示设置，应用管理 / 权限与授权同理；系统页之间的跳转走主屏
         系统网格 / 多任务面板，以及页内既有的互跳入口卡片） -->
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
 * （侧边栏工作台形态），本组件只承载系统页卡——页头 + 页体。
 * 2026-10-19 用户裁决：撤掉页头下的三页互切 tab，每张系统页只展示自己的内容
 * （设置页不再混着「应用管理 / 权限」的切换入口）；系统页之间的跳转走主屏系统
 * 网格 / 多任务面板与页内互跳卡片。当前页取自路由（/sys/:pageId），与 ShellHost
 * 的分流一致。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { SYS_PAGES } from '../composables/state'
import ShellIcon from './ShellIcon.vue'
import SysAppsView from '../sys/SysAppsView.vue'
import SysPermsView from '../sys/SysPermsView.vue'
import SysSettingsView from '../sys/SysSettingsView.vue'

const { t } = useI18n()
const route = useRoute()

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
