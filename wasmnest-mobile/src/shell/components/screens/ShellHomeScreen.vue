<template>
  <!--
    平台主屏
    --------------------------------------------------------------------------
    对齐桌面方案 C 的主屏语义（运行卡片带 + 应用宫格 + 系统宫格），落到 Android
    启动器的形态上：壁纸由壳根提供（宿主所有屏共用）、图标宫格、系统入口与应用同层。
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

      <!-- ======== 系统宫格（平台自有面，与应用同层） ======== -->
      <ShellSection :title="t('shell.home.sysTitle')" class="shell-reveal shell-text-over-wall" :style="{ animationDelay: '240ms' }" />
      <div class="px-4">
        <div class="grid grid-cols-4 gap-3 shell-reveal" role="list" :style="{ animationDelay: '280ms' }">
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
              <!-- 实心块面图形（启动器风格）：fill + fill-rule=evenodd——
                   apps 是四个独立圆角方；permissions/settings 用同一 d 里的相反
                   子路径「挖」出对勾与中心孔，跟 wasm 应用图标同一套语言 -->
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true">
                <path :d="entry.icon" />
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
 * 头部多任务入口是平台导航，系统宫格是平台自有面。新增应用不需要改本文件。
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

/** 宿主系统级服务：只进系统宫格，不进应用宫格（2026-10-23 用户裁决） */
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
 * 系统宫格：平台自有面（应用管理 / 权限管理 / 设置），全部 push 进栈以便返回。
 *
 * 图标为启动器风格实心块面（对齐 wasm 应用图标 icon.svg 的语言：满幅渐变瓦片 +
 * 实心块面图形）；底板与图形色由 shell.css 的 .shell-sys-tile 按 entry.id 取用，
 * 这里只留图形 path 与行为，不再逐处拼 tile 样式。
 * 三枚图形同为 24×24 画框、fill 风格、fill-rule=evenodd：apps 是四个独立圆角方
 * （无挖空）；permissions 的盾与对勾、settings 的齿轮与中心孔各为同一 d 内一正
 * 一反两个子路径，靠 evenodd 挖空，不必为镂空单独引 mask。
 */
/** 宿主系统级服务在系统宫格的实心图形（启动器语言：fill + fill-rule=evenodd） */
const SERVICE_GLYPHS: Record<
  string,
  { id: string; labelKey: string | null; glyph: string }
> = {
  // 认证中心：锁（锁梁 + 锁体 + 挖锁孔）——本机入站裁决者的“信任/凭证”语义
  'com.wasmnest.auth-center': {
    id: 'auth-center',
    labelKey: 'shell.home.sysAuthCenter',
    glyph:
      'M9.6 11.4 V8.4 A2.4 2.4 0 0 1 14.4 8.4 V11.4 Z M6.8 11.4 H17.2 V18.2 A2 2 0 0 1 15.2 20.2 H8.8 A2 2 0 0 1 6.8 18.2 Z M10.9 13.9 A1.1 1.1 0 0 1 13.1 13.9 V15.7 A1.1 1.1 0 0 1 10.9 15.7 Z',
  },
  // 运行监控：仪表盘（外环挖孔 + 指针 + 轴孔）——实时运行时指标
  'com.wasmnest.monitor': {
    id: 'monitor',
    labelKey: 'shell.home.sysMonitor',
    glyph:
      'M12 3.2 A8.8 8.8 0 1 1 3.2 12 A8.8 8.8 0 0 1 12 3.2 Z M12 6.6 A5.4 5.4 0 1 0 17.4 12 A5.4 5.4 0 0 0 12 6.6 Z M11 12.5 L15.8 7.8 L13.5 13.1 Z M11.3 12 A0.7 0.7 0 1 1 12.7 12 A0.7 0.7 0 1 1 11.3 12 Z',
  },
}

/** 未知系统服务的回退图形（通用星形）与插件名 */
const GENERIC_SERVICE_GLYPH =
  'M12 4 13.6 9.2 19.2 9.2 14.7 12.6 16.3 17.8 12 14.4 7.7 17.8 9.3 12.6 4.8 9.2 10.4 9.2 Z'

/**
 * 系统宫格：宿主系统页（应用管理 / 权限管理 / 设置）在前，宿主系统级服务
 * 追加在后。系统服务只在装配存在时出现（注册表投影），不硬编码常驻。
 * 服务瓦片图形按插件 id 取用，未知服务回退通用图形 + 插件名。
 */
