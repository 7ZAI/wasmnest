<template>
  <!--
    平台主屏
    --------------------------------------------------------------------------
    对齐桌面方案 C 的主屏语义（应用宫格 + 服务宫格 + 系统宫格），落到 Android
    启动器的形态上：壁纸由壳根提供（宿主所有屏共用）、图标宫格、服务与系统入口
    同层排布。
    内容层单独滚动。
  -->
  <div class="relative flex flex-col h-full min-h-0">
    <!-- ==================== 头部 ==================== -->
    <header class="relative z-10 flex items-center gap-3 px-4 pt-3 pb-2 flex-shrink-0">
      <ShellBrandTile :size="38" />
      <!-- shell-text-over-wall：标题直接压在壁纸上（无卡面），壁纸亮度不可控，
           靠一层底色描边保证对比度（text-shadow 可继承，包住标题即可，
           不挂到整个 header 上——铃铛角标有自己的实色底，不需要描边） -->
      <div class="shell-text-over-wall flex-1 min-w-0">
        <div class="shell-type-title">
          WasmNest
        </div>
      </div>
      <!-- 多任务入口：与右侧铃铛同档（44px 触达区、无卡面），左邻铃铛；
           系统底部导航条退役后，主屏从这里进入多任务。 -->
      <button
        type="button"
        class="flex items-center justify-center rounded-[10px] min-w-[var(--mobile-touch-target-min)] min-h-[var(--mobile-touch-target-min)] transition-colors duration-200 active:bg-[var(--mobile-accent-muted)]"
        :aria-label="t('shell.switcher.title')"
        @click="nav.openSwitcher()"
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="7" y="3" width="14" height="14" rx="3" />
          <path d="M3 7v10a4 4 0 004 4h10" />
        </svg>
      </button>
      <!-- 通知入口（主入口，44px）：状态条上还有一条（系统状态栏占位时不渲染） -->
      <button
        type="button"
        class="relative flex items-center justify-center rounded-[10px] min-w-[var(--mobile-touch-target-min)] min-h-[var(--mobile-touch-target-min)] transition-colors duration-200 active:bg-[var(--mobile-accent-muted)]"
        :aria-label="t('shell.notify.open', { count: badgeCount })"
        @click="overlays.toggleShade()"
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
          <path d="M10.3 21a2 2 0 0 0 3.4 0" />
        </svg>
        <span
          v-if="badgeCount > 0"
          class="absolute top-1 right-1 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[10px] font-semibold leading-none"
          :style="{ background: 'var(--mobile-error)', color: 'var(--mobile-text-on-accent)' }"
          aria-hidden="true"
        >
          {{ badgeCount > 99 ? '99+' : badgeCount }}
        </span>
      </button>
    </header>

    <!-- ==================== 内容 ==================== -->
    <div class="relative z-10 flex-1 min-h-0 overflow-y-auto pb-6 shell-content-cap">
      <!-- ======== 快捷卡片（应用贡献，横向轮播） ========
           定宽卡片 + 原生 scroll-snap 横向滚动（原型 .slots 同形态）：拍一屏只露一张，
           滑动切下一张。定宽而非 flex-1 是刻意的——卡片内容由应用自持，等宽拉伸会让
           单行信息量不同的卡片看起来参差。 -->
      <template v-if="slotCards.length > 0">
        <ShellSection :title="t('shell.home.slotsTitle')" class="shell-reveal shell-text-over-wall" :style="{ animationDelay: '80ms' }" />
        <div class="shell-slot-track shell-reveal" role="list" :style="{ animationDelay: '120ms' }">
          <div v-for="card in slotCards" :key="card.key" class="shell-slot-item" role="listitem">
            <component :is="card.component" :app="card.app" />
          </div>
        </div>
      </template>

      <!-- ======== 应用宫格 ======== -->
      <!-- 分组头只留「应用」：管理入口已在系统宫格「应用管理」占同层位置，
           行尾再放一个图标是重复入口，且抢掉标题行的视觉重心（用户 2026-10-20 反馈删除）；
           计数文案同为该反馈要求删除的内容，标题行不再承载任何附加信息。 -->
      <ShellSection
        :title="t('shell.home.appsTitle')"
        class="shell-reveal shell-text-over-wall"
        :style="{ animationDelay: '160ms' }"
      />
      <div class="px-4">
        <!-- gap-3 = 12px：ui-ux-pro-max `--domain ux / Touch Spacing` 要求相邻触控目标
     间距 ≥8px，原 gap-1(4px) 既低于门槛、又让四列图标挤成一团。 -->
        <div v-if="businessApps.length > 0" class="grid grid-cols-4 gap-3 shell-reveal" role="list" :style="{ animationDelay: '200ms' }">
          <ShellAppCell v-for="app in businessApps" :key="app.id" :app="app" @open="open" />
        </div>
        <!-- 空态给出下一步（安装入口在应用管理页），而不是只留一句「暂无应用」 -->
        <p
          v-else
          class="rounded-[12px] border border-dashed border-[var(--mobile-border-hover)] px-3 py-5 text-center shell-type-caption text-[var(--mobile-text-secondary)]"
        >
          {{ t('shell.home.emptyAppsHint') }}
        </p>
      </div>

      <!-- ======== 服务宫格（宿主系统级服务，与应用 / 系统同层） ======== -->
      <template v-if="serviceEntries.length > 0">
        <ShellSection :title="t('shell.home.servicesTitle')" class="shell-reveal shell-text-over-wall" :style="{ animationDelay: '240ms' }" />
        <div class="px-4">
          <div class="grid grid-cols-4 gap-3 shell-reveal" role="list" :style="{ animationDelay: '280ms' }">
            <button
              v-for="entry in serviceEntries"
              :key="entry.id"
              type="button"
              class="flex flex-col items-center gap-1.5 py-2 rounded-[12px] transition-colors duration-200 active:bg-[var(--mobile-accent-muted)]"
              :aria-label="entry.label"
              role="listitem"
              @click="entry.run()"
            >
              <span class="shell-sys-tile" :data-tile="entry.id" aria-hidden="true">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.55"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path v-for="d in entry.icon" :key="d" :d="d" />
                </svg>
              </span>
              <span class="w-full text-center shell-type-caption shell-type-clamp-2 font-medium text-[var(--mobile-text-primary)]">
                {{ entry.label }}
              </span>
            </button>
          </div>
        </div>
      </template>

      <!-- ======== 系统宫格（平台自有面，与应用同层） ======== -->
      <ShellSection :title="t('shell.home.sysTitle')" class="shell-reveal shell-text-over-wall" :style="{ animationDelay: '320ms' }" />
      <div class="px-4">
        <div class="grid grid-cols-4 gap-3 shell-reveal" role="list" :style="{ animationDelay: '360ms' }">
          <button
            v-for="entry in sysEntries"
            :key="entry.id"
            type="button"
            class="flex flex-col items-center gap-1.5 py-2 rounded-[12px] transition-colors duration-200 active:bg-[var(--mobile-accent-muted)]"
            :aria-label="entry.label"
            role="listitem"
            @click="entry.run()"
          >
            <span
              class="shell-sys-tile"
              :data-tile="entry.id"
              aria-hidden="true"
            >
              <!-- 与桌面 ShellIcon 同源：24 画框 stroke 线稿（fill=none / 1.55），
                   grid / shield / gear / lock / pulse；未知服务回退 layers -->
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.55"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path v-for="d in entry.icon" :key="d" :d="d" />
              </svg>
            </span>
            <span class="w-full text-center shell-type-caption shell-type-clamp-2 font-medium text-[var(--mobile-text-primary)]">
              {{ entry.label }}
            </span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 平台主屏
 *
 * 主屏是「应用注册表 + 壳偏好的聚合视图」，自身不含业务：快捷卡片由应用注册组件，
 * 头部多任务入口是平台导航，服务宫格是注册表投影，系统宫格是平台自有面。
 * 新增应用 / 服务不需要改本文件。
 *
 * 壁纸与遮罩由壳根（ShellHost）从壳偏好取用并在所有宿主屏铺开，
 * 本屏只负责内容层（不再自持壁纸，否则只有主屏生效）。
 *
 * 正文案纪律（2026-10-14 修订）：分组标题行只留标题与计数，不再写「平台自带」
 * 「由应用提供」「最近使用在前」这类方案期解释——用户看得到事实，不需要旁白。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useShellApps } from '../../composables/useShellApps'
