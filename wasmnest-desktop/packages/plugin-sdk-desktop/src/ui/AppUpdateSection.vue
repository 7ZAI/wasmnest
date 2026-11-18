<template>
  <!--
    应用更新检查（SDK 默认实现）

    应用设置页直接嵌入即可：宿主提供 GitHub Release 判定，本组件只负责状态与
    展示。应用想自实现时不必使用本组件（或传 `check` 覆盖数据面）。
  -->
  <section class="wasmnest-update" data-testid="sdk-app-update">
    <div class="wasmnest-update__row">
      <div class="wasmnest-update__main">
        <span v-if="text.title" class="wasmnest-update__title">{{ text.title }}</span>
        <span v-if="versionLabel" class="wasmnest-update__version">{{ versionLabel }}</span>
      </div>
      <button
        type="button"
        class="wasmnest-update__button"
        :disabled="disabled || checking || !supported"
        :aria-busy="checking"
        data-testid="sdk-app-update-check"
        @click="onCheck"
      >
        {{ checking ? text.checking : text.check }}
      </button>
    </div>
    <p
      v-if="statusLabel"
      class="wasmnest-update__status"
      :class="{ 'is-error': isBad, 'is-available': status === 'available' }"
      data-testid="sdk-app-update-status"
    >
      {{ statusLabel }}
    </p>
    <p
      v-if="reasonLabel"
      class="wasmnest-update__status is-error"
      data-testid="sdk-app-update-reason"
    >
      {{ reasonLabel }}
    </p>
  </section>
</template>

<script setup lang="ts">
/**
 * AppUpdateSection — SDK 默认应用更新卡片（双端同形）
 *
 * 数据面：`PluginContext.appUpdate.check`（宿主统一实现）或调用方传入的 `check`
 * （应用自实现）。状态机在 `useAppUpdate`；本组件只做展示，不发起安装——
 * 更新动作统一收口在宿主应用管理页（需要先停用应用、替换插件目录并重新审批）。
 *
 * 视觉：只依赖 `--mobile-*` / 桌面 `--bg-card` 等 token 的回退组合，不引入
 * 任何一端专属组件；应用可在外层继续套自己的卡片样式。
 */
import { computed } from 'vue'
import { useAppUpdate } from '../update'
import type { AppUpdateCheckResult } from '../types'

/** 文案包（应用可覆盖任意字段；`{version}` 由组件替换） */
export interface AppUpdateLabels {
  title: string
  check: string
  checking: string
  upToDate: string
  available: string
  incompatible: string
  failed: string
  unsupported: string
  reasonNoCompat: string
  reasonMountContract: string
  reasonHostRuntime: string
  reasonHostRuntimeInvalid: string
}

const props = withDefaults(
  defineProps<{
    /** 当前版本（可选；不传时用检查结果的 currentVersion） */
    currentVersion?: string
    /** 自定义检查器；缺省使用宿主 `PluginContext.appUpdate.check` */
    check?: () => Promise<AppUpdateCheckResult>
    /** 文案覆盖（缺省按系统语言内置中 / 英） */
    labels?: Partial<AppUpdateLabels>
    disabled?: boolean
  }>(),
  { currentVersion: '', check: undefined, labels: undefined, disabled: false },
)

const ZH: AppUpdateLabels = {
  title: '版本更新',
  check: '检查更新',
  checking: '正在检查…',
  upToDate: '已是最新版本（v{version}）',
  available: '发现新版本 v{version}；请在应用管理中更新',
  incompatible: '发现新版本 v{version}，但与当前平台不兼容',
  failed: '检查失败，请稍后重试',
  unsupported: '当前平台不提供更新检查',
  reasonNoCompat: '该发布物缺少兼容声明（旧版发布格式），无法确认与当前平台兼容',
  reasonMountContract: '要求挂载契约 {required}，当前平台为 {current}',
  reasonHostRuntime: '要求宿主运行时 {required}，当前为 {current}；请先升级平台',
  reasonHostRuntimeInvalid: '兼容声明版本形态异常（{required}），已拒绝',
}

