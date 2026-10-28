#!/usr/bin/env node

/**
 * package-host —— 产出「可直接运行的宿主产物目录」（供 wasm-app 工程 dev / E2E 使用，不需平台仓源码）
 *
 * ## 为什么需要它
 *
 * wasm-app（应用仓 `apps/<slug>/desktop`）的 UI 迭代长期只能靠**平台仓** `pnpm run
 * tauri:dev`：宿主插件目录在 dev 下硬绑 `CARGO_MANIFEST_DIR/resources/plugins/desktop`
 * （`src-tauri/src/lib.rs`），产物也必须写进平台仓。应用开发者因此被迫依赖平台仓源码。
 *
 * 宿主侧已加 `WASMNEST_PLUGINS_DIR` 覆盖（未设置时行为逐字不变，发布链路不受影响），
 * 于是宿主可以**以构建产物分发**：本脚本打出一份可直接运行的宿主（前端 dist 已由
 * tauri build 嵌入二进制，不需要 vite dev server / 平台仓源码），应用工程把它当运行时，
 * 用 env 把自己的产物目录递给它。
 *
 * ## 产物（宿主运行时产物契约 → 应用仓 `.scratch/2026-10-21-host-runtime-distribution/CONTRACT.md` §1）
 *
 * ```text
 * wasmnest-desktop/dist-host/                  # 默认产物父目录
 *   └─ host-desktop/                           # 产物目录（--out 可覆盖）
 *      ├─ <binary>                           # debug profile（保留 PluginDevWatcher 热重载 + devCsp）
 *      ├─ config.properties                  # 宿主内置配置（bundle.resources 在 --no-bundle 下不复制，随手带上）
 *      └─ host-version.json                  # 版本事实（hostVersion / platform / arch / sourceCommit / ...）
 * ```
 *
 * 产物目录**必须**在 `dist/` 之外（默认 `dist-host/`）：`frontendDist = ../dist`，`vite build`
 * 默认清空 `dist`，落在那里的产物会被下一次前端构建静默删除。
 *
 * ## 不再产出压缩包（2026-10-28 用户裁决）
 *
 * 平台仓**不再构建 / 发布任何 tar.gz**：这里只落目录。面向终端用户的分发形态改为安装包，
 * 机器侧的 tar.gz + sha256 分发链（含 `release-manifest.json` 的 `hostRuntime.artifacts`、
 * `host-release.yml`、`update-host-runtime-artifacts.mjs`）已退役。
 *
 * ## 用法
 *
 * ```bash
 * cd wasmnest/wasmnest-desktop
 * pnpm run host:pack                       # 构建（tauri build --debug --no-bundle）+ 收集到产物目录
 * pnpm run host:pack -- --via-cargo        # 绕开 tauri CLI 的版本一致性检查（见下）
 * pnpm run host:pack -- --skip-build       # 跳过构建，直接复用 src-tauri/target/debug/<bin> 重铺产物
 * node scripts/package-host.mjs --out /tmp/host-desktop
 * ```
 *
 * ### `--via-cargo`（npm 包与 Rust crate minor 漂移时的通路）
 *
 * tauri CLI 在 build 前校验「npm 包 ↔ Rust crate」的 major/minor 一致，不一致直接退出
 * （`Found version mismatched Tauri packages`）。宿主工程 Cargo.toml 用 `version = "2"`
 * 这类宽松写法，Rust 侧被 lock 钉到较新 minor 时就会与 npm 侧漂移——**这是依赖问题，
 * 与本脚本无关**（`pnpm run tauri:build` 同样会红）。根治是升级 npm 侧 6 个包
 * （或回退 Rust 侧），但那属于依赖变更，需单独决策。
 *
 * `--via-cargo` 不走 CLI：先 `pnpm run build:fast` 产出宿主前端 `dist/`，再在
 * `src-tauri/` 下 `cargo build`（debug）——build.rs 的 `tauri_build::build()` 同样会把
 * `frontendDist`（L2 后 = `shell-dist`，由 `pnpm run shell:sync` 从 dist 同步）嵌入二进制，
 * 产物与 `tauri build --no-bundle` 等价。
 *
 * ### 版本事实（单一真源 = `release-manifest.json` 的 `hostRuntime` 段）
 *
 * `hostVersion` / `sdkVersion` / `mountContract` 读 `hostRuntime`；`libTag` 读 `repos.lib.tag`；
 * `witVersion` 读 `contract.version`。`tauri.conf.json` 不再作为宿主版本真源（发布时由
 * `scripts/set-host-version.mjs` 同步）；两者不一致时打印警告，不静默。
 *
 * ### 二进制名
 *
 * 优先 `[[bin]].name`，缺失才退回 `[package].name`——L2 会把 `[package].name` 改成
 * `wasmnest-desktop-runtime` 并保留 `[[bin]] name = "wasmnest-desktop"`，产物名不得随之漂移。
 *
 * ## 为什么固定 debug profile
 *
 * 热重载源 `PluginDevWatcher`（emit `plugin:dev-reload`）在 `src-tauri/src/lib.rs`
 * 被 `#[cfg(debug_assertions)]` 包住——release 产物**没有**热重载。故宿主产物固定
 * debug profile（包体大，但 dev / E2E 诊断能力完整）。将来若需 release + 热重载，把该
 * cfg 换成 feature 后再加参数切换。
 *
 * ## 失败口径
 *
 * 缺 manifest 段 / 缺二进制 / 缺 config / git 身份读不到，全部 fail-visible
 *（点名缺什么 + 给出路，不静默降级）。
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOST_ROOT = resolve(__dirname, '..')
const PLATFORM_ROOT = resolve(HOST_ROOT, '..')
const IS_WIN = process.platform === 'win32'

/** 严格 semver 数字段（不允许前导零；CONTRACT 版本线都是 x.y.z） */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** CONTRACT §1.3 必填字段（顺序即写入顺序；新增可选字段不在此表，读取方忽略未知字段） */
export const HOST_VERSION_FIELDS = Object.freeze([
  'hostVersion',
  'platform',
  'arch',
  'sourceCommit',
  'libTag',
  'witVersion',
  'sdkVersion',
  'mountContract',
  'binary',
  'builtBy',
  'builtAt',
  'pluginsEnv',
  'note',
])

