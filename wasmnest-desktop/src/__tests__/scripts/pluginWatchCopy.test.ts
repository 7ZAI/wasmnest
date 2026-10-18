import { appPath } from '../support/appPaths'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 桌面端脚本不是 TS 工程的一部分，这里直接按相对路径引真实实现（只导出纯函数，无副作用）
import { copyIfChanged } from '../../../scripts/plugin-watch.js'

/**
 * 插件产物复制的内容感知契约（dev 只加载一次的根因锁）
 *
 * 背景：产物目录在 `src-tauri/` 下，`tauri dev` 的 file watch 一见到文件变化就
 * 「Rebuilding application...」重启整个 app。watch 启动时 vite 必然先完整构建一次
 * （产物字节与上次相同），旧实现无条件 `cpSync` 覆盖 → mtime 被刷新 → 每次
 * `pnpm run tauri:dev` 都多一次重启，用户看到「前端加载两次」。
 *
 * 契约：**内容相同绝不写文件**（mtime 保持不变）；内容不同必须写（真改动要能生效）。
 */

let dir: string
let src: string
let dest: string

function mtimeOf(path: string): number {
  return statSync(path).mtimeMs
}

describe('copyIfChanged（插件产物内容感知复制）', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wasmnest-watch-copy-'))
    src = join(dir, 'src.js')
    dest = join(dir, 'out', 'dest.js')
    mkdirSync(join(dir, 'out'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('目标缺失 → 复制并返回 true（正例：首次构建必须落盘）', () => {
    writeFileSync(src, 'export const a = 1\n')
    expect(copyIfChanged(src, dest)).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe('export const a = 1\n')
  })

  it('内容相同 → 不写、返回 false、mtime 不变（反例：这就是不重启的判据）', () => {
    writeFileSync(src, 'same-bytes')
    writeFileSync(dest, 'same-bytes')
    // 把目标 mtime 钉到过去：如果实现里发生了任何写入，mtime 必然变成「现在」
    const past = new Date('2001-01-01T00:00:00Z')
    utimesSync(dest, past, past)
    const before = mtimeOf(dest)

    expect(copyIfChanged(src, dest)).toBe(false)
    expect(mtimeOf(dest), '相同内容却写了文件：宿主会被 tauri dev 重启').toBe(before)
    expect(readFileSync(dest, 'utf-8')).toBe('same-bytes')
  })

  it('内容不同 → 覆盖写入并返回 true（真改了源码必须能生效）', () => {
    writeFileSync(src, 'new-bytes')
    writeFileSync(dest, 'old-bytes')
    expect(copyIfChanged(src, dest)).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe('new-bytes')
  })

  it('源文件不存在 → 抛错（不静默留旧产物）', () => {
    expect(() => copyIfChanged(join(dir, 'missing.js'), dest)).toThrow()
  })
})

describe('接线（dev 脚本必须真的用上内容感知复制）', () => {
  const WATCH = 'scripts/plugin-watch.js'
  const DEV_RUN = 'scripts/dev-run.js'

  it('watch 的产物复制走 copyStep(copyIfChanged)，不得退回无条件 cpSync', () => {
    const src = readFileSync(WATCH, 'utf-8')
    expect(src).toContain('export function copyIfChanged')
    expect(src).toContain("copyStep('复制 index.js'")
    // 反例：退回 `step('复制 index.js', () => cpSync(...))` 即每次刷新 mtime → 加载两次
    expect(src).not.toMatch(/step\(\s*'复制 index\.js'[^)]*cpSync/)
  })

  it('dev-run 在启动宿主之前做前端预重建（顺序错了仍会二次加载）', () => {
    const src = readFileSync(DEV_RUN, 'utf-8')
    const wasmAt = src.indexOf('ensurePluginWasm()')
    const frontAt = src.indexOf('ensurePluginFrontends()')
    const hostAt = src.indexOf('const host = start(')
    expect(wasmAt, 'WASM 补建必须在场').toBeGreaterThan(-1)
    expect(frontAt, '前端预重建必须在场').toBeGreaterThan(wasmAt)
    expect(hostAt, '宿主启动点在场').toBeGreaterThan(frontAt)
  })

  it('bedcode 的 --frontend-only 真的构建前端（否则预重建静默复用旧 dist）', () => {
    const src = readFileSync(appPath('bedcode', 'desktop', 'scripts/build.js'), 'utf-8')
    expect(src).toMatch(/if \(!rustOnly\) buildFrontend\(\)/)
    // 反例：`!rustOnly && !frontendOnly` 会让 --frontend-only 跳过构建
    expect(src).not.toMatch(/if \(!rustOnly && !frontendOnly\) buildFrontend\(\)/)
  })
})
