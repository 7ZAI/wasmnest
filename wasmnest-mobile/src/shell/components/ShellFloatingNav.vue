<template>
  <!-- 悬浮导航（回主屏 / 多任务）：默认关闭，开启后由 App 根常驻渲染。
       位置只写 transform：拖动时每帧只改合成属性，不触发布局重排。
       整个胶囊是拖动面，两个按钮仍是普通点击目标——位移超过阈值才判为拖拽，
       并在捕获阶段吞掉拖拽抬手后浏览器补的那次 click。 -->
  <div
    v-if="enabled"
    ref="barEl"
    class="shell-floatnav"
    :class="{ 'is-ready': ready, 'is-dragging': dragging }"
    :style="barStyle"
    role="group"
    :aria-label="t('shell.floatingNav.move')"
    tabindex="0"
    data-testid="shell-floating-nav"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @click.capture="onCaptureClick"
    @keydown="onKeydown"
    @contextmenu.prevent
  >
    <button
      type="button"
      class="shell-floatnav-btn"
      :aria-label="t('shell.floatingNav.home')"
      @click="goHome"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 10.5L12 3l9 7.5" />
        <path d="M5 9.5V21h14V9.5" />
      </svg>
    </button>

    <span class="shell-floatnav-divider" aria-hidden="true" />

    <button
      type="button"
      class="shell-floatnav-btn"
      :aria-label="t('shell.floatingNav.recents')"
      @click="openSwitcher"
    >
      <svg
        width="19"
        height="19"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="7" y="3" width="14" height="14" rx="3" />
        <path d="M3 7v10a4 4 0 0 0 4 4h10" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * 悬浮导航（Liquid Glass 材质）
 * -----------------------------------------------------------------------------
 * 为什么挂在 App 根而不是壳根：开关开启后要在**任意页面**可见——壳内各屏、
 * 旧设置二级页、以及 wasmnest 应用运行面都要能浮在上面。壳根只覆盖壳内屏，
 * 覆盖不到整页路由；App 根是唯一与所有页面同层的宿主装配点。
 *
 * 层次固定在宿主弹层之下（z-40 < 抽屉 / 通知栏的 z-50+）：弹层打开时
 * 遮罩自然盖住它，不会抢走抽屉的交互。
 *
 * 位置语义：偏好里存归一化比例（0–1），渲染时换算成像素；旋转 / 分屏 /
 * 键盘改变视口后按同一比例重算，悬浮条不会被甩出屏幕。拖拽只写像素，
 * 抬手时才落偏好，避免拖动过程反复写 localStorage。
 *
 * 无拖拽替代路径（WCAG 2.2 Dragging Movements）：拖动面本身可聚焦，
 * 方向键按 8px（Shift 32px）移动并持久化——位置不是只能靠拖。
 *
 * 玻璃材质的三层降级：
 *   ① 不支持 backdrop-filter → 回落到实色卡片底（内容仍可读）
 *   ② 用户开启「减少透明」→ 同上，不做模糊
 *   ③ 减少动效 → 只保留状态色变化，不做缩放 / 过渡
 */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { logger } from '@/utils/frontendLogger'
import { useShellNavigation } from '../composables/useShellNavigation'
import {
  useShellPreferences,
  type FloatingNavPosition,
} from '../composables/useShellPreferences'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const nav = useShellNavigation()
const { floatingNav, floatingNavPos, setFloatingNavPos } = useShellPreferences()

/** 悬浮条与屏幕边缘 / 安全区的留白（px） */
const EDGE_MARGIN = 12
/** 判为拖拽的最小位移（px）：小于它的移动仍算点击，避免手抖吞掉按钮 */
const DRAG_THRESHOLD = 8
/** 方向键单步位移（px）；Shift 加速 */
const KEY_STEP = 8
const KEY_STEP_LARGE = 32

/**
 * 安全区就绪后才显示：Android 首帧的安全区还是 0，提前出现会压在状态栏下，
 * 等 JS 量到真实值再落位（缺省 true = 浏览器预览 / 单测不受影响）。
 */
const safeAreaReady = inject<Ref<boolean>>('safeAreaReady', ref(true))
const enabled = computed(() => floatingNav.value && safeAreaReady.value)

const barEl = ref<HTMLElement | null>(null)
/** 悬浮条自身尺寸：由挂载后实测，位置换算依赖它 */
const size = ref({ width: 0, height: 0 })
const viewport = ref(readViewport())
const positionPx = ref({ x: 0, y: 0 })
/** 尺寸未量到前不显示：避免首帧停在左上角再跳到目标位 */
const ready = ref(false)
const dragging = ref(false)

/**
 * 安全区由 App.vue 注入（同一进程级真源）：Android WebView 不支持 env()，
 * 顶部状态栏与底部手势条只能靠 JS 值避让。
 */
const safeArea = inject<Ref<{ top: number; bottom: number; navigationBar?: number }> | undefined>(
  'safeArea',
  undefined,
)

function readViewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

