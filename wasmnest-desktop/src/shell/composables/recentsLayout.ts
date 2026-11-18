/**
 * 多任务卡片带尺寸解算（`ShellTaskSwitcher` 专用；纯函数，不碰 DOM）
 *
 * 产品口径：
 * - 卡片越少越大：1 张卡独占一行，吃满整条带高（2026-11-06 撤除「单卡不得比
 *   两张卡更大」的纯宽度上限，见 `recentsCardMaxWidth`）；
 * - 卡片越多越小，4 张起分 2 行，尺寸随行高减半；
 * - 第 7 张起（超过 2 行）不再继续缩小，改为整带纵向滚动。
 *
 * 关于「卡片太扁」（2026-11-06 用户反馈与实测结论，两轮定稿 + 2026-11-07 收口）：
 *
 * 第一轮修的是**高度没被当成主变量**：旧解算是宽度优先——先按带宽均分定卡宽，卡高
 * 只能被动跟随，2–3 张并排时卡高锁在 300–480（窗口高 800）。改成高度优先后卡片能
 * 用满纵向空间，但暴露出第二个问题：卡宽乘了收缩系数，**缩略区也跟着被压窄**，
 * 缩略区比例从 16:10 掉到 1.41:1（3 张卡时 1.13:1），contain 缩放只能左右撑满、
 * 上下空出 34–52px——看起来就是「卡片里有大块空白」。
 *
 * 定稿口径（2026-11-07 用户裁决「铺满优先」）：**先定卡高，卡宽由缩略区比例反解，
 * 不再对外框乘收缩系数**。
 *   缩略区宽 = (卡高 - 信息条) × aspect
 *   卡宽     = 缩略区宽 + 描边
 * 缩略区比例因此恒等于应用区比例，contain 正好铺满、零留边；卡片外框与缩略区同比例。
 * 曾试过「外框 × 0.88」实现「宽度稍微减少」，但它会让缩略区比例 = 0.88 × aspect，
 * contain 必然上下留边（1 张卡实测 800/569 = 1.41）——两条要求在 contain + 不裁切
 * 的前提下互斥，最终按「铺满」定稿，收缩系数与 `recentsCardMaxWidth` 一并退役。
 *
 * 仍需接受的几何事实：2 张及以上横向并排时卡片**填不满整条带高**——16:10 的比例
 * 锁死后，1280 窗口里两张卡各最多 610 宽、卡高只到 431，而带高 734。要填满得让
 * 卡宽到 1095、两张共 2206 > 带宽 1236，物理上不可行。这部分留白是居中的正确表现，
 * 不要再拉高卡片——那会让缩略区比例失真、contain 缩放重新出现留边。
 *
 * 卡片形状（2026-11-04 用户裁决，取代 2026-11-01 的竖版 3:4）：卡片 = 顶部信息条 +
 * 缩略区，缩略区的宽高比 = **应用区整幅宽高比**（默认 16:10，运行期按实例实测传入）。
 * 缩略区展示的是应用整页且按 contain 缩放（见 `mount/appSurfaceRegistry`），比例一致
 * 时整页正好铺满缩略区、不留边也不裁切；竖版卡片配横版应用页只会剩大片空白。
 * 所以这里解算的是「**缩略区**比例 + 信息条高度」，不是卡片的宽高比。
 *
 * 带尺寸由调用方实测后传入（内边距 / 滚动条已由调用方扣掉）：**不能**改成 CSS
 * 容器查询——WebKitGTK 下 `container-type: size` 的高度解析为 0，卡片会塌成不可见
 * （2026-10-23 实测，见 `__tests__/shell/recentsWiring.test.ts` 同条回归锁）。
 */

/** 每行最多几张卡（产品口径：最多三列） */
export const RECENTS_MAX_COLS = 3
/** 视野内最多几行；超出的行改为纵向滚动（不再缩小） */
export const RECENTS_MAX_VISIBLE_ROWS = 2
/** 网格轨道数上限：三列拆成 6 个半列轨道，每张卡跨 2 轨 */
export const RECENTS_GRID_TRACKS = 6

