/**
 * useFontSize Linux 门控回归测试
 *
 * 背景：Linux 平台有 1.15 UI 基线缩放（PLATFORM_UI_SCALE，替代原 html.platform-linux
 * 的 CSS zoom，issue 06）。该基线只允许在 Linux 生效——Windows/macOS 必须保持 1.0，
 * 否则用户为 Linux 调整的字号会泄漏到其他平台。
 *
 * 断言面：computeUiScale（档位字号 → --ui-scale 的换算纯函数，applyFontSize 的唯一
 * 决策来源）：
 * - 非 Linux（Windows/macOS）：scale = 设置档位 / 12，无基线因子
 * - Linux：scale = 设置档位 / 12 × 1.15（叠加基线因子）
 * - 档位越界时钳制到 [MIN_FONT_SIZE, MAX_FONT_SIZE]
 *
 * 注：不做 DOM 侧断言（getPropertyValue）。happy-dom 的 CSSStyleDeclaration 对自定义
 * 属性（--ui-scale）的 setProperty 内部会二次写入导致读取不稳定（探针实测随机返回
 * ''），DOM 写入只是一行 setProperty，决策逻辑全部在纯函数中。recompute 的
 * platform===null 早退与 watch 重算路径由调用处代码审查覆盖。
 */
import { describe, it, expect } from 'vitest'
import {
  computeUiScale,
  NORMAL_FONT_SIZE,
  PLATFORM_UI_SCALE,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  FONT_SIZE_LEVELS,
  fontSizeLevelIndex,
} from '@/composables/useFontSize'

describe('computeUiScale Linux 门控（--ui-scale 只针对 Linux 叠加基线）', () => {
  it('Windows + 正常档位(12)：scale = 1，无 Linux 基线', () => {
    expect(computeUiScale(12, false)).toBe(1)
  })

  it('Windows + 大档位(14)：scale = 14/12，仍然不叠加 Linux 基线', () => {
    expect(computeUiScale(14, false)).toBe(14 / NORMAL_FONT_SIZE)
  })

  it('macOS：与 Windows 一致，不叠加 Linux 基线', () => {
    expect(computeUiScale(12, false)).toBe(1)
    expect(computeUiScale(16, false)).toBe(16 / NORMAL_FONT_SIZE)
  })

  it('Linux + 正常档位(12)：scale = 1 × 1.15（叠加 PLATFORM_UI_SCALE）', () => {
    expect(computeUiScale(12, true)).toBe(PLATFORM_UI_SCALE)
  })

  it('Linux + 大档位(14)：scale = 14/12 × 1.15', () => {
    expect(computeUiScale(14, true)).toBeCloseTo((14 / NORMAL_FONT_SIZE) * PLATFORM_UI_SCALE, 5)
  })

  it('Linux + 超大档位(16)：scale = 16/12 × 1.15', () => {
    expect(computeUiScale(16, true)).toBeCloseTo((16 / NORMAL_FONT_SIZE) * PLATFORM_UI_SCALE, 5)
  })

  it('Linux + 小档位(10)：scale = 10/12 × 1.15', () => {
    expect(computeUiScale(10, true)).toBeCloseTo((10 / NORMAL_FONT_SIZE) * PLATFORM_UI_SCALE, 5)
  })

  it('档位钳制：范围外数值收敛到 [10, 16]，Linux 基线因子照常生效', () => {
    expect(computeUiScale(0, true)).toBeCloseTo((MIN_FONT_SIZE / NORMAL_FONT_SIZE) * PLATFORM_UI_SCALE, 5)
    expect(computeUiScale(99, true)).toBeCloseTo((MAX_FONT_SIZE / NORMAL_FONT_SIZE) * PLATFORM_UI_SCALE, 5)
    expect(computeUiScale(99, false)).toBeCloseTo(MAX_FONT_SIZE / NORMAL_FONT_SIZE, 5)
  })

  it('同档位下 Linux 恒为非 Linux 的 1.15 倍（基线只归 Linux）', () => {
    for (const size of [10, 12, 14, 16]) {
      expect(computeUiScale(size, true)).toBeCloseTo(computeUiScale(size, false) * PLATFORM_UI_SCALE, 5)
    }
  })
})

describe('字号五档划分（FONT_SIZE_LEVELS / fontSizeLevelIndex）', () => {
  it('档位表不变量：五档、px 递增、覆盖 [MIN, MAX]、正常档 = 12 在列', () => {
    expect(FONT_SIZE_LEVELS).toHaveLength(5)
    const pxs = FONT_SIZE_LEVELS.map((l) => l.px)
    expect([...pxs].sort((a, b) => a - b)).toEqual(pxs)
    expect(pxs[0]).toBe(MIN_FONT_SIZE)
    expect(pxs.at(-1)).toBe(MAX_FONT_SIZE)
    expect(pxs).toContain(NORMAL_FONT_SIZE)
    for (const l of FONT_SIZE_LEVELS) expect(l.labelKey).toMatch(/^shell\.settings\.ui\.fontLevel\./)
  })

  it('档位 px 精确命中时返回该档', () => {
    expect(fontSizeLevelIndex(10)).toBe(0)
    expect(fontSizeLevelIndex(11)).toBe(1)
    expect(fontSizeLevelIndex(12)).toBe(2)
    expect(fontSizeLevelIndex(14)).toBe(3)
    expect(fontSizeLevelIndex(16)).toBe(4)
  })

  it('旧连续滑杆存量值就近吸附：平局归大档（13→大，15→超大）', () => {
    // 选 13/15 的用户要的是「比正常大」：吸附向下档会把他们的界面调小
    expect(fontSizeLevelIndex(13)).toBe(3)
    expect(fontSizeLevelIndex(15)).toBe(4)
  })

  it('范围外值收敛到两端档位（与 computeUiScale 钳制同口径）', () => {
    expect(fontSizeLevelIndex(0)).toBe(0)
    expect(fontSizeLevelIndex(99)).toBe(4)
    expect(fontSizeLevelIndex(-3)).toBe(0)
  })
})