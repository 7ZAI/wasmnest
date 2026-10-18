<template>
  <Teleport to="body">
    <Transition name="shell-dlg">
      <div
        v-if="dialog"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
        @click.self="close"
      >
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-hidden="true"></div>
        <div
          class="relative w-full max-w-md bg-[var(--bg-card)] border border-[var(--border-strong)] rounded-[var(--radius-sheet)] shadow-[var(--shadow-card-hover)] overflow-hidden flex flex-col max-h-[85vh] shell-dlg-in"
          role="dialog"
          aria-modal="true"
          :aria-label="dlgTitle"
        >
          <!-- ==================== 退出确认（窗口关闭走退出确认弹窗） ==================== -->
          <template v-if="dialog === 'exit'">
            <div class="dlg-h">
              <ShellIcon name="exit" :size="16" />
              <span class="t">{{ t('shell.dialog.exit.title') }}</span>
              <button class="shell-mini" :aria-label="t('shell.dialog.close')" @click="close">
                <ShellIcon name="x" :size="12" />
              </button>
            </div>
            <div class="dlg-b">
              <p class="note">{{ t('shell.dialog.exit.desc') }}</p>
              <div v-for="running in runningApps" :key="running.id" class="shell-rec">
                <span class="tg">{{ running.name }}</span>
                <span class="shell-chip warn">{{ t('shell.state.running') }}</span>
              </div>
              <p v-if="!runningApps.length" class="note">{{ t('shell.dialog.exit.none') }}</p>
            </div>
            <div class="dlg-f">
              <button class="shell-btn ghost" @click="close">{{ t('shell.dialog.cancel') }}</button>
              <button class="shell-btn danger-fill" @click="confirmExit">
                <ShellIcon name="exit" :size="13" /> {{ t('shell.dialog.exit.confirm') }}
              </button>
            </div>
          </template>

          <!-- ==================== 审批（D5：preauthorize → activate → NeedsApproval → 批准后激活） ==================== -->
          <template v-else-if="dialog === 'approval'">
            <div class="dlg-h">
              <ShellIcon name="shield" :size="16" />
              <span class="t">{{ t('shell.dialog.approval.title', { name: app?.name ?? '' }) }}</span>
              <button class="shell-mini" :aria-label="t('shell.dialog.close')" @click="close">
                <ShellIcon name="x" :size="12" />
              </button>
            </div>
            <div class="dlg-b">
              <p class="note">
                {{ t('shell.dialog.approval.desc', { perms: permsCount, risks: risksCount }) }}
              </p>
              <p class="note">{{ t('shell.dialog.approval.afterHint') }}</p>
              <div class="perm-line mono">{{ app?.pluginId }}</div>
            </div>
            <div class="dlg-f">
              <button class="shell-btn ghost" @click="close">{{ t('shell.dialog.cancel') }}</button>
              <button class="shell-btn" :disabled="busy" @click="confirmApprove">
                <ShellIcon name="shield" :size="13" /> {{ t('shell.dialog.approval.confirm') }}
              </button>
            </div>
          </template>

          <!-- ==================== 卸载（含数据清理确认；仅未启用应用可卸） ==================== -->
          <template v-else-if="dialog === 'uninstall'">
            <div class="dlg-h">
              <ShellIcon name="trash" :size="16" />
              <span class="t">{{ t('shell.dialog.uninstall.title', { name: app?.name ?? '' }) }}</span>
              <button class="shell-mini" :aria-label="t('shell.dialog.close')" @click="close">
                <ShellIcon name="x" :size="12" />
              </button>
            </div>
            <div class="dlg-b">
              <p class="note">{{ t('shell.dialog.uninstall.body') }}</p>
              <div class="perm-line mono">{{ app?.pluginId }}</div>
            </div>
            <div class="dlg-f">
              <button class="shell-btn ghost" @click="close">{{ t('shell.dialog.cancel') }}</button>
              <button class="shell-btn danger-fill" :disabled="busy" @click="confirmUninstall">
                <ShellIcon name="trash" :size="13" /> {{ t('shell.dialog.uninstall.confirm') }}
              </button>
            </div>
          </template>

          <!-- 策略二次确认（授权策略切换弹窗；预留扩展点） -->
          <template v-else-if="dialog === 'strategy-confirm'">
            <div class="dlg-h">
              <ShellIcon name="shield" :size="16" />
              <span class="t">{{ t('shell.dialog.strategy.title') }}</span>
              <button class="shell-mini" :aria-label="t('shell.dialog.close')" @click="close">
                <ShellIcon name="x" :size="12" />
              </button>
            </div>
            <div class="dlg-b">
              <p class="note">{{ t('shell.dialog.strategy.body') }}</p>
            </div>
            <div class="dlg-f">
              <button class="shell-btn ghost" @click="close">{{ t('shell.dialog.cancel') }}</button>
              <button class="shell-btn" @click="close">{{ t('shell.dialog.strategy.confirm') }}</button>
            </div>
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * ShellDialogLayer — 壳内全局弹窗层（退出确认 / 审批 / 卸载 / 策略二次确认）
 *
 * 2026-10-17 lifecycle-sync 改造后：审批与卸载弹窗**复活为真实动作**（D2/D5）——
 * - 审批：应用激活被审批门禁拒（NeedsApproval）时打开，确认 = approveAndStart
 *   （整单批准 + 内容哈希钉扎 → 激活 → 挂载运行面）；
 * - 卸载：应用管理页「卸载」按钮，确认 = uninstallApp（停用 → 丢私有库 → 删目录
 *   → 清存储，不可恢复）。
 * 窗口关闭按钮与 requestClose 统一走退出确认，避免绕过会话关窗守卫。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isHighRisk } from '../state'
