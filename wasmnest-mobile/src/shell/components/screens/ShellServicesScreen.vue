<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- ==================== 页头（系统宫格进入的屏，不是栈底） ==================== -->
    <header class="flex items-center gap-2 px-2 pt-2 pb-1">
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
      <div class="flex-1 min-w-0">
        <h1 class="shell-type-display truncate">
          {{ t('shell.services.title') }}
        </h1>
        <p class="shell-type-caption text-[var(--mobile-text-secondary)] truncate">
          {{ t('shell.services.subtitle') }}
        </p>
      </div>
    </header>

    <div class="flex-1 min-h-0 overflow-y-auto pb-6 shell-content-cap">
      <!-- 指标条：服务总数 / 运行中（零值是中性事实，不染绿） -->
      <div class="px-4 pb-1">
        <div
          class="flex items-center gap-2 rounded-[12px] border border-[var(--mobile-group-border)] bg-[var(--mobile-bg-card)] px-3.5 py-3"
          :style="{ boxShadow: 'var(--mobile-card-shadow)' }"
        >
          <span class="flex items-baseline gap-1.5 min-w-0">
            <b class="shell-type-label tabular-nums text-[var(--mobile-text-primary)]">{{ services.length }}</b>
            <span class="shell-type-caption text-[var(--mobile-text-secondary)] truncate">
              {{ t('shell.services.statTotal') }}
            </span>
          </span>
          <span class="shell-type-micro text-[var(--mobile-text-muted)]" aria-hidden="true">·</span>
          <span class="flex items-baseline gap-1.5 min-w-0">
            <b
              class="shell-type-label tabular-nums"
              :style="{ color: runningCount > 0 ? 'var(--mobile-success)' : 'var(--mobile-text-primary)' }"
            >{{ runningCount }}</b>
            <span class="shell-type-caption text-[var(--mobile-text-secondary)] truncate">
              {{ t('shell.apps.statRunning') }}
            </span>
          </span>
        </div>
      </div>

      <!-- ==================== 服务卡片列（点击行 = 进入对应服务运行入口） ==================== -->
      <ShellSection :title="t('shell.apps.systemServices')" data-testid="mobile-shell-services-group" />
      <div class="px-4 pb-1">
        <ShellGroupCard>
          <div
            v-for="app in services"
            :key="app.id"
            class="flex items-center transition-colors duration-200 active:bg-[var(--mobile-group-row-active)]"
            :data-testid="`mobile-shell-services-card-${app.id}`"
          >
            <!-- 主入口：点整行进入服务（open 会先确保运行，再进运行面；待审批转详情） -->
            <button
              type="button"
              class="flex flex-1 min-w-0 items-center gap-3 px-3 py-3 text-left min-h-[var(--mobile-touch-target-min)]"
              :aria-label="t('shell.services.open', { name: app.name })"
              @click="void open(app.id)"
            >
              <ShellAppIcon :app="app" :size="40" />
              <span class="flex-1 min-w-0">
                <span class="flex items-center gap-1.5">
                  <b class="shell-type-label text-[var(--mobile-text-primary)] truncate">{{ app.name }}</b>
                  <ShellChip
                    v-if="app.state === 'running'"
                    :label="t('shell.common.running')"
                    tone="success"
                  />
                  <ShellChip
                    v-else-if="app.state === 'approval'"
                    :label="t('shell.common.approval')"
                    tone="danger"
                  />
                  <ShellChip
                    v-else-if="app.state === 'error'"
                    :label="t('shell.common.error')"
                    tone="danger"
                  />
                </span>
                <span class="block shell-type-caption text-[var(--mobile-text-secondary)] truncate">
                  {{ t('shell.services.openHint') }}
                </span>
              </span>
            </button>
            <!-- 管理入口：停止权限等仍在应用详情页（详情页按 kind 隐藏卸载入口） -->
            <button
              type="button"
              class="flex items-center justify-center rounded-[10px] min-w-[var(--mobile-touch-target-min)] min-h-[var(--mobile-touch-target-min)] mr-1 transition-colors duration-200 active:bg-[var(--mobile-accent-muted)]"
              :aria-label="t('shell.services.detail', { name: app.name })"
              @click="nav.openDetail(app.id)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" :style="{ color: 'var(--mobile-text-secondary)' }">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          </div>
        </ShellGroupCard>
      </div>

      <div v-if="services.length === 0" class="px-4 pb-1">
        <p
          class="rounded-[12px] border border-dashed border-[var(--mobile-border-hover)] px-3 py-5 text-center shell-type-caption text-[var(--mobile-text-secondary)]"
        >
          {{ t('shell.services.empty') }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 服务管理（移动壳）
 *
 * 服务型 wasm（basic-service / internal-business）的唯一管理与入口面：2026-11-20
 * 从「应用管理」服务分组 + 主屏服务宫格迁入。点服务卡片 = 进入对应运行入口；
 * 停止 / 权限等管理动作沿用应用详情页（那里已按 kind 隐藏卸载）。
 * 服务清单只按 manifest kind 判定，不硬编码插件 id；排序 L1 → L2 → 名称。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useShellApps } from '../../composables/useShellApps'
import { useShellNavigation } from '../../composables/useShellNavigation'
import { useShellOpen } from '../../composables/useShellOpen'
import { isServiceKind } from '../../utils'
import ShellAppIcon from '../ShellAppIcon.vue'
import ShellChip from '../ShellChip.vue'
import ShellGroupCard from '../ShellGroupCard.vue'
import ShellSection from '../ShellSection.vue'

const { t } = useI18n()
const nav = useShellNavigation()
const { open } = useShellOpen()
const { sortedApps } = useShellApps()

const services = computed(() =>
  sortedApps.value
    .filter((app) => isServiceKind(app.kind))
    .sort((a, b) => {
      const rank = (kind?: string) => (kind === 'basic-service' ? 0 : 1)
      return rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, 'zh-Hans-CN')
    }),
)

const runningCount = computed(() => services.value.filter((app) => app.state === 'running').length)
</script>
