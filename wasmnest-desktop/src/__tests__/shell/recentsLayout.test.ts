/**
 * 多任务卡片尺寸方向（2026-10-23 用户裁决的回归锁；2026-11-01 / 2026-11-06 三轮修正）
 *
 * 需求原话：只有一个卡片时卡片居中且取最大宽高；有多个卡片时应当**缩小**，
 * 最小缩到「两行三列」网格排布时的自适应大小；超过两行改为滚动查看。
 * 上一版实现方向恰好相反（卡宽固定三等分 + 420px 上限 → 单卡最小），本文件锁死方向。
 *
 * 2026-11-01 用户裁决：单卡要有**上限**（桌面单卡曾达到 ~1250×780，几乎整屏）；
 * 第二轮进一步定为「**不得比两张卡大**」（2026-11-06 已撤除，改为高度优先）。
 * 2026-11-04 用户裁决：卡片形状跟**应用区整幅比例**（默认 16:10）走——缩略区与页面
 * 同比例，contain 缩放才能正好铺满（竖版 3:4 卡配横版页面必然剩大片空白，已退役）。
 * 2026-11-06 用户裁决：「卡片有最大最小高度限制，宽度稍微减少，高度加高」+
 * 「卡片里面的内容应该跟着卡片宽高铺满显示区域」。定稿口径：
 *   - 高度是主变量（行高 × 比例，夹进像素上下限）；
 *   - **缩略区比例恒等于应用区比例**，卡宽的收缩系数只作用在卡片外框上；
 *   - 因此缩略区 width / height 恒等于 aspect，contain 缩放零留边。
 *
 * 三层断言：
 * 1. 方向：卡片数增加时卡宽单调不增，第 7 张起与第 6 张同尺寸（不再缩，改滚动）；
 * 2. 几何：解算出的卡片在带内既不溢宽也不溢高（2 行恰好放下，3 行必然溢出 → 滚动），
 *    且卡高恒在 [MIN, MAX] 与行高的 [55%, 94%] 交集内；
 * 3. 铺满：缩略区比例 == 应用区比例（这是「内容铺满、零留边」的充要条件），
 *    且组件真的把解算出的缩略区尺寸交给了 `AppSurfaceTile`；
 * 4. 常量同源：`.ts-card` 的 aspect-ratio 兜底值、CSS 里缩略区不留额外留白。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  DEFAULT_RECENTS_METRICS,
  RECENTS_CARD_CHROME,
  RECENTS_CARD_INSET,
  RECENTS_CARD_MAX_HEIGHT,
  RECENTS_CARD_MAX_HEIGHT_RATIO,
  RECENTS_CARD_MIN_HEIGHT,
  RECENTS_CARD_MIN_HEIGHT_RATIO,
  RECENTS_GRID_TRACKS,
  RECENTS_MAX_COLS,
  RECENTS_MAX_VISIBLE_ROWS,
  RECENTS_PREVIEW_ASPECT,
  RECENTS_PREVIEW_ASPECT_MAX,
  RECENTS_PREVIEW_ASPECT_MIN,
  normalizePreviewAspect,
  recentsCardPlacement,
  recentsCardSize,
  recentsCardWidth,
  recentsGridShape,
  recentsThumbSize,
  recentsTrackCount,
  type RecentsBand,
} from '@/shell/composables/recentsLayout'

/** 1440×900 窗口扣掉壳内边距 / 标题条后的卡片带（内容盒） */
const BAND_16_9: RecentsBand = { width: 1396, height: 796, gap: 16 }
/** 1280×800 窗口实测的卡片带（内容盒，已扣内边距与滚动条） */
const BAND_WINDOWED: RecentsBand = { width: 1236, height: 734, gap: 16 }
/** 800×600 最小窗口：宽度是瓶颈 */
const BAND_MIN: RecentsBand = { width: 700, height: 470, gap: 16 }

const { aspect: ASPECT, chrome: CHROME, inset: INSET } = DEFAULT_RECENTS_METRICS

