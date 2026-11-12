<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- ==================== 页头（带返回：系统宫格进入的屏，不是栈底） ==================== -->
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
      <h1 class="shell-type-display truncate">
        {{ t('shell.settings.title') }}
      </h1>
    </header>

    <div class="flex-1 min-h-0 overflow-y-auto pb-6 shell-content-cap">
      <!-- ==================== 导航 ==================== -->
      <ShellSection :title="t('shell.settings.navigation')" />
      <div class="px-4 pb-1">
        <ShellGroupCard>
          <div class="flex items-center gap-3 px-3 py-3 min-h-[var(--mobile-touch-target-min)]">
            <svg class="flex-shrink-0" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" :style="{ color: 'var(--mobile-text-secondary)' }" aria-hidden="true">
              <path d="M6 8.5h12a3 3 0 0 1 0 6H6a3 3 0 0 1 0-6z" />
              <path d="M9.5 11.5h.01M12 11.5h.01M14.5 11.5h.01" />
            </svg>
            <div class="flex-1 min-w-0">
              <div class="shell-type-label text-[var(--mobile-text-primary)]">
                {{ t('shell.settings.floatingNavLabel') }}
              </div>
              <div class="shell-type-caption text-[var(--mobile-text-secondary)]">
                {{ t('shell.settings.floatingNavHint') }}
              </div>
            </div>
            <!-- 开关只作用于悬浮条；行文字不做点击面（避免与 label 嵌套产生双触发） -->
            <Toggle
              class="-m-3 p-3"
              :model-value="floatingNav"
              :aria-label="t('shell.settings.floatingNavLabel')"
              @update:model-value="setFloatingNav"
            />
          </div>
        </ShellGroupCard>
      </div>

      <!-- ==================== 平台 ==================== -->
      <ShellSection :title="t('shell.settings.platform')" />
      <div class="px-4 pb-1">
        <ShellGroupCard>
          <button
            v-for="entry in platformEntries"
            :key="entry.id"
            type="button"
            class="flex items-center gap-3 w-full px-3 py-3 text-left transition-colors duration-200 active:bg-[var(--mobile-group-row-active)] min-h-[var(--mobile-touch-target-min)]"
            @click="entry.onSelect()"
          >
            <svg class="flex-shrink-0" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" :style="{ color: 'var(--mobile-text-secondary)' }">
              <path :d="entry.icon" />
            </svg>
            <span class="flex-1 min-w-0 shell-type-label text-[var(--mobile-text-primary)] truncate">
              {{ entry.label }}
            </span>
            <span v-if="entry.hint" class="flex-shrink-0 shell-type-caption text-[var(--mobile-text-secondary)] truncate">
              {{ entry.hint }}
            </span>
          </button>
        </ShellGroupCard>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 我的 / 平台设置
 *
 * 平台项是壳自带的（权限总览 / 外观 / 关于）；应用设置一律由应用自持——
 * 2026-10-25 用户裁决：宿主设置页不再陈列应用贡献项，registerSettingsEntry
 * 贡献面随之在移动端整面退役（防回接见 retiredHostUIRetirementLocks R8）。
 *
 * 三条 2026-10-14 修订：
 *   ① 「连接」「认证」入口从这里删除——连接与凭据归各应用自持，不是宿主面；
 *   ② 「危险操作（清除所有数据）」迁入「关于 WasmNest」——它是设备生命周期动作，
 *      与版本/更新同属「关于本机」，一级设置页不再摆一排红按钮；
 *   ③ 票 2026-10-10 批次 C4：业务设置入口（连接策略 / 通知）随真源下沉 bedcode 应用
 *      从本表删除——壳只留平台机制与安全闸门，避免同一个开关在壳与应用各存一份真值。
 *   ④ 2026-10-27：「导航」分组新增悬浮导航开关（默认关闭；开启后在任意页面常驻，
 *      位置可拖动并持久化），见 App.vue 的挂载说明。
 *
 * 2026-10-27：顶部「本机 · 平台 / 版本」标识卡删除（用户裁决：本机信息无信息量）；
 * 版本号只在「关于」入口的 hint 里保留一处。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useShellNavigation } from '../../composables/useShellNavigation'
import { useShellPreferences } from '../../composables/useShellPreferences'
import ShellGroupCard from '../ShellGroupCard.vue'
import ShellSection from '../ShellSection.vue'
import Toggle from '../ui/Toggle.vue'

/** 平台设置项（壳自带） */
interface PlatformEntry {
  id: string
  label: string
  hint?: string
  icon: string
  onSelect: () => void
}

const { t } = useI18n()
const router = useRouter()
const nav = useShellNavigation()
// 悬浮导航是壳的视觉偏好（localStorage），不写宿主 AppConfig（与壁纸同口径）
const { floatingNav, setFloatingNav } = useShellPreferences()




/** 版本号来自构建期注入（与设置页同源，不另立真源） */
const appVersion = __APP_VERSION__

const platformEntries = computed<PlatformEntry[]>(() => [
  {
    id: 'appearance',
    label: t('shell.settings.appearance'),
    hint: t('shell.settings.appearanceHint'),
    icon: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4 M12 8a4 4 0 100 8 4 4 0 000-8z',
    // 外观沿用既有设置页：壳不与既有实现重复造一套主题配置
    onSelect: () => router.push({ name: 'mobile-settings-appearance' }),
  },
  {
    id: 'permissions',
    label: t('shell.settings.permissions'),
    hint: t('shell.settings.permissionsHint'),
    icon: 'M12 3l8 3v6c0 4.5-3.2 7.6-8 9-4.8-1.4-8-4.5-8-9V6l8-3z M9 12l2 2 4-4',
    onSelect: () => nav.openPermissions(),
  },
  {
    id: 'about',
    label: t('shell.settings.about'),
    hint: `v${appVersion}`,
    icon: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 8h.01 M12 11v5',
    onSelect: () => router.push({ name: 'mobile-settings-about' }),
  },
])
</script>
