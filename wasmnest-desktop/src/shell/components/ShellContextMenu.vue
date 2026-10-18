<template>
  <Teleport to="body">
    <div
      v-if="menu"
      class="shell-ctx-root fixed z-[60] min-w-[168px] p-1.5 bg-[var(--bg-card)] border border-[var(--border-strong)] rounded-[var(--radius-card)] shadow-[var(--shadow-card-hover)] shell-fade-in"
      :style="{ left: left, top: top }"
      role="menu"
      :aria-label="t('shell.ctx.aria')"
      @contextmenu.prevent
    >
      <button
        v-if="running"
        class="it"
        role="menuitem"
        @click="act(stopApp)"
      >
        <ShellIcon name="stop" :size="13" />
        {{ t('shell.ctx.stop') }}
      </button>
      <button v-else class="it" role="menuitem" @click="act(openApp)">
        <ShellIcon name="play" :size="13" />
        {{ t('shell.ctx.startOpen') }}
      </button>
      <button class="it" role="menuitem" @click="act(manage)">
        <ShellIcon name="info" :size="13" /> {{ t('shell.ctx.manage') }}
      </button>
      <button class="it" role="menuitem" @click="act(perms)">
        <ShellIcon name="shield" :size="13" /> {{ t('shell.ctx.perms') }}
      </button>
      <div v-if="userInstalled" class="sep"></div>
      <button
        v-if="userInstalled"
        class="it danger"
        role="menuitem"
        :disabled="running"
        :title="t('shell.apps.uninstallDisabled')"
        @click="act(uninstallApp)"
      >
        <ShellIcon name="trash" :size="13" /> {{ t('shell.ctx.uninstall') }}
      </button>
    </div>
  </Teleport>
</template>
<script setup lang="ts">
/**
 * ShellContextMenu — 应用图标右键菜单（启动/停用 / 管理 / 权限 / 卸载）
 *
 * 2026-10-17 lifecycle-sync 改造后：停用 / 卸载语义**复活为真实动作**（D2）——
 * 停用 = deactivate 真停用 + 摘运行面；卸载 = 数据清理确认弹窗（仅用户安装）。
 * 运行中的应用不可卸载（后端门禁同口径，前端先行置灰避免无反馈点击）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useShellState } from '../useShellState'
import { useShellApps } from '../useShellApps'
import ShellIcon from './ShellIcon.vue'

const { t } = useI18n()
const state = useShellState()
const appsStore = useShellApps()

const menu = computed(() => state.ctxMenu.value)
const app = computed(() => (menu.value ? appsStore.appOf(menu.value.appId) : null))
const running = computed(
  () => app.value?.state === 'running' || app.value?.state === 'degraded',
)
const userInstalled = computed(() => app.value?.source === 'user-installed')
/** 贴边约束（菜单不超出视口） */
const left = computed(() => {
  const m = menu.value
  return m ? Math.min(m.x, window.innerWidth - 190) + 'px' : '0px'
})
const top = computed(() => {
  const m = menu.value
  return m ? Math.min(m.y, window.innerHeight - 160) + 'px' : '0px'
})

function act(fn: () => void | Promise<void>) {
  state.ctxMenu.value = null
  void fn()
}
function openApp() {
  if (app.value) void state.openApp(app.value.id)
}
function stopApp() {
  if (app.value) void state.stopApp(app.value.id)
}
/** 管理：打开系统页「应用管理」（选中态由管理页自行拉取清单） */
function manage() {
  state.openSys('apps')
}
function perms() {
  state.openSys('perms')
}
function uninstallApp() {
  if (app.value) {
    state.dialog.value = 'uninstall'
    state.dialogAppId.value = app.value.id
  }
}
</script>
<style scoped>
.it {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-button);
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-primary);
  cursor: pointer;
  transition: background-color 0.12s;
}
.it:hover {
  background: var(--bg-hover);
}
.it.danger {
  color: var(--color-danger);
}
.it.danger:hover {
  background: var(--color-danger-light);
}
.sep {
  height: 1px;
  margin: 4px 2px;
  background: var(--border);
}
.it:disabled {
  opacity: 0.4;
  cursor: default;
}
.it:disabled:hover {
  background: none;
}
</style>
