<template>
  <div class="flex flex-col gap-2.5">
    <!-- 生命周期口径说明：说清「运行中」与「启用」是两件事（启用 = 偏好，不驱动启动），
         否则「运行中但启用未勾选」会被读成自相矛盾 -->
    <p class="note hint">{{ t('shell.apps.managedByHost') }}</p>

    <!-- 已安装应用清单（注册表投影：真实运行态 / 来源 / 启用 / 自启；动作走真实命令面） -->
    <ShellCard
      v-for="app in appsStore.plugins.value"
      :key="app.id"
      :title="app.name"
      :icon="app.icon"
    >
      <div class="sub-line">
        <span class="shell-chip" :class="chipMeta(app.state).cls">{{ chipMeta(app.state).text }}</span>
        <span class="sub-note mono">{{ app.pluginId }}</span>
        <span class="sub-note">{{ sourceText(app.source) }} · v{{ app.version }}</span>
        <span class="grow"></span>
        <!-- 启用 / 自启偏好（只改持久化偏好，不触发当前进程启停） -->
        <label class="toggle" :title="t('shell.apps.enabledHint')">
          <input
            type="checkbox"
            :checked="app.enabled"
            :disabled="busy(app.id)"
            @change="onEnabled(app, ($event.target as HTMLInputElement).checked)"
          />
          <span>{{ t('shell.apps.enabled') }}</span>
        </label>
        <label class="toggle" :title="t('shell.apps.autostartHint')">
          <input
            type="checkbox"
            :checked="app.autostart"
            :disabled="busy(app.id)"
            @change="onAutostart(app, ($event.target as HTMLInputElement).checked)"
          />
          <span>{{ t('shell.apps.autostart') }}</span>
        </label>
      </div>

      <div v-if="app.state === 'approval'" class="approval-callout">
        {{ t('shell.apps.approvalCallout', { perms: app.permissions.length, risks: riskCount(app) }) }}
      </div>
      <!-- 失败态只给壳自有文案（ADR 0030）：后端原文（`WASM module not loaded`、
           linker 报错等）中英混杂且对用户无意义，技术详情在 error.* 日志里 -->
      <p v-else-if="app.error" class="note err">{{ t('shell.apps.errorHint') }}</p>

      <div class="actions">
        <!-- 待审批：批准并启动；运行中：停用；未启动：启动并打开 -->
        <button
          v-if="app.state === 'approval'"
          class="shell-btn"
          :disabled="busy(app.id)"
          @click="onApprove(app)"
        >
          <ShellIcon name="shield" :size="13" /> {{ t('shell.apps.approveStart') }}
        </button>
        <template v-else>
          <button
            v-if="app.state === 'running' || app.state === 'degraded'"
            class="shell-btn ghost"
            :disabled="busy(app.id)"
            @click="void state.stopApp(app.id)"
          >
            <ShellIcon name="stop" :size="13" /> {{ t('shell.apps.stop') }}
          </button>
          <button
            v-else
            class="shell-btn"
            :disabled="busy(app.id)"
            @click="void state.openApp(app.id)"
          >
            <ShellIcon name="play" :size="13" />
            {{ app.route ? t('shell.apps.startOpen') : t('shell.apps.open') }}
          </button>
        </template>
        <button
          v-if="app.source === 'user-installed'"
          class="shell-btn danger ghost"
          :disabled="busy(app.id) || app.state === 'running' || app.state === 'degraded'"
          :title="t('shell.apps.uninstallDisabled')"
          @click="onUninstall(app)"
        >
          <ShellIcon name="trash" :size="13" /> {{ t('shell.apps.uninstall') }}
        </button>
      </div>
      <p v-if="app.route" class="note">{{ t('shell.apps.surfaceHint', { route: app.route }) }}</p>
    </ShellCard>

    <!-- 权限入口（与「权限与授权」系统页同构跳转；策略/记录呈现单一口径） -->
    <ShellCard :title="t('shell.apps.permCardTitle')" icon="shield">
      <p class="note">{{ t('shell.apps.permHint') }}</p>
      <div class="flex gap-2">
        <button class="shell-btn ghost" @click="state.openSys('perms')">
          <ShellIcon name="shield" :size="13" /> {{ t('shell.apps.permGo') }}
        </button>
      </div>
    </ShellCard>
  </div>
</template>

<script setup lang="ts">
/**
 * SysAppsView — 系统页「应用管理」（壳内实现）
 *
 * 2026-10-17 lifecycle-sync 改造后：面目录从「静态只读投影」升级为**真实注册表
 * 投影 + 生命周期动作**——清单 / 运行态 / 待审批经宿主命令面（useShellApps
 * 收口），启停 / 审批 / 卸载 / 启用 / 自启开关全部走真实命令面（D2）。
 * 卸载带数据清理确认（ShellDialogLayer uninstall 分支）。
 */
import { useI18n } from 'vue-i18n'
import { chipMetaOf, isHighRisk } from '../composables/state'
import { useShellState } from '../composables/useShellState'
import { useShellApps, type ShellAppEntry } from '../composables/useShellApps'
import ShellIcon from '../components/ShellIcon.vue'
import ShellCard from '../components/ShellCard.vue'

const { t } = useI18n()
const state = useShellState()
const appsStore = useShellApps()

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

/** 展示态 chip 展示（单表真源 = state.ts `CHIP_META`；文案走 i18n 保持语言响应式） */
function chipMeta(st: string): { text: string; cls: string } {
  const meta = chipMetaOf(st)
  return meta ? { text: t(meta.textKey), cls: meta.cls } : { text: st, cls: '' }
}

// 偏好动作失败的用户提示统一由 showUserError 发出（ADR 0030，lastError 只是错误码）：
// 调用点不再 toast，只要求刷新后的开关回到真实偏好值（runAction 内已 refresh）
function onEnabled(app: ShellAppEntry, enabled: boolean) {
  void appsStore.setEnabled(app.id, enabled)
}
function onAutostart(app: ShellAppEntry, autostart: boolean) {
  void appsStore.setAutostart(app.id, autostart)
}
function onApprove(app: ShellAppEntry) {
  void state.approveAndStart(app.id)
}
function onUninstall(app: ShellAppEntry) {
  state.dialog.value = 'uninstall'
  state.dialogAppId.value = app.id
}
</script>

<style scoped>
.sub-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(12px * var(--ui-scale));
  flex-wrap: wrap;
}
.sub-note {
  color: var(--text-tertiary);
  font-size: calc(11px * var(--ui-scale));
}
.mono {
  font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
}
.grow {
  flex: 1;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-secondary);
  cursor: pointer;
}
.toggle input {
  accent-color: var(--color-primary);
}
.approval-callout {
  padding: 7px 9px;
  border-radius: var(--radius-button);
  /* 用真实存在的 token（此前引用的 --color-danger-soft 全仓零定义，
     只靠 color-mix 兜底） */
  background: var(--color-danger-light);
  border: 1px solid color-mix(in srgb, var(--color-danger) 30%, transparent);
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-primary);
  line-height: 1.5;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.note {
  font-size: calc(11px * var(--ui-scale));
  color: var(--text-secondary);
  line-height: 1.55;
}
.note.hint {
  padding: 0 2px;
  color: var(--text-tertiary);
}
.note.err {
  color: var(--color-danger);
}
</style>