import { useShellNavigation } from '../../composables/useShellNavigation'
import { useShellNotifications } from '../../composables/useShellNotifications'
import { useShellOpen } from '../../composables/useShellOpen'
import { useShellOverlays } from '../../composables/useShellOverlays'
import { isServiceKind } from '../../utils'
import ShellAppCell from '../ShellAppCell.vue'
import ShellBrandTile from '../ShellBrandTile.vue'
import ShellSection from '../ShellSection.vue'

const { t } = useI18n()
const nav = useShellNavigation()
const { apps, sortedApps } = useShellApps()
const { open } = useShellOpen()
const overlays = useShellOverlays()
const { notificationCount } = useShellNotifications()

/** 宿主系统级服务：只进服务宫格，不进应用宫格（2026-10-23 用户裁决） */
const businessApps = computed(() => sortedApps.value.filter((app) => !isServiceKind(app.kind)))

/** 未读计数：通知 + 待审批（与状态条角标同口径） */
const badgeCount = computed(
  () => notificationCount.value + apps.value.filter((a) => a.state === 'approval').length,
)

/** 应用贡献的快捷卡片（按应用顺序展开，排序在 registry 侧完成） */
const slotCards = computed(() =>
  apps.value.flatMap((app) =>
    (app.contributions.slots ?? []).map((slot) => ({
      key: `${app.id}:${slot.id}`,
      component: slot.component,
      app,
    })),
  ),
)

