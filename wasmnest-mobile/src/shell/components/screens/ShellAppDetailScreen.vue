<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- ==================== 返回行 ==================== -->
    <div class="flex items-center gap-2 px-2 pt-2 pb-1">
      <button
        type="button"
        class="flex items-center justify-center rounded-[10px] min-w-[var(--mobile-touch-target-min)] min-h-[var(--mobile-touch-target-min)] transition-colors duration-200 active:bg-[var(--mobile-accent-muted)]"
        :aria-label="t('shell.detail.back')"
        @click="nav.back()"
      >
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      <span class="shell-type-title text-[var(--mobile-text-primary)]">
        {{ t('shell.detail.title') }}
      </span>
    </div>

    <div v-if="app" class="flex-1 min-h-0 overflow-y-auto pb-6 shell-content-cap">
      <!-- ==================== Hero ==================== -->
      <div class="flex items-center gap-3.5 px-4 pt-2 pb-4">
        <ShellAppIcon :app="app" :size="60" />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <b class="shell-type-title text-[var(--mobile-text-primary)] truncate">{{ app.name }}</b>
            <ShellChip v-if="app.official" :label="t('shell.detail.official')" tone="accent" />
          </div>
          <div class="mt-0.5 shell-type-caption text-[var(--mobile-text-secondary)] truncate">
            {{ app.version ? t('shell.detail.version', { version: app.version }) : '' }}
            <span v-if="app.author"> · {{ app.author }}</span>
          </div>
          <div class="mt-1 flex items-center gap-1.5 shell-type-caption">
            <span class="w-1.5 h-1.5 rounded-full flex-shrink-0" :style="{ background: stateDot }" aria-hidden="true" />
            <span :style="{ color: 'var(--mobile-text-secondary)' }">{{ stateLabel }}</span>
            <span v-if="app.error" class="truncate" :style="{ color: 'var(--mobile-error)' }"> · {{ app.error }}</span>
          </div>
        </div>
      </div>

      <!-- ==================== 待审批（需要用户动作：整单批准 + 哈希钉扎） ==================== -->
      <div v-if="app.state === 'approval'" class="px-4 pb-1">
        <div
          class="rounded-[12px] border px-3 py-3"
          :style="{
            background: 'var(--mobile-warning-muted)',
            borderColor: 'var(--mobile-warning)',
          }"
        >
          <p class="shell-type-body text-[var(--mobile-text-primary)]">
            {{ t('shell.detail.approvalDesc', { count: app.permissions.length }) }}
          </p>
          <button
            type="button"
            class="mt-2.5 w-full rounded-[10px] px-4 py-2.5 shell-type-label transition-opacity duration-200 active:opacity-80 min-h-[var(--mobile-touch-target-min)]"
            :style="{ background: 'var(--mobile-accent)', color: 'var(--mobile-text-on-accent)' }"
            @click="handleApprove"
          >
            {{ t('shell.detail.approveStart') }}
          </button>
        </div>
      </div>

      <!-- ==================== 运行状态 ==================== -->
      <!-- 应用自持连接，平台不知道它的连接对端；这里只投影平台确实掌握的事实：运行态 -->
      <ShellSection :title="t('shell.detail.state')" />
      <div class="px-4 pb-1">
        <ShellGroupCard>
          <div class="flex items-center gap-3 px-3 py-3">
            <span class="w-1.5 h-1.5 rounded-full flex-shrink-0" :style="{ background: stateDot }" aria-hidden="true" />
            <div class="flex-1 min-w-0">
              <div class="shell-type-label text-[var(--mobile-text-primary)]">
                {{ app.name }}
              </div>
            </div>
            <ShellChip :label="stateLabel" :tone="stateTone" />
          </div>
        </ShellGroupCard>
      </div>

      <!-- ==================== 自启（系统服务默认开，用户可关） ==================== -->
      <template v-if="canAutostart">
        <ShellSection
          :title="t('shell.apps.autostart')"
          :note="isService ? t('shell.apps.systemServiceHint') : t('shell.apps.autostartHint')"
        />
        <div class="px-4 pb-1">
          <ShellGroupCard>
            <div class="flex items-center gap-3 px-3 py-3 min-h-[var(--mobile-touch-target-min)]">
              <div class="flex-1 min-w-0">
                <div class="shell-type-label text-[var(--mobile-text-primary)]">
                  {{ t('shell.apps.autostart') }}
                </div>
                <div class="shell-type-caption text-[var(--mobile-text-secondary)]">
                  {{ t('shell.apps.autostartHint') }}
                </div>
              </div>
              <Toggle
                :model-value="autostart"
                :disabled="autostartBusy"
                @update:model-value="handleAutostart"
              />
            </div>
          </ShellGroupCard>
        </div>
      </template>

      <!-- ==================== 权限 ====================
           系统服务（L1/L2）的权限随包固定、不经用户授权：保留只读清单，
           但不渲染任何逐项开关（2026-10-23 用户裁决；同一裁决已把服务移出权限总览）。 -->
      <ShellSection :title="t('shell.detail.permissions')" :note="permissionsNote" />
      <div class="px-4 pb-1">
        <ShellGroupCard v-if="permissionGroups.length > 0">
          <template v-for="group in permissionGroups" :key="group.id">
            <div class="px-3 pt-2.5 pb-1 shell-type-micro text-[var(--mobile-text-muted)]">
              {{ t(group.titleKey) }}
            </div>
            <div
              v-for="grant in group.items"
              :key="grant.key"
              class="flex items-center gap-3 px-3 py-2.5 min-h-[var(--mobile-touch-target-min)]"
            >
              <div class="flex-1 min-w-0">
                <div class="shell-type-label text-[var(--mobile-text-primary)]">
                  {{ permissionTitle(grant.key) }}
                  <code class="ml-1.5 shell-type-micro text-[var(--mobile-text-secondary)]">{{ grant.key }}</code>
                </div>
                <div
                  v-if="permissionDesc(grant.key)"
                  class="shell-type-caption text-[var(--mobile-text-secondary)]"
                >
                  {{ permissionDesc(grant.key) }}
                </div>
                <div v-if="grant.locked" class="shell-type-caption text-[var(--mobile-text-secondary)]">
                  {{ t('shell.detail.permissionLocked') }}
                </div>
                <div v-else-if="grant.scope" class="shell-type-caption text-[var(--mobile-text-secondary)]">
                  {{ grant.scope }}
                </div>
              </div>
              <!-- 锁定项：不给开关，只标徽标——隐藏会让用户误以为应用没有该能力 -->
              <ShellChip v-if="grant.locked" :label="t('shell.detail.permissionLocked')" tone="neutral" />
              <!-- 系统服务不给开关（分区 note 已说明权限随包固定）；业务应用保持逐项开关 -->
              <Toggle
                v-else-if="!isService"
                :model-value="grant.granted"
                :disabled="!permissionControlEnabled"
                @update:model-value="(next: boolean) => handleToggle(grant.key, next)"
              />
            </div>
          </template>
        </ShellGroupCard>
        <p
          v-else
          class="rounded-[12px] border border-dashed border-[var(--mobile-border-hover)] px-3 py-4 text-center shell-type-caption text-[var(--mobile-text-secondary)]"
        >
          {{ t('mobile.plugin.noPermissions') }}
        </p>
        <!-- 能力缺失要显性说明：把开关置灰却不解释，用户会以为是应用的问题。
             系统服务的「无开关」由分区 note 解释，不走这条后端能力提示。 -->
        <p
          v-if="!permissionControlEnabled && !isService"
          class="mt-2 px-1 shell-type-caption text-[var(--mobile-text-secondary)]"
        >
          {{ t('shell.detail.permissionUnsupported') }}
        </p>
        <p v-if="toggleError" class="mt-2 px-1 shell-type-caption" :style="{ color: 'var(--mobile-error)' }">
          {{ toggleError }}
        </p>
      </div>

      <!-- ==================== 存储 ==================== -->
      <ShellSection :title="t('shell.detail.storage')" />
      <div class="px-4 pb-1">
        <ShellGroupCard>
          <div class="flex items-center px-3 py-3 min-h-[var(--mobile-touch-target-min)]">
            <span class="flex-1 shell-type-label text-[var(--mobile-text-primary)]">
              {{ t('shell.detail.appData') }}
            </span>
            <span class="shell-type-caption text-[var(--mobile-text-secondary)]">{{ formatBytes(app.sizeBytes) }}</span>
          </div>
          <!-- 缓存行已删：后端没有缓存统计源，永远显示「—」的行属于空白项 -->
        </ShellGroupCard>
      </div>

      <!-- ==================== 授权记录 ==================== -->
      <ShellSection :title="t('shell.detail.grants')" :note="t('shell.detail.grantsNote')" />
      <div class="px-4 pb-1">
        <p
          class="rounded-[12px] border border-dashed border-[var(--mobile-border-hover)] px-3 py-4 text-center shell-type-caption text-[var(--mobile-text-secondary)]"
        >
          {{ t('shell.detail.grantsEmpty') }}
        </p>
      </div>

      <!-- ==================== 操作 ==================== -->
      <!-- 层级：停用（次要）→ 卸载（危险，描边而非淡粉底：淡粉底在浅色主题下
           看起来像 disabled 按钮，反而弱化了危险性 -->
      <div class="px-4 pt-3 flex flex-col gap-2.5">
        <button
          type="button"
          class="w-full rounded-[10px] border border-[var(--mobile-border)] px-4 py-3 shell-type-label text-[var(--mobile-text-primary)] transition-colors duration-200 active:bg-[var(--mobile-accent-muted)] min-h-[var(--mobile-touch-target-min)] disabled:opacity-40 disabled:cursor-not-allowed disabled:text-[var(--mobile-text-disabled)] disabled:active:bg-transparent"
          :disabled="!canStop"
          @click="handleStop"
        >
          <!-- 停止动作按装配角色分词语：系统服务说「停止服务」（2026-10-23 用户裁决）。
               系统服务停止前弹确认（下方 ConfirmDialog）：服务是常驻能力，误停影响面广；
               业务应用停用保持即时生效。 -->
          {{ isService ? t('shell.detail.stopService') : t('shell.detail.disable') }}
        </button>
        <button
          v-if="canRemove"
          type="button"
          class="w-full rounded-[10px] border px-4 py-3 shell-type-label transition-colors duration-200 active:opacity-80 min-h-[var(--mobile-touch-target-min)]"
          :style="{
            borderColor: 'var(--mobile-error)',
            color: 'var(--mobile-error)',
            background: 'transparent',
          }"
          @click="confirmRemove = true"
        >
          {{ t('shell.detail.uninstall') }}
        </button>
      </div>
    </div>

    <!-- 应用已卸载/不存在：给出原因与出口，不留白屏 -->
    <div v-else class="flex-1 flex items-center justify-center px-8 text-center">
      <p class="shell-type-body text-[var(--mobile-text-secondary)]">
        {{ t('shell.run.notFound') }}
      </p>
    </div>

    <!-- 危险操作二次确认：复用平台通用 ConfirmDialog，不用原生对话框
         （原生 confirm 是系统弹窗，视觉与平台不一致，且不可本地化按钮）。
         放在 `v-if="app"` / `v-else` 配对之外，避免打断两者的相邻关系。 -->
    <ConfirmDialog
      :model-value="confirmRemove"
      variant="danger"
      :title="t('shell.detail.uninstall')"
      :message="app ? t('shell.apps.uninstallConfirm', { name: app.name }) : ''"
      :confirm-text="t('shell.detail.uninstall')"
      :cancel-text="t('shell.common.cancel')"
      @update:model-value="confirmRemove = $event"
      @confirm="handleRemove"
    />
    <!-- 系统服务停止确认（服务是常驻能力，误停影响面广；业务应用停用不弹） -->
    <ConfirmDialog
      :model-value="confirmStop"
      variant="warning"
      :title="t('shell.detail.stopService')"
      :message="app ? t('shell.detail.stopServiceConfirm', { name: app.name }) : ''"
      :confirm-text="t('shell.detail.stopService')"
      :cancel-text="t('shell.common.cancel')"
      @update:model-value="confirmStop = $event"
      @confirm="handleStopConfirm"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 应用详情与权限
 *
 * 权限开关是 UX，裁决在 Rust 端（docs/security.md §1）。因此：
 *   · 后端不支持逐项授予时，开关置灰并显式说明，不做「点了就算通过」的假成功
 *   · 授权记录区没有后端真源，渲染空态而不是编造几条示例
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import Toggle from '../ui/Toggle.vue'
import { useToast } from '../../composables/useToast'
import { useShellApps } from '../../composables/useShellApps'
import { useShellNavigation } from '../../composables/useShellNavigation'
import { groupPermissions, permissionDescKey, permissionTitleKey } from '../../permissions'
import { formatBytes, isServiceKind } from '../../utils'
import ShellAppIcon from '../ShellAppIcon.vue'
import ShellChip from '../ShellChip.vue'
import ShellGroupCard from '../ShellGroupCard.vue'
import ShellSection from '../ShellSection.vue'