/** 可移动范围：两端各留 EDGE_MARGIN，上下再叠加安全区 */
const bounds = computed(() => {
  const topInset = safeArea?.value.top ?? 0
  const bottomInset = safeArea?.value.navigationBar ?? safeArea?.value.bottom ?? 0
  const minX = EDGE_MARGIN
  const maxX = Math.max(minX, viewport.value.width - size.value.width - EDGE_MARGIN)
  const minY = EDGE_MARGIN + topInset
  const maxY = Math.max(
    minY,
    viewport.value.height - size.value.height - EDGE_MARGIN - bottomInset,
  )
  return { minX, maxX, minY, maxY }
})

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 比例 → 像素；非有限值按默认比例兜底，不让 NaN 写进 transform */
function normalizeRatio(value: number, fallback: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : fallback
}

function pxFromRatio(pos: FloatingNavPosition): { x: number; y: number } {
  const { minX, maxX, minY, maxY } = bounds.value
  return {
    x: minX + normalizeRatio(pos.x, 0.5) * (maxX - minX),
    y: minY + normalizeRatio(pos.y, 1) * (maxY - minY),
  }
}

function ratioFromPx(px: { x: number; y: number }): FloatingNavPosition {
  const { minX, maxX, minY, maxY } = bounds.value
  return {
    x: maxX > minX ? clamp((px.x - minX) / (maxX - minX), 0, 1) : 0.5,
    y: maxY > minY ? clamp((px.y - minY) / (maxY - minY), 0, 1) : 1,
  }
}

/** 实测尺寸并落到当前位置；尺寸没变时也不重复写（watch 只在比例 / 视口变化时触发） */
function measure(): void {
  const el = barEl.value
  if (!el) return
  size.value = { width: el.offsetWidth, height: el.offsetHeight }
  if (!dragging.value) positionPx.value = pxFromRatio(floatingNavPos.value)
  ready.value = true
}

const barStyle = computed(() => ({
  transform: `translate3d(${Math.round(positionPx.value.x)}px, ${Math.round(positionPx.value.y)}px, 0)`,
}))

/**
 * 离开整页路由（旧设置二级页）时先进壳：导航动作改的是壳内栈，
 * 不 push 回壳路由的话，用户看到的还是原来的整页。
 */
async function ensureShellRoute(): Promise<void> {
  if (route.name === 'mobile-shell') return
  try {
    await router.push({ name: 'mobile-shell' })
  } catch (e) {
    // 导航被守卫拒绝 / 重复导航：留在当前页即可，悬浮条自身仍可用
    logger.warn('[ShellFloatingNav] enter shell route failed', e)
  }
}

function goHome(): void {
  nav.goHome()
  void ensureShellRoute()
}

function openSwitcher(): void {
  nav.openSwitcher()
  void ensureShellRoute()
}

// ==================== 拖动（指针事件，触屏与鼠标同一路径） ====================

interface DragOrigin {
  pointerId: number
  x: number
  y: number
  left: number
  top: number
}

let dragOrigin: DragOrigin | null = null
/** 本次手势是否已越过阈值：抬手后的 click 要吞掉，否则拖拽会顺手触发按钮 */
let dragMoved = false
let capturedPointerId: number | null = null
/** 拖拽余波 click 的兜底清理定时器（见 onPointerUp） */
let dragClickGuardTimer: ReturnType<typeof setTimeout> | null = null
/** 窗口级收尾监听是否在挂：指针捕获不可用的老 WebView 靠它兜住出界抬手 */
let windowUpListening = false

function listenWindowRelease(): void {
  if (windowUpListening) return
  windowUpListening = true
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
}

function unlistenWindowRelease(): void {
  if (!windowUpListening) return
  windowUpListening = false
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
}

function capturePointer(pointerId: number): void {
  const el = barEl.value
  // 老 WebView 可能没有该 API：缺了就退化到不捕获，功能不受影响
  if (!el || typeof el.setPointerCapture !== 'function') return
  try {
    el.setPointerCapture(pointerId)
    capturedPointerId = pointerId
  } catch (e) {
    // 捕获失败 → 快速划出胶囊时手势可能收不到收尾事件（停在最后一帧）
    logger.warn('[ShellFloatingNav] setPointerCapture failed; drag may end outside', e)
  }
}

function releasePointer(): void {
  const el = barEl.value
  const pointerId = capturedPointerId
  capturedPointerId = null
  if (!el || pointerId === null || typeof el.releasePointerCapture !== 'function') return
  try {
    el.releasePointerCapture(pointerId)
  } catch (e) {
    // 指针已抬起 / 取消时释放会抛（该指针不再活跃），属清理路径
    logger.debug('[ShellFloatingNav] releasePointerCapture skipped', e)
  }
}

