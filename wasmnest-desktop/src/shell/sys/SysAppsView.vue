<template>
  <div class="flex flex-col gap-2.5">
    <!-- 已安装应用清单（注册表投影：真实运行态 / 来源 / 启用 / 自启；动作走真实命令面）。
         系统服务区按 manifest kind 分组：L1/L2 在前、L3 业务应用在后；没有服务时不渲染空标题。 -->
    <template v-for="group in appGroups" :key="group.id">
      <div
        v-if="group.title"
        class="group-title"
        :data-testid="`sys-apps-group-${group.id}`"
      >
        {{ group.title }}
      </div>
      <ShellCard
        v-for="app in group.apps"
        :key="app.id"
        :title="app.name"
        :icon="app.icon"
      >
      <div class="sub-line">
        <span class="shell-chip" :class="chipMeta(app.state).cls">{{ chipMeta(app.state).text }}</span>
        <span class="sub-note mono">{{ app.pluginId }}</span>
        <span class="sub-note">{{ sourceText(app.source) }} · v{{ app.version }}</span>
        <span class="grow"></span>
        <!-- 启用 = 主屏入口可见性（缺省可见；关闭后主屏 / 搜索隐藏入口）；自启 = boot
             自动激活偏好。两者都只写持久化偏好，不触发当前进程启停（方角开关，视觉同设置页） -->
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
          v-if="app.source === 'user-installed' && !isServiceKind(app.kind)"
          class="shell-btn danger ghost"
          :disabled="busy(app.id) || app.state === 'running' || app.state === 'degraded'"
          :title="t('shell.apps.uninstallDisabled')"
          @click="onUninstall(app)"
        >
          <ShellIcon name="trash" :size="13" /> {{ t('shell.apps.uninstall') }}
        </button>
      </div>
      </ShellCard>
    </template>

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
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { chipMetaOf, isHighRisk } from '../composables/state'
import { useShellState } from '../composables/useShellState'
import { isServiceKind, useShellApps, type ShellAppEntry } from '../composables/useShellApps'
import ShellIcon from '../components/ShellIcon.vue'
import ShellCard from '../components/ShellCard.vue'

const { t } = useI18n()
const state = useShellState()
const appsStore = useShellApps()

/**
 * 系统服务 / 业务应用分组（唯一判据 = manifest kind；不在 UI 里硬编码 id）。
 * 服务按 L1 → L2 → 名称，应用保持原注册表顺序（运行态排序由主屏负责）。
 */
const appGroups = computed(() => {
  const services = appsStore.plugins.value
    .filter((app) => isServiceKind(app.kind))
    .sort((a, b) => {
      const rank = (kind?: string) => (kind === 'basic-service' ? 0 : 1)
      return rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
  const apps = appsStore.plugins.value.filter((app) => !isServiceKind(app.kind))
  return [
    { id: 'services', title: services.length > 0 ? t('shell.apps.systemServices') : '', apps: services },
    { id: 'apps', title: apps.length > 0 ? t('shell.apps.businessApps') : '', apps },
  ].filter((group) => group.apps.length > 0)
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
.group-title {
  padding: 4px 2px 0;
  font-size: calc(12px * var(--ui-scale));
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
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
.mono {
  font-family: var(--font-mono);
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
/* 方角开关（视觉同 SettingsSystemSection 的防止休眠开关：40×20 轨道 + 12×12 滑块） */
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
  /* 用真实存在的 token（此前引用的 --color-danger-soft 全仓零定义，
     只靠 color-mix 兜底） */
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
.note.hint {
  padding: 0 2px;
  color: var(--text-secondary);
}
.note.err {
  color: var(--color-danger-ink);
}
</style>