const EN: AppUpdateLabels = {
  title: 'Version update',
  check: 'Check for updates',
  checking: 'Checking…',
  upToDate: 'Up to date (v{version})',
  available: 'v{version} available; update it in App Management',
  incompatible: 'v{version} found, but it is incompatible with this platform',
  failed: 'Update check failed, try again later',
  unsupported: 'Update check is not available on this platform',
  reasonNoCompat:
    'The release lacks a compatibility declaration (legacy format); compatibility cannot be confirmed',
  reasonMountContract: 'Requires mount contract {required}; this platform is {current}',
  reasonHostRuntime:
    'Requires host runtime {required}; this platform is {current}. Upgrade the platform first',
  reasonHostRuntimeInvalid: 'Malformed compatibility version ({required}); refused',
}

const text = computed<AppUpdateLabels>(() => {
  const isZh = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
  return { ...(isZh ? ZH : EN), ...(props.labels ?? {}) }
})

const {
  status,
  latestVersion,
  currentVersion,
  reason,
  checking,
  supported,
  check: runCheck,
} = useAppUpdate({ check: props.check })

const versionLabel = computed(() => {
  const v = props.currentVersion || currentVersion.value
  return v ? `v${v}` : ''
})

function fill(template: string, params: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? '')
}

const statusLabel = computed(() => {
  if (!supported.value) return text.value.unsupported
  switch (status.value) {
    case 'checking':
      return text.value.checking
    case 'up-to-date':
      return fill(text.value.upToDate, {
        version: latestVersion.value || currentVersion.value || '',
      })
    case 'available':
      return fill(text.value.available, { version: latestVersion.value || '' })
    case 'incompatible':
      return fill(text.value.incompatible, { version: latestVersion.value || '' })
    case 'error':
      return text.value.failed
    default:
      return ''
  }
})

const isBad = computed(() => status.value === 'error' || status.value === 'incompatible')

const reasonLabel = computed(() => {
  const r = reason.value
  if (!r) return ''
  const params = { ...(r.params ?? {}), version: latestVersion.value }
  if (r.key.endsWith('noCompat')) return text.value.reasonNoCompat
  if (r.key.endsWith('mountContract')) return fill(text.value.reasonMountContract, params)
  if (r.key.endsWith('hostRuntimeInvalid')) return fill(text.value.reasonHostRuntimeInvalid, params)
  if (r.key.endsWith('hostRuntime')) return fill(text.value.reasonHostRuntime, params)
  return ''
})

function onCheck(): void {
  void runCheck()
}

defineExpose({ check: runCheck })
</script>

<style scoped>
.wasmnest-update {
  border: 1px solid var(--mobile-border, var(--border, rgba(127, 127, 127, 0.28)));
  background: var(--mobile-bg-card, var(--bg-card, transparent));
  border-radius: var(--mobile-radius-lg, 12px);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wasmnest-update__row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.wasmnest-update__main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.wasmnest-update__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--mobile-text-primary, var(--text-primary, inherit));
}

.wasmnest-update__version {
  font-size: 12px;
  color: var(--mobile-text-secondary, var(--text-secondary, #888));
  font-variant-numeric: tabular-nums;
}

.wasmnest-update__button {
  flex-shrink: 0;
  min-height: var(--mobile-touch-target-min, 32px);
  padding: 0 12px;
  border-radius: var(--mobile-radius-md, 8px);
  border: 1px solid var(--mobile-border, var(--border, rgba(127, 127, 127, 0.28)));
  background: transparent;
  color: var(--mobile-accent, var(--brand, #4f8cff));
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s ease;
}

.wasmnest-update__button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.wasmnest-update__status {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--mobile-text-secondary, var(--text-secondary, #888));
}

.wasmnest-update__status.is-available {
  color: var(--mobile-accent, var(--brand, #4f8cff));
}

.wasmnest-update__status.is-error {
  color: var(--mobile-error, var(--danger, #e5484d));
}
</style>
