import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { readFileSync } from 'node:fs'
import SplashLoading from '@/shell/components/SplashLoading.vue'
import {
  SPLASH_BASE_FADE_MS,
  SPLASH_DRAW_TOTAL_MS,
  splashDrawingPlan,
  splashStrokeOffset,
} from '@/shell/components/splashTiming'

// 品牌位尺寸换成可被 happy-dom CSSOM 解析的哨兵值：证明组件内联绑定真的消费
// 共享常量（happy-dom 会整段丢弃 clamp() 这类解析不了的样式值）。其余导出保持真源。
vi.mock('@/shell/components/splashTiming', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shell/components/splashTiming')>()
  return { ...actual, SPLASH_LOGO_SIZE: '77px' }
})

/**
 * SplashLoading（移动端启动画面，与桌面端同一组件）
 *
 * 钉住：
 * - 无文字 / 无进度条，加载进度 = 绘画动画
 * - 线框与 icon.svg 逐字同源（124 条、双色、无实心态填充层）
 * - 两条完成路径：SVG 可测量 → rAF 逐笔描边；不可测量 / reduced-motion → complete
 * - 品牌位尺寸与描边偏移公式来自 splashTiming.ts（纯函数真源）
 * - 不自绘 CSS 动画回退（两端统一 rAF 驱动）
 */

const ICON_SVG = readFileSync('src-tauri/icons/icon.svg', 'utf-8')
const ICON_POLY_COUNT = [...ICON_SVG.matchAll(/<polyline points="([^"]+)"/g)].length

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: {
      'zh-CN': {
        mobile: {
          splash: {
            status: '正在启动…',
          },
        },
      },
    },
  })
}

function mountSplash(props: Record<string, unknown>, slots: Record<string, unknown> = {}) {
  return mount(SplashLoading, {
    props,
    slots,
    global: {
      plugins: [createTestI18n()],
      stubs: {
        Teleport: false,
        Transition: false,
      },
    },
    attachTo: document.body,
  })
}

async function flushDraw() {
  await flushPromises()
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  await flushPromises()
}

