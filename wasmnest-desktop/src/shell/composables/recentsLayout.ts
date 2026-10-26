/**
 * 多任务卡片带尺寸解算（`ShellTaskSwitcher` 专用；纯函数，不碰 DOM）
 *
 * 产品口径（2026-10-23 用户裁决，修正上一版的反方向）：
 * - 卡片越少越大：只有 1 张时取卡片带里的**最大**尺寸（居中显示）；
 * - 卡片越多越小，但**最小**只缩到「2 行 × 3 列」网格排布时的自适应格；
 * - 第 7 张起（超过 2 行）不再继续缩小，改为整带纵向滚动。
 *
 * 卡片保持竖版 3/4（与 `.ts-card` 的 `aspect-ratio` 同一常量），所以「最大尺寸」
 * = 带内能放下的最大 3:4 矩形：宽受带高限制时以高度为准（单卡 = 0.75 × 带高）。
 *
 * 带尺寸由调用方实测后传入（内边距 / 滚动条已由调用方扣掉）：**不能**改成 CSS
 * 容器查询——WebKitGTK 下 `container-type: size` 的高度解析为 0，卡片会塌成不可见
 * （2026-10-23 实测，见 `__tests__/shell/recentsWiring.test.ts` 同条回归锁）。
 */

/** 每行最多几张卡（产品口径：最多三列） */
export const RECENTS_MAX_COLS = 3
/** 视野内最多几行；超出的行改为纵向滚动（不再缩小） */
export const RECENTS_MAX_VISIBLE_ROWS = 2
/** 卡片宽高比（宽 / 高）；与 `.ts-card` 的 `aspect-ratio` 同源，改一处必须改另一处 */
export const RECENTS_CARD_ASPECT = 3 / 4
/** 网格轨道数上限：三列拆成 6 个半列轨道，每张卡跨 2 轨 */
export const RECENTS_GRID_TRACKS = 6

/**
 * 本次排布用几轨（半列）：三列 = 6 轨，1 / 2 张卡收窄到 2 / 4 轨。
 *
 * 轨道总宽必须等于这一行的卡片总宽，否则半列网格按三列撑开时，单卡轨道区会比
 * 卡片带宽一倍，只能靠 overflow-x:hidden 把两侧空白裁掉（能看，但位置靠负偏移，
 * 以后容易踩到）。收窄后 6 轨只在 ≥3 张时出现，末行居中仍由半列偏移完成。
 */
export function recentsTrackCount(count: number): number {
  if (!(count > 0)) return RECENTS_GRID_TRACKS
  return Math.min(Math.floor(count), RECENTS_MAX_COLS) * 2
}

/** 卡片带可用尺寸（内容盒：已扣内边距与滚动条占位） */
export interface RecentsBand {
  /** 可用宽度（px） */
  width: number
  /** 可用高度（px） */
  height: number
  /** 卡片间距（CSS gap 的实测值，px） */
  gap: number
}

/** 本次排布采用的网格形状（列数 / 行数；行数封顶 2，超出走滚动） */
export interface RecentsGridShape {
  cols: number
  rows: number
}

/**
 * 卡片数 → 网格形状
 *
 * `rows` 是**尺寸解算用**的行数（封顶 `RECENTS_MAX_VISIBLE_ROWS`），不是实际行数：
 * 第 7 张起实际会排 3 行以上，但卡片按 2 行时的格子定尺寸 → 溢出滚动。
 */
export function recentsGridShape(count: number): RecentsGridShape {
  const safe = Math.max(1, Math.floor(count))
  return {
    cols: Math.min(safe, RECENTS_MAX_COLS),
    rows: Math.min(Math.ceil(safe / RECENTS_MAX_COLS), RECENTS_MAX_VISIBLE_ROWS),
  }
}

/**
 * 单张卡宽度（px，向下取整：亚像素会把最后一张挤出换行、白赚一条滚动条）
 *
 * 取「按宽度均分的列宽」与「按高度均分的行高反推的 3:4 宽度」的较小值：
 * - 宽窗口（16:9）：高度是瓶颈 → 1 张 = 0.75 × 带高，2 张与 1 张同高同宽；
 * - 窄窗口：宽度是瓶颈 → 按列数均分。
 *
 * @returns 0 = 还量不到带尺寸（首帧测量前 / 无布局的测试环境）：调用方保留 CSS 兜底宽度
 */
export function recentsCardWidth(count: number, band: RecentsBand): number {
  if (!(count > 0) || !(band.width > 0) || !(band.height > 0)) return 0
  const { cols, rows } = recentsGridShape(count)
  const byWidth = (band.width - band.gap * (cols - 1)) / cols
  const byHeight = ((band.height - band.gap * (rows - 1)) / rows) * RECENTS_CARD_ASPECT
  return Math.max(0, Math.floor(Math.min(byWidth, byHeight)))
}

/**
 * 单张卡高度（px，由卡宽按 3:4 派生）
 *
 * 行高也由它显式注入（`grid-auto-rows`）：把行高交给 `auto` 时，Chromium 在内容
 * 超过带高的情况下会把隐式行压扁去填满容器（实测 3 行被压成 260px，卡片溢出到
 * 带顶之外、首行不可见）。行高与卡高同源后，溢出只剩"滚动"一种结果。
 */
export function recentsCardHeight(width: number): number {
  if (!(width > 0)) return 0
  return width / RECENTS_CARD_ASPECT
}

/** 卡片在 6 轨网格里的显式位置（1-based，与 CSS grid 一致） */
export interface RecentsCardPlacement {
  /** 行号（1-based） */
  row: number
  /** 起始轨（1-based）；卡片固定跨 2 轨 */
  columnStart: number
}

/**
 * 末行不满时，把这一组卡整体居中（其余卡交给 CSS 自动排布）
 *
 * 三列被拆成 6 个半列轨道（每张卡跨 2 轨）就是为了这一步：末行 2 张能落在
 * 半列偏移上（各让出 0.5 卡宽），末行 1 张落在正中（两侧各 1.5 卡宽）。
 * 单纯三等分网格做不到——2 张只剩"靠左"或"靠右"两种对齐。
 *
 * 不足 3 张时轨道数已经收窄（见 `recentsTrackCount`），这一行本来就是居中的，
 * 公式按实际轨道数算出的位置与自动排布一致（1 张 → 第 1 轨，2 张 → 1 / 3 轨）。
 *
 * @returns null = 该卡由自动排布决定（整行满 3 张）；非末行卡不会返回位置
 */
export function recentsCardPlacement(index: number, count: number): RecentsCardPlacement | null {
  if (!(count > 0) || index < 0 || index >= count) return null
  const rem = count % RECENTS_MAX_COLS
  if (rem === 0 || index < count - rem) return null
  const slot = index - (count - rem)
  const tracks = recentsTrackCount(count)
  return {
    row: Math.floor(index / RECENTS_MAX_COLS) + 1,
    columnStart: 1 + (tracks - rem * 2) / 2 + slot * 2,
  }
}
