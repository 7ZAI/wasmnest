/**
 * Tailwind content 覆盖锁（宿主侧；桌面 UI 宿主修正 2026-10-17 改写）
 *
 * 背景：桌面 UI 宿主修正后 Tailwind 只在宿主编译一次，content 只扫**宿主源码**
 * （`./src/**`）+ 共享 SDK 组件。各 wasm app 前端是独立构建的挂载包，其 Tailwind
 * 类由各 app 自己的构建编译（批 C 起各 app 自持 tailwind 配置，覆盖锁在各 app
 * 工程内）。
 *
 * 本锁钉住：
 * - 宿主 content 必须含 `./src/**`（漏掉则宿主壳工具类零产出）；
 * - 宿主 content 不再含任何 `./wasm-apps/<id>/src/**` 条目（app 类自编译；
 *   残留即死路径或回接宿主编译）；
 * - 解析器不空转：条目数有基线。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const TAILWIND_CONFIG = 'tailwind.config.js'

/** 从 `tailwind.config.js` 文本抓出 content 条目（保序去重） */
function parseContentEntries(configText: string): string[] {
  const entries: string[] = []
  for (const match of configText.matchAll(/'(\.\/[^']+)'/g)) {
    if (match[1].endsWith('/**/*.{vue,js,ts,jsx,tsx}') || match[1].endsWith('/**/*.{js,ts}')) {
      if (!entries.includes(match[1])) entries.push(match[1])
    }
  }
  return entries
}

describe('Tailwind content 覆盖锁（宿主）', () => {
  it('正例：宿主 content 含 ./src/** 与 SDK 共享组件路径', () => {
    const entries = parseContentEntries(readFileSync(TAILWIND_CONFIG, 'utf-8'))
    expect(entries).toContain('./src/**/*.{vue,js,ts,jsx,tsx}')
    expect(entries.some((e) => e.includes('packages/plugin-sdk-desktop/src'))).toBe(true)
  })

  it('反例：content 残留 wasm-apps 条目 = 死路径或回接宿主编译（app 类自编译）', () => {
    const configText = readFileSync(TAILWIND_CONFIG, 'utf-8')
    const appEntries = configText.match(/'(\.\/wasm-apps\/[^']*)'/g)
    expect(appEntries, '宿主 tailwind content 不得残留 ./wasm-apps/* 条目').toEqual(null)
  })

  it('基线：条目数不为零（防扫描空转全绿）', () => {
    const entries = parseContentEntries(readFileSync(TAILWIND_CONFIG, 'utf-8'))
    expect(entries.length).toBeGreaterThanOrEqual(2)
  })
})