describe('卡片数 → 网格形状（最多 3 列，尺寸行数封顶 2 行）', () => {
  it.each([
    [1, { cols: 1, rows: 1 }],
    [2, { cols: 2, rows: 1 }],
    [3, { cols: 3, rows: 1 }],
    [4, { cols: 3, rows: 2 }],
    [6, { cols: 3, rows: 2 }],
    [7, { cols: 3, rows: 2 }],
    [12, { cols: 3, rows: 2 }],
  ])('%i 张 → %o', (count, shape) => {
    expect(recentsGridShape(count)).toEqual(shape)
  })

  it('行数封顶 2：第 7 张起形状不再变化（尺寸不缩，改滚动）', () => {
    expect(recentsGridShape(7)).toEqual(recentsGridShape(6))
    expect(recentsGridShape(40)).toEqual(recentsGridShape(6))
  })

  it('常量口径：最多 3 列、可视 2 行、缩略区横版 16:10、卡高上下限有序', () => {
    expect(RECENTS_MAX_COLS).toBe(3)
    expect(RECENTS_MAX_VISIBLE_ROWS).toBe(2)
    // 2026-11-04 用户裁决：卡片形状跟应用区比例（横版），与页面同比例才能铺满
    expect(RECENTS_PREVIEW_ASPECT).toBeCloseTo(16 / 10)
    expect(RECENTS_PREVIEW_ASPECT).toBeGreaterThan(1)
    // 缩略区之外的固定开销：信息条 + 描边
    expect(RECENTS_CARD_CHROME).toBeGreaterThan(0)
    expect(RECENTS_CARD_INSET).toBeGreaterThan(0)
    // 2026-11-06 用户裁决「卡片有最大最小高度限制」：上下限必须有序且区间合理
    expect(RECENTS_CARD_MIN_HEIGHT).toBeLessThan(RECENTS_CARD_MAX_HEIGHT)
    expect(RECENTS_CARD_MIN_HEIGHT).toBeGreaterThanOrEqual(240)
    expect(RECENTS_CARD_MAX_HEIGHT).toBeLessThanOrEqual(720)
    // 行高比例区间必须收在 (0, 1]：> 1 会溢出卡片带
    expect(RECENTS_CARD_MIN_HEIGHT_RATIO).toBeGreaterThan(0)
    expect(RECENTS_CARD_MAX_HEIGHT_RATIO).toBeLessThanOrEqual(1)
    expect(RECENTS_CARD_MIN_HEIGHT_RATIO).toBeLessThan(RECENTS_CARD_MAX_HEIGHT_RATIO)
  })

  it('实测比例夹到可用区间（0 / 负数 / NaN → 默认；极端值不产出怪形状）', () => {
    expect(normalizePreviewAspect(0)).toBeCloseTo(RECENTS_PREVIEW_ASPECT)
    expect(normalizePreviewAspect(-2)).toBeCloseTo(RECENTS_PREVIEW_ASPECT)
    expect(normalizePreviewAspect(Number.NaN)).toBeCloseTo(RECENTS_PREVIEW_ASPECT)
    expect(normalizePreviewAspect(0.4)).toBeCloseTo(RECENTS_PREVIEW_ASPECT_MIN)
    expect(normalizePreviewAspect(9)).toBeCloseTo(RECENTS_PREVIEW_ASPECT_MAX)
    expect(normalizePreviewAspect(1.93)).toBeCloseTo(1.93)
  })
})