/**
 * 缩略区默认宽高比（宽 / 高）——桌面应用区多为横版 16:10。
 *
 * 运行期由调用方按保活实例实测的应用区尺寸传入（`appViewportAspect`）：
 * 比例跟真实应用区一致，contain 缩放才会正好铺满缩略区。这个默认值只用于
 * 「还没量到任何实例」的首帧与单测（`.ts-card` 的 CSS 兜底也用它）。
 */
export const RECENTS_PREVIEW_ASPECT = 16 / 10
/** 允许的缩略区比例区间：异常实测值（0 / 极端窄高）不得把卡片解算成怪形状 */
export const RECENTS_PREVIEW_ASPECT_MIN = 1.2
export const RECENTS_PREVIEW_ASPECT_MAX = 2.6

/**
 * 缩略区之外的高度（px）：卡片信息条 + 卡片上下描边。
 *
 * `.ts-meta` = 图标 30 + 上下 padding 9×2 + 下描边 1 = 49，卡片上 / 下描边各 1 → 51。
 * 运行期由 `ShellTaskSwitcher` 直接量信息条 DOM 后覆盖（`--ui-scale` / 样式改动都跟得上），
 * 这里是「量不到时」与单测的兜底值。
 */
export const RECENTS_CARD_CHROME = 51
/** 缩略区之外的宽度（px）：卡片左右描边各 1 */
export const RECENTS_CARD_INSET = 2

/**
 * 卡高上下限（px，绝对像素）——2026-11-06 用户裁决
 *
 * 用户原话：「卡片有最大最小高度限制，宽度稍微减少，高度加高」。
 *
 * 这两个是**视觉口径**的硬边界：卡太小缩略区读不清，卡太大就成了整屏大图、
 * 丢掉「一眼看全多个任务」的语义。它们与「按行高比例」两条约束**同时**生效
 * （取交集），因为：
 * - 只有像素上下限 → 矮窗口两行时 360×2 会撑破带子；
 * - 只有比例 → 大窗口下行高很大，1 张卡会涨到 900+（实测 1920×1080 → 933）。
 */
export const RECENTS_CARD_MIN_HEIGHT = 300
export const RECENTS_CARD_MAX_HEIGHT = 620

/**
 * 卡高相对**可用行高**的伸缩区间（与像素上下限取交集）
 *
 * 行高是物理上限（永不溢出卡片带），比例负责「尽量用满」：
 * - 上限 0.94：留一点余量，卡片不贴死带边；
 * - 下限 0.55：即便带很矮，卡片也占住一半以上，不塌成一条。
 */
export const RECENTS_CARD_MAX_HEIGHT_RATIO = 0.94
export const RECENTS_CARD_MIN_HEIGHT_RATIO = 0.55

/** 卡片形状参数：缩略区比例 + 缩略区之外占用的高 / 宽 */
export interface RecentsCardMetrics {
  /** 缩略区宽高比（宽 / 高）= 应用区整幅宽高比 */
  aspect: number
  /** 缩略区之外的固定高度（信息条 + 卡片上下描边，px） */
  chrome: number
  /** 缩略区之外的固定宽度（卡片左右描边，px） */
  inset: number
}

/** 量不到实测值时的默认形状（与 `.ts-card` / `.ts-meta` 的 CSS 同源） */
export const DEFAULT_RECENTS_METRICS: RecentsCardMetrics = {
  aspect: RECENTS_PREVIEW_ASPECT,
  chrome: RECENTS_CARD_CHROME,
  inset: RECENTS_CARD_INSET,
}

