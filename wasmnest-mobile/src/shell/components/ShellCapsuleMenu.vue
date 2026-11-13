<template>
  <ShellSheet
    :open="appId !== null"
    :title="app?.name ?? t('shell.capsule.title')"
    @close="overlays.closeCapsule()"
  >
    <ShellGroupCard>
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="flex items-center gap-3 w-full px-3 py-3 text-left transition-colors duration-200 min-h-[var(--mobile-touch-target-min)]"
        :class="item.danger ? 'active:bg-[var(--mobile-error-muted)]' : 'active:bg-[var(--mobile-group-row-active)]'"
        @click="select(item)"
      >
        <svg class="flex-shrink-0" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" :style="{ color: item.danger ? 'var(--mobile-error)' : 'var(--mobile-text-secondary)' }">
          <path :d="item.icon" />
        </svg>
        <span class="flex-1 min-w-0 shell-type-label truncate" :class="item.danger ? 'text-[var(--mobile-error)]' : 'text-[var(--mobile-text-primary)]'">
          {{ item.label }}
        </span>
      </button>
    </ShellGroupCard>

    <template #footer>
      <button
        type="button"
        class="w-full rounded-[10px] border border-[var(--mobile-border)] px-4 py-3 shell-type-label text-[var(--mobile-text-secondary)] transition-colors duration-200 active:bg-[var(--mobile-accent-muted)] min-h-[var(--mobile-touch-target-min)]"
        @click="overlays.closeCapsule()"
      >
        {{ t('shell.common.cancel') }}
      </button>
    </template>
  </ShellSheet>
</template>

<script setup lang="ts">
/**
 * 胶囊菜单
 *
 * 平台项与应用项在同一张卡里按 order 混排：平台项自带 order（权限 10 / 停用 30），
 * 应用可用中间值插入。这是平台控制项与应用自定义项唯一的协作面。
 *
 * 标题用应用名而不是「应用」：菜单已经画在该应用的胶囊下方，再写一遍「应用」
 * 等于没说；也不写「与小程序胶囊一致」这类方案期说明（2026-10-14 修订：宿主
 * 文案只留事实与后果）。
 *
 * 自读覆盖层状态（不接 props）：胶囊只有一个实例、由壳根统一渲染，
 * 再往下传 appId 只是把同一份状态抄一遍。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useShellApps } from '../composables/useShellApps'
import { openShellApp } from '../composables/useShellOpen'
import { useShellNavigation } from '../composables/useShellNavigation'
import { useShellOverlays } from '../composables/useShellOverlays'
import { isServiceKind } from '../utils'
import ShellGroupCard from './ShellGroupCard.vue'
import ShellSheet from './ShellSheet.vue'

interface CapsuleEntry {
  id: string
  label: string
  icon: string
  order: number
  /** 破坏性项（停用）：红字 + 红按压底，与普通菜单项视觉区分 */
  danger?: boolean
  run: () => void | Promise<void>
}

const { t } = useI18n()
const nav = useShellNavigation()
const overlays = useShellOverlays()
const { apps, getApp, stop } = useShellApps()

const appId = computed(() => overlays.capsuleAppId.value)
const app = computed(() => (appId.value ? getApp(appId.value) : undefined))

/**
 * 全局入口（票 04 / spec §4.3）：manifest 声明 contributes.globalEntries 且持有
 * ui:globalEntry 权限的应用，在胶囊菜单平台项之前插入入口。
 * 隐藏条件：未启用 / 上次启动失败（state=error）/ 未声明 globalEntries /
 * 未持有 ui:globalEntry。
 */
const globalEntries = computed(() => {
  const result = []
  for (const a of apps.value) {
    // 隐藏条件：被停用 / 启动失败 / 未声明 globalEntries / 未持有 ui:globalEntry
    // （移动壳的「停用」就是 state = disabled，没有独立的 enabled 字段）
    if (a.state === 'disabled') continue
    if (a.state === 'error') continue
    if (!a.contributions.globalEntries || a.contributions.globalEntries.length === 0) continue
    const grants = a.permissions ?? []
    const hasGlobalEntry = grants.some(
      (g) => typeof g === 'object' && g !== null && 'key' in g && g.key === 'ui:globalEntry',
    )
    if (!hasGlobalEntry) continue
    for (const entry of a.contributions.globalEntries) {
      result.push({
        id: `global:${a.id}/${entry.id}`,
        label: entry.title,
        icon: 'M13 2 3 14h9l-1 8 10-12h-9l1-8Z', // bolt
        order: entry.order ?? 5, // 平台项之前（order < 10）
        run: async () => {
          overlays.closeCapsule()
          // 走壳统一「启动 + 进运行面」收口（openShellApp）：不得用裸 launch——
          // 那样只启动不导航，且失败返回值被丢弃（票 04「点击经 openApp 进全屏」）。
          const ok = await openShellApp(a.id)
          if (!ok) {
            // 启动失败的具体原因已由 launch → lastError + 失败通知暴露，
            // 这里不重复弹窗，也不假装成功（不回退成 closeCapsule 后就结束）
            return
          }
        },
      })
    }
  }
  return result.sort((a, b) => a.order - b.order)
})

const items = computed<CapsuleEntry[]>(() => {
  const id = appId.value
  if (!id) return []

  // 全局入口在平台项之前（order < 10）
  const globalItems = globalEntries.value

  const platformItems: CapsuleEntry[] = [
    {
      id: 'platform:permissions',
      label: t('shell.capsule.permissions'),
      icon: 'M12 3l8 3v6c0 4.5-3.2 7.6-8 9-4.8-1.4-8-4.5-8-9V6l8-3z M9 12l2 2 4-4',
      order: 10,
      run: () => {
        overlays.closeCapsule()
        nav.openDetail(id)
      },
    },
    {
      id: 'platform:disable',
      // 停止动作按装配角色分词语：系统服务说「停止服务」（2026-10-23 用户裁决）
      label: isServiceKind(app.value?.kind)
        ? t('shell.capsule.disableService')
        : t('shell.capsule.disable'),
      icon: 'M12 4V2m0 20v-2M4 12H2m20 0h-2 M12 7a5 5 0 100 10 5 5 0 000-10z M15.5 8.5L20 4M8.5 15.5L4 20',
      order: 30,
      danger: true,
      run: async () => {
        overlays.closeCapsule()
        await stop(id)
      },
    },
  ]

  // 应用贡献项：wasm-app 可用 order 插在平台项之间（如 20 即位于权限与停用之间）
  const appItems: CapsuleEntry[] = (app.value?.contributions.capsuleItems ?? []).map((item) => ({
    id: `app:${item.id}`,
    label: item.label,
    icon: item.icon ?? 'M12 8h.01 M12 11v5 M12 21a9 9 0 100-18 9 9 0 000 18z',
    order: item.order ?? 100,
    run: async () => {
      overlays.closeCapsule()
      await item.onSelect?.(id)
    },
  }))

  return [...globalItems, ...platformItems, ...appItems].sort((a, b) => a.order - b.order)
})

async function select(item: CapsuleEntry): Promise<void> {
  await item.run()
}
</script>