describe('高度优先解算：卡高上下限 + 行高比例三重交集（2026-11-06 用户裁决）', () => {
  /**
   * 期望卡高：先取「行高 × 0.94 夹进像素上下限」，再按列宽等比收窄。
   *
   * 这是「卡片有最大最小高度限制，高度加高」+「横向放不下就等比缩小」的完整算术表达。
   * 收窄分支的存在是几何必然：每行 3 张时列宽只有 ~400px，按吃满带高反推要 1100+px。
   */
  function expectedHeight(count: number, band: RecentsBand): number {
    const { cols, rows } = recentsGridShape(count)
    const rowHeight = (band.height - band.gap * (rows - 1)) / rows
    const lower = Math.max(RECENTS_CARD_MIN_HEIGHT, rowHeight * RECENTS_CARD_MIN_HEIGHT_RATIO)
    const upper = Math.min(
      RECENTS_CARD_MAX_HEIGHT,
      rowHeight * RECENTS_CARD_MAX_HEIGHT_RATIO,
      rowHeight,
    )
    const target = rowHeight * RECENTS_CARD_MAX_HEIGHT_RATIO
    const height = upper < lower ? Math.round(upper) : Math.round(Math.min(upper, Math.max(lower, target)))
    const thumbWidth = Math.floor((height - CHROME) * ASPECT)
    const columnWidth = Math.max(0, (band.width - band.gap * (cols - 1)) / cols - INSET)
    if (thumbWidth <= columnWidth) return height
    const fitThumbWidth = Math.max(0, Math.floor(columnWidth))
    return Math.min(Math.floor(rowHeight), Math.round(fitThumbWidth / ASPECT + CHROME))
  }

  it.each([
    ['1280×800', BAND_WINDOWED],
    ['1440×900', BAND_16_9],
    ['800×600', BAND_MIN],
  ])('%s：每档卡高 == 行高比例 ∩ 像素上下限（放不下时按列宽等比收窄）', (_label, band) => {
    for (const count of [1, 2, 3, 4, 5, 6, 9, 12]) {
      expect(recentsCardSize(count, band).height, `${count} 张卡高`).toBe(
        expectedHeight(count, band),
      )
    }
  })

  it('单卡 / 两卡能用满高度，三卡起受列宽约束（用户实测「太扁」的主战场）', () => {
    // 1280 窗口：1 张独占整行 → 只受像素上限约束，高度顶到 620；
    // 2 / 3 张并排时列宽是瓶颈，等比收窄后卡高由「列宽 ÷ 比例」决定——几何必然。
    // 数值（2026-11-07 撤除外框收缩后）：1 张 620、2 张 431、3 张 300（贴住像素下限，
    // 因为 3 张的列宽只有 ~399，比例锁死后自然高度就是 300 + 信息条）。
    expect(recentsCardSize(1, BAND_WINDOWED).height).toBe(RECENTS_CARD_MAX_HEIGHT)
    expect(recentsCardSize(2, BAND_WINDOWED).height).toBe(431)
    expect(recentsCardSize(3, BAND_WINDOWED).height).toBe(RECENTS_CARD_MIN_HEIGHT)
    // 单调性：卡片越少越大，且三卡不会掉到下限以下
    expect(recentsCardSize(1, BAND_WINDOWED).height).toBeGreaterThan(
      recentsCardSize(2, BAND_WINDOWED).height,
    )
    expect(recentsCardSize(2, BAND_WINDOWED).height).toBeGreaterThan(
      recentsCardSize(3, BAND_WINDOWED).height,
    )
    expect(recentsCardSize(3, BAND_WINDOWED).height).toBeGreaterThanOrEqual(
      RECENTS_CARD_MIN_HEIGHT,
    )
  })

  it('卡高永不超过像素上限（大窗口下单卡不会涨成整屏大图）', () => {
    const huge: RecentsBand = { width: 3000, height: 2000, gap: 16 }
    expect(recentsCardSize(1, huge).height).toBeLessThanOrEqual(RECENTS_CARD_MAX_HEIGHT)
  })

  it('卡高恒 ≤ 行高（矮窗口里两行也绝不溢出卡片带）', () => {
    for (const band of [BAND_WINDOWED, BAND_MIN, { width: 1236, height: 500, gap: 16 }]) {
      for (const count of [1, 3, 6]) {
        const { rows } = recentsGridShape(count)
        const rowHeight = (band.height - band.gap * (rows - 1)) / rows
        expect(recentsCardSize(count, band).height, `${count} 张`).toBeLessThanOrEqual(
          Math.floor(rowHeight),
        )
      }
    }
  })

  it('单卡明显高于两张卡并排时的每张（旧宽度优先口径下两者同高）', () => {
    const one = recentsCardSize(1, BAND_WINDOWED)
    const two = recentsCardSize(2, BAND_WINDOWED)
    expect(one.height).toBeGreaterThan(two.height)
  })
})