const sysEntries = computed(() => {
  const services = apps.value
    .filter((app) => isServiceKind(app.kind))
    .map((app) => {
      const meta = SERVICE_GLYPHS[app.id]
      return {
        id: meta?.id ?? app.id,
        label: meta?.labelKey ? t(meta.labelKey) : app.name,
        icon: meta?.glyph ?? GENERIC_SERVICE_GLYPH,
        run: () => open(app.id),
      }
    })
  return [
    {
      id: 'apps',
      label: t('shell.home.sysApps'),
      // 2×2 圆角方阵（应用格）：方 7.4、缝 2.4、圆角 2.2，占画框 ~72%
      icon: 'M5.6 3.4 H8.6 A2.2 2.2 0 0 1 10.8 5.6 V8.6 A2.2 2.2 0 0 1 8.6 10.8 H5.6 A2.2 2.2 0 0 1 3.4 8.6 V5.6 A2.2 2.2 0 0 1 5.6 3.4 Z M15.4 3.4 H18.4 A2.2 2.2 0 0 1 20.6 5.6 V8.6 A2.2 2.2 0 0 1 18.4 10.8 H15.4 A2.2 2.2 0 0 1 13.2 8.6 V5.6 A2.2 2.2 0 0 1 15.4 3.4 Z M5.6 13.2 H8.6 A2.2 2.2 0 0 1 10.8 15.4 V18.4 A2.2 2.2 0 0 1 8.6 20.6 H5.6 A2.2 2.2 0 0 1 3.4 18.4 V15.4 A2.2 2.2 0 0 1 5.6 13.2 Z M15.4 13.2 H18.4 A2.2 2.2 0 0 1 20.6 15.4 V18.4 A2.2 2.2 0 0 1 18.4 20.6 H15.4 A2.2 2.2 0 0 1 13.2 18.4 V15.4 A2.2 2.2 0 0 1 15.4 13.2 Z',
      run: () => nav.navigate('apps'),
    },
    {
      id: 'permissions',
      label: t('shell.home.sysPermissions'),
      // 盾（整块）+ 对勾（加粗折线的偏移多边形，靠 evenodd 挖空）：折线过 (8.6,11.7)→(10.9,14.1)→(15.6,9.2)
      icon: 'M12 2.6 L19.8 5.4 V11.6 C19.8 16.4 16.5 20 12 21.8 C7.5 20 4.2 16.4 4.2 11.6 V5.4 Z M7.84 12.43 L10.14 14.83 L11.66 14.83 L16.36 9.93 L14.84 8.47 L10.14 13.37 L11.66 13.37 L9.36 10.97 Z',
      run: () => nav.openPermissions(),
    },
    {
      id: 'settings',
      label: t('shell.home.sysSettings'),
      // 八齿齿轮 + 中心孔（同为相反子路径挖空）：齿顶 r9.4 / 齿根 r7.2 / 齿半角 10.5° / 孔 r3.6
      icon: 'M9.24 5.35 L9.96 5.1 L10.69 4.92 L11.43 2.62 L12.57 2.62 L13.71 2.76 L14.04 5.1 L14.76 5.35 L15.44 5.67 L16.08 6.07 L18.23 4.96 L19.04 5.77 L19.75 6.68 L18.33 8.56 L18.65 9.24 L18.9 9.96 L19.08 10.69 L21.38 11.43 L21.38 12.57 L21.24 13.71 L18.9 14.04 L18.65 14.76 L18.33 15.44 L17.93 16.08 L19.04 18.23 L18.23 19.04 L17.32 19.75 L15.44 18.33 L14.76 18.65 L14.04 18.9 L13.31 19.08 L12.57 21.38 L11.43 21.38 L10.29 21.24 L9.96 18.9 L9.24 18.65 L8.56 18.33 L7.92 17.93 L5.77 19.04 L4.96 18.23 L4.25 17.32 L5.67 15.44 L5.35 14.76 L5.1 14.04 L4.92 13.31 L2.62 12.57 L2.62 11.43 L2.76 10.29 L5.1 9.96 L5.35 9.24 L5.67 8.56 L6.07 7.92 L4.96 5.77 L5.77 4.96 L6.68 4.25 L8.56 5.67 L9.24 5.35 Z M8.4 12 A3.6 3.6 0 1 1 15.6 12 A3.6 3.6 0 1 1 8.4 12 Z',
      run: () => nav.navigate('settings'),
    },
    ...services,
  ]
})
</script>