const HOST_VERSION_NOTE =
  '宿主构建产物：应用工程以 WASMNEST_PLUGINS_DIR 指定自己的 plugins 目录后直接运行本二进制'

/** Node 平台名 → CONTRACT §1.3 的 platform token */
export function normalizePlatform(platform) {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return platform
}

/** Node 架构名 → CONTRACT §1.3 的 arch token */
export function normalizeArch(arch) {
  if (arch === 'x64') return 'x86_64'
  return arch
}

/** host-version.json（CONTRACT §1.3；L3 瘦身已取消，不再写 profile） */
export function buildHostVersionJson({
  hostVersion,
  platform,
  arch,
  sourceCommit,
  libTag,
  witVersion,
  sdkVersion,
  mountContract,
  binary,
  builtBy,
  builtAt,
  dirty,
}) {
  const values = {
    hostVersion,
    platform,
    arch,
    sourceCommit,
    libTag,
    witVersion,
    sdkVersion,
    mountContract,
    binary,
    builtBy,
    builtAt,
  }
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`[package-host] host-version.json 的 ${key} 缺失或非字符串`)
    }
  }
  const meta = { ...values, pluginsEnv: 'WASMNEST_PLUGINS_DIR', note: HOST_VERSION_NOTE }
  // 可选字段：工作树有未提交改动时标记，读取方忽略未知字段（CONTRACT §1.3 兼容规则）
  if (dirty) meta.dirty = true
  return meta
}

/** 取 TOML 的某个顶层 section 文本（`[name]` 到下一个 `[` 之前） */
function sectionOf(toml, name) {
  const start = new RegExp(`^\\[${name}\\]\\s*$`, 'm').exec(toml)
  if (!start) return null
  const rest = toml.slice(start.index + start[0].length)
  const end = rest.search(/^\[/m)
  return end === -1 ? rest : rest.slice(0, end)
}

/** 宿主二进制名：优先 [[bin]].name，缺失才退回 [package].name（P3 改 package name 不影响产物名） */
export function resolveHostBinaryName(cargoToml) {
  for (const block of cargoToml.split(/^\[\[bin\]\]\s*$/m).slice(1)) {
    const seg = block.split(/^\[/m)[0]
    const m = /^\s*name\s*=\s*"([^"]+)"/m.exec(seg)
    if (m) return m[1]
  }
  const pkg = sectionOf(cargoToml, 'package')
  const m = pkg && /^\s*name\s*=\s*"([^"]+)"/m.exec(pkg)
  if (m) return m[1]
  throw new Error('[package-host] src-tauri/Cargo.toml 里读不到 [[bin]].name 或 [package].name')
}

