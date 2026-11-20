<template>
  <div class="flex flex-col gap-2.5">
    <!-- 服务清单（注册表投影）：服务型 wasm（basic-service / internal-business）的
         唯一管理面。卡片本身可点 = 进入该服务的运行入口；卡内按钮 / 开关不冒泡。
         排序 L1 → L2 → 名称（2026-10-23 用户裁决，随「服务」区一并从应用管理迁入）。 -->
    <template v-for="group in serviceGroups" :key="group.id">
      <div class="group-title" :data-testid="`sys-services-group-${group.id}`">
        {{ group.title }}
      </div>
      <div
        v-for="app in group.apps"
        :key="app.id"
        class="svc-item"
        :data-testid="`sys-services-card-${app.pluginId}`"
        @click="onCardClick($event, app)"
      >
        <ShellCard :title="app.name">
          <template #icon>
            <ShellAppTile
              :icon="app.icon"
              :plugin-id="app.pluginId"
              :icon-file="app.iconFile"
              :tone="app.tone"
              :size="20"
            />
          </template>
          <div class="sub-line">
            <span class="shell-chip" :class="chipMeta(app.state).cls">{{ chipMeta(app.state).text }}</span>
            <span class="sub-note">{{ sourceText(app.source) }} · v{{ app.version }}</span>
            <span class="grow"></span>
            <label class="toggle" :title="t('shell.apps.enabledHint')">
              <button
                class="switch"
                type="button"
                role="switch"
                :aria-checked="app.enabled"
                :disabled="busy(app.id)"
                @click="onEnabled(app, !app.enabled)"
              >
                <span class="switch-thumb" />
              </button>
              <span>{{ t('shell.apps.enabled') }}</span>
            </label>
            <label class="toggle" :title="t('shell.apps.autostartHint')">
              <button
                class="switch"
                type="button"
                role="switch"
                :aria-checked="app.autostart"
                :disabled="busy(app.id)"
                @click="onAutostart(app, !app.autostart)"
              >
                <span class="switch-thumb" />
              </button>
              <span>{{ t('shell.apps.autostart') }}</span>
            </label>
          </div>

          <div v-if="app.state === 'approval'" class="approval-callout">
            {{ t('shell.apps.approvalCallout', { perms: app.permissions.length, risks: riskCount(app) }) }}
          </div>
          <p v-else-if="app.error" class="note err">{{ t('shell.apps.errorHint') }}</p>

          <div class="actions">
            <button
              v-if="app.state === 'approval'"
              class="shell-btn"
              :disabled="busy(app.id)"
              @click="onApprove(app)"
            >
              <ShellIcon name="shield" :size="13" /> {{ t('shell.apps.approveStart') }}
            </button>
            <template v-else>
              <!-- 服务详情：进入该服务的运行界面（与整卡点击同义；无运行面的服务不出现） -->
              <button
                v-if="app.route"
                class="shell-btn ghost"
                :disabled="busy(app.id)"
                @click="open(app)"
              >
                <ShellIcon name="info" :size="13" /> {{ t('shell.services.detail') }}
              </button>
              <!-- 运行态 = 同一个按钮切换（2026-11-20 用户裁决）：运行中 → 停止服务（先确认）；
                   其余 → 运行服务（只启动，不离开本页）。避免停止后按钮消失、无处重启。 -->
              <button
                v-if="isRunning(app)"
                class="shell-btn ghost"
                :disabled="busy(app.id)"
                @click="onStop(app)"
              >
                <ShellIcon name="stop" :size="13" /> {{ t('shell.apps.stopService') }}
              </button>
              <button
                v-else
                class="shell-btn"
                :disabled="busy(app.id)"
                @click="onStart(app)"
              >
                <ShellIcon name="play" :size="13" /> {{ t('shell.services.start') }}
              </button>
            </template>
          </div>
        </ShellCard>
      </div>
    </template>

    <div v-if="serviceGroups.length === 0" class="note empty">
      {{ t('shell.services.empty') }}
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * SysServicesView — 系统页「服务管理」（桌面，壳内实现）
 *
 * 服务型 wasm（装配角色 basic-service / internal-business）的唯一管理面。
 * 2026-11-20 从应用管理「系统服务」分组 + 主屏「服务」宫格迁入：服务不再混在
 * 业务应用清单里，也不在主屏占一宫格；点服务卡片 = 进入该服务页面。
 * 卡片保留迁移前的全部能力（状态 / 启用 / 自启 / 停止确认 / 审批），去掉与
 * 服务无关的「安装 / 卸载 / 更新 / 权限入口」——那四件属于业务应用管理面。
 * 2026-11-20 二次裁决：主按钮改称「服务详情」（原「打开服务」会被读成启动），
 * 运行态用同一个按钮切换「停止服务 ↔ 运行服务」，停止后不会失去重启入口。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { chipMetaOf, isHighRisk } from '../composables/state'
