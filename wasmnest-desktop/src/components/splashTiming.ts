/**
 * 开屏绘画动画时序（SplashLoading 与 ShellHost 共用的单一真源）
 *
 * 为什么单独成文件：动画总时长决定「最后一笔画完」的时刻，而宿主以同一时刻作为
 * 启动面最低展示时长（画完即加载完成，随即收起开屏）。两处各写一份常量时，
 * 调动画节奏必然漂移——展示短于动画 → 线框画到一半被切掉；展示长于动画 →
 * 画完干等。改节奏只动本文件，两端自动对齐。
 *
 * 总时长 = 底板淡入 180ms + 124 条线框连续收笔（约 1.1s 绘画窗口），
 * 收起条件即「画完」；两个调用方都无需再动。
 */
export const SPLASH_DRAW_TOTAL_MS = 1260

/** 底板淡入时长：画布先就位，W 线框随后从「一笔未画」开始 */
export const SPLASH_BASE_FADE_MS = 180

/** 绘画窗口：第一笔起笔到末笔落定的时长（总时长扣掉底板淡入） */
export const SPLASH_DRAWING_SPAN_MS = SPLASH_DRAW_TOTAL_MS - SPLASH_BASE_FADE_MS

/**
 * 末笔落定后到收起开屏的停留。
 *
 * CSS animation 从 .drawing 加上后的下一帧开始计时，而 ShellHost 的计时器从挂载
 * 时刻起算——两者存在一帧级错位。留 80ms 让末笔完整渲染后再淡出，避免最后一笔
 * 被淡出盖掉；视觉上仍是「1.26s 画完」。
 */
export const SPLASH_HOLD_AFTER_DRAW_MS = 80

export interface SplashLineTiming {
  /** 相对组件挂载的起笔延迟（ms） */
  delay: number
  /** 单条线框的描边时长（ms），与自身周长成正比 */
  duration: number
}

/** 一条线框的几何：points 与 SVG 的 points 同源，length = getTotalLength() */
export interface SplashStrokeGeometry {
  points: Array<[number, number]>
  length: number
}

export interface SplashStrokeTiming extends SplashLineTiming {
  /** 对应输入 strokes 的下标 */
  index: number
  /** +1 = 从首点画到末点；-1 = 从末点画到首点 */
  direction: 1 | -1
}

const CYLINDER_COUNT = 4

/** 单笔描边方向：+1 首点→末点，-1 末点→首点；零长度点跟随组方向 */
function strokeDirection(first: number, last: number, downward: boolean): 1 | -1 {
  if (first === last) return downward ? 1 : -1
  if (downward) return first < last ? 1 : -1
  return first > last ? 1 : -1
}

/** 主成分方向；统一取 y 增大（向下）为正，便于判定「上→下」 */
function principalAxis(points: Array<[number, number]>): {
  cx: number
  cy: number
  ux: number
  uy: number
} {
  if (points.length === 0) return { cx: 0, cy: 0, ux: 0, uy: 1 }

  let cx = 0
  let cy = 0
  for (const [x, y] of points) {
    cx += x
    cy += y
  }
  cx /= points.length
  cy /= points.length

  let xx = 0
  let yy = 0
  let xy = 0
  for (const [x, y] of points) {
    const dx = x - cx
    const dy = y - cy
    xx += dx * dx
    yy += dy * dy
    xy += dx * dy
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy)
  let ux = Math.cos(angle)
  let uy = Math.sin(angle)
  if (uy < 0) {
    ux = -ux
    uy = -uy
  }
  return { cx, cy, ux, uy }
}

/**
 * 按恒定「笔速」给线框排期。
 *
 * lengths 按实际描边顺序传入；排期天然是「前一条收笔 = 后一条起笔」，任意时刻
 * 已画长度与时间成正比。末笔恰好在 SPLASH_DRAW_TOTAL_MS 落定，与开屏展示时长
 * 严格一致。
 */
export function splashLineSchedule(lengths: number[]): SplashLineTiming[] {
  const total = lengths.reduce((sum, len) => sum + Math.max(0, len), 0)
  if (total <= 0) return lengths.map(() => ({ delay: SPLASH_BASE_FADE_MS, duration: 0 }))

  const speed = total / SPLASH_DRAWING_SPAN_MS // 用户单位 / ms（全程恒定）
  let cursor = 0
  return lengths.map((rawLen) => {
    const len = Math.max(0, rawLen)
    const timing = {
      delay: SPLASH_BASE_FADE_MS + cursor / speed,
      duration: len / speed,
    }
    cursor += len
    return timing
  })
}

/**
 * 生成 W 的描边计划。
 *
 * 四根圆柱按 icon.svg 的源码顺序（左 → 右）分组；组内不再照抄描摹顺序，而是
 * 沿圆柱轴向按 W 的自然笔顺推进：
 *
 *   左柱  上 → 下（左肩到左谷）
 *   左中  下 → 上（左谷到中峰）
 *   右中  上 → 下（中峰到右谷）
 *   右柱  下 → 上（右谷到右肩）
 *
 * 每条线框按「进入点」排序（下行组取最高点、上行组取最低点），并被强制从进入
 * 端向另一端描出（direction = ±1 对应 dashoffset 的 ±周长）。于是笔尖沿 W 的
 * 骨架连续行走：左肩 → 左谷 → 中峰 → 右谷 → 右肩，视觉上就是从左边开始、
 * 一路向右把 W 画出来。
 */
export function splashDrawingPlan(strokes: SplashStrokeGeometry[]): SplashStrokeTiming[] {
  if (strokes.length === 0) return []

  const groupSize = Math.ceil(strokes.length / CYLINDER_COUNT)
  const ordered: Array<{ index: number; direction: 1 | -1 }> = []

  for (let groupIdx = 0; groupIdx < CYLINDER_COUNT; groupIdx++) {
    const start = groupIdx * groupSize
    const group = strokes.slice(start, start + groupSize)
    if (group.length === 0) continue

    const { cx, cy, ux, uy } = principalAxis(group.flatMap((stroke) => stroke.points))
    // 上→下 / 下→上 交替：左柱下、左中上、右中下、右柱上
    const downward = groupIdx % 2 === 0

    const items = group.map((stroke, localIdx) => {
      const project = (point: [number, number]) => (point[0] - cx) * ux + (point[1] - cy) * uy
      const first = project(stroke.points[0] ?? [cx, cy])
      const last = project(stroke.points[stroke.points.length - 1] ?? [cx, cy])
      // 进入点：下行组取最高点（投影最小），上行组取最低点（投影最大）
      const entry = downward ? Math.min(first, last) : Math.max(first, last)
      return {
        index: start + localIdx,
        entry,
        direction: strokeDirection(first, last, downward),
      }
    })

    items.sort((a, b) => (downward ? a.entry - b.entry : b.entry - a.entry))
    for (const item of items) ordered.push({ index: item.index, direction: item.direction })
  }

  const schedule = splashLineSchedule(ordered.map((item) => strokes[item.index].length))
  return ordered.map((item, i) => ({ ...item, ...schedule[i] }))
}