describe('铺满：缩略区比例 == 应用区比例（内容零留边的充要条件）', () => {
  it.each([
    ['1280×800', BAND_WINDOWED],
    ['1440×900', BAND_16_9],
    ['800×600', BAND_MIN],
    ['1200×600 矮窗口', { width: 1156, height: 534, gap: 16 }],
    ['2560×1400 超宽', { width: 2400, height: 1320, gap: 16 }],
  ])('%s：所有档位的缩略区比例恒等于 aspect', (_label, band) => {
    for (const count of [1, 2, 3, 4, 6, 12]) {
      const thumb = recentsThumbSize(count, band)
      expect(thumb.width, `${count} 张`).toBeGreaterThan(0)
      expect(thumb.height, `${count} 张`).toBeGreaterThan(0)
      // 宽度向下取整带来的误差 < 0.5%，contain 缩放的留边不足 1px
      expect(Math.abs(thumb.width / thumb.height - ASPECT), `${count} 张缩略区比例`).toBeLessThan(
        0.01,
      )
    }
  })

  it('卡片与缩略区同比例：卡宽 = 缩略区宽 + 描边（外框收缩已退役）', () => {
    // 1 张卡独占整行、不被列宽收窄 → 走「高度优先」分支，能验证外框与缩略区的关系。
    // 2026-11-07 用户裁决「铺满优先」：曾把外框收窄到 88%，缩略区随之变成
    // 0.88 × aspect，contain 必然上下留边——两条要求互斥，最终保铺满。
    const size = recentsCardSize(1, BAND_WINDOWED)
    expect(size.width).toBe(size.thumbWidth + INSET)
    // 比例说的是**缩略区**（卡高含信息条，卡框比例必然比 aspect 更「立」）
    expect(size.thumbWidth / (size.height - CHROME)).toBeCloseTo(ASPECT, 2)
  })

  it('缩略区尺寸 = 卡宽扣描边 / 卡高扣信息条（与 DOM 盒子的实际尺寸同源）', () => {
    for (const count of [1, 2, 3, 6]) {
      const size = recentsCardSize(count, BAND_WINDOWED)
      // 断言右手边独立写成 width − INSET：若 `thumbWidth` 退回「收缩前的按比例宽」，
      // 这条必须红（旧写法用 size.thumbWidth 当期望值，等价于自证）。
      expect(recentsThumbSize(count, BAND_WINDOWED)).toEqual({
        width: size.width - INSET,
        height: size.height - CHROME,
      })
    }
  })

  it('实测应用区比例改动会等比例作用到卡片与缩略区（两者不脱钩）', () => {
    const wide = { aspect: 1.93, chrome: CHROME, inset: INSET }
    const narrow = { aspect: 1.4, chrome: CHROME, inset: INSET }
    // 用 1 张卡（独占整行、不被列宽收窄）才能观察到「比例 → 尺寸」的纯映射
    const w = recentsThumbSize(1, BAND_WINDOWED, wide)
    const n = recentsThumbSize(1, BAND_WINDOWED, narrow)
    expect(Math.abs(w.width / w.height - 1.93)).toBeLessThan(0.02)
    expect(Math.abs(n.width / n.height - 1.4)).toBeLessThan(0.02)
    // 同一卡高下，宽比例反解出的宽度更大 → 卡也更宽
    expect(n.width).toBeLessThan(w.width)
    expect(recentsCardSize(1, BAND_WINDOWED, narrow).width).toBeLessThan(
      recentsCardSize(1, BAND_WINDOWED, wide).width,
    )
    // 无论哪种比例，缩略区一律铺满其自身盒子（比例恒等）
    const frame = recentsCardSize(1, BAND_WINDOWED, narrow)
    expect(Math.abs(frame.thumbWidth / (frame.height - CHROME) - 1.4)).toBeLessThan(0.02)
  })

  it('组件把解算出的缩略区尺寸交给 AppSurfaceTile（否则缩放只能等 DOM 自己量）', () => {
    const vue = readFileSync('src/shell/components/ShellTaskSwitcher.vue', 'utf-8')
    expect(vue).toContain(':thumb-width="thumbSize.width"')
    expect(vue).toContain(':thumb-height="thumbSize.height"')
    const tile = readFileSync('src/shell/mount/AppSurfaceTile.vue', 'utf-8')
    expect(tile, '解算尺寸必须透传给表面注册表的缩放接口').toContain(
      'presentAppSurfaceInPreview(props.appId, box, solvedBox()',
    )
    expect(tile).toContain('fitAppSurfacePreview(props.appId, box)')
  })

  it('contain 缩放不变：整页必须看全，不得改回 cover 裁切', () => {
    const src = readFileSync('src/shell/mount/appSurfaceRegistry.ts', 'utf-8')
    expect(src, '缩放必须取 Math.min（contain）').toMatch(
      /Math\.min\(boxWidth \/ surfaceSize\.width, boxHeight \/ surfaceSize\.height\)/,
    )
  })
})

