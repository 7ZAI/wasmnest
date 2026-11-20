<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- 与宿主 shell/components/screens/ShellServicesScreen.vue 同构：
         服务卡点击进入运行入口，右侧箭头进详情页（停止 / 权限沿用详情页）。 -->
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
        <h1 class="text-[var(--font-size-lg)] font-semibold text-[var(--mobile-text-primary)] truncate">
          {{ t('shell.services.title') }}
        </h1>
        <p class="text-[var(--font-size-xs)] text-[var(--mobile-text-secondary)] truncate">
          {{ t('shell.services.subtitle') }}
        </p>
      </div>
    </header>

    <div class="flex-1 min-h-0 overflow-y-auto pb-6">
      <ShellSection :title="t('shell.services.systemServices')" />
      <div class="px-4 pb-1">
        <ShellGroupCard v-if="services.length > 0">
          <div
            v-for="app in services"
            :key="app.id"
            class="flex items-center transition-colors duration-200 active:bg-[var(--mobile-group-row-active)]"
          >
            <button
              type="button"
              class="flex flex-1 min-w-0 items-center gap-3 px-3 py-3 text-left min-h-[var(--mobile-touch-target-min)]"
              :aria-label="t('shell.services.open', { name: app.name })"
              @click="void open(app.id)"
            >
              <ShellAppIcon :app="app" :size="40" />
              <span class="flex-1 min-w-0">
                <b class="text-[var(--font-size-base)] text-[var(--mobile-text-primary)] truncate">{{ app.name }}</b>
                <span class="block text-[var(--font-size-xs)] text-[var(--mobile-text-secondary)] truncate">
                  {{ t('shell.services.openHint') }}
                </span>
              </span>
            </button>
            <button
              type="button"
              class="flex items-center justify-center rounded-[10px] min-w-[var(--mobile-touch-target-min)] min-h-[var(--mobile-touch-target-min)] mr-1"
              :aria-label="t('shell.services.detail', { name: app.name })"
              @click="nav.openDetail(app.id)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" :style="{ color: 'var(--mobile-text-secondary)' }">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          </div>
        </ShellGroupCard>
        <p v-else class="rounded-[12px] border border-dashed border-[var(--mobile-border-hover)] px-3 py-5 text-center text-[var(--font-size-xs)] text-[var(--mobile-text-secondary)]">
          {{ t('shell.services.empty') }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/** dev-shell 服务管理（与宿主 shell 同构；独立 npm 包不能 import 宿主源码） */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useShellApps } from '../../composables/useShellApps'
import { useShellNavigation } from '../../composables/useShellNavigation'
import { useShellOpen } from '../../composables/useShellOpen'
import ShellAppIcon from '../ShellAppIcon.vue'
import ShellGroupCard from '../ShellGroupCard.vue'
import ShellSection from '../ShellSection.vue'

const { t } = useI18n()
const nav = useShellNavigation()
const { open } = useShellOpen()
const { sortedApps } = useShellApps()

const isServiceKind = (kind?: string) => kind === 'basic-service' || kind === 'internal-business'
const services = computed(() =>
  sortedApps.value
    .filter((app) => isServiceKind(app.kind))
    .sort((a, b) => {
      const rank = (kind?: string) => (kind === 'basic-service' ? 0 : 1)
      return rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, 'zh-Hans-CN')
    }),
)
</script>
