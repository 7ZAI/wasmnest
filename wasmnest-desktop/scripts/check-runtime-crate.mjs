#!/usr/bin/env node

/**
 * check-runtime-crate —— 通用宿主 runtime crate（L2）的打包门禁
 *
 * ## 为什么需要它
 *
 * `wasmnest-desktop/src-tauri` 从「宿主 bin crate」升为**唯一**可发布 runtime crate
 * `wasmnest-desktop-runtime`（`.scratch/2026-10-21-host-runtime-distribution/spec.md`
 * D4 / CONTRACT §5）：包名变了、二进制名仍是 `wasmnest-desktop`，壳前端从「build 时
 * 取 `../dist`」改成「随包携带 `src-tauri/shell-dist/`」。这些约束靠 `Cargo.toml`
 * 的 `include` 表达，一旦漏项，`cargo install wasmnest-desktop-runtime` 装出来的
 * 宿主会在启动时白屏 / 找不到能力声明——本脚本把「发布包内必须有什么」变成显性门禁。
 *
 * ## 判据
 *
 * 1. crate 身份：`[package].name = wasmnest-desktop-runtime`、`[lib].name =
 *    wasmnest_desktop_lib`、`[[bin]].name = wasmnest-desktop`（安装入口名不变）；
 * 2. `cargo package --list` 包含 `src/**` / `tauri.conf.json` / `capabilities/**` /
 *    `icons/**` / `resources/config.properties` / `shell-dist/**`；
 * 3. `cargo metadata --no-deps` 成功（manifest 可被外部工程解析）；
 * 4. 依赖图可发布：不得残留 `wasmnest-lib` 的 path 依赖，12 条能力仓依赖走
 *    git tag（`tag = "lib-v0.0.2"`），桌面 SDK 走 crates.io 精确版本
 *    （`=0.0.1`）；`[patch]` 只允许留在 `.cargo/config.toml`（发布包不带配置，
 *    写进 manifest 会让包不可发布）；
 * 5. 壳前端漂移：`dist/` 在场时跑 `sync-shell-dist.mjs --check`；干净 checkout
 *    （没有 `dist/`）允许跳过并打印提示，不伪装成通过。
 *
 * ## 前置（fail-visible，不静默降级）
 *
 * `cargo package --list` 需要能解析 `wasmnest-plugin-api`（crates.io 尚未发布时由
 * 平台仓根 `.cargo/config.toml` 的 `[patch.crates-io]` 指回工作树 SDK）。完整
 * `cargo package`（verify 编译）不在本门禁内：它要求 SDK 已发布到 crates.io，
 * 见 CONTRACT §5.4 的发布前置。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(__dirname, '..')
const CRATE_ROOT = join(DESKTOP_ROOT, 'src-tauri')
const MANIFEST = join(CRATE_ROOT, 'Cargo.toml')

/** 发布包里必须出现的条目（id 供报告与测试引用，label 为人类可读名） */
export const REQUIRED_PACKAGE_ENTRIES = [
  { id: 'src', label: 'src/**（crate 源码）', matches: (p) => p.startsWith('src/') },
  { id: 'tauri-conf', label: 'tauri.conf.json（壳上下文）', matches: (p) => p === 'tauri.conf.json' },
  { id: 'build-rs', label: 'build.rs（tauri_build）', matches: (p) => p === 'build.rs' },
  { id: 'capabilities', label: 'capabilities/**（权限声明）', matches: (p) => p.startsWith('capabilities/') },
  { id: 'icons', label: 'icons/**（窗口 / 托盘图标）', matches: (p) => p.startsWith('icons/') },
  {
    id: 'config-properties',
    label: 'resources/config.properties（宿主内置配置）',
    matches: (p) => p === 'resources/config.properties',
  },
  { id: 'shell-dist', label: 'shell-dist/**（随包的壳前端）', matches: (p) => p.startsWith('shell-dist/') },
  {
    id: 'plugins-placeholder',
    label: 'resources/plugins/.gitkeep（随包产物目录占位；缺目录 = tauri_build 失败）',
    matches: (p) => p === 'resources/plugins/.gitkeep',
  },
]