/**
 * 从 release-manifest 读取宿主版本事实（唯一真源）。
 * 缺段 / 缺字段 / 非法 semver / 与 repos.contract 真源不一致 → 抛错。
 */
export function parseHostRuntimeManifest(manifest) {
  const hostRuntime = manifest?.hostRuntime
  if (!hostRuntime || typeof hostRuntime !== 'object' || Array.isArray(hostRuntime)) {
    throw new Error(
      '[package-host] release-manifest.json 缺 hostRuntime 段（CONTRACT §2.3）；' +
        '发布前须补齐 version / sourceCommit / libTag / witVersion / sdkVersion / mountContract / artifacts',
    )
  }
  const str = (field) => {
    const value = hostRuntime[field]
    if (typeof value !== 'string' || value === '') {
      throw new Error(`[package-host] release-manifest.json 的 hostRuntime.${field} 缺失或非字符串`)
    }
    return value
  }
  const version = str('version')
  if (!SEMVER_RE.test(version)) {
    throw new Error(`[package-host] hostRuntime.version=${version} 非 semver（CONTRACT §2.3）`)
  }
  const libTag = str('libTag')
  const reposLibTag = manifest?.repos?.lib?.tag
  if (libTag !== reposLibTag) {
    throw new Error(`[package-host] hostRuntime.libTag=${libTag} 与 repos.lib.tag=${reposLibTag} 不一致`)
  }
  const witVersion = str('witVersion')
  const contractVersion = manifest?.contract?.version
  if (witVersion !== contractVersion) {
    throw new Error(
      `[package-host] hostRuntime.witVersion=${witVersion} 与 contract.version=${contractVersion} 不一致`,
    )
  }
  return {
    version,
    sdkVersion: str('sdkVersion'),
    mountContract: str('mountContract'),
    libTag,
    witVersion,
  }
}

// ==================== CLI ====================

function fail(msg, hint) {
  console.error(msg)
  if (hint) console.error(hint)
  process.exit(1)
}

function toExecutable(cmd) {
  return IS_WIN && cmd === 'pnpm' ? 'pnpm.cmd' : cmd
}

function gitOutput(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) return null
  return result.stdout.trim()
}

function readText(file, label) {
  if (!existsSync(file)) fail(`[package-host] 缺 ${label}：${file}`)
  return readFileSync(file, 'utf-8')
}

/**
 * 构建（tauri build --debug --no-bundle 或 --via-cargo）。
 * --no-bundle 的理由：bundle 只产出安装包，而我们要的是**可直接运行**的二进制；
 * 前端 dist 由 tauri build 嵌入二进制，与是否 bundle 无关。
 */