const { t } = useI18n()
const toast = useToast()
const nav = useShellNavigation()
const {
  getApp,
  supportsPermissionControl,
  setPermissionGrant,
  supportsRemove,
  removeApp,
  supportsAutostart,
  isAutostart,
  setAutostart,
  stop,
  approveApp,
  launch,
} = useShellApps()

/** 应用 id 来自导航参数（壳内导航不落 URL） */
const appId = computed(() => nav.params.value.appId ?? '')
const app = computed(() => getApp(appId.value))

const permissionControlEnabled = computed(() =>
  appId.value ? supportsPermissionControl(appId.value) : false,
)
const isService = computed(() => isServiceKind(app.value?.kind))
const canRemove = computed(
  () => !isService.value && (appId.value ? supportsRemove(appId.value) : false),
)
const canAutostart = computed(
  () => (appId.value ? supportsAutostart(appId.value) : false),
)
/**
 * 停止只在应用可能持有运行时实例时可用：未启动 / 已停用 / 待审批没有可停止的对象，
 * 按钮置灰而不是让用户点了没反应。error 保留可点——启动失败后仍可能需要清掉残留实例，
 * 停止失败后的重试也走这里。
 */
const canStop = computed(
  () => app.value?.state === 'running' || app.value?.state === 'error',
)
const autostart = ref(false)
const autostartBusy = ref(false)

