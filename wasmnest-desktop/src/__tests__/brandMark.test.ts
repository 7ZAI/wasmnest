/**
 * 桌面品牌标志几何锁（宿主侧；桌面 UI 宿主修正 2026-10-17，启动链路唯一化 2026-10-19）
 * -----------------------------------------------------------------------------
 * 品牌位归位后全仓 2 处，都在宿主侧：ShellToolbar / SplashLoading
 * （壳 + 启动画面）。ShellBootScreen 已于 2026-10-19 退役——启动链路唯一化后
 * 启动语义（等应用清单就绪）并入 SplashLoading 绘画动画版，不再有第三个品牌位。
 *
 * 品牌两档（icon.svg 真源三档降级的宿主侧两档）：
 *   · SplashLoading（启动面大尺寸位）＝ 真源高档：icon.svg 镂空线框（124 条描边曲线，
 *     四根圆柱螺旋编织），与图标逐字同源——L1b 钉住 g 变换 + 每条 points ∈ icon.svg。
 *   · ShellToolbar（工具栏小尺寸位）＝ 实心态降级档：编织 W 四根棒料——L1a 钉住。
 * wasm-app 不再有自绘标题栏，故 app 侧没有品牌位（原
 * `bedcode/src/components/TitleBar.vue` 及其 app 侧品牌锁随「标题栏归壳」退役）。
 *   L1 每个品牌位画其对应档位的当前标志几何（真源 / 降级）
 *   L2 全宿主源码不再出现已退役的旧标志笔画（防回接）
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

// vitest 以宿主工程根为 cwd
const HOST_SRC_DIR = join(process.cwd(), 'src')

/** 当前标志几何（编织 W 实心态的四根棒料，与应用图标逐字同源） */
const MARK_PATHS = [
  '4.54,22.28 26.06,92.71 32.32,59.81 19.46,17.72',
  '24.22,90.61 51.10,56.86 51.10,34.38 29.84,61.08',
  '48.90,56.86 75.78,90.61 70.16,61.08 48.90,34.38',
  '73.94,92.71 95.46,22.28 80.54,17.72 67.68,59.81',
]

/** 已退役的旧标志笔画 */
const RETIRED_GEOMETRY = [
  '23.2',
  '36.8',
  '39.3',
  '48.7',
  '51.3',
  '60.7',
  '63.2',
  '76.8',
  'M 24 18 L 59 50 L 24 82 L 32 74 L 51 50 L 32 26 Z',
  'M 51 60 L 84 62 L 53 65 Z',
]

/** 品牌位（宿主侧：壳工具栏 / 启动画面） */
const BRAND_SOURCES = [
  'src/shell/components/ShellToolbar.vue',
  'src/components/SplashLoading.vue',
]

function collectVueFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectVueFiles(full))
    } else if (entry.name.endsWith('.vue')) {
      out.push(relative(process.cwd(), full).split('\\').join('/'))
    }
  }
  return out
}

describe('品牌标志几何锁（宿主侧）', () => {
  it('L1 每个品牌位画其对应档位的当前标志几何', () => {
    expect(BRAND_SOURCES.length, '品牌位清单不得为空（否则本锁空转）').toBe(2)

    // L1b 真源高档（SplashLoading 启动面）：镂空线框与 icon.svg 逐字同源
    const ICON = readFileSync('src-tauri/icons/icon.svg', 'utf-8')
    const iconPolys = [...ICON.matchAll(/<polyline points="([^"]+)"/g)].map((m) => m[1])
    expect(iconPolys.length, 'icon.svg 至少要有四根圆柱的线框曲线（否则本锁空转）').toBeGreaterThan(50)

    const splashSource = readFileSync('src/components/SplashLoading.vue', 'utf-8')
    // g 变换与真源一致：镂空线框以同一缩放落在底板中央（非实心态降级档）
    expect(splashSource).toContain('translate(16.5,18.45) scale(0.67)')
    const splashPolys = [
      ...splashSource.matchAll(/<polyline class="logo-line" points="([^"]+)"/g),
    ].map((m) => m[1])
    expect(splashPolys.length, 'SplashLoading 线框曲线数须与 icon.svg 一致（一条不缺）').toBe(
      iconPolys.length,
    )
    for (const p of splashPolys) {
      expect(iconPolys, `SplashLoading 出现真源之外的线框路径 ${p.slice(0, 40)}…`).toContain(p)
    }

    // L1a 实心态降级档（ShellToolbar 小尺寸位）：编织 W 四根棒料
    const toolbarSource = readFileSync('src/shell/components/ShellToolbar.vue', 'utf-8')
    for (const path of MARK_PATHS) {
      expect(toolbarSource, `ShellToolbar 缺少实心态棒料路径 ${path.slice(0, 24)}…`).toContain(path)
    }
  })

  it('L2 除 SplashLoading（icon.svg 真源同源）外，全宿主源码不再出现已退役的旧标志笔画', () => {
    // SplashLoading 内联的是 icon.svg 真源线框（L1b 逐字同源）：旧 BedCode 笔画坐标
    // 与真源线框坐标存在数字子串撞车（如 '51.3'），故从本锁扫描中排除。
    // 防回接由 L1b 承担：任何借道 SplashLoading 回接旧笔画都会被
    // 「每条 points ∈ icon.svg」拦下。
    const files = collectVueFiles(HOST_SRC_DIR).filter(
      (file) => file !== 'src/components/SplashLoading.vue',
    )
    expect(files.length, '宿主 src 下 .vue 文件数基线').toBeGreaterThanOrEqual(20)

    const offenders = files.filter((file) =>
      RETIRED_GEOMETRY.some((token) => readFileSync(file, 'utf-8').includes(token)),
    )
    expect(offenders, '旧标志笔画已退役，出现即为品牌位漏改').toEqual([])
  })
})
