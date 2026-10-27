<template>
  <div class="flex flex-col gap-2.5">
    <!-- 已安装应用清单（注册表投影：真实运行态 / 来源 / 启用 / 自启；动作走真实命令面）。
         按 manifest kind 分组：业务应用在前、L1/L2 系统服务在后（2026-10-23 用户裁决）；
         没有服务时不渲染空标题。 -->
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
            @click="onStop(app)"
          >
            <!-- 停止动作按装配角色分词语：系统服务（L1/L2）说「停止服务」（2026-10-23 用户裁决）。
                 系统服务停止前弹确认（ShellDialogLayer stop-service 分支）：服务是常驻能力，
                 误停影响面广；业务应用停用保持即时生效。 -->
            <ShellIcon name="stop" :size="13" />
            {{ isServiceKind(app.kind) ? t('shell.apps.stopService') : t('shell.apps.stop') }}
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

      <!-- 更新面（应用版本更新全链路）：仅 user-installed 业务应用（与卸载同门槛，
           builtin/scanned 的更新走宿主发布装配）。兼容判断在 useAppUpdates（壳持有
           MOUNT_CONTRACT 与宿主版本）：不兼容只给原因、绝不出现更新按钮。 -->
      <div
        v-if="isUpdatable(app)"
        class="update-line"
        :data-testid="`sys-apps-update-${app.pluginId}`"
      >
        <button
          class="shell-btn ghost"
          :data-testid="`sys-apps-update-check-${app.pluginId}`"
          :disabled="updateBusy(app.id)"
          @click="onCheckUpdate(app)"
        >
          <ShellIcon name="reset" :size="13" /> {{ t('shell.apps.update.check') }}
        </button>
        <span
          v-if="updateStatusText(app.id)"
          class="sub-note update-status"
          :class="{ err: updateStatusIsBad(app.id) }"
          :data-testid="`sys-apps-update-status-${app.pluginId}`"
        >{{ updateStatusText(app.id) }}</span>
        <button
          v-if="updateStates[app.id]?.status === 'available'"
          class="shell-btn"
          :data-testid="`sys-apps-update-apply-${app.pluginId}`"
          :disabled="updateBusy(app.id) || app.state === 'running' || app.state === 'degraded'"
          :title="t('shell.apps.uninstallDisabled')"
          @click="onApplyUpdate(app)"
        >
          <ShellIcon name="transfer" :size="13" />
          {{ t('shell.apps.update.apply', { version: updateStates[app.id]?.latestVersion }) }}
        </button>
        <p
          v-if="updateReasonText(app.id)"
          class="note err update-reason"
        >{{ updateReasonText(app.id) }}</p>
      </div>
      </ShellCard>
    </template>

    <!-- 安装应用（本地 zip）：原生选包对话框（Rust 发起，前端不传任意路径）→
         既有 plugin_install_from_file；安装后清单自动刷新 -->
    <ShellCard :title="t('shell.apps.install')" icon="file">
      <p class="note">{{ t('shell.apps.installDesc') }}</p>
      <div class="flex gap-2">
        <button class="shell-btn ghost" data-testid="sys-apps-install" @click="onInstallZip">
          <ShellIcon name="folder" :size="13" /> {{ t('shell.apps.install') }}
        </button>
      </div>
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
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@/utils/invoke'
import { ensureHostCredential } from '@/utils/appCommands'
import { showUserError } from '@/utils/userError'
import { chipMetaOf, isHighRisk } from '../composables/state'
import { useShellState } from '../composables/useShellState'
import { isServiceKind, useShellApps, type ShellAppEntry } from '../composables/useShellApps'
import { useAppUpdates, type AppUpdateState } from '../composables/useAppUpdates'
import ShellIcon from '../components/ShellIcon.vue'
import ShellCard from '../components/ShellCard.vue'

const { t } = useI18n()
const state = useShellState()
const appsStore = useShellApps()

/**
 * 业务应用 / 系统服务分组（唯一判据 = manifest kind；不在 UI 里硬编码 id）。
 * 业务应用在前、系统服务在后（2026-10-23 用户裁决）；服务按 L1 → L2 → 名称，
 * 应用保持原注册表顺序（运行态排序由主屏负责）。
 */