/** 权限按能力域分组；未归类的新权限进「其他」组，保证不会因未归类而消失 */
const permissionGroups = computed(() =>
  groupPermissions(app.value?.permissions ?? [], 'shell.permission.group.other'),
)

/**
 * 权限分区说明
 *
 * 系统服务没有逐项开关（权限随包固定），这里说明「为什么没有开关」，
 * 而不是继续报授予计数——否则用户会去别处找本不存在的控制项。
 */
const permissionsNote = computed(() => {
  if (isService.value) return t('shell.detail.permissionServiceFixed')
  const list = app.value?.permissions ?? []
  const granted = list.filter((p) => p.granted).length
  const locked = list.filter((p) => p.locked).length
  return t('shell.detail.permissionsNote', { granted, locked })
})

/** 权限标题：复用既有本地化文案，未知权限回退原始权限词（不显示为空白） */
function permissionTitle(key: string): string {
  const i18nKey = permissionTitleKey(key)
  return i18nKey ? t(i18nKey) : key
}

/** 权限说明：已知权限展示能力边界（如 metrics:read 的侧信道提示）；未知权限不占行 */
function permissionDesc(key: string): string {
  const i18nKey = permissionDescKey(key)
  return i18nKey ? t(i18nKey) : ''
}

const stateLabel = computed(() => {
  switch (app.value?.state) {
    case 'running':
      return t('shell.common.running')
    case 'approval':
      return t('shell.common.approval')
    case 'disabled':
      return t('shell.common.disabled')
    case 'error':
      return t('shell.common.error')
    default:
      return t('shell.common.stopped')
  }
})

