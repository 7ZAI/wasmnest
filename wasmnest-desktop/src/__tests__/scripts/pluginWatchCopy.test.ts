import { appPath } from '../support/appPaths'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 桌面端脚本不是 TS 工程的一部分，这里直接按相对路径引真实实现（只导出纯函数，无副作用）；
// 实现已收进桌面 SDK（`bin/`），应用侧从包名导入——平台仓内按相对路径直引同一文件。
import {
  copyIfChanged,
  copyManifestIfChanged,
  copyWatchArtifacts,
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
 *
 * 改造说明（issue #23 / codemap §8.1 首批，#12 样板）：接线组原以调用点字面量锁
 * `copyStep('复制 index.js'` 等（改步骤文案 / 合法重排即红），现按三层收敛——
 * ① `copyIfChanged` / `copyManifestIfChanged` 行为测试（既有，不动）；
 * ② watch 复制链整体提为可注入依赖的导出 `copyWatchArtifacts`（plugin-watch.js
 *    最小 diff 提纯，命令形态不变），本套件在真实临时目录上行为锁定；
 * ③ 接线面只留 1 条轻量锁（startPluginWatch 真的调用共享复制链）；
 * ④ bedcode `--frontend-only` 由源码正则改为沙箱 fixture 驱动真实 build.js
 *    （假 vite / 假 cargo 记账，不触发真实构建）。
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

describe('copyWatchArtifacts（watch 复制链行为：临时目录 fixture 驱动真实实现）', () => {
  let fx: string
  let root: string
  let res: string
  const logger = { log: vi.fn(), error: vi.fn() }

  beforeEach(() => {
    fx = mkdtempSync(join(tmpdir(), 'wasmnest-watch-chain-'))
    root = join(fx, 'plugin')
    res = join(fx, 'resources', 'com.example.demo')
    mkdirSync(join(root, 'dist'), { recursive: true })
    mkdirSync(res, { recursive: true })
    writeFileSync(join(root, 'dist', 'index.js'), 'console.log("v1")\n')
    writeFileSync(
      join(root, 'plugin.json'),
      `${JSON.stringify({ id: 'com.example.demo', name: 'Demo', rustLibrary: 'demo_plugin' }, null, 2)}\n`,
    )
    writeFileSync(join(res, 'demo_plugin.wasm'), 'wasm-bytes')
    logger.log.mockClear()
    logger.error.mockClear()
  })

  afterEach(() => {
    rmSync(fx, { recursive: true, force: true })
  })

  const run = (extraFiles: string[] = []) =>
    copyWatchArtifacts({ root, resourcesDir: res, extraFiles, logger })

  it('首次复制：index.js / 清单（带 wasm 摘要）/ extraFile 全部落盘', () => {
    writeFileSync(join(root, 'logo.svg'), '<svg/>')

    const result = run(['logo.svg'])

    expect(result.failed).toBeUndefined()
    expect(result.changed).toBe(3)
    expect(readFileSync(join(res, 'index.js'), 'utf-8')).toBe('console.log("v1")\n')
    const manifest = JSON.parse(readFileSync(join(res, 'plugin.json'), 'utf-8'))
    expect(manifest.wasmHash).toBe(sha256Hex(readFileSync(join(res, 'demo_plugin.wasm'))))
    expect(readFileSync(join(res, 'logo.svg'), 'utf-8')).toBe('<svg/>')
  })

  it('幂等：同内容再跑零写入（mtime 不变）——退回无条件 cpSync 即红', () => {
    run()
    const past = new Date('2001-01-01T00:00:00Z')
    for (const f of ['index.js', 'plugin.json']) utimesSync(join(res, f), past, past)
    const before = { index: mtimeOf(join(res, 'index.js')), manifest: mtimeOf(join(res, 'plugin.json')) }

    const result = run()

    expect(result).toEqual({ changed: 0, hashChanged: false })
    expect(mtimeOf(join(res, 'index.js')), '相同内容却写了 index.js：宿主会被 tauri dev 重启').toBe(
      before.index,
    )
    expect(mtimeOf(join(res, 'plugin.json')), '相同内容却重写了清单').toBe(before.manifest)
  })

  it('真改动 index.js → 落盘生效（dev 期热更新的既有形态）', () => {
    run()
    writeFileSync(join(root, 'dist', 'index.js'), 'console.log("v2")\n')

    const result = run()

    expect(result.changed).toBe(1)
    expect(readFileSync(join(res, 'index.js'), 'utf-8')).toBe('console.log("v2")\n')
  })

  it('清单摘要感知：源清单不带 wasmHash 也不判成变化（按源字节直拷即红）', () => {
    // 产物清单 = 源清单 + wasmHash，两者字节永远不等——若复制链对清单走裸
    // copyIfChanged，这里每次冷启动都会重写并触发 tauri dev 重启（窗口闪两次）。
    run()
    const artifactManifest = join(res, 'plugin.json')
    const past = new Date('2001-01-01T00:00:00Z')
    utimesSync(artifactManifest, past, past)
    const before = mtimeOf(artifactManifest)

    run()

    expect(mtimeOf(artifactManifest)).toBe(before)
    // 摘要只写产物：源清单不得被反写
    expect(readFileSync(join(root, 'plugin.json'), 'utf-8')).not.toContain('wasmHash')
  })

  it('dist 缺 index.js → 整链不执行，不创建产物目录', () => {
    rmSync(join(root, 'dist'), { recursive: true })
    const fresh = join(fx, 'fresh-res')

    const result = copyWatchArtifacts({ root, resourcesDir: fresh, logger })

    expect(result).toEqual({ changed: 0, hashChanged: false })
    expect(existsSync(fresh)).toBe(false)
  })

  it('中途失败 fail-visible：点名失败步骤 + 已完成前半（不谎报「没复制过」）', () => {
    run()
    // 让「复制 plugin.json」这一步写失败：产物清单位置被目录占用
    rmSync(join(res, 'plugin.json'))
    mkdirSync(join(res, 'plugin.json'))

    const result = run()

    expect(result.failed).toBe(true)
    expect(logger.error).toHaveBeenCalledTimes(2)
    const [headline, detail] = logger.error.mock.calls.map((call) => String(call[0]))
    expect(headline).toContain('步骤「复制 plugin.json」')
    expect(detail).toContain('已完成步骤')
    expect(detail).toContain('复制 index.js')
  })
})

describe('接线（dev 脚本必须真的用上内容感知复制）', () => {
  // 实现住桌面 SDK（发布物），dev-run 反向引它；应用侧从包名导入同一份文件
  const WATCH = 'packages/plugin-sdk-desktop/bin/plugin-watch.js'
  const DEV_RUN = 'scripts/dev-run.js'

  // 复制链语义已全部行为化（copyIfChanged / copyManifestIfChanged /
  // copyWatchArtifacts 三组测试），接线面只留这一条轻量锁：watch 入口真的
  // 调用共享复制链（issue #23 收敛：不再逐 copyStep 文案点名）。
  it('startPluginWatch 真的调用共享复制链 copyWatchArtifacts', () => {
    const src = readFileSync(WATCH, 'utf-8')
    const fnAt = src.indexOf('export function startPluginWatch')
    // 从入口定义起找调用点（跳过共享链自身的定义处）
    const wireAt = src.indexOf('copyWatchArtifacts({ root, resourcesDir, extraFiles', fnAt)
    expect(fnAt).toBeGreaterThan(-1)
    expect(wireAt, 'watch 必须走共享复制链（不得回退私有实现 / 无条件 cpSync）').toBeGreaterThan(fnAt)
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

  it('bedcode 的 --frontend-only 真的构建前端（沙箱 fixture 驱动真实 build.js）', () => {
    const { viteLog, cargoLog, resDir, run } = bedcodeBuildFixture()

    // --frontend-only：前端必须真的构建（vite 被调）、rust 不参与（cargo 未调）、
    // 前端挂载包落进产物目录（否则预重建静默复用旧 dist，改码不生效）
    run(['--frontend-only'])

    expect(readFileSync(viteLog, 'utf-8'), '--frontend-only 必须真的跑 vite build').toContain('vite build')
    expect(existsSync(cargoLog), '--frontend-only 不得触发 cargo（wasm 保持现状）').toBe(false)
    expect(
      readFileSync(join(resDir, 'index.js'), 'utf-8'),
      '新构建的前端挂载包必须落进产物目录',
    ).toBe('frontend bundle from fake vite\n')
  })
})

/**
 * bedcode build.js 的沙箱 fixture（issue #23：源码正则锁 → 行为锁）。
 *
 * 被锁源码住应用仓（本仓不改）：把真实 `scripts/build.js` 复制进临时目录，
 * 按它自身的相对布局补齐依赖桩（plugin-wasm-config / SDK wasm-hash），再以
 * PATH 注入假 vite / 假 cargo——build.js 以为在真构建，实际只记账。这样
 * 「`--frontend-only` 是否真的调 buildFrontend」由进程行为回答，改内部函数名 /
 * 重排编排不误红，漏调 vite 立即红。
 */
function bedcodeBuildFixture() {
  const fx = mkdtempSync(join(tmpdir(), 'wasmnest-bedcode-build-'))
  const buildSrc = appPath('bedcode', 'desktop', 'scripts/build.js')
  // build.js 以自身位置推导 ROOT（import.meta.url），fixture 必须复刻
  // `<appsRoot>/apps/bedcode/desktop/scripts/` 与 `<appsRoot>/scripts/` 布局
  const buildJs = join(fx, 'apps', 'bedcode', 'desktop', 'scripts', 'build.js')
  mkdirSync(join(fx, 'apps', 'bedcode', 'desktop', 'scripts'), { recursive: true })
  copyFileSync(buildSrc, buildJs)
  // 依赖桩 1：构建链配置（仅 buildRust 消费，--frontend-only 下不会走到）
  mkdirSync(join(fx, 'scripts'), { recursive: true })
  writeFileSync(
    join(fx, 'scripts', 'plugin-wasm-config.mjs'),
    [
      'export const WASM_TARGET = "wasm32-wasip2-unknown-unknown"',
      'export const WASM_TARGET_DIR = "rust/target"',
      'export function wasip3CargoEnv() { return process.env }',
      '',
    ].join('\n'),
  )
  // 依赖桩 2：SDK wasm-hash（node_modules 解析自 fx 根）
  const sdkDir = join(fx, 'node_modules', '@binblink', 'wasmnest-plugin-sdk-desktop', 'bin')
  mkdirSync(sdkDir, { recursive: true })
  writeFileSync(
    join(fx, 'node_modules', '@binblink', 'wasmnest-plugin-sdk-desktop', 'package.json'),
    '{"name":"@binblink/wasmnest-plugin-sdk-desktop","version":"0.0.0","type":"module"}\n',
  )
  writeFileSync(
    join(sdkDir, 'wasm-hash.js'),
    'export function injectWasmHash() { return { reason: "unchanged" } }\n',
  )
  // 插件工程最小面：源清单（ROOT/plugin.json）
  writeFileSync(
    join(fx, 'apps', 'bedcode', 'desktop', 'plugin.json'),
    `${JSON.stringify({ id: 'com.wasmnest.terminal-session', name: 'BedCode', rustLibrary: 'bedcode_plugin_terminal_session' }, null, 2)}\n`,
  )
  // 产物目录预置 wasm：--frontend-only 的语义 = 复用上一份 wasm
  const outDir = join(fx, 'out')
  const resDir = join(outDir, 'com.wasmnest.terminal-session')
  mkdirSync(resDir, { recursive: true })
  writeFileSync(join(resDir, 'bedcode_plugin_terminal_session.wasm'), 'wasm-bytes')

  // 假工具链：npx vite build → 记账 + 产出 dist/index.js；cargo → 记账
  const fakeBin = join(fx, 'fakebin')
  mkdirSync(fakeBin, { recursive: true })
  const viteLog = join(fx, 'vite.log')
  const cargoLog = join(fx, 'cargo.log')
  writeFileSync(
    join(fakeBin, 'npx'),
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = "vite" ] && [ "$2" = "build" ]; then',
      `  echo "vite build" >> "${viteLog}"`,
      '  mkdir -p dist',
      '  printf "frontend bundle from fake vite\\n" > dist/index.js',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(fakeBin, 'cargo'),
    ['#!/usr/bin/env bash', `echo "cargo $1" >> "${cargoLog}"`, 'exit 0', ''].join('\n'),
  )
  chmodSync(join(fakeBin, 'npx'), 0o755)
  chmodSync(join(fakeBin, 'cargo'), 0o755)

  const run = (flags: string[]) => {
    execFileSync(process.execPath, [buildJs, '--out', outDir, ...flags], {
      cwd: fx,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  return { fx, viteLog, cargoLog, resDir, run }
}
