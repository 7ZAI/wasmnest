import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { readFileSync } from 'node:fs'
import SplashLoading from '@/components/SplashLoading.vue'
import {
  SPLASH_BASE_FADE_MS,
  SPLASH_DRAW_TOTAL_MS,
  splashDrawingPlan,
} from '@/components/splashTiming'

/**
 * SplashLoading（真源镂空线框 · 从左到右绘画动画）测试
 *
 * 重新设计（2026-10-19）后组件只输出一个居中 logo：真源线框（icon.svg 逐字同源，
 * 124 条描边曲线）、视觉上零文字、零进度条，加载进度 = 绘画动画。本套件钉住：
 * - 无文字 / 无进度条（防止后续把终端行 / boot log / footer 塞回来）
 * - 线框与 icon.svg 逐字同源：polyline 数量一致、每条 points 都在真源中出现、
 *   双色（琥珀 / 暖白）齐全、无实心态填充层
 * - 两条完成路径都可达：SVG 可测量（getTotalLength）→ .drawing 按 W 笔顺逐笔描边
 *   （左柱上→下、左中下→上、右中上→下、右柱下→上；组间左→右，末笔 = 总时长）；
 *   SVG 不可测量（happy-dom 默认）→ .complete
 * - reduced-motion → .complete
 * - 主题锁（浅/深色板对称）由 SplashLoadingTheme.test.ts 单独钉住
 */

// mock Tauri 运行时 API：本版已无 footer，getVersion 不再被引用；保留空 mock 兜底
vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(() => Promise.resolve('9.9.9')),
}))

/** 品牌真源：应用图标（与组件内联线框逐字同源） */
const ICON_SVG = readFileSync('src-tauri/icons/icon.svg', 'utf-8')
const ICON_POLY_COUNT = [...ICON_SVG.matchAll(/<polyline points="([^"]+)"/g)].length