const stateTone = computed<'success' | 'warn' | 'danger' | 'neutral'>(() => {
  switch (app.value?.state) {
    case 'running':
      return 'success'
    case 'approval':
      return 'warn'
    case 'disabled':
      return 'warn'
    case 'error':
      return 'danger'
    default:
      return 'neutral'
  }
})

const stateDot = computed(() => {
  switch (app.value?.state) {
    case 'running':
      return 'var(--mobile-success)'
    case 'approval':
      return 'var(--mobile-warning)'
    case 'error':
      return 'var(--mobile-error)'
    default:
      return 'var(--mobile-text-disabled)'
  }
})

const toggleError = ref<string | null>(null)
/** 卸载二次确认（复用平台 ConfirmDialog，见模板） */
const confirmRemove = ref(false)
/** 系统服务停止二次确认（复用平台 ConfirmDialog，见模板） */
const confirmStop = ref(false)
// 切换应用时清掉上一条的失败提示，避免张冠李戴；顺带读取自启偏好
watch(
  appId,
  async () => {
    toggleError.value = null
    autostart.value = appId.value ? await isAutostart(appId.value) : false
  },
  { immediate: true },
)

async function handleAutostart(next: boolean): Promise<void> {
  if (!appId.value || autostartBusy.value) return
  autostartBusy.value = true
  try {
    const ok = await setAutostart(appId.value, next)
    if (ok) autostart.value = next
  } finally {
    autostartBusy.value = false
  }
}