const appGroups = computed(() => {
  const apps = appsStore.plugins.value.filter((app) => !isServiceKind(app.kind))
  const services = appsStore.plugins.value
    .filter((app) => isServiceKind(app.kind))
    .sort((a, b) => {
      const rank = (kind?: string) => (kind === 'basic-service' ? 0 : 1)
      return rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
  return [
    { id: 'apps', title: apps.length > 0 ? t('shell.apps.businessApps') : '', apps },
    { id: 'services', title: services.length > 0 ? t('shell.apps.systemServices') : '', apps: services },
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
/**
 * 停止入口分派：系统服务（L1/L2）先弹确认（ShellDialogLayer stop-service 分支，
 * 服务是常驻能力，误停影响面广）；业务应用停用保持即时生效。
 */
function onStop(app: ShellAppEntry) {
  if (isServiceKind(app.kind)) {
    state.dialog.value = 'stop-service'
    state.dialogAppId.value = app.id
    return
  }
  void state.stopApp(app.id)
}
function onUninstall(app: ShellAppEntry) {
  state.dialog.value = 'uninstall'
  state.dialogAppId.value = app.id
}

// ==================== 应用更新面（应用版本更新全链路） ====================

const updates = useAppUpdates()
/** script setup 顶层 ref：模板里自动解包（`updateStates[app.id]` 直取状态） */
const updateStates = updates.states

/** 更新面只对 user-installed 业务应用开放（与卸载同门槛；builtin 走宿主发布装配） */
function isUpdatable(app: ShellAppEntry): boolean {
  return app.source === 'user-installed' && !isServiceKind(app.kind)
}

function updateBusy(appId: string): boolean {
  const st = updates.states.value[appId]
  return st?.status === 'checking' || st?.status === 'updating'
}

function updateStatusIsBad(appId: string): boolean {
  const st = updates.states.value[appId]
  return st?.status === 'error' || st?.status === 'incompatible'
}

/** 状态行文案（i18n 单一来源；idle 不渲染） */
function updateStatusText(appId: string): string {
  const st: AppUpdateState | undefined = updates.states.value[appId]
  if (!st) return ''
  switch (st.status) {
    case 'checking':
      return t('shell.apps.update.checking')
    case 'up-to-date':
      return t('shell.apps.update.upToDate', { version: st.currentVersion ?? '' })
    case 'available':
      return t('shell.apps.update.available', { version: st.latestVersion ?? '' })
    case 'incompatible':
      return t('shell.apps.update.incompatible', { version: st.latestVersion ?? '' })
    case 'updating':
      return t('shell.apps.update.updating')
    case 'error':
      return t('shell.apps.update.failed')
    default:
      return ''
  }
}

/** 不兼容原因（独立成行红字；版本号等参数在 composable 里已装好） */
function updateReasonText(appId: string): string {
  const reason = updates.states.value[appId]?.reason
  return reason ? t(reason.key, reason.params ?? {}) : ''
}

function onCheckUpdate(app: ShellAppEntry) {
  void updates.check(app.pluginId)
}

async function onApplyUpdate(app: ShellAppEntry) {
  const ok = await updates.applyUpdate(app.pluginId)
  // 升级成功后清单里的版本号 / 状态需要重新投影（wasm-core 已换目录重装载）
  if (ok) await appsStore.refresh()
}

/** 安装应用（本地 zip）：原生选包 → 既有安装命令（首装模式） */
async function onInstallZip() {
  try {
    const credential = await ensureHostCredential()
    const picked = await invoke<string | null>('plugin_pick_app_zip')
    if (!picked) return // 用户取消
    await invoke('plugin_install_from_file', { path: picked, credential })
    await appsStore.refresh()
  } catch (e) {
    showUserError(e)
  }
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
.update-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  border-top: 1px solid var(--border);
  padding-top: 8px;
  margin-top: 2px;
}
.update-status.err {
  color: var(--color-danger-ink);
}
.update-reason {
  width: 100%;
  margin: 0;
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