function onPointerDown(event: PointerEvent): void {
  // 只响应主指针；鼠标右键 / 中键不参与
  if (event.pointerType === 'mouse' && event.button !== 0) return
  if (!ready.value) return
  // 上一轮手势可能因出界丢掉收尾事件：起手先复位，别把 is-dragging 留到下一次
  resetDrag()
  dragOrigin = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: positionPx.value.x,
    top: positionPx.value.y,
  }
  dragMoved = false
  // 指针捕获不可用时仍能在窗口层收到抬手 / 取消
  listenWindowRelease()
}

function onPointerMove(event: PointerEvent): void {
  const origin = dragOrigin
  if (!origin || event.pointerId !== origin.pointerId) return
  const dx = event.clientX - origin.x
  const dy = event.clientY - origin.y
  if (!dragMoved) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    dragMoved = true
    dragging.value = true
    // 确认是拖拽后才捕获：纯点击不捕获，click 仍落在按钮上
    capturePointer(origin.pointerId)
  }
  event.preventDefault()
  const { minX, maxX, minY, maxY } = bounds.value
  positionPx.value = {
    x: clamp(origin.left + dx, minX, maxX),
    y: clamp(origin.top + dy, minY, maxY),
  }
}

function onPointerUp(event?: PointerEvent): void {
  const origin = dragOrigin
  if (!origin) return
  // 只结束本次手势的指针：第二根手指抬起不应打断正在进行的拖动
  if (event && event.pointerId !== origin.pointerId) return
  const moved = dragMoved
  resetDrag()
  if (!moved) return
  // 抬手才落偏好：拖动过程不反复写 localStorage
  setFloatingNavPos(ratioFromPx(positionPx.value))
  // 浏览器在同一个任务里补发 click（拖拽余波）之后才轮到 0ms 定时器：
  // 用定时器清标记，既吞掉余波，也不会误伤之后（含键盘触发）的点击。
  clearDragClickGuard()
  dragClickGuardTimer = setTimeout(() => {
    dragClickGuardTimer = null
    dragMoved = false
  }, 0)
}

function onPointerCancel(event?: PointerEvent): void {
  if (event && dragOrigin && event.pointerId !== dragOrigin.pointerId) return
  resetDrag()
  // 取消后不再吞下一次 click（本次手势没有可归位的点击语义）
  dragMoved = false
}

function clearDragClickGuard(): void {
  if (dragClickGuardTimer === null) return
  clearTimeout(dragClickGuardTimer)
  dragClickGuardTimer = null
}

/**
 * 拖拽抬手后浏览器仍会补一次 click（落在抬手处那个元素上）。
 * 捕获阶段吞掉它，避免「拖完位置顺手打开了应用 / 切到多任务」。
 */
function onCaptureClick(event: MouseEvent): void {
  if (!dragMoved) return
  dragMoved = false
  clearDragClickGuard()
  event.stopPropagation()
  event.preventDefault()
}

function resetDrag(): void {
  releasePointer()
  unlistenWindowRelease()
  clearDragClickGuard()
  dragOrigin = null
  dragging.value = false
}

// ==================== 键盘移动（拖拽的无障碍替代路径） ====================

function onKeydown(event: KeyboardEvent): void {
  // 只在拖动面自身获得焦点时响应：按钮上的方向键留给按钮语义
  if (event.target !== barEl.value) return
  let dx = 0
  let dy = 0
  switch (event.key) {
    case 'ArrowLeft':
      dx = -1
      break
    case 'ArrowRight':
      dx = 1
      break
    case 'ArrowUp':
      dy = -1
      break
    case 'ArrowDown':
      dy = 1
      break
    default:
      return
  }
  event.preventDefault()
  const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
  const { minX, maxX, minY, maxY } = bounds.value
  positionPx.value = {
    x: clamp(positionPx.value.x + dx * step, minX, maxX),
    y: clamp(positionPx.value.y + dy * step, minY, maxY),
  }
  setFloatingNavPos(ratioFromPx(positionPx.value))
}

// ==================== 生命周期 ====================

function onViewportResize(): void {
  viewport.value = readViewport()
  measure()
}

watch(enabled, async (on) => {
  if (!on) {
    ready.value = false
    return
  }
  // 关闭时根节点被 v-if 摘掉，重新开启要等 DOM 回来再量
  await nextTick()
  measure()
})

// 外部改比例（含多窗口 / 测试复位）时重新落位；拖动中不跟外部值
watch(floatingNavPos, (pos) => {
  if (dragging.value || !ready.value) return
  positionPx.value = pxFromRatio(pos)
})

// 旋转 / 分屏 / 键盘改变可移动范围：按同一比例重算像素位置
watch(bounds, () => {
  if (dragging.value || !ready.value) return
  positionPx.value = pxFromRatio(floatingNavPos.value)
})

onMounted(() => {
  viewport.value = readViewport()
  measure()
  window.addEventListener('resize', onViewportResize)
  // 键盘弹出只改 visual viewport 的实现也要跟随（两路都监听，重复触发无代价）
  window.visualViewport?.addEventListener?.('resize', onViewportResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportResize)
  window.visualViewport?.removeEventListener?.('resize', onViewportResize)
  resetDrag()
})
</script>