/** 归一化 `cargo package --list` 输出：去 BOM / CR / 空行 / 首尾空白 */
export function parseCargoPackageList(stdout) {
  return stdout
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** 返回缺失的必备条目（空数组 = 合规） */
export function missingRequiredEntries(files) {
  return REQUIRED_PACKAGE_ENTRIES.filter((entry) => !files.some((file) => entry.matches(file)))
}

/**
 * 从 Cargo.toml 文本解析发布身份。
 *
 * 只覆盖门禁需要的三个字段（`[package].name` / `[lib].name` / 所有 `[[bin]].name`），
 * 不引入 TOML 依赖：manifest 由本仓维护，节名格式稳定。
 */
export function parseCrateIdentity(manifestText) {
  let section = ''
  let packageName = ''
  let libName = ''
  const binNames = []

  for (const rawLine of manifestText.split(/\r?\n/)) {
    const line = rawLine.trim()
    // 先匹配数组表 `[[bin]]`，再匹配普通表 `[package]`（数组表内层还有一对方括号）
    const header = line.match(/^\[\[([^\]]+)\]\]$/) ?? line.match(/^\[([^\]]+)\]$/)
    if (header) {
      section = header[1].trim()
      continue
    }
    if (line.startsWith('#')) continue
    const kv = line.match(/^name\s*=\s*"([^"]+)"/)
    if (!kv) continue
    if (section === 'package') packageName = kv[1]
    else if (section === 'lib') libName = kv[1]
    else if (section === 'bin') binNames.push(kv[1])
  }

  return { packageName, libName, binNames }
}

/**
 * manifest 的可发布性检查（返回问题列表；空数组 = 合规）。
 *
 * - 能力仓依赖必须是 git tag（path 依赖会让 `cargo package` / 外部工程消费失效）；
 * - SDK 必须是 crates.io 精确版本（本地开发经 `.cargo/config.toml` 的 patch 指回）；
 * - `[patch]` 不得留在这个 manifest（发布包会带它，cargo 拒绝 patch 进包）。
 */
export function manifestPublishabilityIssues(manifestText) {
  const issues = []
  const libPath = manifestText.match(/path\s*=\s*"[^"]*wasmnest-lib[^"]*"/g) ?? []
  if (libPath.length > 0) {
    issues.push(`仍有 ${libPath.length} 条 wasmnest-lib path 依赖；能力仓依赖必须改为 git tag（否则包不可发布）`)
  }

  const gitDeps = manifestText.match(/git\s*=\s*"https:\/\/github\.com\/7ZAI\/wasmnest-lib"/g) ?? []
  if (gitDeps.length !== 12) {
    issues.push(`能力仓 git 依赖应为 12 条，实际 ${gitDeps.length} 条`)
  }
  if (gitDeps.length > 0 && !/tag\s*=\s*"lib-v0\.0\.2"/.test(manifestText)) {
    issues.push('能力仓 git 依赖缺少固定 tag（当前发布线 = lib-v0.0.2）')
  }

  if (!/wasmnest-plugin-api\s*=\s*\{[^}]*version\s*=\s*"=0\.0\.1"/.test(manifestText)) {
    issues.push('wasmnest-plugin-api 必须是 crates.io 精确版本 =0.0.1（本地源码经 .cargo/config.toml patch）')
  }
  if (/wasmnest-plugin-api\s*=\s*\{\s*path/.test(manifestText)) {
    issues.push('wasmnest-plugin-api 仍是 path 依赖；发布 manifest 不允许 path')
  }

  if (/^\[patch\./m.test(manifestText)) {
    issues.push('[patch] 不得留在 src-tauri/Cargo.toml（发布包会带它）；patch 应放平台仓根 .cargo/config.toml')
  }

  return issues
}

// ==================== CLI ====================

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { encoding: 'utf-8', ...opts })
  if (result.error) {
    fail(`无法执行 ${command}：${result.error.message}`)
  }
  return result
}

