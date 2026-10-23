import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 桌面端脚本不是 TS 工程的一部分，按相对路径直引真实实现（与 pluginWatchCopy.test.ts
// 同一口径）；模块导入无副作用（CLI 直执行入口按 process.argv[1] 判定，测试里不触发）。
// 四步与陈旧判定均为可注入依赖的导出：本文件注入记录器 / 临时目录，绝不触发真实构建。
import {
  ensurePluginFrontends,
  ensurePluginManifests,
  ensurePluginWasm,
  frontendStaleReason,
  pruneStalePluginDirs,
  runPluginPrecheck,
  wasmStaleReason,
} from '../../../scripts/plugin-precheck.mjs'

/**
 * 插件产物预检四步的行为锁（issue #12 / spec §4.1：行为断言 + 轻量接线锁）
 *
 * 背景：dev 预检已从 dev-run.js 内联实现收进 scripts/plugin-precheck.mjs，接线面
 * 只留一条「runPluginPrecheck 先于宿主启动」的轻量锁（pluginWatchCopy.test.ts）；
 * 四步各自的判据与顺序在这里用**可注入依赖 + 真实临时目录**承载：
 *   1. 陈旧判定：产物缺失 / 源码（端 rust/ · 应用级 ../rust/ · SDK rust/src）比产物新 /
 *      构建产物目录（target / dist / node_modules）不算源码；
 *   2. ensurePluginWasm：`--out` 直写宿主产物目录（2026-10-23 修复的接线）、
 *      dist 在场走 `--rust-only` 快路径、产物最新零构建（幂等秒过）、失败 fail-fast；
 *   3. ensurePluginFrontends：skipWatch 插件不预重建、`--frontend-only --out`；
 *   4. ensurePluginManifests：skipWatch / 产物目录缺失跳过，真实同步出 wasmHash；
 *   5. runPluginPrecheck：四步顺序 = WASM → 前端 → 清单 → 退役清理。
 */

const PAST = new Date('2001-01-01T00:00:00Z')
const FUTURE = new Date('2099-01-01T00:00:00Z')

let dir: string
let resourcesBase: string
let runtimeResourcesBase: string
let sdkRoot: string
let pluginRoot: string

/** 写文件并把 mtime 钉到指定时刻（判定只看 mtime，钉住才能证明「谁更新」） */
function touch(path: string, date: Date, content = 'x'): void {
  writeFileSync(path, content)
  utimesSync(path, date, date)
}

/** 最小注册表条目（wasmFile 只被 ensurePluginWasm 取 basename() 定位产物名） */
function pluginEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    group: 'apps',
    slug: 'demo',
    id: 'com.example.demo',
    args: ['scripts/build.js', '--watch'],
    wasmFile: 'rust/target/wasm32-wasip3/release/demo_plugin.wasm',
    ...overrides,
  }
}

/** 记录型构建执行器：不 spawn 任何进程，只记录命令形态 */
function recorderBuild(status = 0) {
  const calls: Array<{ script: string[]; cwd: string }> = []
  return {
    calls,
    runBuild: (script: string[], cwd: string) => {
      calls.push({ script, cwd })
      return { status }
    },
  }
}

/** 记录型 exit（默认实现是 process.exit，注入后不真杀测试进程） */
function recorderExit() {
  const codes: number[] = []
  return { codes, exit: (code: number) => void codes.push(code) }
}

