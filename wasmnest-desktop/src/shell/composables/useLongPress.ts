/**
 * 长按手势（pointer 事件，鼠标 / 触屏同径）——壳内交互原语，不携带产品语义。
 *
 * 按住 `duration`（缺省 500ms，对齐移动端长按惯例）且位移不超过阈值即触发；
 * 期间位移超阈值（拖动 / 滚动意图）、抬起、指针取消、`cancel()`（右键菜单先行
 * 等场景）都撤销计时。触发后吞掉紧随的一次 click——长按不是打开（消费口
 * `consumeClick`，调用方在 click 处理器里先问再决定是否执行默认动作）。
 *
 * 冲突口径：非主键按下（右键 / 中键）不启动计时，右键菜单语义独立；已有按压
 * 进行中（多点触控）忽略第二指针。down 时对元素 `setPointerCapture`，按住移出
 * 元素后 move / up 仍抵达本元素，位移阈值与抬起取消照常生效（happy-dom 等无
 * capture 能力的环境可选调用，不影响手势本身）。
 *
 * 无障碍：长按只做既有动作的快捷入口——右键菜单键 / 键盘焦点路径仍可达同一
 * 菜单（调用方保证），不新增仅手势可达的功能。
 */
export interface LongPressOptions {
  /** 触发时长 ms（缺省 500） */
  duration?: number
  /** 取消位移 px（缺省 10） */
  moveThreshold?: number
}

export function useLongPress<C>(
  onLongPress: (ctx: C, x: number, y: number) => void,
  options: LongPressOptions = {},
) {
  const duration = options.duration ?? 500
  const moveThreshold = options.moveThreshold ?? 10

  let timer: ReturnType<typeof setTimeout> | null = null
  let activePointerId: number | null = null
  let activeCtx: C | undefined
  let startX = 0
  let startY = 0
  /** 长按已触发：紧随的一次 click 应被吞掉（长按不是打开） */
  let swallowNextClick = false

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    activePointerId = null
    activeCtx = undefined
  }

  /** 按下：仅主键启动计时（context 携带调用方身份，触发时原样交还） */
  function down(e: PointerEvent, ctx: C): void {
    if (activePointerId !== null || e.button !== 0) return
    activePointerId = e.pointerId
    activeCtx = ctx
    startX = e.clientX
    startY = e.clientY
    try {
      ;(e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId)
    } catch {
      /* 无 capture 能力（测试环境）不影响手势计时 */
    }
    timer = setTimeout(() => {
      timer = null
      swallowNextClick = true
      onLongPress(activeCtx as C, e.clientX, e.clientY)
      clear()
    }, duration)
  }

  /** 移动：位移超阈值 = 拖动 / 滚动意图，撤销计时 */
  function move(e: PointerEvent): void {
    if (activePointerId !== e.pointerId) return
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > moveThreshold) clear()
  }

  /** 抬起 / 系统取消：未触发前撤销计时 */
  function up(e: PointerEvent): void {
    if (activePointerId === e.pointerId) clear()
  }

  /** 外部撤销（右键菜单先行、组件卸载等）：无条件清计时 */
  function cancel(): void {
    clear()
  }

  /**
   * click 消费口：长按触发后的第一次调用返回 true（调用方跳过默认动作），
   * 其后返回 false。不依赖事件参数，调用方把它放在自己的 click 处理器首行。
   */
  function consumeClick(): boolean {
    const swallow = swallowNextClick
    swallowNextClick = false
    return swallow
  }

  return { down, move, up, cancel, consumeClick }
}
