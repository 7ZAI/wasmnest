/**
 * 多任务卡片尺寸方向（2026-10-23 用户裁决的回归锁）
 *
 * 需求原话：只有一个卡片时卡片居中且取最大宽高；有多个卡片时应当**缩小**，
 * 最小缩到「两行三列」网格排布时的自适应大小；超过两行改为滚动查看。
 * 上一版实现方向恰好相反（卡宽固定三等分 + 420px 上限 → 单卡最小），本文件锁死方向。
 *
 * 三层断言：
 * 1. 方向：卡片数增加时卡宽单调不增，第 7 张起与第 6 张同尺寸（不再缩，改滚动）；
 * 2. 几何：解算出的卡宽在带内既不溢宽也不溢高（2 行恰好放下，3 行必然溢出 → 滚动）；
 * 3. 常量同源：`.ts-card` 的 aspect-ratio 与 RECENTS_CARD_ASPECT 必须一致。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  RECENTS_CARD_ASPECT,
  RECENTS_GRID_TRACKS,
  RECENTS_MAX_COLS,
  RECENTS_MAX_VISIBLE_ROWS,
  recentsCardHeight,
  recentsCardPlacement,
  recentsCardWidth,
  recentsGridShape,
  recentsTrackCount,
  type RecentsBand,
} from '@/shell/composables/recentsLayout'

/** 1440×900 窗口扣掉壳内边距 / 标题条后的卡片带（内容盒） */
const BAND_16_9: RecentsBand = { width: 1396, height: 796, gap: 16 }
/** 800×600 最小窗口：宽度是瓶颈 */
const BAND_MIN: RecentsBand = { width: 700, height: 470, gap: 16 }
/** 「两行三列」格子的尺寸基准：第 6 张及以后卡宽必须等于它 */
const TWO_BY_THREE = recentsCardWidth(6, BAND_16_9)

/** 卡高（由 3/4 比例派生，与 CSS aspect-ratio 同一公式） */
const cardHeight = recentsCardHeight

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

  it('常量口径：最多 3 列、可视 2 行', () => {
    expect(RECENTS_MAX_COLS).toBe(3)
    expect(RECENTS_MAX_VISIBLE_ROWS).toBe(2)
    expect(RECENTS_CARD_ASPECT).toBeCloseTo(3 / 4)
  })
})

describe('方向：卡片越少越大，第 6 张起封底', () => {
  it('单卡取带内最大 3:4 卡（宽度受带高限制，且明显大于旧的 420px 上限）', () => {
    const width = recentsCardWidth(1, BAND_16_9)
    // 宽窗口下高度是瓶颈：宽 = 0.75 × 带高（不是三等分，也不是 420）
    expect(width).toBe(Math.floor(BAND_16_9.height * RECENTS_CARD_ASPECT))
    expect(width).toBeGreaterThan(420)
    expect(cardHeight(width)).toBeLessThanOrEqual(BAND_16_9.height)
  })

  it('卡片数增加时卡宽单调不增（上一版方向相反的回归点）', () => {
    const widths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12].map((n) => recentsCardWidth(n, BAND_16_9))
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i - 1], `第 ${i} 张起不许变大`).toBeGreaterThanOrEqual(widths[i] as number)
    }
    expect(widths[0], '单卡必须比 6 张时大').toBeGreaterThan(widths[5] as number)
  })

  it('最小尺寸 = 两行三列的自适应格：4–6 张同尺寸，第 7 张起不再缩小', () => {
    for (const count of [4, 5, 6]) {
      expect(recentsCardWidth(count, BAND_16_9)).toBe(TWO_BY_THREE)
    }
    for (const count of [7, 8, 9, 12, 32]) {
      expect(recentsCardWidth(count, BAND_16_9)).toBe(TWO_BY_THREE)
    }
  })

  it('窄窗口按列均分：1 张仍最大，2 张立刻小于 1 张', () => {
    expect(recentsCardWidth(1, BAND_MIN)).toBeGreaterThan(recentsCardWidth(2, BAND_MIN))
    expect(recentsCardWidth(2, BAND_MIN)).toBeGreaterThan(recentsCardWidth(3, BAND_MIN))
    // 3 列时宽度是瓶颈：卡宽 = (带宽 - 两个 gap) / 3 向下取整
    expect(recentsCardWidth(3, BAND_MIN)).toBe(Math.floor((BAND_MIN.width - 2 * BAND_MIN.gap) / 3))
  })
})

describe('几何：解算结果在带内不溢宽，两行放得下、三行必然滚动', () => {
  it.each([
    ['16:9 标准窗口', BAND_16_9],
    ['800×600 最小窗口', BAND_MIN],
  ])('%s：3 列不溢宽，2 行不溢高', (_label, band) => {
    const width = recentsCardWidth(6, band)
    const height = cardHeight(width)
    expect(width * 3 + band.gap * 2).toBeLessThanOrEqual(band.width)
    expect(height * 2 + band.gap).toBeLessThanOrEqual(band.height)
  })

  it('第 7 张起必然溢出两行（滚动的前提：不再继续缩小卡片）', () => {
    const height = cardHeight(TWO_BY_THREE)
    expect(height * 3 + BAND_16_9.gap * 2).toBeGreaterThan(BAND_16_9.height)
  })

  it('卡高 = 卡宽 / 3:4（行高与 aspect-ratio 同一公式，不另立一套比例）', () => {
    const width = recentsCardWidth(3, BAND_16_9)
    expect(recentsCardHeight(width)).toBeCloseTo(width / RECENTS_CARD_ASPECT)
    expect(recentsCardHeight(0)).toBe(0)
    expect(recentsCardHeight(-10)).toBe(0)
  })

  it('带尺寸没量到（0 / 负数）或没有卡片 → 0，调用方保留 CSS 兜底宽度', () => {
    expect(recentsCardWidth(0, BAND_16_9)).toBe(0)
    expect(recentsCardWidth(3, { width: 0, height: 796, gap: 16 })).toBe(0)
    expect(recentsCardWidth(3, { width: 1396, height: 0, gap: 16 })).toBe(0)
    expect(recentsCardWidth(3, { width: -1, height: -1, gap: 16 })).toBe(0)
  })

  it('带小到放不下时不会返回负数（负数轨道宽会让卡片直接消失）', () => {
    expect(recentsCardWidth(3, { width: 10, height: 10, gap: 16 })).toBe(0)
  })
})

describe('与组件样式同源', () => {
  it('.ts-card 的 aspect-ratio 必须等于 RECENTS_CARD_ASPECT', () => {
    const src = readFileSync('src/shell/components/ShellTaskSwitcher.vue', 'utf-8')
    const rule = src.match(/\.ts-card\s*\{[^}]*aspect-ratio:\s*([\d.]+)\s*\/\s*([\d.]+)/)
    expect(rule, '.ts-card 必须声明 aspect-ratio').not.toBeNull()
    const ratio = Number(rule?.[1]) / Number(rule?.[2])
    expect(ratio).toBeCloseTo(RECENTS_CARD_ASPECT)
  })

  it('行高显式注入 + 溢出时置顶（auto 行高会被引擎压扁，首行滚不回来）', () => {
    const src = readFileSync('src/shell/components/ShellTaskSwitcher.vue', 'utf-8')
    expect(src, '行高必须与卡高同源').toMatch(
      /\.ts-cards\s*\{[^}]*grid-auto-rows:\s*var\(--ts-card-h/,
    )
    expect(src, '超过 2 行必须从头排（可滚动）').toMatch(
      /\.ts-cards\.is-scrolling\s*\{[^}]*align-content:\s*start/,
    )
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