describe('方向：卡片越少越大，第 6 张起封底', () => {
  it('卡片数增加时卡宽单调不增（上一版方向相反的回归点）', () => {
    const widths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12].map((n) => recentsCardWidth(n, BAND_16_9))
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i - 1], `第 ${i} 张起不许变大`).toBeGreaterThanOrEqual(widths[i] as number)
    }
    expect(widths[0], '单卡必须比 6 张时大').toBeGreaterThan(widths[5] as number)
  })

  it('最小尺寸 = 两行三列的自适应格：4–6 张同尺寸，第 7 张起不再缩小', () => {
    const twoByThree = recentsCardWidth(6, BAND_16_9)
    for (const count of [4, 5, 6]) {
      expect(recentsCardWidth(count, BAND_16_9)).toBe(twoByThree)
    }
    for (const count of [7, 8, 9, 12, 32]) {
      expect(recentsCardWidth(count, BAND_16_9)).toBe(twoByThree)
    }
  })

  it('单卡不再被「两张卡格宽」锁死（2026-11-06 撤除该纯宽度上限）', () => {
    const one = recentsCardSize(1, BAND_WINDOWED)
    const two = recentsCardSize(2, BAND_WINDOWED)
    expect(one.width).toBeGreaterThan(two.width)
    expect(one.height).toBeGreaterThan(two.height)
  })

  it('窄窗口：1 张 > 2 张 > 3 张，张数越多越小', () => {
    const [w1, w2, w3] = [1, 2, 3].map((n) => recentsCardWidth(n, BAND_MIN))
    expect(w1).toBeGreaterThan(w2)
    expect(w2).toBeGreaterThan(w3)
  })
})