describe('SplashLoading (mobile)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    delete (SVGElement.prototype as unknown as { getTotalLength?: () => number }).getTotalLength
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('should not render overlay when visible is false', () => {
    mountSplash({ visible: false })
    expect(document.querySelector('.splash-root')).toBeNull()
  })

  it('should render a fullscreen z-[100] overlay with only the logo', () => {
    const wrapper = mountSplash({ visible: true })
    const overlay = document.querySelector('.splash-root')!

    expect(overlay).toBeTruthy()
    expect(overlay.classList.contains('z-[100]')).toBe(true)
    // 零文字 / 零进度条：加载进度只由绘画动画表达
    expect(overlay.textContent?.trim() ?? '').toBe('')
    expect(overlay.querySelector('.splash-progress')).toBeNull()
    expect(overlay.getAttribute('aria-label')).toBe('正在启动…')
    wrapper.unmount()
  })

  it('should keep the true-source wireframe word-for-word from icon.svg', () => {
    const wrapper = mountSplash({ visible: true })
    const svg = document.querySelector('.splash-logo svg')!

    expect(svg.querySelector('.logo-base')).toBeTruthy()
    const lines = svg.querySelectorAll('.logo-line')
    expect(lines.length).toBe(ICON_POLY_COUNT)
    expect(ICON_POLY_COUNT).toBe(124)

    const iconPoints = new Set(
      [...ICON_SVG.matchAll(/<polyline points="([^"]+)"/g)].map((m) => m[1]),
    )
    for (const line of lines) {
      expect(iconPoints.has(line.getAttribute('points')!)).toBe(true)
    }

    const g = svg.querySelector('g')
    expect(g?.getAttribute('transform')).toContain('translate(16.5,18.45)')
    expect(g?.getAttribute('transform')).toContain('scale(0.67)')
    expect(svg.querySelector('.logo-fills')).toBeNull()
    // 品牌色走 shell.css token（壳内禁硬编码色值）：左侧琥珀 + 纸白股线
    expect(svg.querySelectorAll('[stroke="var(--shell-brand-stripe)"]').length).toBeGreaterThan(0)
    expect(svg.querySelectorAll('[stroke="var(--shell-brand-glyph)"]').length).toBeGreaterThan(0)
    const shellCss = readFileSync('src/shell/styles/shell.css', 'utf-8')
    for (const token of [
      '--shell-brand-stripe: #ff9e2c',
      '--shell-brand-glyph: #f5f7f9',
      '--splash-logo-base-from: #151b23',
      '--splash-logo-base-to: #050608',
    ]) {
      expect(shellCss).toContain(token)
    }
    wrapper.unmount()
  })

  it('should plan the W pen order: left down, mid-left up, mid-right down, right up', () => {
    const strokes = Array.from({ length: 8 }, (_, i) => {
      const p = (i % 2) * 10
      return { points: [[0, p], [0, p + 1]] as Array<[number, number]>, length: 1 }
    })
    const plan = splashDrawingPlan(strokes)

    expect(plan.map((t) => t.index)).toEqual([0, 1, 3, 2, 4, 5, 7, 6])
    expect(plan.map((t) => t.direction)).toEqual([1, 1, -1, -1, 1, 1, -1, -1])

    expect(plan[0].delay).toBeCloseTo(SPLASH_BASE_FADE_MS, 5)
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].delay).toBeCloseTo(plan[i - 1].delay + plan[i - 1].duration, 6)
    }
    const last = plan[plan.length - 1]
    expect(last.delay + last.duration).toBeCloseTo(SPLASH_DRAW_TOTAL_MS, 5)
  })

  it('should draw the W with rAF from a blank state to the complete frame', async () => {
    const proto = SVGElement.prototype as unknown as { getTotalLength?: () => number }
    proto.getTotalLength = () => 100

    const startTime = 10_000
    vi.spyOn(performance, 'now').mockReturnValue(startTime)
    const pendingFrames: FrameRequestCallback[] = []
    let rafId = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      pendingFrames.push(cb)
      rafId += 1
      return rafId
    })
    const runNextFrame = (time: number) => {
      const callbacks = pendingFrames.splice(0)
      expect(callbacks.length).toBeGreaterThan(0)
      for (const cb of callbacks) cb(time)
    }

    const wrapper = mountSplash({ visible: true })
    await flushPromises()

    const wrap = document.querySelector('.splash-content')
    expect(wrap?.classList.contains('drawing')).toBe(true)
    expect(wrap?.classList.contains('complete')).toBe(false)

    const lines = Array.from(document.querySelectorAll<SVGElement>('.logo-line'))
    expect(lines.length).toBe(ICON_POLY_COUNT)
    const iconPoints = [...ICON_SVG.matchAll(/<polyline points="([^"]+)"/g)].map((m) => m[1])
    expect(lines.map((line) => line.getAttribute('points'))).toEqual(iconPoints)

    // 初始态：W 一笔未画
    lines.forEach((line) => {
      expect(line.style.strokeDasharray).toBe('100px')
      expect(line.style.opacity).toBe('0')
    })

    // 第 0 帧仍在底板淡入期
    runNextFrame(startTime)
    expect(lines.filter((line) => line.style.opacity === '1')).toHaveLength(0)

    // 第一笔中段：offset 处于 ±周长 与 0 之间（逐帧描边，不是静态图）
    const plan = splashDrawingPlan(
      lines.map((line) => ({
        points: line
          .getAttribute('points')!
          .split(' ')
          .map((pair) => {
            const [x, y] = pair.split(',').map(Number)
            return [x, y] as [number, number]
          }),
        length: 100,
      })),
    )
    const first = plan[0]
    runNextFrame(startTime + first.delay + first.duration / 2)
    const firstLine = lines[first.index]
    expect(firstLine.style.opacity).toBe('1')
    const midOffset = Math.abs(Number.parseFloat(firstLine.style.strokeDashoffset))
    expect(midOffset).toBeGreaterThan(1)
    expect(midOffset).toBeLessThan(99)

    // 总时长帧：全部收笔
    runNextFrame(startTime + SPLASH_DRAW_TOTAL_MS)
    lines.forEach((line) => {
      expect(line.style.strokeDashoffset).toBe('0px')
      expect(line.style.opacity).toBe('1')
    })
    wrapper.unmount()
  })

  it('should finish the drawing in 1s on mobile', async () => {
    // 移动端节奏裁决：整段绘画（含底板淡入）1s 收笔；桌面端保持 1.26s。
    const timing = await vi.importActual<typeof import('@/shell/components/splashTiming')>(
      '@/shell/components/splashTiming',
    )
    expect(timing.SPLASH_DRAW_TOTAL_MS).toBe(1000)
    expect(timing.SPLASH_DRAWING_SPAN_MS).toBe(820)
  })

  it('should bind the logo size from the shared constant and offset from the pure formula', async () => {
    const timing = await vi.importActual<typeof import('@/shell/components/splashTiming')>(
      '@/shell/components/splashTiming',
    )
    expect(timing.SPLASH_LOGO_SIZE).toBe('clamp(144px, 24vmin, 200px)')

    const wrapper = mountSplash({ visible: true })
    const logo = document.querySelector<HTMLElement>('.splash-logo')!
    expect(logo.style.width).toBe('77px')
    expect(logo.style.height).toBe('77px')
    wrapper.unmount()

    expect(splashStrokeOffset(1, 100, 0)).toBe(100)
    expect(splashStrokeOffset(-1, 100, 0)).toBe(-100)
    expect(splashStrokeOffset(1, 100, 1)).toBeCloseTo(0, 10)
  })

  it('should never fall back to CSS animation for the drawing', () => {
    const source = readFileSync('src/shell/components/SplashLoading.vue', 'utf-8')
    expect(source).not.toContain('@keyframes logo-line-draw')
    expect(source).not.toContain('animation-name: logo-line-draw')
    expect(source).not.toContain('transitionProperty')
  })

  it('should land on complete when SVG measurement is unavailable', async () => {
    const wrapper = mountSplash({ visible: true })
    await flushDraw()

    const wrap = document.querySelector('.splash-content')
    expect(wrap?.classList.contains('complete')).toBe(true)
    wrapper.unmount()
  })

  it('should land on complete under reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))

    const wrapper = mountSplash({ visible: true })
    await flushDraw()

    const wrap = document.querySelector('.splash-content')
    expect(wrap?.classList.contains('complete')).toBe(true)
    wrapper.unmount()
  })

  it('should allow logo slot override', () => {
    const wrapper = mountSplash({ visible: true }, { logo: '<div class="custom-logo">X</div>' })
    expect(document.querySelector('.custom-logo')).toBeTruthy()
    expect(document.querySelector('.splash-logo svg')).toBeNull()
    wrapper.unmount()
  })
})