import { useShellState } from '../composables/useShellState'
import { isServiceKind, useShellApps, type ShellAppEntry } from '../composables/useShellApps'
import ShellIcon from '../components/ShellIcon.vue'
import ShellAppTile from '../components/ShellAppTile.vue'
import ShellCard from '../components/ShellCard.vue'

const { t } = useI18n()
const state = useShellState()
const appsStore = useShellApps()

/** 服务唯一判据 = manifest kind；L1 basic-service → L2 internal-business → 名称 */
const serviceGroups = computed(() => {
  const services = appsStore.plugins.value
    .filter((app) => isServiceKind(app.kind))
    .sort((a, b) => {
      const rank = (kind?: string) => (kind === 'basic-service' ? 0 : 1)
      return rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
  return services.length > 0
    ? [{ id: 'services', title: t('shell.apps.systemServices'), apps: services }]
    : []
})

function busy(id: string): boolean {
  return appsStore.busyId.value === id
}

function riskCount(app: ShellAppEntry): number {
  return app.permissions.filter((p) => isHighRisk(p)).length
}

function sourceText(source: string): string {
  const map: Record<string, string> = {
    builtin: t('shell.apps.source.builtin'),
    scanned: t('shell.apps.source.scanned'),
    wasm: t('shell.apps.source.wasm'),
    'user-installed': t('shell.apps.source.user'),
  }
  return map[source] ?? source
}

/** 展示态 chip 展示（单表真源 = state.ts `CHIP_META`） */
function chipMeta(st: string): { text: string; cls: string } {
  const meta = chipMetaOf(st)
  return meta ? { text: t(meta.textKey), cls: meta.cls } : { text: st, cls: '' }
}

/** 整卡点击 = 进入服务；卡内按钮 / 开关 / 链接的点击不冒泡成「打开」 */
function onCardClick(e: MouseEvent, app: ShellAppEntry): void {
  if ((e.target as HTMLElement | null)?.closest('button, label, a')) return
  open(app)
}

function open(app: ShellAppEntry): void {
  void state.openApp(app.id)
}

/** 运行态判定：停止确认与「停止服务」按钮同口径（degraded 仍可停止） */
function isRunning(app: ShellAppEntry): boolean {
  return app.state === 'running' || app.state === 'degraded'
}

/** 运行服务：只启动（真激活），不离开本页；进入界面走「服务详情」/ 整卡点击 */
function onStart(app: ShellAppEntry) {
  void appsStore.activate(app.id)
}

function onEnabled(app: ShellAppEntry, enabled: boolean) {
  void appsStore.setEnabled(app.id, enabled)
}
function onAutostart(app: ShellAppEntry, autostart: boolean) {
  void appsStore.setAutostart(app.id, autostart)
}
function onApprove(app: ShellAppEntry) {
  void state.approveAndStart(app.id)
}
/** 服务停止先弹确认（ShellDialogLayer stop-service 分支），不直接停 */
function onStop(app: ShellAppEntry) {
  state.dialog.value = 'stop-service'
  state.dialogAppId.value = app.id
}
</script>

<style scoped>
.group-title {
  padding: 4px 2px 0;
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
}
.svc-item {
  border-radius: var(--radius-card);
  cursor: pointer;
}
.svc-item:focus-within {
  outline: var(--focus-ring-width) solid var(--focus-ring-color);
}
.sub-line {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: calc(12px * var(--ui-scale));
  flex-wrap: wrap;
}
.sub-note {
  color: var(--text-tertiary);
  font-size: calc(11.5px * var(--ui-scale));
}
.grow {
  flex: 1;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-secondary);
  cursor: pointer;
}
/* 方角开关（与应用管理页同一套：40×20 轨道 + 12×12 滑块） */
.switch {
  position: relative;
  flex-shrink: 0;
  width: 40px;
  height: 20px;
  padding: 0;
  border-radius: 4px;
  border: 1px solid var(--border-strong);
  background: var(--bg-page);
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}
.switch[aria-checked='true'] {
  background: var(--color-primary);
  border-color: var(--color-primary);
}
.switch .switch-thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 12px;
  height: 12px;
  border-radius: 2px;
  background: var(--border-strong);
  transition:
    left 0.15s ease,
    background 0.15s ease;
}
.switch[aria-checked='true'] .switch-thumb {
  left: 22px;
  background: var(--color-primary-contrast);
}
.switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.approval-callout {
  padding: 8px 10px;
  border-radius: var(--radius-button);
  background: var(--color-danger-light);
  border: 1px solid color-mix(in srgb, var(--color-danger) 30%, transparent);
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-primary);
  line-height: 1.5;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.note {
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-secondary);
  line-height: 1.55;
}
.note.err {
  color: var(--color-danger-ink);
}
.note.empty {
  padding: 14px 2px;
}
</style>