async function handleToggle(key: string, next: boolean): Promise<void> {
  if (!appId.value) return
  const ok = await setPermissionGrant(appId.value, key, next)
  if (!ok) {
    toggleError.value = t('shell.detail.permissionToggleFailed', {
      reason: t('shell.detail.permissionUnsupported'),
    })
  }
}

async function handleStop(): Promise<void> {
  if (!appId.value) return
  // 系统服务是常驻能力：停止前先弹确认；业务应用停用保持即时生效
  if (isService.value) {
    confirmStop.value = true
    return
  }
  await stop(appId.value)
}

/** 服务停止确认后执行（confirmStop 弹窗的确认动作） */
async function handleStopConfirm(): Promise<void> {
  confirmStop.value = false
  if (!appId.value) return
  await stop(appId.value)
}

/**
 * 批准并启动
 *
 * 审批是整单的（后端 plugin_approve：全部声明权限 + 内容哈希钉扎）；批准失败时
 * 不继续启动——半途而废的「已批准」假象比直接报错更危险（权限是安全面）。
 */
async function handleApprove(): Promise<void> {
  if (!app.value) return
  const approved = await approveApp(app.value.id)
  if (!approved) {
    toggleError.value = t('shell.permissions.approveFailed')
    return
  }
  const started = await launch(app.value.id)
  if (started) nav.openApp(app.value.id)
}

async function handleRemove(): Promise<void> {
  confirmRemove.value = false
  if (!app.value) return
  const ok = await removeApp(app.value.id)
  if (ok) {
    toast.success(t('shell.apps.uninstallSuccess', { name: app.value.name }))
    nav.back()
  } else {
    toast.error(t('shell.apps.uninstallFailed', { error: t('shell.run.notFound') }))
  }
}
</script>
