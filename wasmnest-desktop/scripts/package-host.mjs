#!/usr/bin/env node

/**
 * package-host —— 产出「可运行宿主产物」（供 wasm-app 工程 dev 使用，不需平台仓源码）
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
 * ## 产物
 *
 * ```text
 * wasmnest-desktop/dist/host-desktop/
 *   ├─ <host-binary>        # debug profile（保留 PluginDevWatcher 热重载 + devCsp）
 *   ├─ config.properties    # 宿主内置配置（bundle.resources 在 --no-bundle 下不复制，随手带上）
 *   └─ host-version.json    # 版本事实（dev-host 起宿主前比对，防止 ABI 错配黑盒）
 * ```
 *
 * ## 用法
 *
 * ```bash
 * cd wasmnest/wasmnest-desktop
 * pnpm run host:pack
 * pnpm run host:pack -- --via-cargo      # 绕开 tauri CLI 的版本一致性检查（见下）
 * node scripts/package-host.mjs --out dist/host-desktop
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
 * `frontendDist`（`../dist`）嵌入二进制，产物与 `tauri build --no-bundle` 等价。
 *
 * 应用侧（应用仓）：
 *   cd apps/file-transfer/desktop && pnpm run dev:host -- --host <platform>/wasmnest-desktop/dist/host-desktop
 *
 * ## 为什么固定 debug profile
 *
 * 热重载源 `PluginDevWatcher`（emit `plugin:dev-reload`）在 `src-tauri/src/lib.rs`
 * 被 `#[cfg(debug_assertions)]` 包住——release 产物**没有**热重载。故宿主产物固定
 * debug profile（包体大，但 dev 期诊断能力完整）。将来若需 release + 热重载，把该
 * cfg 换成 feature 后再加参数切换。
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOST_ROOT = resolve(__dirname, '..')
const IS_WIN = process.platform === 'win32'

// ==================== 参数 ====================

const argv = process.argv.slice(2)
function valueOf(flag, fallback) {
  const i = argv.indexOf(flag)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const outDir = resolve(HOST_ROOT, valueOf('--out', 'dist/host-desktop'))
/** 绕开 tauri CLI 的 npm↔crate 版本一致性检查：前端 vite build + src-tauri cargo build */
const viaCargo = argv.includes('--via-cargo')

// ==================== 版本事实 ====================

function readTomlVersion(label, file) {
  if (!existsSync(file)) {
    console.error(`[package-host] 缺 ${label}：${file}`)
    process.exit(1)
  }
  const m = readFileSync(file, 'utf-8').match(/^version\s*=\s*"([^"]+)"/m)
  if (!m) {
    console.error(`[package-host] ${label} 里读不到 version：${file}`)
    process.exit(1)
  }
  return m[1]
}

const tauriConfPath = join(HOST_ROOT, 'src-tauri', 'tauri.conf.json')
if (!existsSync(tauriConfPath)) {
  console.error(`[package-host] 缺 tauri.conf.json：${tauriConfPath}`)
  process.exit(1)
}
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'))

/** 宿主二进制名 = src-tauri 的 Cargo package name（不是 productName） */
const cargoTomlPath = join(HOST_ROOT, 'src-tauri', 'Cargo.toml')
const cargoName = readFileSync(cargoTomlPath, 'utf-8').match(/^name\s*=\s*"([^"]+)"/m)?.[1]
if (!cargoName) {
  console.error(`[package-host] src-tauri/Cargo.toml 里读不到 [package].name：${cargoTomlPath}`)
  process.exit(1)
}

const sdkVersion = readTomlVersion(
  '桌面 SDK Cargo.toml',
  join(HOST_ROOT, 'packages', 'plugin-sdk-desktop', 'rust', 'Cargo.toml'),
)

// ==================== 构建（tauri build --debug --no-bundle） ====================

/**
 * --no-bundle 的理由：bundle 只产出安装包（tauri.conf 的 targets = nsis/deb），
 * 而我们要的是**可直接运行**的二进制；前端 dist 由 tauri build 嵌入二进制，与是否
 * bundle 无关。插件目录走 WASMNEST_PLUGINS_DIR，故 bundle.resources 也不需要。
 */