describe('几何：解算结果在带内不溢宽，两行放得下、三行必然滚动', () => {
  it.each([
    ['16:9 标准窗口', BAND_16_9],
    ['1280×800 窗口化', BAND_WINDOWED],
    ['800×600 最小窗口', BAND_MIN],
  ])('%s：3 列不溢宽，2 行不溢高', (_label, band) => {
    const { width, height } = recentsCardSize(6, band)
    expect(width * 3 + band.gap * 2).toBeLessThanOrEqual(band.width)
    expect(height * 2 + band.gap).toBeLessThanOrEqual(band.height)
  })

  it('任何时候都不溢宽、不溢高', () => {
    for (const band of [
      BAND_WINDOWED,
      BAND_16_9,
      { width: 1236, height: 500, gap: 16 },
      { width: 700, height: 470, gap: 16 },
      { width: 3000, height: 1400, gap: 16 },
    ]) {
      for (const count of [1, 2, 3, 4, 6]) {
        const { width, height } = recentsCardSize(count, band)
        const { cols, rows } = recentsGridShape(count)
        expect(
          width * cols + band.gap * (cols - 1),
          `${count} 张 @ ${band.width}×${band.height} 溢宽`,
        ).toBeLessThanOrEqual(band.width)
        expect(
          height * rows + band.gap * (rows - 1),
          `${count} 张 @ ${band.width}×${band.height} 溢高`,
        ).toBeLessThanOrEqual(band.height)
      }
    }
  })

  it('第 7 张起必然溢出两行（滚动的前提：不再继续缩小卡片）', () => {
    const { height } = recentsCardSize(6, BAND_16_9)
    expect(height * 3 + BAND_16_9.gap * 2).toBeGreaterThan(BAND_16_9.height)
  })

  it('缩略区盒宽 = 卡宽 − 描边（收缩只作用外框，不得把缩略区按比例压窄）', () => {
    // 2026-11-07 修：曾把「按比例反解出的内容宽」当缩略区宽导出（比真实盒宽大 12%），
    // 照文档接线会让实例按过宽的盒子缩放、画面横向溢出被卡片裁掉。
    for (const count of [1, 2, 3, 6]) {
      const size = recentsCardSize(count, BAND_16_9)
      const thumb = recentsThumbSize(count, BAND_16_9)
      expect(thumb.width, `${count} 张缩略区宽`).toBe(size.width - INSET)
      expect(size.thumbWidth, `${count} 张解算字段`).toBe(size.width - INSET)
      expect(thumb.height, `${count} 张缩略区高`).toBe(size.height - CHROME)
    }
  })

  it('带尺寸没量到（0 / 负数）或没有卡片 → 0，调用方保留 CSS 兜底', () => {
    expect(recentsCardWidth(0, BAND_16_9)).toBe(0)
    expect(recentsCardWidth(3, { width: 0, height: 796, gap: 16 })).toBe(0)
    expect(recentsCardWidth(3, { width: 1396, height: 0, gap: 16 })).toBe(0)
    expect(recentsCardWidth(3, { width: -1, height: -1, gap: 16 })).toBe(0)
    expect(recentsThumbSize(3, { width: 0, height: 0, gap: 16 })).toEqual({ width: 0, height: 0 })
  })

  it('带小到放不下时不会返回负数（负数轨道宽会让卡片直接消失）', () => {
    expect(recentsCardWidth(3, { width: 10, height: 10, gap: 16 })).toBe(0)
    expect(recentsThumbSize(3, { width: 10, height: 10, gap: 16 }).width).toBe(0)
  })

  it('解算仍是纯函数：不读视口，只用调用方实测的带尺寸', () => {
    const src = readFileSync('src/shell/composables/recentsLayout.ts', 'utf-8')
    expect(src).not.toMatch(/innerHeight|window\.|document\./)
    // 组件侧也不该引入视口高（2026-11-06 试过一版，方向错了，已撤）
    const vue = readFileSync('src/shell/components/ShellTaskSwitcher.vue', 'utf-8')
    expect(vue, '旧方案的 viewportHeight 接线应已撤除').not.toMatch(/viewportHeight/)
  })
})