import { useShellState } from '../useShellState'
import { useShellApps } from '../useShellApps'
import ShellIcon from './ShellIcon.vue'

const { t } = useI18n()
const state = useShellState()
const appsStore = useShellApps()

const dialog = computed(() => state.dialog.value)
const app = computed(() =>
  state.dialogAppId.value ? appsStore.appOf(state.dialogAppId.value) : undefined,
)

const runningApps = computed(() =>
  appsStore.plugins.value.filter((p) => p.state === 'running' || p.state === 'degraded'),
)

const permsCount = computed(() => app.value?.permissions.length ?? 0)
const risksCount = computed(() => app.value?.permissions.filter((p) => isHighRisk(p)).length ?? 0)
const busy = computed(() =>
  state.dialogAppId.value ? appsStore.busyId.value === state.dialogAppId.value : false,
)

const dlgTitle = computed(() => {
  switch (dialog.value) {
    case 'exit':
      return t('shell.dialog.exit.title')
    case 'approval':
      return t('shell.dialog.approval.title', { name: app.value?.name ?? '' })
    case 'uninstall':
      return t('shell.dialog.uninstall.title', { name: app.value?.name ?? '' })
    case 'strategy-confirm':
      return t('shell.dialog.strategy.title')
    default:
      return ''
  }
})

function close() {
  state.dialog.value = null
  state.dialogAppId.value = null
}

async function confirmExit() {
  try {
    await getCurrentWindow().close()
  } catch {
    /* 预览环境（非 Tauri）忽略 */
  }
}

/** 审批确认：批准 → 激活 → 挂载运行面（approveAndStart 收口全部状态回写） */
function confirmApprove() {
  if (!state.dialogAppId.value) return
  void state.approveAndStart(state.dialogAppId.value)
}

/** 卸载确认（数据清理不可恢复，正文已写明） */
function confirmUninstall() {
  if (!state.dialogAppId.value) return
  void state.uninstallApp(state.dialogAppId.value)
}
</script>

<style scoped>
.dlg-h {
  padding: 13px 16px 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  color: var(--text-primary);
}
.dlg-h .t {
  font-size: calc(13px * var(--ui-scale));
  font-weight: 600;
  flex: 1;
  min-width: 0;
}
.dlg-b {
  padding: 13px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dlg-f {
  padding: 10px 16px 12px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
  border-top: 1px solid var(--border);
}
.note {
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-secondary);
  line-height: 1.55;
}
.perm-line {
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-tertiary);
}
.mono {
  font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
}
.shell-rec {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-button);
  background: var(--bg-hover);
}
.shell-rec .tg {
  flex: 1;
  min-width: 0;
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-primary);
}
.shell-dlg-enter-active,
.shell-dlg-leave-active {
  transition: opacity 0.2s ease;
}
.shell-dlg-enter-from,
.shell-dlg-leave-to {
  opacity: 0;
}
</style>