function fail(message) {
  console.error(`[check-runtime-crate] ${message}`)
  process.exit(1)
}

function main() {
  if (!existsSync(MANIFEST)) fail(`缺 src-tauri/Cargo.toml：${MANIFEST}`)

  const manifestText = readFileSync(MANIFEST, 'utf-8')
  const identity = parseCrateIdentity(manifestText)
  if (identity.packageName !== 'wasmnest-desktop-runtime') {
    fail(`[package].name 应为 wasmnest-desktop-runtime，实际 "${identity.packageName}"`)
  }
  if (!identity.binNames.includes('wasmnest-desktop')) {
    fail(`[[bin]].name 应保留 wasmnest-desktop（安装入口名），实际 [${identity.binNames.join(', ')}]`)
  }
  if (identity.libName !== 'wasmnest_desktop_lib') {
    fail(`[lib].name 应为 wasmnest_desktop_lib，实际 "${identity.libName}"`)
  }

  const publishIssues = manifestPublishabilityIssues(manifestText)
  if (publishIssues.length > 0) {
    fail(`依赖图不可发布：\n  - ${publishIssues.join('\n  - ')}`)
  }

  const cargo = process.env.CARGO ?? 'cargo'

  // cargo metadata 先跑：manifest 解析失败时给出比 package --list 更直接的报错
  const metadata = run(cargo, ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', MANIFEST])
  if (metadata.status !== 0) {
    fail(`cargo metadata 失败（manifest 不可解析）：\n${metadata.stderr}`)
  }
  const meta = JSON.parse(metadata.stdout)
  const pkg = meta.packages?.find((p) => p.name === 'wasmnest-desktop-runtime')
  if (!pkg) fail('cargo metadata 里找不到 wasmnest-desktop-runtime 包')
  const targets = pkg.targets ?? []
  if (!targets.some((t) => t.name === 'wasmnest-desktop' && t.kind.includes('bin'))) {
    fail('cargo metadata 的 targets 里缺 bin wasmnest-desktop')
  }
  if (!targets.some((t) => t.name === 'wasmnest_desktop_lib' && t.crate_types?.includes('rlib'))) {
    fail('cargo metadata 的 targets 里缺 lib wasmnest_desktop_lib（rlib）')
  }

  // `--allow-dirty`：门禁在开发树 / 未提交变更上也要能跑（只列清单，不产包）
  const listed = run(cargo, [
    'package',
    '--list',
    '--allow-dirty',
    '--manifest-path',
    MANIFEST,
  ])
  if (listed.status !== 0) {
    fail(
      `cargo package --list 失败（依赖不可解析？SDK 未发布时需平台仓根 .cargo/config.toml 的 [patch.crates-io]）：\n${listed.stderr}`,
    )
  }

  const files = parseCargoPackageList(listed.stdout)
  const missing = missingRequiredEntries(files)
  if (missing.length > 0) {
    fail(`发布包缺少必备条目（检查 [package].include）：\n  - ${missing.map((e) => e.label).join('\n  - ')}`)
  }

  // 壳前端漂移：dist 在场时强校验；干净 checkout 允许跳过（明确打印，不伪装通过）
  const distDir = join(DESKTOP_ROOT, 'dist')
  if (existsSync(distDir)) {
    const sync = run(process.execPath, [join(DESKTOP_ROOT, 'scripts', 'sync-shell-dist.mjs'), '--check'])
    if (sync.status !== 0) fail(`shell-dist 与 dist 漂移（先跑 sync-shell-dist.mjs）：\n${sync.stdout}${sync.stderr}`)
  } else {
    console.warn('[check-runtime-crate] skip: wasmnest-desktop/dist 不存在（干净 checkout）——先 pnpm run build 再复查壳漂移')
  }

  console.log(
    `[check-runtime-crate] OK：${identity.packageName}（bin=${identity.binNames.join(',')}），包内 ${files.length} 个文件，必备条目齐全`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
