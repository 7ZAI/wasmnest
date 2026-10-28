<template>
  <!-- 悬浮导航（回主屏 / 多任务）：默认关闭，开启后由 ShellHost 常驻渲染。
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
      @click="state.goHome()"
    >
      <ShellIcon name="home" :size="17" />
    </button>

    <span class="shell-floatnav-divider" aria-hidden="true" />

    <button
      type="button"
      class="shell-floatnav-btn"
      :aria-label="t('shell.floatingNav.recents')"
      @click="state.toggleRecents()"
    >
      <ShellIcon name="recents" :size="16" />
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * ShellFloatingNav — 悬浮导航胶囊（Liquid Glass 材质，与移动端 ShellFloatingNav 同构）
 *
 * 为什么挂在 ShellHost：开关开启后要在**任意面**可见——主屏 / 系统页 / 应用面
 * 都渲染在 ShellHost 之内（桌面没有壳外的整页路由），ShellHost 就是唯一与所有
 * 面同层的宿主装配点。bareWindow 独立窗口不渲染（窗口 chrome 归应用自持，
 * 与 ShellToolbar / ShellStatusBar 同口径，由 ShellHost 的 v-if 承担）。
 *
 * 层次固定在宿主弹层之下（z-40：工具栏 30 / 状态栏 20 之上，多任务 44 /
 * 面板 45 / 弹窗 50 / 右键 60 之下）：弹层打开时遮罩自然盖住它，不抢交互。
 *
 * 位置语义：偏好里存归一化比例（0–1），渲染时换算成像素；窗口缩放后按同一
 * 比例重算，胶囊不会被甩出窗口。拖拽只写像素，抬手才落偏好，避免拖动过程
 * 反复写 localStorage。bottomReserve 由 ShellHost 传入（状态栏可见时让出
 * 状态栏条带），默认落位是底部居中、状态栏正上方。
 *
 * 无拖拽替代路径（WCAG 2.2 Dragging Movements）：拖动面本身可聚焦，
 * 方向键按 8px（Shift 32px）移动并持久化——位置不是只能靠拖。
 *
 * 玻璃材质的三层降级（样式在 shell.css）：
 *   ① 不支持 backdrop-filter → 回落实色卡片底（图标仍可读）
 *   ② 系统「降低透明度」偏好 → 同上，不做模糊
 *   ③ 减少动效 / 壳「动画效果」关闭 → shell.css 与 style.css 的既有降级块
 *      （.shell-root * / html.anim-disabled）把过渡压成瞬时，无需组件自理
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { logger } from '@/utils/frontendLogger'
import { useShellState } from '../composables/useShellState'
import { useShellSettings } from '../composables/useShellSettings'
import type { FloatingNavPosition } from '../types'
import ShellIcon from './ShellIcon.vue'

/** 底部让位（px）：状态栏可见时由 ShellHost 传入状态栏高度，胶囊不盖机制事实 */
const props = defineProps<{ bottomReserve?: number }>()

const { t } = useI18n()
const state = useShellState()
const { prefs } = useShellSettings()

/** 悬浮条与窗口边缘的留白（px） */
const EDGE_MARGIN = 12
/** 判为拖拽的最小位移（px）：小于它的移动仍算点击，避免手抖吞掉按钮 */
const DRAG_THRESHOLD = 8
/** 方向键单步位移（px）；Shift 加速 */
const KEY_STEP = 8
const KEY_STEP_LARGE = 32

const enabled = computed(() => prefs.value.floatingNav === true)
/** 底部让位：状态栏可见（主屏 / 系统页）时让出状态栏条带，不盖住机制事实 */
const bottomReserve = computed(() => props.bottomReserve ?? 0)

const barEl = ref<HTMLElement | null>(null)
/** 悬浮条自身尺寸：由挂载后实测，位置换算依赖它 */
const size = ref({ width: 0, height: 0 })
const viewport = ref(readViewport())
const positionPx = ref({ x: 0, y: 0 })
/** 尺寸未量到前不显示：避免首帧停在左上角再跳到目标位 */
const ready = ref(false)
const dragging = ref(false)

function readViewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

/** 可移动范围：四边各留 EDGE_MARGIN，底部再让出 bottomReserve（状态栏条带） */
const bounds = computed(() => {
  const minX = EDGE_MARGIN
  const maxX = Math.max(minX, viewport.value.width - size.value.width - EDGE_MARGIN)
  const minY = EDGE_MARGIN
  const maxY = Math.max(
    minY,
    viewport.value.height - size.value.height - EDGE_MARGIN - bottomReserve.value,
  )
  return { minX, maxX, minY, maxY }
})

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 比例 → 像素；非有限值按默认比例兜底，不让 NaN 写进 transform */
function normalizeRatio(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, 0, 1)
    : fallback
}

function pxFromRatio(pos: FloatingNavPosition | undefined): { x: number; y: number } {
  const { minX, maxX, minY, maxY } = bounds.value
  return {
    x: minX + normalizeRatio(pos?.x, 0.5) * (maxX - minX),
    y: minY + normalizeRatio(pos?.y, 1) * (maxY - minY),
  }
}

function ratioFromPx(px: { x: number; y: number }): FloatingNavPosition {
  const { minX, maxX, minY, maxY } = bounds.value
  return {
    x: maxX > minX ? clamp((px.x - minX) / (maxX - minX), 0, 1) : 0.5,
    y: maxY > minY ? clamp((px.y - minY) / (maxY - minY), 0, 1) : 1,
  }
}

/** 实测尺寸并落到当前位置 */
function measure(): void {
  const el = barEl.value
  if (!el) return
  size.value = { width: el.offsetWidth, height: el.offsetHeight }
  if (!dragging.value) positionPx.value = pxFromRatio(prefs.value.floatingNavPos)
  ready.value = true
}

const barStyle = computed(() => ({
  transform: `translate3d(${Math.round(positionPx.value.x)}px, ${Math.round(positionPx.value.y)}px, 0)`,
}))

// ==================== 拖动（指针事件，鼠标与触屏同一路径） ====================

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
/** 窗口级收尾监听是否在挂：指针捕获不可用时靠它兜住出界抬手 */
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
  // 只结束本次手势的指针：第二指针抬起不应打断正在进行的拖动
  if (event && event.pointerId !== origin.pointerId) return
  const moved = dragMoved
  resetDrag()
  if (!moved) return
  // 抬手才落偏好：拖动过程不反复写 localStorage
  prefs.value.floatingNavPos = ratioFromPx(positionPx.value)
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
 * 捕获阶段吞掉它，避免「拖完位置顺手打开了主屏 / 多任务」。
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
  prefs.value.floatingNavPos = ratioFromPx(positionPx.value)
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

// 外部改比例（测试复位等）时重新落位；拖动中不跟外部值
watch(
  () => prefs.value.floatingNavPos,
  (pos) => {
    if (dragging.value || !ready.value) return
    positionPx.value = pxFromRatio(pos)
  },
)

// 窗口缩放 / 面切换（bottomReserve 变化）改变可移动范围：按同一比例重算像素位置
watch(bounds, () => {
  if (dragging.value || !ready.value) return
  positionPx.value = pxFromRatio(prefs.value.floatingNavPos)
})

onMounted(() => {
  viewport.value = readViewport()
  measure()
  window.addEventListener('resize', onViewportResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportResize)
  resetDrag()
})
</script>