/**
 * 服务 / 系统宫格图标与桌面壳同源：路径逐字取自桌面 ShellIcon（grid / shield /
 * gear / lock / pulse；未知服务回退 layers），以 24 画框 stroke 线稿渲染；瓦片本身
 * 是中性 card 表面 + 1px border（桌面 .tone-system 同口径），不再按入口上色。
 */
const SYSTEM_ICON_PATHS = {
  grid: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
  shield: [
    'M12 3 5 6v5.6c0 4.1 2.9 7.8 7 9.4 4.1-1.6 7-5.3 7-9.4V6l-7-3Z',
    'm8.8 12.2 2.2 2.2 4.1-4.3',
  ],
  gear: [
    'M10.55 5.46L10.01 3.02A9.2 9.2 0 0 1 13.99 3.02L13.45 5.46A6.7 6.7 0 0 1 16.94 7.47L18.78 5.78A9.2 9.2 0 0 1 20.77 9.23L18.39 9.99A6.7 6.7 0 0 1 18.39 14.01L20.77 14.77A9.2 9.2 0 0 1 18.78 18.22L16.94 16.53A6.7 6.7 0 0 1 13.45 18.54L13.99 20.98A9.2 9.2 0 0 1 10.01 20.98L10.55 18.54A6.7 6.7 0 0 1 7.06 16.53L5.22 18.22A9.2 9.2 0 0 1 3.23 14.77L5.61 14.01A6.7 6.7 0 0 1 5.61 9.99L3.23 9.23A9.2 9.2 0 0 1 5.22 5.78L7.06 7.47A6.7 6.7 0 0 1 10.55 5.46Z',
    'M15.4 12a3.4 3.4 0 1 1-6.8 0 3.4 3.4 0 0 1 6.8 0Z',
  ],
  lock: ['M3 11h18v11H3z', 'M7 11V7a5 5 0 0 1 10 0v4'],
  pulse: ['M3.75 12h4.5l2.25-6 3 12 2.25-6h4.5'],
  layers: ['m12 2 9 5-9 5-9-5Z', 'm3 12 9 5 9-5', 'm3 17 9 5 9-5'],
} as const

/** 宿主系统级服务在服务宫格的图形（与桌面同源：认证中心=lock / 运行监控=pulse） */
const SERVICE_GLYPHS: Record<
  string,
  { id: string; labelKey: string | null; icon: readonly string[] }
> = {
  'com.wasmnest.auth-center': {
    id: 'auth-center',
    labelKey: 'shell.home.serviceAuthCenter',
    icon: SYSTEM_ICON_PATHS.lock,
  },
  'com.wasmnest.monitor': {
    id: 'monitor',
    labelKey: 'shell.home.serviceMonitor',
    icon: SYSTEM_ICON_PATHS.pulse,
  },
}

/**
 * 服务宫格：装配角色为系统服务（basic-service / internal-business）的全部应用。
 * 只在装配存在时出现（注册表投影），不硬编码常驻；未来 wasm 服务类型自动落位。
 * 服务图标按插件 id 取用，未知服务回退 layers + 插件名。
 */
const serviceEntries = computed(() =>
  apps.value
    .filter((app) => isServiceKind(app.kind))
    .map((app) => {
      const meta = SERVICE_GLYPHS[app.id]
      return {
        id: meta?.id ?? app.id,
        label: meta?.labelKey ? t(meta.labelKey) : app.name,
        icon: meta?.icon ?? SYSTEM_ICON_PATHS.layers,
        run: () => open(app.id),
      }
    }),
)

/** 系统宫格：宿主系统页（应用管理 / 权限管理 / 设置），全部 push 进栈以便返回。 */
const sysEntries = computed(() => [
  {
    id: 'apps',
    label: t('shell.home.sysApps'),
    icon: SYSTEM_ICON_PATHS.grid,
    run: () => nav.navigate('apps'),
  },
  {
    id: 'permissions',
    label: t('shell.home.sysPermissions'),
    icon: SYSTEM_ICON_PATHS.shield,
    run: () => nav.openPermissions(),
  },
  {
    id: 'settings',
    label: t('shell.home.sysSettings'),
    icon: SYSTEM_ICON_PATHS.gear,
    run: () => nav.navigate('settings'),
  },
])
</script>
