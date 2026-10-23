<template>
  <div class="flex flex-col h-full min-h-0" @click="onSurfaceClick">
    <!-- ==================== 页头（返回 + 标题 + 数量 + 全部关闭） ==================== -->
    <header class="flex items-center gap-2 px-2 pt-2 pb-1 flex-shrink-0">
      <button
        type="button"
        class="flex items-center justify-center rounded-[10px] min-w-[var(--mobile-touch-target-min)] min-h-[var(--mobile-touch-target-min)] transition-colors duration-200 active:bg-[var(--mobile-accent-muted)]"
        :aria-label="t('shell.switcher.back')"
        @click="nav.back()"
      >
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      <div class="flex items-baseline gap-1.5 flex-1 min-w-0">
        <h1 class="shell-type-display truncate">
          {{ t('shell.switcher.title') }}
        </h1>
        <span
          v-if="cards.length > 0"
          class="flex-shrink-0 shell-type-micro text-[var(--mobile-text-secondary)] tabular-nums"
        >
          {{ cards.length }} {{ t('shell.switcher.countUnit') }}
        </span>
      </div>
      <ShellChip
        v-if="cards.length > 0"
        :label="t('shell.switcher.closeAll')"
        tone="danger"
        clickable
        @click="closeAll"
      />
    </header>

    <!-- ==================== 卡片区（与桌面同形的多行卡片布局） ====================
         桌面多任务是「信息条在上 + 缩略区在下」的 3/4 竖版卡片，按行居中排布；
         移动端沿用同一形态与同一信息层级，只把卡片缩到移动端尺寸：每行 2 张
         （宽屏 3 张），整组上下左右居中，超出时可纵向滚动。

         缩略区仍不伪造应用截图——平台拿不到应用画面，放大应用图标 + 版本 /
         权限数就是平台掌握的全部事实（AGENTS §5.1 B4）。

         手势保留：横向拖动切换当前卡（网格轻微跟手后吸附），上滑关闭单张；
         拖拽不是唯一路径——每张卡都可直接点按进入，右上角另有独立关闭键
         （WCAG 2.2 Dragging Movements）。网格内容溢出时纵向上滑让位给原生
         滚动，否则列表滚不动；此时关闭同样走卡片上的 ×。两种状态都保留
         pinch-zoom，不吞掉系统的双指缩放。 -->
    <template v-if="cards.length > 0">
      <div
        ref="gridEl"
        class="shell-recents-grid flex-1 min-h-0"
        :class="{
          'shell-recents-grid--dragging': dragAxis !== null,
          'shell-recents-grid--scrollable': scrollable,
        }"
        role="list"
        :aria-label="t('shell.switcher.title')"
        :style="{ touchAction: scrollable ? 'pan-y pinch-zoom' : 'pinch-zoom' }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="resetDrag"
      >
        <div class="shell-recents-grid-inner" :style="gridStyle()">
          <article
            v-for="(card, index) in cards"
            :key="card.app.id"
            class="shell-recents-card"
            :class="{ active: index === activeIndex }"
            :style="cardStyle(index)"
            :data-app-id="card.app.id"
            role="listitem"
          >
            <!-- 信息条在卡片顶部（与桌面一致）：图标打头 + 名称；
                 非运行 / 异常状态才追加一行状态文字，运行中不重复播报默认事实。 -->
            <div class="shell-recents-meta" aria-hidden="true">
              <ShellAppIcon :app="card.app" :size="28" />
              <span class="flex-1 min-w-0">
                <span class="shell-recents-name">{{ card.app.name }}</span>
                <span
                  v-if="stateText(card)"
                  class="shell-recents-status"
                  :class="stateClass(card)"
                >
                  {{ stateText(card) }}
                </span>
              </span>
            </div>

            <div
              class="shell-recents-thumb"
              :class="{ 'is-running': card.running }"
              aria-hidden="true"
            >
              <ShellAppIcon :app="card.app" :size="64" />
              <span v-if="thumbMeta(card)" class="shell-recents-thumb-meta">
                {{ thumbMeta(card) }}
              </span>
            </div>

            <!-- 唯一打开动作：覆盖整张卡的空按钮（视觉层 pointer-events:none）。
                 预览面 / 信息条可能含应用自绘或不可交互内容，不再嵌进 button。 -->
            <button
              type="button"
              class="shell-recents-open"
              :aria-label="t(card.running ? 'shell.switcher.enterApp' : 'shell.switcher.launchApp', { name: card.app.name })"
              :aria-current="index === activeIndex ? 'true' : undefined"
              @click.stop="onCardClick(card)"
            ></button>

            <!-- 关闭：每张卡都有（桌面同形），独立按钮压在整卡按钮之上，
                 并标出 data-card-ignore-drag —— 从它起手不算卡片手势 -->
            <button
              type="button"
              data-card-ignore-drag
              class="shell-recents-close"
              :aria-label="t('shell.switcher.closeCard', { name: card.app.name })"
              @click.stop="dismiss(card.app.id)"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </article>
        </div>
      </div>
    </template>

    <!-- ==================== 空态 ==================== -->
    <div
      v-else
      class="flex-1 flex flex-col items-center justify-center px-6 text-center"
      data-testid="shell-recents-empty"
    >
      <span
        class="flex items-center justify-center w-14 h-14 rounded-[18px]"
        :style="{ background: 'var(--mobile-bg-elevated)', color: 'var(--mobile-text-secondary)' }"
        aria-hidden="true"
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M3 9h18" />
        </svg>
      </span>
      <p class="mt-4 shell-type-label text-[var(--mobile-text-primary)]">
        {{ t('shell.switcher.empty') }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 多任务（与桌面同形的卡片布局）
 * -----------------------------------------------------------------------------
 * 形态：卡片按行居中排布（移动端每行 2 张，宽屏 3 张），信息条在上、缩略区在下，
 * 比例 3/4。桌面用 420×560 的大卡，这里只是同一形态的移动端尺寸，几何真源在
 * `styles/shell.css`（.shell-recents-*），组件只给手势位移与序号。
 *
 * 四条硬约束：
 *   ① 预览位不伪造内容——平台不持有应用内部快照，放大应用图标 + 真实元信息即
 *      平台掌握的全部事实（伪造截图属于 B4 业务投影越线）；
 *   ② 拖拽**不是唯一路径**（WCAG 2.2 Dragging Movements）：每张卡都可直接点按
 *      进入，关闭键常驻卡片右上角，页头返回 / 点非卡片区域负责退出；
 *   ③ 手势不互相抢：pointermove 首次越过轴锁阈值即锁定本次手势方向——横向
 *      切卡、纵向上滑关闭；网格内容溢出时纵向手势让位给原生滚动（否则列表
 *      滚不动），贴屏幕左右边缘起手则让位给系统返回手势；
 *   ④ 点哪张进哪张、上滑关哪张；拖拽抬手后浏览器补的那次 click 必须吞掉，
 *      否则上滑关闭会顺手把应用打开。
 *
 * 卡片集合 = 运行中应用（MRU 优先）+ 最近使用但未运行的应用。关闭运行中的卡片 =
 * 停用实例并移出最近列表（不然它会以「未运行」身份原地复活，看起来像关不掉）。
 *
 * 已退役：底部「上一个 / 下一个 + 圆点 + 页码」切换条（用户 2026-10-21 裁决）。
 * 手势与整卡点按已覆盖全部切换路径，底部常驻控件只会压缩卡片可视高度。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { logger } from '@/utils/frontendLogger'
import { useShellApps } from '../../composables/useShellApps'
import { useShellNavigation } from '../../composables/useShellNavigation'
import { useShellOpen } from '../../composables/useShellOpen'
import { useShellRecent } from '../../composables/useShellRecent'
import type { ShellApp } from '../../types'
import ShellAppIcon from '../ShellAppIcon.vue'
import ShellChip from '../ShellChip.vue'

const { t } = useI18n()
const nav = useShellNavigation()
const { apps, stop } = useShellApps()
const { recentIds, removeRecent, clearRecent } = useShellRecent()
const { open } = useShellOpen()

interface RecentCard {
  app: ShellApp
  running: boolean
}

/** 最近使用排序：recentIds 有记录的按记录顺序，其余运行中应用按名称兜底 */
function mruRank(app: ShellApp): number {
  const index = recentIds.value.indexOf(app.id)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

const cards = computed<RecentCard[]>(() => {
  const running = apps.value
    .filter((a) => a.state === 'running')
    .sort((a, b) => {
      const diff = mruRank(a) - mruRank(b)
      return diff !== 0 ? diff : a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
  const runningIds = new Set(running.map((a) => a.id))
  // 最近使用但未运行：卡片保留在列表里（Android recents 的同一语义），点它即启动
  const dormant = recentIds.value
    .map((id) => apps.value.find((a) => a.id === id))
    .filter((app): app is ShellApp => app !== undefined && !runningIds.has(app.id))
  return [
    ...running.map((app) => ({ app, running: true })),
    ...dormant.map((app) => ({ app, running: false })),
  ]
})

// ==================== 前层选择 ====================

/** 前层卡片 id；null = 取列表第一张（卡片集合变化时的兜底） */
const activeId = ref<string | null>(null)

const activeIndex = computed(() => {
  const index = cards.value.findIndex((c) => c.app.id === activeId.value)
  return index >= 0 ? index : 0
})

/** 卡片集合变化（启动 / 关闭 / 刷新）后修正前层：原前层消失就落到相邻张 */
watch(cards, (list) => {
  if (list.length === 0) {
    activeId.value = null
    return
  }
  if (!list.some((c) => c.app.id === activeId.value)) {
    activeId.value = list[Math.min(activeIndex.value, list.length - 1)]?.app.id ?? null
  }
})

/** 上一个 / 下一个（越界即无操作；横向手势的唯一消费者） */
function step(delta: number): void {
  const target = cards.value[activeIndex.value + delta]
  if (target) activeId.value = target.app.id
}

// ==================== 卡片内容 ====================

/** 状态行：运行中不重复播报默认事实，只给未运行 / 待审批 / 停用 / 失败 */
function stateText(card: RecentCard): string {
  switch (card.app.state) {
    case 'running':
      return ''
    case 'approval':
      return t('shell.common.approval')
    case 'disabled':
      return t('shell.common.disabled')
    case 'error':
      return t('shell.common.error')
    default:
      return t('shell.switcher.dormant')
  }
}

/** 状态行的语义色：异常态才偏离次级文字色（颜色之外另有文字，非纯色传达） */
function stateClass(card: RecentCard): string {
  if (card.app.state === 'approval') return 'is-warn'
  if (card.app.state === 'error') return 'is-danger'
  return ''
}

/** 缩略区元信息：版本 + 权限数，取不到就不留空行 */
function thumbMeta(card: RecentCard): string {
  const parts: string[] = []
  if (card.app.version) parts.push(`v${card.app.version}`)
  if (card.app.permissions.length > 0) {
    parts.push(t('shell.apps.permissionCount', { count: card.app.permissions.length }))
  }
  return parts.join(' · ')
}

// ==================== 手势几何 ====================

/** 轴锁阈值：小于该位移视为点击，避免手抖把点击判成拖拽 */
const AXIS_LOCK = 10
/** 切卡位移阈值 */
const SWIPE_STEP = 56
/** 上滑关闭阈值（负值方向） */
const DISMISS_THRESHOLD = 72
/**
 * 屏幕左右边缘让位带（px）
 *
 * ui-ux-pro-max `ux / Gesture Conflicts`：自定义手势不得覆盖系统手势。从这条带里
 * 起手不接管卡片手势，交给系统的返回手势——否则贴着屏幕边缘划动会既切卡又返回。
 */
const EDGE_GUARD = 24
/** 横向拖动时网格整体跟手位移上限（px）：给手势反馈，但不把卡片拖出视野 */
const GRID_NUDGE_LIMIT = 28
/** 网格整体跟手比例：横向手势是「切当前卡」，卡片本身不离开网格 */
const GRID_NUDGE_RATIO = 0.14

const gridEl = ref<HTMLElement | null>(null)
/** 网格内容是否溢出（溢出时纵向上滑归原生滚动） */
const scrollable = ref(false)

/**
 * 同步「是否可纵向滚动」
 *
 * 必须在手势开始前确定：溢出时 `touch-action: pan-y` 把纵向手势交给浏览器，
 * 不溢出时用 `touch-action: none` 接管纵向上滑关闭。若等 pointermove 再判断，
 * 浏览器已经启动滚动 / 发出 pointercancel，滑动关闭会时灵时不灵。
 */
function syncScrollable(): void {
  const el = gridEl.value
  scrollable.value = !!el && el.scrollHeight > el.clientHeight + 1
}

function onViewportResize(): void {
  syncScrollable()
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  syncScrollable()
  window.addEventListener('resize', onViewportResize)
  // 视口旋转 / 分屏会改变可用高度；ResizeObserver 不存在的老 WebView 靠 resize 兜底
  if (typeof ResizeObserver !== 'undefined' && gridEl.value) {
    resizeObserver = new ResizeObserver(syncScrollable)
    resizeObserver.observe(gridEl.value)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportResize)
  resizeObserver?.disconnect()
  resizeObserver = null
})

watch(cards, async () => {
  await nextTick()
  syncScrollable()
})

/** 网格整体位移：只在横向拖动时轻微跟手，抬手后吸附回原位 */
function gridStyle(): Record<string, string> {
  if (dragAxis.value !== 'x') return {}
  const raw = Math.max(
    -GRID_NUDGE_LIMIT,
    Math.min(GRID_NUDGE_LIMIT, dragDx.value * GRID_NUDGE_RATIO),
  )
  // 取整到 0.1px：避免浮点误差写出一长串小数（CSS 里也没有亚像素收益）
  const nudge = Math.round(raw * 10) / 10
  return { transform: `translate3d(${nudge}px, 0, 0)` }
}

/** 卡片自身样式：上滑关闭时跟手位移 + 淡出；其余卡片保持原位 */
function cardStyle(index: number): Record<string, string> {
  const style: Record<string, string> = { '--i': String(index) }
  const dragging = dragAxis.value === 'y' && cards.value[index]?.app.id === dragTargetId
  if (!dragging) return style
  style.opacity = String(Math.max(0.4, 1 + dragDy.value / 360))
  style.transform = `translate3d(0, ${dragDy.value}px, 0)`
  return style
}

// ==================== 手势（横向切卡 / 纵向上滑关闭） ====================

const dragAxis = ref<'x' | 'y' | null>(null)
const dragDx = ref(0)
const dragDy = ref(0)
/** 本次手势是否已越过阈值（越过则抬手后的 click 不再触发卡片动作） */
let dragMoved = false
/** 本次手势作用的卡片（纵向关闭按手指下那张卡判定） */
let dragTargetId: string | null = null
/** 手势起点 */
let dragOrigin: { x: number; y: number } | null = null
/** 起手时网格是否可纵向滚动（可滚动则纵向手势让给原生滚动） */
let scrollAtStart = false
/** 本次手势的指针 id（捕获指针时要用） */
let lastPointerId: number | undefined
/** 已 setPointerCapture 的指针（抬起 / 取消时释放） */
let capturedPointerId: number | null = null

/**
 * 接管本次手势的后续事件
 *
 * 只在**越过轴锁、确认是拖拽之后**才捕获：简单点击不捕获，click 仍落在卡片上
 * （「点卡片进入」依赖它）。捕获后手指滑出网格区（快速上滑）仍能收到
 * move/up，否则手势会停在偏移位上、卡片留在错位状态。
 */
function capturePointer(): void {
  const el = gridEl.value
  const id = lastPointerId
  // 非 Tauri 运行时 / 老 WebView 可能没有该 API：缺了就退化到「不捕获」，功能不受影响
  if (!el || id === undefined || typeof el.setPointerCapture !== 'function') return
  try {
    el.setPointerCapture(id)
    capturedPointerId = id
  } catch (e) {
    capturedPointerId = null
    // 捕获失败 → 快滑出界时手势收不到事件（卡片会停在偏移位），降级但要说出来
    logger.warn('[ShellSwitcher] setPointerCapture failed; drag may end out of grid', e)
  }
}

function releasePointer(): void {
  const el = gridEl.value
  const id = capturedPointerId
  capturedPointerId = null
  if (!el || id === null || typeof el.releasePointerCapture !== 'function') return
  try {
    el.releasePointerCapture(id)
  } catch (e) {
    // 指针已抬起 / 取消时释放会抛（该指针不再活跃），属清理路径，不影响交互
    logger.debug('[ShellSwitcher] releasePointerCapture skipped (pointer no longer active)', e)
  }
}

function onPointerDown(event: PointerEvent): void {
  // 只响应主指针；鼠标右键 / 中键不参与
  if (event.pointerType === 'mouse' && event.button !== 0) return
  // 只把「关闭」按钮排除在卡片手势之外：整卡覆盖按钮仍是手势起手面
  if ((event.target as HTMLElement | null)?.closest('[data-card-ignore-drag]')) return
  // 贴边起手让位给系统返回手势（EDGE_GUARD）
  if (event.clientX <= EDGE_GUARD || event.clientX >= window.innerWidth - EDGE_GUARD) return
  // 手指导下真正能否滚动：ref 可能滞后于布局（字体 / 内容晚到），以当次测量为准
  const el = gridEl.value
  scrollAtStart = !!el && el.scrollHeight > el.clientHeight + 1
  // 命中测试取手指底下那张卡；落在卡片之间空档时退回当前卡片
  const hitId =
    (event.target as HTMLElement | null)?.closest('[data-app-id]')?.getAttribute('data-app-id') ??
    cards.value[activeIndex.value]?.app.id
  if (!hitId || !cards.value.some((c) => c.app.id === hitId)) return
  dragTargetId = hitId
  dragOrigin = { x: event.clientX, y: event.clientY }
  lastPointerId = event.pointerId
  dragMoved = false
  dragAxis.value = null
  dragDx.value = 0
  dragDy.value = 0
}

function onPointerMove(event: PointerEvent): void {
  if (!dragOrigin) return
  const dx = event.clientX - dragOrigin.x
  const dy = event.clientY - dragOrigin.y
  if (dragAxis.value === null) {
    if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return
    const horizontal = Math.abs(dx) > Math.abs(dy)
    // 网格可滚动时纵向手势归浏览器：不锁轴、不捕获、不阻止默认滚动
    if (!horizontal && scrollAtStart) {
      dragOrigin = null
      return
    }
    // 首次越过阈值即锁轴：横向归切卡、纵向归关闭，同一次手势内不再改判
    dragAxis.value = horizontal ? 'x' : 'y'
    dragMoved = true
    // 确认是拖拽后才捕获指针：手指滑出网格区仍能收尾
    capturePointer()
  }
  if (dragAxis.value === 'x') {
    dragDx.value = dx
  } else {
    // 只允许上滑（offset ≤ 0）：下滑是「取消」，不应该把卡片往下推
    dragDy.value = Math.min(0, dy)
  }
}

function onPointerUp(event: PointerEvent): void {
  const origin = dragOrigin
  const target = dragTargetId
  const axis = dragAxis.value
  const dx = dragDx.value
  resetDrag()
  if (!origin || !target) return
  if (axis === 'x') {
    if (dx <= -SWIPE_STEP) step(1)
    else if (dx >= SWIPE_STEP) step(-1)
    return
  }
  if (axis !== 'y') return
  // 以抬起位置为准（pointermove 可能因快速滑动而稀疏甚至缺失）
  const offset = Math.min(0, event.clientY - origin.y)
  if (offset <= -DISMISS_THRESHOLD) void dismiss(target)
}

function resetDrag(): void {
  releasePointer()
  dragOrigin = null
  dragTargetId = null
  scrollAtStart = false
  dragAxis.value = null
  dragDx.value = 0
  dragDy.value = 0
}

/**
 * 拖拽刚结束时吞掉随后的 click
 *
 * 一次拖拽抬手后浏览器仍会补一次 click（落在抬手处那个元素上）。不吞掉的话，
 * 上滑关闭会顺手把应用打开、横滑切卡会连带进入——拖拽与点击必须分开判。
 *
 * @returns true = 这次 click 属于拖拽余波，调用方不要再执行动作
 */
function consumeDragClick(): boolean {
  if (!dragMoved) return false
  dragMoved = false
  return true
}

/** 点卡片 = 进入 / 启动该应用（Android recents：点哪张开哪张） */
function onCardClick(card: RecentCard): void {
  if (consumeDragClick()) return
  void enter(card.app.id)
}

/**
 * 点非卡片区域 = 回主屏（背景即「离开多任务」）。
 *
 * 卡片与交互控件（返回 / 全部关闭 / 卡片打开与关闭）有自己的动作，不在这里
 * 重复处理；拖拽抬手后的补 click 也必须吞掉，避免手势收尾误回主屏。
 */
function onSurfaceClick(event: MouseEvent): void {
  if (consumeDragClick()) return
  const target = event.target as HTMLElement | null
  if (target?.closest('button, a, input, textarea, select, [role="button"], [data-app-id]')) return
  nav.goHome()
}

// ==================== 动作 ====================

/** 关闭一张卡片：运行中先停用，然后（无论是否在跑）移出最近列表 */
async function dismiss(appId: string): Promise<void> {
  const index = cards.value.findIndex((c) => c.app.id === appId)
  if (index === -1) return
  // 前层移走后落到相邻张（后一张优先，没有则前一张）
  if (activeId.value === appId || index === activeIndex.value) {
    activeId.value =
      cards.value[index + 1]?.app.id ?? cards.value[index - 1]?.app.id ?? null
  }
  const app = cards.value[index]
  if (app?.running) await stop(appId)
  removeRecent(appId)
  // 只有「关闭最后一张卡」这个动作才回主屏；进入多任务时本就无卡不算，
  // 不能把 cards 变 0 本身当成返回信号。
  if (cards.value.length === 0) nav.goHome()
}

/** 全部关闭：停止所有运行中实例并清空最近列表（Android「清除全部」的同一语义） */
async function closeAll(): Promise<void> {
  const running = apps.value.filter((a) => a.state === 'running')
  for (const app of running) {
    await stop(app.id)
  }
  clearRecent()
  if (cards.value.length === 0) nav.goHome()
}

/** 进入应用：先回主屏重置栈，再走统一入口（未运行的会先启动，待审批落详情页） */
async function enter(appId: string): Promise<void> {
  nav.goHome()
  await open(appId)
}
</script>