/** 把实测 / 外部传入的比例夹到可用区间；非法值回默认（0 / NaN / 负数） */
export function normalizePreviewAspect(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return RECENTS_PREVIEW_ASPECT
  return Math.min(RECENTS_PREVIEW_ASPECT_MAX, Math.max(RECENTS_PREVIEW_ASPECT_MIN, aspect))
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

/*
 * 已退役的两条派生：
 * - `recentsCardHeight(width)`（卡宽 → 卡高）——2026-11-06 改高度优先后，卡高由
 *   「卡数 + 带高」解算、卡宽反而是派生物，任何 width → height 的反解都会给出偏矮
 *   的卡高（实测 802 → 551，真实 620），对不上 grid 行高；
 * - `recentsCardMaxWidth(band)`（「1 张卡不得比 2 张大」）——该裁决 2026-11-06 撤除，
 *   函数只剩测试引用。
 * 两者已删除，尺寸唯一入口 = `recentsCardSize`，缩略区 = `recentsThumbSize`。
 */

/** 解算结果：卡片的高与宽（px） */
export interface RecentsCardSize {
  /** 卡高（含信息条与描边） */
  height: number
  /** 卡宽（含描边） */
  width: number
  /**
   * 缩略区盒子（实例 contain 缩放的依据）的实际宽度（px）= 卡宽 − 左右描边
   *
   * 与 `width` 只差描边——缩放面必须按这个**真实盒宽**算，不要另算一遍。
   */
  thumbWidth: number
}

/**
 * 单张卡尺寸（高 + 宽）——**高度优先 + 铺满带高**（2026-11-06 用户裁决）
 *
 * 用户原话：「卡片有最大最小高度限制，宽度稍微减少，高度加高」+
 * 「卡片里面的内容应该跟着卡片宽高铺满显示区域」。
 *
 * 解算顺序：
 * 1. **卡高**：行内可用高度（带高扣行间隙 / 行数）× 上限比例 0.94，夹进
 *    `[RECENTS_CARD_MIN_HEIGHT, RECENTS_CARD_MAX_HEIGHT]` 与行高本身——
 *    卡片因此总能占住这一行 94% 的高度（「高度加高」在这里）。
 * 2. **卡宽**：由缩略区按应用区比例反解（`缩略区宽 = (卡高 - 信息条) × aspect`），
 *    再 + 描边即卡宽（2026-11-07 撤除外框收缩系数，见文件头）。
 *    缩略区宽高比因此恒等于应用区比例 → contain 缩放零留边（「铺满」）。
 * 3. **放不下就收窄**：卡宽超过列宽时，把缩略区**等比**缩到列宽能容下的尺寸。
 *    这是几何上唯一的办法：1280 窗口里每行 3 张只有 ~401px 可用，按「吃满带高」
 *    反推要 1100+px，横向物理放不下。等比缩小时缩略区比例不变，画面仍铺满，
 *    变的只是卡片整体大小（3 张 / 行时卡片明显小于 1–2 张 / 行时的卡片）。
 *
 * 与旧实现的本质区别：
 * - 旧版「宽度优先」先按带宽均分定卡宽、卡高被动跟随，2–3 张并排时卡高锁在
 *   300–480（窗口高 800）——这就是用户说的「太扁」；
 * - 中途一版把收缩系数乘在缩略区宽度上，缩略区比例从 16:10 掉到 1.13:1，
 *   contain 只能左右撑满、上下空出 50+px——这就是用户说的「内容没铺满」。
 *
 * @returns {0,0,0} = 还量不到带尺寸（首帧测量前 / 无布局的测试环境）：调用方用 CSS 兜底
 */
export function recentsCardSize(
  count: number,
  band: RecentsBand,
  metrics = DEFAULT_RECENTS_METRICS,
): RecentsCardSize {
  const empty: RecentsCardSize = { height: 0, width: 0, thumbWidth: 0 }
  if (!(count > 0) || !(band.width > 0) || !(band.height > 0)) return empty
  const { cols, rows } = recentsGridShape(count)
  const aspect = normalizePreviewAspect(metrics.aspect)

  // 1) 卡高：行高 × 0.94，夹进像素上下限与行高本身（物理上限，超了就是溢高）
  const rowHeight = (band.height - band.gap * (rows - 1)) / rows
  const height = clampCardHeight(rowHeight * RECENTS_CARD_MAX_HEIGHT_RATIO, rowHeight)
  if (!(height > metrics.chrome)) return empty

  // 2) 卡宽：缩略区按应用区比例反解，卡宽 = 缩略区宽 + 描边（同比例、零留边）
  const thumbWidth = Math.floor((height - metrics.chrome) * aspect)
  const width = thumbWidth + metrics.inset

  // 3) 横向放不下（每行 3 张 / 窄窗口）：保持缩略区比例，**等比**缩到列宽
  //    列宽是 content-box 口径的盒宽上限（不含左右描边）
  const columnWidth = Math.max(0, (band.width - band.gap * (cols - 1)) / cols - metrics.inset)
  if (thumbWidth <= columnWidth) return { height, width, thumbWidth }

  // 缩略区吃满列宽 → 卡高由缩略区按比例反解，且不得超行高
  const fitThumbWidth = Math.max(0, Math.floor(columnWidth))
  const fitHeight = Math.min(
    Math.floor(rowHeight),
    Math.round(fitThumbWidth / aspect + metrics.chrome),
  )
  return { height: fitHeight, width: fitThumbWidth + metrics.inset, thumbWidth: fitThumbWidth }
}

/**
 * 卡高夹取：像素上下限 ∩ 行高比例区间 ∩ 可用行高
 *
 * 三道约束缺一不可：
 * - `[RECENTS_CARD_MIN_HEIGHT, RECENTS_CARD_MAX_HEIGHT]`：视觉口径，太小读不清、
 *   太大像整屏；
 * - `rowHeight × [MIN_RATIO, MAX_RATIO]`：矮窗口里跟着带子缩，不塌成一条；
 * - `≤ rowHeight`：物理上限，永不溢出卡片带（两行时尤其关键）。
 *
 * 注意 `RECENTS_CARD_MIN_HEIGHT` 在这里**不是无条件下限**：两行的大窗口里行高
 * 可能只有 ~250（1200×600），此时上限优先——宁可小于 300 也不能溢出表格。
 */
function clampCardHeight(height: number, rowHeight: number): number {
  if (!(height > 0) || !(rowHeight > 0)) return 0
  const lower = Math.max(RECENTS_CARD_MIN_HEIGHT, rowHeight * RECENTS_CARD_MIN_HEIGHT_RATIO)
  const upper = Math.min(RECENTS_CARD_MAX_HEIGHT, rowHeight * RECENTS_CARD_MAX_HEIGHT_RATIO, rowHeight)
  // 行高太小时（upper < lower）以行高为准，宁可小也不能溢出
  if (upper < lower) return Math.round(Math.max(0, upper))
  return Math.round(Math.min(upper, Math.max(lower, height)))
}

/**
 * 单张卡宽度（px，向下取整：亚像素会把最后一张挤出换行、白赚一条滚动条）
 *
 * 保留此函数作为 `recentsCardSize().width` 的薄封装，供只需要宽度的调用点使用；
 * 需要卡高（`--ts-card-h`）时必须用 `recentsCardSize`，否则宽度与高度会各自解算、
 * 对不上（高度优先的口径下，宽度是由高度派生的）。
 *
 * @returns 0 = 还量不到带尺寸（首帧测量前 / 无布局的测试环境）：调用方保留 CSS 兜底宽度
 *
 * 注意：这是**卡宽**，不等于缩略区宽（卡宽 = 缩略区宽 + 描边，差 2px 描边）。
 * 缩略区尺寸用 `recentsThumbSize`。
 */
export function recentsCardWidth(
  count: number,
  band: RecentsBand,
  metrics = DEFAULT_RECENTS_METRICS,
): number {
  return recentsCardSize(count, band, metrics).width
}

/**
 * 缩略区尺寸（px）——实例 contain 缩放的依据，必须与卡片盒子的实际内宽一致
 *
 * 卡片矩形是 `卡宽 × 卡高`，缩略区只是它扣掉信息条的那块。CSS 上缩略区用
 * `1fr` 自动填满，所以它的宽度就是**卡宽减左右描边**；高度是卡高减信息条。
 * 但实例的缩放**不能**等 DOM 自己撑开再量：卡片带在首帧还没被写成
 * `--ts-card-w` 时是兜底三等分，`ResizeObserver` 回调里量到的宽度会和最终卡宽
 * 差一截，画面先按错的比例缩一次再跳。这里直接把解算结果交给缩放面，首帧即对。
 *
 * @returns {0,0} = 还量不到带尺寸（调用方让缩放面自己量盒子）
 */
export function recentsThumbSize(
  count: number,
  band: RecentsBand,
  metrics = DEFAULT_RECENTS_METRICS,
): { width: number; height: number } {
  const size = recentsCardSize(count, band, metrics)
  if (!(size.width > 0) || !(size.height > 0)) return { width: 0, height: 0 }
  return {
    width: Math.max(0, size.thumbWidth),
    height: Math.max(0, size.height - metrics.chrome),
  }
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