describe('与组件样式同源', () => {
  it('.ts-card 的 aspect-ratio 兜底必须与实测尺寸同源（`--ts-card-ratio`）', () => {
    const src = readFileSync('src/shell/components/ShellTaskSwitcher.vue', 'utf-8')
    const rule = src.match(/\.ts-card\s*\{[^}]*aspect-ratio:\s*var\(--ts-card-ratio,\s*([\d.]+)\s*\/\s*([\d.]+)\)/)
    expect(rule, '.ts-card 必须声明 aspect-ratio 兜底（var(--ts-card-ratio, …)）').not.toBeNull()
    // 兜底比例 ≈ aspect（卡片与缩略区同比例，2026-11-07 外框收缩退役）
    const ratio = Number(rule?.[1]) / Number(rule?.[2])
    expect(ratio).toBeCloseTo(ASPECT, 1)
  })

  it('组件把实测比例注入 `--ts-card-aspect`、把卡宽 / 卡高 / 卡片比例一并注入', () => {
    const src = readFileSync('src/shell/components/ShellTaskSwitcher.vue', 'utf-8')
    expect(src).toContain("'--ts-card-aspect'")
    expect(src).toContain("'--ts-card-ratio'")
    expect(src).toContain("'--ts-card-w'")
    expect(src).toContain("'--ts-card-h'")
    expect(src).toContain('appViewportAspect')
    expect(src, '信息条高度必须实测（不能只靠常量）').toContain('measureCardChrome')
  })

  it('卡片按行高拉伸（align-items: stretch）+ 行高显式注入（auto 行高会被引擎压扁）', () => {
    const src = readFileSync('src/shell/components/ShellTaskSwitcher.vue', 'utf-8')
    expect(src, '行高必须与卡高同源').toMatch(
      /\.ts-cards\s*\{[^}]*grid-auto-rows:\s*var\(--ts-card-h/,
    )
    expect(src, '卡片必须精确填满行高（否则缩略区高度靠 aspect-ratio 自算，留边）').toMatch(
      /\.ts-cards\s*\{[^}]*align-items:\s*stretch/,
    )
    expect(src, '超过 2 行必须从头排（可滚动）').toMatch(
      /\.ts-cards\.is-scrolling\s*\{[^}]*align-content:\s*start/,
    )
  })

  it('缩略区铺满卡片剩余空间（flex:1 + 无内边距），不给画面额外留白', () => {
    const src = readFileSync('src/shell/components/ShellTaskSwitcher.vue', 'utf-8')
    // 组件里同一个类有两个规则块（视觉层 pointer-events + 布局），逐个检查
    const rules = src.match(/\.ts-thumb\s*\{[^}]*\}/g) ?? []
    expect(rules.length, '.ts-thumb 必须有样式规则').toBeGreaterThan(0)
    const layout = rules.find((r) => /flex:\s*1/.test(r))
    expect(layout, '缩略区必须吃掉信息条以外的全部高度（flex:1）').toBeDefined()
    expect(layout, '缩略区不能自带内边距（会挤压画面）').not.toMatch(/padding:/)
    expect(layout, '缩略区不能留额外外边距').not.toMatch(/margin:/)
  })

  it('网格轨道数与 RECENTS_GRID_TRACKS 一致（6 半轨 = 3 列，1/2 张收窄）', () => {
    const src = readFileSync('src/shell/components/ShellTaskSwitcher.vue', 'utf-8')
    const rule = src.match(/\.ts-cards\s*\{[^}]*grid-template-columns:\s*repeat\(\s*(var\([^)]*\))/)
    expect(rule, '.ts-cards 必须声明半列网格').not.toBeNull()
    expect(rule?.[1]).toContain(`var(--ts-tracks, ${RECENTS_GRID_TRACKS})`)
    expect(recentsTrackCount(0)).toBe(RECENTS_GRID_TRACKS)
    expect(recentsTrackCount(1)).toBe(2)
    expect(recentsTrackCount(2)).toBe(4)
    expect(recentsTrackCount(3)).toBe(RECENTS_GRID_TRACKS)
    expect(recentsTrackCount(32)).toBe(RECENTS_GRID_TRACKS)
  })
})

describe('末行居中（6 半轨网格的显式位置）', () => {
  it.each([
    [0, 1, { row: 1, columnStart: 1 }],
    [0, 2, { row: 1, columnStart: 1 }],
    [1, 2, { row: 1, columnStart: 3 }],
    [3, 4, { row: 2, columnStart: 3 }],
    [3, 5, { row: 2, columnStart: 2 }],
    [4, 5, { row: 2, columnStart: 4 }],
    [6, 7, { row: 3, columnStart: 3 }],
  ])('第 %i 张（共 %i 张）→ %o', (index, count, place) => {
    expect(recentsCardPlacement(index, count)).toEqual(place)
  })

  it('整行满 3 张不接管位置（交给 CSS 自动排布）', () => {
    for (const count of [3, 6, 9]) {
      for (let i = 0; i < count; i += 1) {
        expect(recentsCardPlacement(i, count)).toBeNull()
      }
    }
  })

  it('非末行的卡不接管位置', () => {
    for (const index of [0, 1, 2]) expect(recentsCardPlacement(index, 7)).toBeNull()
  })

  it('越界 / 空清单返回 null（不写非法行列）', () => {
    expect(recentsCardPlacement(0, 0)).toBeNull()
    expect(recentsCardPlacement(-1, 3)).toBeNull()
    expect(recentsCardPlacement(3, 3)).toBeNull()
  })
})
