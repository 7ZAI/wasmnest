<template>
  <Transition name="shell-panel">
    <div
      v-if="open"
      class="panel shell-notif-panel"
      role="dialog"
      :aria-label="t('shell.notif.title')"
    >
      <!-- 面板头 -->
      <div class="panel-h">
        <span class="t">{{ t('shell.notif.title') }}</span>
        <span class="n">{{ total }} {{ t('shell.notif.countUnit') }}</span>
        <span class="grow"></span>
        <button
          v-if="state.notifs.value.some((n) => !n.sticky)"
          class="shell-mini"
          @click="clearAll"
        >
          {{ t('shell.notif.clearAll') }}
        </button>
        <button class="shell-mini" :aria-label="t('shell.notif.close')" @click="close">
          <ShellIcon name="x" :size="12" />
        </button>
      </div>

      <div class="panel-in">
        <!-- 待处理区：审批通知（动态派生） -->
        <template v-if="approvals.length">
          <div class="blk-t">{{ t('shell.notif.pending') }}<span class="line"></span></div>
          <NotifCard
            v-for="n in approvals"
            :key="n.id"
            :notif="n"
            @action="() => onApprovalAction(n)"
          />
        </template>

        <!-- 通知区 -->
        <div class="blk-t">{{ t('shell.notif.notifications') }}<span class="line"></span></div>
        <NotifCard
          v-for="n in state.notifs.value"
          :key="n.id"
          :notif="n"
          @dismiss="state.dismissNotif(n.id)"
          @action="onNotifAction(n, $event)"
        />
        <div v-if="!state.notifs.value.length && !approvals.length" class="empty-note">
          {{ t('shell.notif.empty') }}
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * ShellNotificationPanel — 通知中心（工具栏锚定下拉面板，spec-c §7）
 *
 * 审批区（待处理）+ 通知区（事件/进度/信息卡片）。快捷设置（主题 / 动画 /
 * 链路加密 / 防休眠）自 2026-10-19 拆分为独立面板（ShellQuickSettings，工具栏
 * 独立图标入口），不再与通知混在一起。宿主只承载机制面：来源 / 驻留 / 动作 /
 * 时间；文案由来源方给出。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useShellState } from '../composables/useShellState'
import ShellIcon from './ShellIcon.vue'
import NotifCard from './NotifCard.vue'
import type { HostNotif } from '../types'

const { t } = useI18n()
const state = useShellState()

const open = computed(() => state.panelOpen.value)
const approvals = computed(() => state.approvalNotifs())
const total = computed(() => approvals.value.length + state.notifs.value.length)

function close() {
  state.panelOpen.value = false
}
function clearAll() {
  state.clearNotifs()
}

/** 审批动作：去审批 = 关面板 + 开审批弹窗 */
function onApprovalAction(n: HostNotif) {
  if (!n.app) return
  state.panelOpen.value = false
  state.dialog.value = 'approval'
  state.dialogAppId.value = n.app
}

/** 事件通知动作：打开应用 / 重新打开 */
function onNotifAction(n: HostNotif, actionId: string) {
  if (actionId === 'open' && n.app) {
    state.panelOpen.value = false
    void state.openApp(n.app)
  }
}
</script>

<style scoped>
.panel {
  position: absolute;
  top: calc(var(--toolbar-h) + 6px);
  right: 8px;
  z-index: 45;
  width: 364px;
  max-height: min(480px, calc(100% - 60px));
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sheet);
  box-shadow: var(--shadow-card-hover);
  overflow: hidden;
  transform-origin: top right;
}
.panel-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 12px 12px 0;
}
.panel-h .t {
  font-size: calc(14px * var(--ui-scale));
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}
.panel-h .n {
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.panel-h .grow {
  flex: 1;
}
.panel-in {
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 分区标签：句首大写的小标题（中文无大小写，靠字号 + 字重区分），
   右侧细线把标签与内容的分界拉通整行 */
.blk-t {
  font-size: calc(11px * var(--ui-scale));
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  gap: 8px;
}
.blk-t .line {
  flex: 1;
  height: 1px;
  background: var(--border);
}
.empty-note {
  text-align: center;
  padding: 16px 0;
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-secondary);
}
/* 面板入场：从触发键方向轻微下压 + 放大到位（只动 transform/opacity） */
.shell-panel-enter-active,
.shell-panel-leave-active {
  transition:
    opacity var(--motion-duration-fast) var(--motion-ease),
    transform var(--motion-duration-fast) var(--motion-ease);
}
.shell-panel-enter-from,
.shell-panel-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}
</style>