function buildHost(viaCargo) {
  if (viaCargo) {
    // 随包壳前端 = src-tauri/shell-dist（frontendDist 指向它，L2 契约 §5.1）。
    // 这条路径绕开 tauri CLI，因此 beforeBuildCommand 不会跑：必须自己 build:fast + 同步。
    console.log('[package-host] --via-cargo：构建宿主前端并同步随包 shell-dist（pnpm run shell:sync）')
    const fe = spawnSync(toExecutable('pnpm'), ['run', 'shell:sync'], { cwd: HOST_ROOT, stdio: 'inherit' })
    if (fe.status !== 0) fail(`[package-host] 宿主前端 / shell-dist 构建失败（exit=${fe.status}）`)
    if (!existsSync(join(HOST_ROOT, 'src-tauri', 'shell-dist', 'index.html'))) {
      fail('[package-host] src-tauri/shell-dist 未生成 —— build.rs 嵌入 frontendDist 会失败')
    }
    console.log('[package-host] --via-cargo：cargo build（src-tauri，debug）')
    const be = spawnSync('cargo', ['build'], { cwd: join(HOST_ROOT, 'src-tauri'), stdio: 'inherit' })
    if (be.status !== 0) fail(`[package-host] 宿主构建失败（exit=${be.status}）`)
    return
  }

  const require = createRequire(import.meta.url)
  let tauriCli
  try {
    tauriCli = require.resolve('@tauri-apps/cli/tauri.js')
  } catch {
    fail('[package-host] 找不到 @tauri-apps/cli（宿主工程未装依赖？先 pnpm install）')
  }
  console.log(
    '[package-host] 构建宿主（debug profile，--no-bundle）：随包壳 shell-dist 会被嵌入二进制\n' +
      '[package-host]   shell-dist 由 tauri.conf 的 beforeBuildCommand（pnpm run shell:sync）刷新',
  )
  const build = spawnSync(
    process.execPath,
    // createUpdaterArtifacts 需签名密钥；本产物不发布安装包，显式关掉避免缺密钥直接失败
    [
      tauriCli,
      'build',
      '--debug',
      '--no-bundle',
      '--config',
      JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
    ],
    { cwd: HOST_ROOT, stdio: 'inherit' },
  )
  if (build.status !== 0) {
    fail(
      `[package-host] 宿主构建失败（exit=${build.status}）`,
      '[package-host]   若报错是 "Found version mismatched Tauri packages"：npm 包与 Rust crate\n' +
        '[package-host]   minor 漂移（依赖问题，与打包脚本无关，tauri:build 同样会红）。\n' +
        '[package-host]   两条路：① 加 --via-cargo 绕开 CLI 检查先拿产物；② 根治：升 npm 侧\n' +
        '[package-host]   @tauri-apps/* 到与 crate 同 minor（或回退 Rust 侧版本）后重跑。',
    )
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const valueOf = (flag, fallback) => {
    const i = argv.indexOf(flag)
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
  }
  const viaCargo = argv.includes('--via-cargo')
  const skipBuild = argv.includes('--skip-build')
  const outDir = resolve(HOST_ROOT, valueOf('--out', 'dist-host/host-desktop'))

  if (viaCargo && skipBuild) fail('[package-host] --via-cargo 与 --skip-build 互斥（一个要构建，一个跳过构建）')

  // ---------- 版本事实（manifest 是唯一真源） ----------
  const manifestPath = join(PLATFORM_ROOT, 'release-manifest.json')
  let manifest
  try {
    manifest = JSON.parse(readText(manifestPath, 'release-manifest.json'))
  } catch (err) {
    fail(`[package-host] 解析 release-manifest.json 失败：${err.message}`)
  }
  let truth
  try {
    truth = parseHostRuntimeManifest(manifest)
  } catch (err) {
    fail(err.message)
  }

  const tauriConfPath = join(HOST_ROOT, 'src-tauri', 'tauri.conf.json')
  const tauriConf = JSON.parse(readText(tauriConfPath, 'tauri.conf.json'))
  const cargoTomlPath = join(HOST_ROOT, 'src-tauri', 'Cargo.toml')
  const cargoToml = readText(cargoTomlPath, 'src-tauri/Cargo.toml')

  let binaryStem
  try {
    binaryStem = resolveHostBinaryName(cargoToml)
  } catch (err) {
    fail(err.message)
  }

  const sdkCargoPath = join(HOST_ROOT, 'packages', 'plugin-sdk-desktop', 'rust', 'Cargo.toml')
  const sdkSection = sectionOf(readText(sdkCargoPath, '桌面 SDK Cargo.toml'), 'package') ?? ''
  const sdkVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(sdkSection)?.[1]
  if (!sdkVersion) fail(`[package-host] 桌面 SDK Cargo.toml 里读不到 [package].version：${sdkCargoPath}`)
  if (sdkVersion !== truth.sdkVersion) {
    fail(
      `[package-host] SDK 版本不一致：release-manifest hostRuntime.sdkVersion=${truth.sdkVersion}，` +
        `SDK Cargo.toml=${sdkVersion}（先对齐版本，禁止产物内版本事实与真实 SDK 不符）`,
    )
  }

  const platform = normalizePlatform(process.platform)
  const arch = normalizeArch(process.arch)

  if (tauriConf.version !== truth.version) {
    console.warn(
      `[package-host][warn] tauri.conf.json version=${tauriConf.version} 与 hostRuntime.version=${truth.version} 不一致；` +
        '发布前用 node scripts/set-host-version.mjs <x.y.z> 同步（本脚本以 manifest 为准）',
    )
  }

  const sourceCommit = gitOutput(PLATFORM_ROOT, ['rev-parse', 'HEAD'])
  if (!sourceCommit) {
    fail(
      `[package-host] 读不到平台仓 HEAD（git rev-parse HEAD 失败，cwd=${PLATFORM_ROOT}）——` +
        'sourceCommit 是宿主构建身份的一部分，不接受缺省',
    )
  }
  const dirtyOutput = gitOutput(PLATFORM_ROOT, ['status', '--porcelain', '--untracked-files=no'])
  const dirty = Boolean(dirtyOutput)
  if (dirty) {
    console.warn(
      `[package-host][warn] 平台仓工作树有未提交改动（host-version.json 将标记 dirty:true）：\n${dirtyOutput}`,
    )
  }

  // ---------- 构建 + 收集 ----------
  if (!skipBuild) buildHost(viaCargo)
  else console.log('[package-host] --skip-build：跳过构建，复用 src-tauri/target/debug 下现有二进制')

  const binName = IS_WIN ? `${binaryStem}.exe` : binaryStem
  const builtBin = join(HOST_ROOT, 'src-tauri', 'target', 'debug', binName)
  if (!existsSync(builtBin)) {
    fail(
      `[package-host] 构建产物不存在：${builtBin}`,
      '[package-host]   检查 src-tauri/Cargo.toml 的 [[bin]].name / [package].name；' +
        '或先不带 --skip-build 构建一次',
    )
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const destBin = join(outDir, binName)
  copyFileSync(builtBin, destBin)
  if (!IS_WIN) {
    try {
      chmodSync(destBin, 0o755)
    } catch (e) {
      console.warn(`[package-host] chmod +x 失败（必要时手动 chmod）：${e.message}`)
    }
  }

  // 内置配置：bundle.resources 在 --no-bundle 下不复制，宿主若读它会在产物里找不到
  const configSrc = join(HOST_ROOT, 'src-tauri', 'resources', 'config.properties')
  if (!existsSync(configSrc)) {
    fail(`[package-host] 缺宿主内置配置：${configSrc}（产物形态须符合 CONTRACT §1.1）`)
  }
  copyFileSync(configSrc, join(outDir, 'config.properties'))

  const builtBy = skipBuild
    ? 'skip-build(reuse src-tauri/target/debug)'
    : viaCargo
      ? 'cargo(+vite dist)'
      : 'tauri-cli(--no-bundle)'
  const hostVersion = buildHostVersionJson({
    hostVersion: truth.version,
    platform,
    arch,
    sourceCommit,
    libTag: truth.libTag,
    witVersion: truth.witVersion,
    sdkVersion: truth.sdkVersion,
    mountContract: truth.mountContract,
    binary: binName,
    builtBy,
    builtAt: new Date().toISOString(),
    dirty,
  })
  writeFileSync(join(outDir, 'host-version.json'), JSON.stringify(hostVersion, null, 2) + '\n')

  console.log(`\n[package-host] 宿主产物已生成：${outDir}`)
  console.log(`[package-host]   - ${binName}`)
  console.log('[package-host]   - config.properties')
  console.log(
    `[package-host]   - host-version.json（hostVersion=${hostVersion.hostVersion}, sdk=${hostVersion.sdkVersion}, ` +
      `wit=${hostVersion.witVersion}, mountContract=${hostVersion.mountContract}）`,
  )
  console.log(`[package-host] 分发：该目录可直接运行，不再产出 tar.gz / sha256（2026-10-28 裁决）`)
  console.log('\n[package-host] 应用侧用法：')
  console.log('[package-host]   cd <应用仓>/apps/<slug>/desktop')
  console.log(`[package-host]   pnpm run dev:host -- --host ${outDir}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[package-host] ${err?.message ?? err}`)
    process.exit(1)
  })
}
