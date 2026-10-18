/**
 * 桌面品牌标志几何锁（宿主侧；桌面 UI 宿主修正 2026-10-17）
 * -----------------------------------------------------------------------------
 * 品牌位归位后全仓 3 处，都在宿主侧：ShellToolbar / ShellBootScreen / SplashLoading
 * （壳 + 启动画面）。wasm-app 不再有自绘标题栏，故 app 侧没有品牌位（原
 * `bedcode/src/components/TitleBar.vue` 及其 app 侧品牌锁随「标题栏归壳」退役）。
 *   L1 每个品牌位都画当前标志几何（WasmNest 编织 W，与应用图标 icon.svg 逐字同源）
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

/** 品牌位（宿主侧：壳工具栏 / 启动屏步骤面 / 启动画面） */
const BRAND_SOURCES = [
  'src/shell/components/ShellToolbar.vue',
  'src/shell/components/ShellBootScreen.vue',
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
  it('L1 每个品牌位都画当前标志几何', () => {
    expect(BRAND_SOURCES.length, '品牌位清单不得为空（否则本锁空转）').toBe(3)
    for (const file of BRAND_SOURCES) {
      const source = readFileSync(file, 'utf-8')
      for (const path of MARK_PATHS) {
        expect(source, `${file} 缺少当前标志路径 ${path}`).toContain(path)
      }
    }
  })

  it('L2 全宿主源码不再出现已退役的旧标志笔画', () => {
    const files = collectVueFiles(HOST_SRC_DIR)
    expect(files.length, '宿主 src 下 .vue 文件数基线').toBeGreaterThanOrEqual(20)

    const offenders = files.filter((file) =>
      RETIRED_GEOMETRY.some((token) => readFileSync(file, 'utf-8').includes(token)),
    )
    expect(offenders, '旧标志笔画已退役，出现即为品牌位漏改').toEqual([])
  })
})
