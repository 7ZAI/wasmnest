<script setup lang="ts">
/**
 * dev-shell 根组件 —— 宿主 chrome 骨架（挂载包形态）
 *
 * 结构与宿主 `src/shell/ShellHost.vue` 同形：
 *   壳标题栏（ShellToolbar，常驻）→ 应用挂载槽（AppMountSlot，标题栏以下）→
 *   平台状态栏（ShellStatusBar，常驻）。
 *
 * 与宿主的差异（都因为「浏览器里没有宿主运行时」）：
 * - 没有主屏 / 多任务 / 系统页（dev-shell 只调试**一个** app）；
 * - 没有通知中心 / 快捷设置 / 右键菜单 / 授权弹窗（宿主覆层，无对应事实）。
 *
 * 承载 app 的槽必须与真机同形：app 在真机上占「标题栏以下」的整块区域，
 * dev-shell 复刻这条边界，app 的布局验证才有意义。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { apps } from './registry'
import { ready } from './loader'
import ShellToolbar from './shell/components/ShellToolbar.vue'
import ShellStatusBar from './shell/components/ShellStatusBar.vue'
import AppMountSlot from './shell/components/AppMountSlot.vue'
import LogPanel from './components/LogPanel.vue'
// SDK 共享全局弹窗宿主（与宿主 ShellDialogLayer 同组件）：app 若经 SDK 的
// openGlobalDialog 弹窗，这里负责渲染
import PluginGlobalDialog from '../../src/ui/PluginGlobalDialog.vue'

const logOpen = ref(false)
/** 当前被调试 app（空 = 未选中；默认取第一个） */
const selectedAppId = ref('')

const { t } = useI18n()

const currentAppId = computed(() => selectedAppId.value || apps.value[0]?.id || '')

function selectApp(appId: string) {
  selectedAppId.value = appId
}

// 选中的 app 被移除（工程重载 / 列表变化）→ 回落默认
watch(
  () => apps.value.map((a) => a.id),
  (ids) => {
    if (selectedAppId.value && !ids.includes(selectedAppId.value)) {
      selectedAppId.value = ''
    }
  },
)
</script>

<template>
  <div class="shell-root">
    <ShellToolbar
      :apps="apps"
      :current-app-id="currentAppId"
      :log-open="logOpen"
      @select-app="selectApp"
      @toggle-log="logOpen = !logOpen"
    />

    <!-- 应用面：没有选中 app 时给引导（fail-visible：说明怎么启动，不留空白） -->
    <div v-if="!currentAppId" class="dev-shell-empty">
      <p class="text-[calc(14px*var(--ui-scale))] font-medium text-[var(--text-primary)]">
        {{ t('devshell.apps.none') }}
      </p>
      <p class="text-[calc(12px*var(--ui-scale))] text-[var(--text-secondary)] max-w-[52ch] text-center">
        {{ t('devshell.apps.noneHint') }}
      </p>
    </div>
    <AppMountSlot v-else :app-id="currentAppId" route="/" />

    <ShellStatusBar :apps="apps" :ready="ready" />

    <LogPanel v-model:log-open="logOpen" />
    <PluginGlobalDialog />
  </div>
</template>

<style scoped>
.dev-shell-empty {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-secondary);
}
</style>