/** 标准可注入依赖集：临时目录布局 + 记录器；overrides 逐测试替换 */
function makeDeps(overrides: Record<string, unknown> = {}) {
  const build = recorderBuild()
  const exiter = recorderExit()
  return {
    build,
    exiter,
    deps: {
      plugins: [pluginEntry()],
      resourcesBase,
      runtimeResourcesBase,
      appDirOf: () => pluginRoot,
      hasApp: () => existsSync(pluginRoot),
      sdkRoot,
      runBuild: build.runBuild,
      exit: exiter.exit,
      ...overrides,
    },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wasmnest-precheck-'))
  resourcesBase = join(dir, 'resources', 'desktop')
  runtimeResourcesBase = join(dir, 'runtime', 'desktop')
  sdkRoot = join(dir, 'sdk')
  pluginRoot = join(dir, 'apps', 'demo', 'desktop')
  mkdirSync(resourcesBase, { recursive: true })
  mkdirSync(runtimeResourcesBase, { recursive: true })
  mkdirSync(join(pluginRoot, 'src'), { recursive: true })
  mkdirSync(join(sdkRoot, 'rust'), { recursive: true })
  mkdirSync(join(sdkRoot, 'src'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('陈旧判定：wasmStaleReason（真实临时目录）', () => {
  const sdkRust = () => join(sdkRoot, 'rust')

  it('产物缺失 → 报缺失原因（不静默当最新）', () => {
    const reason = wasmStaleReason(pluginRoot, join(resourcesBase, 'missing.wasm'), {
      sdkRustRoot: sdkRust(),
    })
    expect(reason).toContain('产物缺失')
  })

  it('端内 rust/ 源码比产物新 → 需重建', () => {
    const wasm = join(resourcesBase, 'com.example.demo', 'demo_plugin.wasm')
    mkdirSync(join(wasm, '..'), { recursive: true })
    touch(wasm, PAST)
    mkdirSync(join(pluginRoot, 'rust', 'src'), { recursive: true })
    touch(join(pluginRoot, 'rust', 'src', 'lib.rs'), FUTURE)
    expect(
      wasmStaleReason(pluginRoot, wasm, { sdkRustRoot: sdkRust() }),
    ).toBe('Rust 源码比产物新（需重建）')
  })

  it('应用级 ../rust/（file-transfer 布局）比产物新 → 需重建（只扫端目录会静默失效）', () => {
    const wasm = join(resourcesBase, 'com.example.demo', 'demo_plugin.wasm')
    mkdirSync(join(wasm, '..'), { recursive: true })
    touch(wasm, PAST)
    // 端目录无 rust/，crate 收在上一级 apps/demo/rust/（真实布局：{core,plugin}）
    mkdirSync(join(pluginRoot, '..', 'rust', 'core'), { recursive: true })
    touch(join(pluginRoot, '..', 'rust', 'core', 'mod.rs'), FUTURE)
    expect(wasmStaleReason(pluginRoot, wasm, { sdkRustRoot: sdkRust() })).toContain('需重建')
  })

  it('SDK rust 面（WIT / 权限表 / HostApp trait）比产物新 → 全量补建判据', () => {
    const wasm = join(resourcesBase, 'com.example.demo', 'demo_plugin.wasm')
    mkdirSync(join(wasm, '..'), { recursive: true })
    touch(wasm, PAST)
    touch(join(sdkRoot, 'rust', 'permissions.wit'), FUTURE)
    expect(wasmStaleReason(pluginRoot, wasm, { sdkRustRoot: sdkRust() })).toContain('需重建')
  })

  it('产物最新 → null；target/dist/node_modules 里的新文件不算源码（增量产物不误判）', () => {
    const wasm = join(resourcesBase, 'com.example.demo', 'demo_plugin.wasm')
    mkdirSync(join(wasm, '..'), { recursive: true })
    touch(wasm, PAST)
    // 真源码比产物旧
    mkdirSync(join(pluginRoot, 'rust', 'src'), { recursive: true })
    touch(join(pluginRoot, 'rust', 'src', 'lib.rs'), new Date(PAST.getTime() - 86400_000))
    // 构建产物目录里的新文件必须被跳过，否则增量构建会永远判「陈旧」
    for (const skip of ['target', 'dist', 'node_modules']) {
      mkdirSync(join(pluginRoot, 'rust', skip), { recursive: true })
      touch(join(pluginRoot, 'rust', skip, 'incremental.bin'), FUTURE)
    }
    expect(wasmStaleReason(pluginRoot, wasm, { sdkRustRoot: sdkRust() })).toBeNull()
  })
})

describe('陈旧判定：frontendStaleReason（真实临时目录）', () => {
  const sdkSrc = () => join(sdkRoot, 'src')

  function bundle(): string {
    const dest = join(resourcesBase, 'com.example.demo', 'index.js')
    mkdirSync(join(dest, '..'), { recursive: true })
    return dest
  }

  it('产物缺失 → 报缺失原因', () => {
    expect(
      frontendStaleReason(pluginRoot, join(resourcesBase, 'com.example.demo', 'index.js'), {
        sdkSrcRoot: sdkSrc(),
      }),
    ).toContain('产物缺失')
  })

  it('前端源码比产物新 → 需重建', () => {
    const dest = bundle()
    touch(dest, PAST)
    touch(join(pluginRoot, 'src', 'main.ts'), FUTURE)
    expect(frontendStaleReason(pluginRoot, dest, { sdkSrcRoot: sdkSrc() })).toBe(
      '前端源码比产物新（需重建）',
    )
  })

  it('打包配置（vite.config.ts / plugin.json）比产物新也要重建', () => {
    const dest = bundle()
    touch(dest, PAST)
    touch(join(pluginRoot, 'vite.config.ts'), FUTURE)
    expect(frontendStaleReason(pluginRoot, dest, { sdkSrcRoot: sdkSrc() })).toContain('需重建')
  })

  it('共享 SDK 前端（packages/plugin-sdk-desktop/src）比产物新 → 重建', () => {
    const dest = bundle()
    touch(dest, PAST)
    touch(join(sdkRoot, 'src', 'shared.ts'), FUTURE)
    expect(frontendStaleReason(pluginRoot, dest, { sdkSrcRoot: sdkSrc() })).toContain('需重建')
  })

  it('全部旧于产物 → null（幂等秒过的判据）', () => {
    const dest = bundle()
    touch(dest, FUTURE)
    touch(join(pluginRoot, 'src', 'main.ts'), PAST)
    touch(join(sdkRoot, 'src', 'shared.ts'), PAST)
    expect(frontendStaleReason(pluginRoot, dest, { sdkSrcRoot: sdkSrc() })).toBeNull()
  })
})

describe('ensurePluginWasm（注入构建记录器，绝不触发真实构建）', () => {
  function wasmArtifact(date: Date): string {
    const wasm = join(resourcesBase, 'com.example.demo', 'demo_plugin.wasm')
    mkdirSync(join(wasm, '..'), { recursive: true })
    touch(wasm, date)
    return wasm
  }

  it('产物缺失且无 dist → 全量构建，且 --out 直写宿主产物目录（2026-10-23 修复的接线）', () => {
    const { deps, build } = makeDeps()
    ensurePluginWasm(deps)
    expect(build.calls).toHaveLength(1)
    expect(build.calls[0]?.script).toEqual(['scripts/build.js', '--out', resourcesBase])
    expect(build.calls[0]?.cwd).toBe(pluginRoot)
  })

  it('dist/index.js 已在场 → 走 --rust-only 快路径（跳过 vite）', () => {
    mkdirSync(join(pluginRoot, 'dist'), { recursive: true })
    writeFileSync(join(pluginRoot, 'dist', 'index.js'), 'bundle')
    const { deps, build } = makeDeps()
    ensurePluginWasm(deps)
    expect(build.calls[0]?.script).toEqual([
      'scripts/build.js',
      '--rust-only',
      '--out',
      resourcesBase,
    ])
  })

  it('产物最新 → 零构建（幂等：beforeDevCommand 与 dev-run 双路径相遇秒过）', () => {
    wasmArtifact(FUTURE)
    mkdirSync(join(pluginRoot, 'rust'), { recursive: true })
    touch(join(pluginRoot, 'rust', 'lib.rs'), PAST)
    const { deps, build } = makeDeps()
    ensurePluginWasm(deps)
    expect(build.calls).toHaveLength(0)
  })

  it('补建 exit≠0 → fail-fast（exit 收到退出码，不静默继续带旧产物起宿主）', () => {
    const { deps, build, exiter } = makeDeps()
    const failing = recorderBuild(2)
    deps.runBuild = failing.runBuild
    ensurePluginWasm(deps)
    expect(build.calls).toHaveLength(0)
    expect(failing.calls).toHaveLength(1)
    expect(exiter.codes).toEqual([2])
  })
})

describe('ensurePluginFrontends（注入构建记录器）', () => {
  function bundleArtifact(date: Date): string {
    const dest = join(resourcesBase, 'com.example.demo', 'index.js')
    mkdirSync(join(dest, '..'), { recursive: true })
    touch(dest, date)
    return dest
  }

  it('bundle 缺失 → --frontend-only --out 直写 resources（宿主启动前完成预重建）', () => {
    const { deps, build } = makeDeps()
    ensurePluginFrontends(deps)
    expect(build.calls).toHaveLength(1)
    expect(build.calls[0]?.script).toEqual([
      'scripts/build.js',
      '--frontend-only',
      '--out',
      resourcesBase,
    ])
    expect(build.calls[0]?.cwd).toBe(pluginRoot)
  })

  it('skipWatch 插件（bedcode 口径）即便产物缺失也不预重建', () => {
    const { deps, build } = makeDeps({ plugins: [pluginEntry({ skipWatch: true })] })
    ensurePluginFrontends(deps)
    expect(build.calls).toHaveLength(0)
  })

  it('bundle 最新 → 零构建', () => {
    bundleArtifact(FUTURE)
    touch(join(pluginRoot, 'src', 'main.ts'), PAST)
    const { deps, build } = makeDeps()
    ensurePluginFrontends(deps)
    expect(build.calls).toHaveLength(0)
  })
})

describe('ensurePluginManifests（真实同步，真实临时目录）', () => {
  function writeSourceManifest(): void {
    writeFileSync(
      join(pluginRoot, 'plugin.json'),
      `${JSON.stringify(
        { id: 'com.example.demo', name: 'Demo', rustLibrary: 'demo_plugin' },
        null,
        2,
      )}\n`,
    )
  }

  function artifactDir(): string {
    const artifact = join(resourcesBase, 'com.example.demo')
    mkdirSync(artifact, { recursive: true })
    return artifact
  }

  it('产物 plugin.json 落后于源清单 → 启动前同步出 wasmHash（wasm 摘要基线对齐）', () => {
    writeSourceManifest()
    const artifact = artifactDir()
    writeFileSync(join(artifact, 'demo_plugin.wasm'), 'wasm-bytes')
    writeFileSync(join(artifact, 'plugin.json'), '{"id":"com.example.demo"}')
    ensurePluginManifests(makeDeps().deps)
    const manifest = JSON.parse(readFileSync(join(artifact, 'plugin.json'), 'utf-8'))
    expect(manifest.name).toBe('Demo')
    expect(manifest.wasmHash).toBeTypeOf('string')
  })

  it('已是基线形态 → 不写（syncArtifactManifest 的幂等由 pluginWatchCopy 锁死，这里锁接线不重复写）', () => {
    writeSourceManifest()
    const artifact = artifactDir()
    writeFileSync(join(artifact, 'demo_plugin.wasm'), 'wasm-bytes')
    ensurePluginManifests(makeDeps().deps) // 第一遍：写出基线
    const before = readFileSync(join(artifact, 'plugin.json'), 'utf-8')
    ensurePluginManifests(makeDeps().deps) // 第二遍：不得有第二次写入
    expect(readFileSync(join(artifact, 'plugin.json'), 'utf-8')).toBe(before)
  })

  it('skipWatch / 产物目录缺失 → 跳过（不动任何文件）', () => {
    writeSourceManifest()
    const { deps } = makeDeps({ plugins: [pluginEntry({ skipWatch: true })] })
    expect(() => ensurePluginManifests(deps)).not.toThrow()
    expect(existsSync(join(resourcesBase, 'com.example.demo'))).toBe(false)
    // 非 skipWatch 但产物目录不存在：同样跳过（冷启动首建交给 WASM 补建步）
    const fresh = makeDeps()
    expect(() => ensurePluginManifests(fresh.deps)).not.toThrow()
  })
})

describe('pruneStalePluginDirs（退役产物清理）', () => {
  it('两个产物根里：注册表外的幽灵目录被删、注册表内的保留（fail-visible 清理）', () => {
    for (const base of [resourcesBase, runtimeResourcesBase]) {
      mkdirSync(join(base, 'com.example.demo'), { recursive: true }) // 在注册表
      mkdirSync(join(base, 'com.bedcode.legacy'), { recursive: true }) // ADR 0056 改名后的退役 id
      writeFileSync(join(base, 'com.bedcode.legacy', 'index.js'), 'ghost')
    }
    pruneStalePluginDirs(makeDeps().deps)
    for (const base of [resourcesBase, runtimeResourcesBase]) {
      expect(existsSync(join(base, 'com.example.demo')), `${base} 注册表目录被误删`).toBe(true)
      expect(existsSync(join(base, 'com.bedcode.legacy')), `${base} 幽灵目录未被清理`).toBe(
        false,
      )
    }
  })

  it('产物根不存在 → 静默跳过（首建环境无目录可清）', () => {
    rmSync(resourcesBase, { recursive: true, force: true })
    rmSync(runtimeResourcesBase, { recursive: true, force: true })
    expect(() => pruneStalePluginDirs(makeDeps().deps)).not.toThrow()
  })
})

describe('runPluginPrecheck：四步顺序（WASM 补建 → 前端预重建 → 清单基线 → 退役清理）', () => {
  it('单插件全陈旧布局上，事件顺序与文件效果一致', () => {
    // 全陈旧：wasm / bundle / 清单都要动作，另留一个幽灵目录看清理时机
    const artifact = join(resourcesBase, 'com.example.demo')
    mkdirSync(artifact, { recursive: true })
    writeFileSync(join(artifact, 'plugin.json'), '{"id":"com.example.demo"}')
    mkdirSync(join(resourcesBase, 'com.bedcode.legacy'), { recursive: true })
    writeFileSync(join(pluginRoot, 'plugin.json'), `${JSON.stringify(
      { id: 'com.example.demo', name: 'Demo', rustLibrary: 'demo_plugin' },
      null,
      2,
    )}\n`)

    const events: string[] = []
    const ghostDir = join(resourcesBase, 'com.bedcode.legacy')
    const build = recorderBuild()
    const exiter = recorderExit()
    runPluginPrecheck({
      plugins: [pluginEntry()],
      resourcesBase,
      runtimeResourcesBase,
      appDirOf: () => pluginRoot,
      hasApp: () => true,
      sdkRoot,
      runBuild: (script: string[]) => {
        events.push(script.includes('--frontend-only') ? 'frontend-build' : 'wasm-build')
        return build.runBuild(script, pluginRoot)
      },
      // 记录清单同步时刻幽灵目录是否还在（在 = 清理还没轮到，锁顺序）
      sync: (src: string, dest: string) => {
        events.push('manifest-sync')
        expect(existsSync(ghostDir), '清单同步时幽灵目录已被清理：顺序错成 清理→清单').toBe(
          true,
        )
        return { written: true, reason: 'written' as const }
      },
      exit: exiter.exit,
    })

    expect(events).toEqual(['wasm-build', 'frontend-build', 'manifest-sync'])
    expect(existsSync(ghostDir), '预检结束后幽灵目录必须被清理').toBe(false)
    expect(exiter.codes).toEqual([])
  })
})
