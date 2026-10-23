import { appPath } from '../support/appPaths'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 桌面端脚本不是 TS 工程的一部分，这里直接按相对路径引真实实现（只导出纯函数，无副作用）；
// 实现已收进桌面 SDK（`bin/`），应用侧从包名导入——平台仓内按相对路径直引同一文件。
import {
  copyIfChanged,
  copyManifestIfChanged,
  expectedArtifactManifest,
  syncArtifactManifest,
} from '../../../packages/plugin-sdk-desktop/bin/plugin-watch.js'
import { injectWasmHash, sha256Hex } from '../../../packages/plugin-sdk-desktop/bin/wasm-hash.js'

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

describe('syncArtifactManifest / copyManifestIfChanged（plugin.json 幂等同步）', () => {
  let artifactDir: string
  let manifestSrc: string
  let wasmPath: string

  function writeSourceManifest(name = 'Demo'): void {
    writeFileSync(
      manifestSrc,
      `${JSON.stringify(
        { id: 'com.example.demo', name, rustLibrary: 'demo_plugin' },
        null,
        2,
      )}\n`,
    )
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wasmnest-watch-manifest-'))
    artifactDir = join(dir, 'artifact')
    mkdirSync(artifactDir, { recursive: true })
    manifestSrc = join(dir, 'plugin.json')
    wasmPath = join(artifactDir, 'demo_plugin.wasm')
    writeFileSync(wasmPath, 'wasm-bytes')
    writeSourceManifest()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('产物已是「源清单 + 当前摘要」→ 不写文件（冷启动零重启的判据）', () => {
    const artifactManifest = join(artifactDir, 'plugin.json')
    expect(syncArtifactManifest(manifestSrc, artifactDir).written).toBe(true)
    // 把产物 mtime 钉到过去：任何一次多余写入都会把它刷新成「现在」
    const past = new Date('2001-01-01T00:00:00Z')
    utimesSync(artifactManifest, past, past)
    const before = mtimeOf(artifactManifest)

    expect(syncArtifactManifest(manifestSrc, artifactDir)).toEqual({
      written: false,
      reason: 'unchanged',
    })
    expect(mtimeOf(artifactManifest), '源清单与产物只差 wasmHash，却被当成变化重写了').toBe(before)
  })

  it('copyManifestIfChanged 同样幂等（watch 首次复制不得重写只差摘要的清单）', () => {
    const artifactManifest = join(artifactDir, 'plugin.json')
    writeFileSync(artifactManifest, expectedArtifactManifest(manifestSrc, artifactDir)!)
    const past = new Date('2001-01-01T00:00:00Z')
    utimesSync(artifactManifest, past, past)
    const before = mtimeOf(artifactManifest)

    expect(copyManifestIfChanged(manifestSrc, artifactDir)).toBe(false)
    expect(mtimeOf(artifactManifest)).toBe(before)
  })

  it('写出的内容与 injectWasmHash 的最终形态逐字一致（注入端随即 no-op）', () => {
    syncArtifactManifest(manifestSrc, artifactDir)

    expect(injectWasmHash(artifactDir).reason).toBe('unchanged')
    const manifest = JSON.parse(readFileSync(join(artifactDir, 'plugin.json'), 'utf-8'))
    expect(manifest.wasmHash).toBe(sha256Hex(readFileSync(wasmPath)))
    // 摘要只写产物：源清单不得被反写
    expect(readFileSync(manifestSrc, 'utf-8')).not.toContain('wasmHash')
  })

  it('源清单内容真的变了 → 写入并保留正确摘要（真改动必须生效）', () => {
    syncArtifactManifest(manifestSrc, artifactDir)
    writeSourceManifest('Demo 2')

    expect(syncArtifactManifest(manifestSrc, artifactDir).written).toBe(true)
    const manifest = JSON.parse(readFileSync(join(artifactDir, 'plugin.json'), 'utf-8'))
    expect(manifest.name).toBe('Demo 2')
    expect(manifest.wasmHash).toBe(sha256Hex('wasm-bytes'))
  })

  it('产物缺 wasm → not-ready 且不动现有清单（交给 watch fail-visible，不静默降级）', () => {
    const artifactManifest = join(artifactDir, 'plugin.json')
    syncArtifactManifest(manifestSrc, artifactDir)
    const before = readFileSync(artifactManifest, 'utf-8')
    rmSync(wasmPath)

    expect(syncArtifactManifest(manifestSrc, artifactDir)).toEqual({
      written: false,
      reason: 'not-ready',
    })
    expect(readFileSync(artifactManifest, 'utf-8')).toBe(before)
  })

  it('纯前端插件（无 rustLibrary）→ 源字节即预期内容，相同不写', () => {
    writeFileSync(
      manifestSrc,
      `${JSON.stringify({ id: 'com.example.front', name: 'Front' }, null, 2)}\n`,
    )
    const artifactManifest = join(artifactDir, 'plugin.json')
    writeFileSync(artifactManifest, readFileSync(manifestSrc))

    expect(expectedArtifactManifest(manifestSrc, artifactDir)).toBe(
      readFileSync(manifestSrc, 'utf-8'),
    )
    expect(syncArtifactManifest(manifestSrc, artifactDir).written).toBe(false)
  })
})

describe('接线（dev 脚本必须真的用上内容感知复制）', () => {
  // 实现住桌面 SDK（发布物），dev-run 反向引它；应用侧从包名导入同一份文件
  const WATCH = 'packages/plugin-sdk-desktop/bin/plugin-watch.js'
  const DEV_RUN = 'scripts/dev-run.js'

  it('watch 的产物复制走 copyStep(copyIfChanged)，不得退回无条件 cpSync', () => {
    const src = readFileSync(WATCH, 'utf-8')
    expect(src).toContain('export function copyIfChanged')
    expect(src).toContain("copyStep('复制 index.js'")
    // 反例：退回 `step('复制 index.js', () => cpSync(...))` 即每次刷新 mtime → 加载两次
    expect(src).not.toMatch(/step\(\s*'复制 index\.js'[^)]*cpSync/)
  })

  it('watch 的 plugin.json 走摘要感知的 copyManifestIfChanged，不得按源字节直拷', () => {
    const src = readFileSync(WATCH, 'utf-8')
    expect(src).toContain("copyManifestIfChanged(resolve(root, 'plugin.json')")
    // 反例：源清单不带 wasmHash、产物带 → 裸 copyIfChanged 每次冷启动都判成变化
    expect(src).not.toContain("copyStep('复制 plugin.json'")
  })

  // 预检已收进 scripts/plugin-precheck.mjs（dev-run 只 import 并调用 runPluginPrecheck），
  // 接线面只留这一条轻量锁：预检真的被调用、且先于宿主启动点。四步内部顺序与判据由
  // pluginPrecheck.test.ts 的行为测试承载（issue #12 / spec §4.1：不回填旧函数名）。
  it('dev-run 在宿主启动前调用 runPluginPrecheck（顺序错了仍会二次加载）', () => {
    const src = readFileSync(DEV_RUN, 'utf-8')
    const precheckAt = src.indexOf('runPluginPrecheck()')
    const hostAt = src.indexOf('const host = start(')
    expect(precheckAt, '插件产物预检必须在宿主启动前真的被调用').toBeGreaterThan(-1)
    expect(hostAt, '宿主启动点在场').toBeGreaterThan(precheckAt)
  })

  it('bedcode 的 --frontend-only 真的构建前端（否则预重建静默复用旧 dist）', () => {
    const src = readFileSync(appPath('bedcode', 'desktop', 'scripts/build.js'), 'utf-8')
    expect(src).toMatch(/if \(!rustOnly\) buildFrontend\(\)/)
    // 反例：`!rustOnly && !frontendOnly` 会让 --frontend-only 跳过构建
    expect(src).not.toMatch(/if \(!rustOnly && !frontendOnly\) buildFrontend\(\)/)
  })
})