function fail(msg, hint) {
  console.error(msg)
  if (hint) console.error(hint)
  process.exit(1)
}

if (viaCargo) {
  // 1) 宿主前端 dist（tauri.conf 的 frontendDist = ../dist）
  console.log('[package-host] --via-cargo：先构建宿主前端 dist（pnpm run build:fast）')
  const fe = spawnSync(toExecutable('pnpm'), ['run', 'build:fast'], { cwd: HOST_ROOT, stdio: 'inherit' })
  if (fe.status !== 0) fail(`[package-host] 宿主前端构建失败（exit=${fe.status}）`)
  if (!existsSync(join(HOST_ROOT, 'dist'))) {
    fail('[package-host] dist/ 未生成 —— build.rs 嵌入 frontendDist 会失败')
  }
  // 2) 宿主二进制（debug；build.rs 的 tauri_build::build() 嵌入 ../dist）
  console.log('[package-host] --via-cargo：cargo build（src-tauri，debug）')
  const be = spawnSync('cargo', ['build'], { cwd: join(HOST_ROOT, 'src-tauri'), stdio: 'inherit' })
  if (be.status !== 0) fail(`[package-host] 宿主构建失败（exit=${be.status}）`)
} else {
  const require = createRequire(import.meta.url)
  let tauriCli
  try {
    tauriCli = require.resolve('@tauri-apps/cli/tauri.js')
  } catch {
    fail('[package-host] 找不到 @tauri-apps/cli（宿主工程未装依赖？先 pnpm install）')
  }

  console.log('[package-host] 构建宿主（debug profile，--no-bundle）：前端 dist 会被嵌入二进制')
  const build = spawnSync(
    process.execPath,
    // createUpdaterArtifacts 需签名密钥；本产物不发布，显式关掉避免缺密钥直接失败
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

/** Windows 下 pnpm 需 pnpm.cmd */
function toExecutable(cmd) {
  return IS_WIN && cmd === 'pnpm' ? 'pnpm.cmd' : cmd
}

// ==================== 收集产物 ====================

const binName = IS_WIN ? `${cargoName}.exe` : cargoName
const builtBin = join(HOST_ROOT, 'src-tauri', 'target', 'debug', binName)
if (!existsSync(builtBin)) {
  console.error(`[package-host] 构建产物不存在：${builtBin}`)
  console.error('[package-host]   检查 src-tauri/Cargo.toml 的 [package].name 与产物名是否一致')
  process.exit(1)
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
if (existsSync(configSrc)) {
  copyFileSync(configSrc, join(outDir, 'config.properties'))
} else {
  console.warn(`[package-host] 未找到 ${configSrc}（宿主若不读它可忽略）`)
}

const hostVersion = {
  hostVersion: tauriConf.version,
  binary: binName,
  profile: 'debug',
  builtBy: viaCargo ? 'cargo(+vite dist)' : 'tauri-cli(--no-bundle)',
  sdkVersion,
  builtAt: new Date().toISOString(),
  pluginsEnv: 'WASMNEST_PLUGINS_DIR',
  note: '宿主构建产物：应用工程以 WASMNEST_PLUGINS_DIR 指定自己的 plugins 目录后直接运行本二进制',
}
writeFileSync(join(outDir, 'host-version.json'), JSON.stringify(hostVersion, null, 2) + '\n')

console.log(`\n[package-host] 宿主产物已生成：${outDir}`)
console.log(`[package-host]   - ${binName}（${hostVersion.profile}）`)
console.log('[package-host]   - config.properties')
console.log(`[package-host]   - host-version.json（hostVersion=${hostVersion.hostVersion}, sdk=${sdkVersion}）`)
console.log('\n[package-host] 应用侧用法：')
console.log('[package-host]   cd <应用仓>/apps/<slug>/desktop')
console.log(`[package-host]   pnpm run dev:host -- --host ${outDir}`)