/** 测试用最小 i18n 实例：仅含 splash 相关 key（aria-label 使用） */
function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: {
      'zh-CN': {
        desktop: {
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

/** 等待 onMounted 的测量 + requestAnimationFrame 加 .drawing 完成 */
async function flushDraw() {
  await flushPromises()
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  await flushPromises()
}

describe('SplashLoading Component', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    // getTotalLength 的 mock 是直接赋值到 prototype（spyOn 无法覆盖不存在的属性），
    // restoreAllMocks 不处理这类手动赋值——显式删除，避免污染后续用例的降级路径
    delete (SVGElement.prototype as unknown as { getTotalLength?: () => number }).getTotalLength
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('should not render overlay when visible is false', () => {
    mountSplash({ visible: false })
    expect(document.querySelector('.splash-root')).toBeNull()
  })

  it('should render fullscreen overlay with z-[100] when visible', () => {
    const wrapper = mountSplash({ visible: true })

    const overlay = document.querySelector('.splash-root')
    expect(overlay).toBeTruthy()
    expect(overlay?.classList.contains('z-[100]')).toBe(true)
    wrapper.unmount()
  })

  it('should show only the logo: no text and no progress indicators', () => {
    const wrapper = mountSplash({ visible: true })
    const overlay = document.querySelector('.splash-root')!

    // 零文字：品牌名 / 终端启动行 / 状态文案 / footer 全部不应出现
    expect(overlay.textContent?.trim() ?? '').toBe('')
    expect(overlay.querySelector('.splash-typed')).toBeNull()
    expect(overlay.querySelector('.splash-footer')).toBeNull()
    expect(overlay.querySelector('.splash-bootlog')).toBeNull()
    // 零进度指示
    expect(overlay.querySelector('.splash-progress')).toBeNull()
    expect(overlay.querySelector('.splash-progress-track')).toBeNull()
    wrapper.unmount()
  })

  it('should keep the true-source wireframe, word-for-word from icon.svg', () => {
    const wrapper = mountSplash({ visible: true })
    const svg = document.querySelector('.splash-logo svg')!

    // 底板渐变底
    expect(svg.querySelector('.logo-base')).toBeTruthy()
    // 线框数量 = 品牌真源 icon.svg 的 polyline 数量（逐字同源）
    const lines = svg.querySelectorAll('.logo-line')
    expect(lines.length).toBe(ICON_POLY_COUNT)
    expect(ICON_POLY_COUNT).toBeGreaterThan(50)
    // 每条 points 都来自 icon.svg（一条不缺、不新增）
    const iconPoints = new Set(
      [...ICON_SVG.matchAll(/<polyline points="([^"]+)"/g)].map((m) => m[1]),
    )
    for (const line of lines) {
      expect(iconPoints.has(line.getAttribute('points')!)).toBe(true)
    }
    // g 变换与真源一致（镂空线框在底板中央，非实心态降级）
    const g = svg.querySelector('g')
    expect(g?.getAttribute('transform')).toContain('translate(19.056,20.269)')
    expect(g?.getAttribute('transform')).toContain('scale(0.61887)')
    // 无实心态填充层：镂空线框画完即最终态
    expect(svg.querySelector('.logo-fills')).toBeNull()
    // 双色齐全：左侧琥珀（活跃实例）+ 右侧暖白
    expect(svg.querySelectorAll('[stroke="#FF9E2C"]').length).toBeGreaterThan(0)
    expect(svg.querySelectorAll('[stroke="#F5F7F9"]').length).toBeGreaterThan(0)
    wrapper.unmount()
  })

  it('should plan the W pen order: left down, mid-left up, mid-right down, right up', () => {
    // 每组两根竖线：p 越大越靠下
    const strokes = Array.from({ length: 8 }, (_, i) => {
      const p = (i % 2) * 10
      return { points: [[0, p], [0, p + 1]] as Array<[number, number]>, length: 1 }
    })
    const plan = splashDrawingPlan(strokes)

    // 组顺序仍是左→右；组内：下行组上→下，上行组下→上
    expect(plan.map((t) => t.index)).toEqual([0, 1, 3, 2, 4, 5, 7, 6])
    expect(plan.map((t) => t.direction)).toEqual([1, 1, -1, -1, 1, 1, -1, -1])

    // 单笔连续描边、末笔 = 总时长
    expect(plan[0].delay).toBeCloseTo(SPLASH_BASE_FADE_MS, 5)
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].delay).toBeCloseTo(plan[i - 1].delay + plan[i - 1].duration, 6)
    }
    const last = plan[plan.length - 1]
    expect(last.delay + last.duration).toBeCloseTo(SPLASH_DRAW_TOTAL_MS, 5)
  })

  it('should draw the W from left to right in pen order', async () => {
    // 提供可测量的 SVG：getTotalLength 返回固定周长 → 组件走 rAF 逐笔描
    const proto = SVGElement.prototype as unknown as { getTotalLength?: () => number }
    proto.getTotalLength = () => 100

    // 手动驱动 rAF：固定起始时间 + 逐帧时间戳，能验证「中间帧确实在画」
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

    // 顺序真源 = icon.svg 的 polyline 源码顺序：DOM 里第 i 条就是源码第 i 条（零重排）
    const iconPoints = [...ICON_SVG.matchAll(/<polyline points="([^"]+)"/g)].map((m) => m[1])
    expect(lines.map((line) => line.getAttribute('points'))).toEqual(iconPoints)

    // 源码顺序 = 四根圆柱从左到右（各 31 条）：先画左圆柱，再一路画到右边
    const meanX = lines.map((line) => {
      const xs = line
        .getAttribute('points')!
        .split(' ')
        .map((pair) => Number(pair.split(',')[0]))
      return xs.reduce((sum, x) => sum + x, 0) / xs.length
    })
    const cuts = [0, 31, 62, 93, ICON_POLY_COUNT]
    const cylinderMeanX = cuts.slice(0, -1).map((start, i) => {
      const group = meanX.slice(start, cuts[i + 1])
      return group.reduce((sum, x) => sum + x, 0) / group.length
    })
    expect(cylinderMeanX).toEqual([...cylinderMeanX].sort((a, b) => a - b))

    // 动画计划真源：四根圆柱按 W 笔顺重排（不是 DOM 顺序）
    const geometry = lines.map((line) => ({
      points: line
        .getAttribute('points')!
        .split(' ')
        .map((pair) => {
          const [x, y] = pair.split(',').map(Number)
          return [x, y] as [number, number]
        }),
      length: 100,
    }))
    const expected = splashDrawingPlan(geometry)
    expect(expected.length).toBe(ICON_POLY_COUNT)

    // 组间 = 左柱 → 左中 → 右中 → 右柱；每组 31 条
    const groupSize = Math.ceil(ICON_POLY_COUNT / 4)
    const groupOf = (index: number) => Math.floor(index / groupSize)
    expect(expected.map((t) => groupOf(t.index))).toEqual(
      Array.from({ length: 4 }, (_, g) => Array(groupSize).fill(g)).flat(),
    )

    // 组内方向 = W 笔顺：左柱下、左中上、右中下、右柱上
    for (let g = 0; g < 4; g++) {
      const expectedDirection = g % 2 === 0 ? 1 : -1
      const dirs = expected.filter((t) => groupOf(t.index) === g).map((t) => t.direction)
      expect(dirs).toEqual(Array(groupSize).fill(expectedDirection))
    }

    // 单笔连续描边：计划顺序里下一条起笔 = 上一条收笔（不重叠、不留空档）
    expect(expected[0].delay).toBeCloseTo(SPLASH_BASE_FADE_MS, 5)
    for (let i = 1; i < expected.length; i++) {
      expect(expected[i].delay).toBeCloseTo(expected[i - 1].delay + expected[i - 1].duration, 6)
    }

    // 初始态：全部线框隐藏（W 一笔未画）
    lines.forEach((line) => {
      expect(line.style.strokeDasharray).toBe('100px')
      expect(line.style.opacity).toBe('0')
    })

    // 第 0 帧（elapsed = 0）：仍在底板淡入期，没有任何线可见
    runNextFrame(startTime)
    expect(lines.filter((line) => line.style.opacity === '1')).toHaveLength(0)

    // 第一笔中段：offset 应在 ±周长 与 0 之间（证明是在逐帧描，不是静态/瞬时完成）
    const first = expected[0]
    runNextFrame(startTime + first.delay + first.duration / 2)
    const firstLine = lines[first.index]
    expect(firstLine.style.opacity).toBe('1')
    const midOffset = Math.abs(Number.parseFloat(firstLine.style.strokeDashoffset))
    expect(midOffset).toBeGreaterThan(1)
    expect(midOffset).toBeLessThan(99)

    // 总时长帧：全部线框收笔，offset 归 0、透明度 1
    runNextFrame(startTime + SPLASH_DRAW_TOTAL_MS)
    lines.forEach((line) => {
      expect(line.style.strokeDashoffset).toBe('0px')
      expect(line.style.opacity).toBe('1')
    })

    // 末条收笔 = 动画总时长（ShellHost 以同一时刻收起开屏，不得漂移）
    expect(expected[expected.length - 1].delay + expected[expected.length - 1].duration).toBeCloseTo(
      SPLASH_DRAW_TOTAL_MS,
      5,
    )
    wrapper.unmount()
  })

  it('should keep the splash logo at the enlarged brand size', () => {
    const source = readFileSync('src/components/SplashLoading.vue', 'utf-8')
    // 开屏品牌位随窗口短边缩放（最小窗口 144px，常见窗口约 192px）
    expect(source).toContain('width: clamp(144px, 24vmin, 200px)')
    expect(source).toContain('height: clamp(144px, 24vmin, 200px)')
    // 旧的小尺寸位不得回接
    expect(source).not.toContain('h-[96px] w-[96px]')
  })

  it('should start from a blank W and advance the drawing with requestAnimationFrame', () => {
    const source = readFileSync('src/components/SplashLoading.vue', 'utf-8')
    // 初始内联态：offset = ±周长、opacity 0（整段隐藏，零长度点也不提前露出）
    expect(source).toContain('el.style.strokeDashoffset = `${timing.direction * length}px`')
    expect(source).toContain("el.style.opacity = '0'")
    // 由 rAF 逐帧推进：进度 0→1 时 offset 从 ±周长回到 0
    expect(source).toContain('requestAnimationFrame(frame)')
    expect(source).toContain('const progress = line.duration > 0')
    expect(source).toContain(
      'line.el.style.strokeDashoffset = `${line.direction * line.length * (1 - progress)}px`',
    )
    expect(source).toContain("line.el.style.strokeDashoffset = '0px'")
    // 回退锁：不得回退到 CSS animation / keyframes / transition（WebKitGTK 下会退化为静态）
    expect(source).not.toContain('@keyframes logo-line-draw')
    expect(source).not.toContain('animation-name: logo-line-draw')
    expect(source).not.toContain('transitionProperty')
  })

  it('should land on the complete state when SVG measurement is unavailable', async () => {
    // happy-dom 默认无 getTotalLength：不卡在半途，直接完成态
    const wrapper = mountSplash({ visible: true })
    await flushDraw()

    const wrap = document.querySelector('.splash-content')
    expect(wrap?.classList.contains('complete')).toBe(true)
    wrapper.unmount()
  })

  it('should land on the complete state under reduced motion', async () => {
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
    // 自定义 logo 时不再渲染内建 SVG
    expect(document.querySelector('.splash-logo svg')).toBeNull()
    wrapper.unmount()
  })
})
