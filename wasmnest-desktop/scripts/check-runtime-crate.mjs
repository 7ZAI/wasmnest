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
 * 4. 依赖图可发布：不得有任何 path 依赖；能力仓依赖逐条对账（11 条 git 依赖，
 *    `tag` 必须等于 `release-manifest.json` 的 `repos.lib.tag`，`version` 与 tag
 *    对齐）；`[patch]` 只允许留在 `.cargo/config.toml`（发布包不带配置，写进
 *    manifest 会让包不可发布）。桌面 SDK 已不是本 crate 的直接依赖（批 2 / issue #36），
 *    它只作为 `wasmnest-wasm-core` 的 `desktop-assembly` 传递依赖由能力仓声明；
 * 5. 壳前端漂移：`dist/` 在场时跑 `sync-shell-dist.mjs --check`；干净 checkout
 *    （没有 `dist/`）允许跳过并打印提示，不伪装成通过。
 *
 * ## 前置（fail-visible，不静默降级）
 *
 * `cargo package --list` 需要能解析能力仓 `wasmnest-wasm-core` 的传递依赖
 * `wasmnest-plugin-api`（本地开发由平台仓根 `.cargo/config.toml` 的
 * `[patch.crates-io]` 指回工作树 SDK）。完整 `cargo package`（verify 编译）不在
 * 本门禁内：它要求 SDK 已发布到 crates.io，见 CONTRACT §5.4 的发布前置。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(__dirname, '..')
const CRATE_ROOT = join(DESKTOP_ROOT, 'src-tauri')
const MANIFEST = join(CRATE_ROOT, 'Cargo.toml')
/** 跨仓版本唯一真源（repos.lib.tag）；main 用它覆盖下面的默认 tag */
const RELEASE_MANIFEST = resolve(DESKTOP_ROOT, '..', 'release-manifest.json')

/**
 * 能力仓依赖的默认固定 tag（兜底常量；CLI 实际以 release-manifest.json 为准）。
 * 发布线 = `lib-v0.0.1`。
 */
export const EXPECTED_LIB_TAG = 'lib-v0.0.1'

/**
 * 宿主直接消费的能力仓 crate 清单（2026-10-22 peer-net-dissolve 后 11 条：
 * `wasmnest-server-peer-net-base` 已并入 `wasmnest-server-peer-net`）。
 * 增删拆分 crate 时同步本清单——清单外/缺失都会转红。
 */
export const EXPECTED_LIB_CRATES = [
  'wasmnest-link-crypto',
  'wasmnest-server-base',
  'wasmnest-host-kit',
  'wasmnest-wasm-core',
  'wasmnest-pty-engine',
  'wasmnest-discovery-engine',
  'wasmnest-crypto-engine',
  'wasmnest-server-core',
  'wasmnest-server-http',
  'wasmnest-server-websocket',
  'wasmnest-server-peer-net',
]

const LIB_GIT_URL = 'https://github.com/7ZAI/wasmnest-lib'
/** TOML 1.0 要求 inline table 单行，故逐行解析依赖声明即可 */
const INLINE_DEP_RE = /^([A-Za-z0-9_-]+)\s*=\s*\{([^}]*)\}\s*$/gm

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
 * - 任何 path 依赖都不允许（`cargo package` / 外部工程消费时不存在本地路径）；
 * - 能力仓依赖逐条对账：git 源 + tag（默认等于 release-manifest 的 repos.lib.tag）+
 *   version 与 tag 对齐；清单外 / 缺失同样报错（拆分合并后不留下悬空条目）；
 * - 桌面 SDK 不是本 crate 的直接依赖（批 2 / issue #36），故不在这里声明/断言；
 * - `[patch]` 不得留在这个 manifest（发布包会带它，cargo 拒绝 patch 进包）。
 *
 * @param {string} manifestText
 * @param {{ tag?: string, crates?: string[] }} [options]
 */
export function manifestPublishabilityIssues(manifestText, options = {}) {
  const expectedTag = options.tag ?? EXPECTED_LIB_TAG
  const expectedCrates = options.crates ?? EXPECTED_LIB_CRATES
  const issues = []
  const deps = [...manifestText.matchAll(INLINE_DEP_RE)].map((m) => ({ name: m[1], body: m[2] }))

  const libPath = manifestText.match(/path\s*=\s*"[^"]*wasmnest-lib[^"]*"/g) ?? []
  if (libPath.length > 0) {
    issues.push(`仍有 ${libPath.length} 条 wasmnest-lib path 依赖；能力仓依赖必须改为 git tag（否则包不可发布）`)
  }
  const otherPathDeps = deps
    .filter((d) => /\bpath\s*=/.test(d.body) && !d.body.includes('wasmnest-lib'))
    .map((d) => d.name)
  if (otherPathDeps.length > 0) {
    issues.push(`存在 path 依赖：${otherPathDeps.join(', ')}（发布 manifest 不允许 path，本地开发用 .cargo/config.toml 的 [patch]）`)
  }

  if (!/^lib-v\d+\.\d+\.\d+/.test(expectedTag)) {
    issues.push(`能力仓 tag 形如 lib-vX.Y.Z，当前 "${expectedTag}"（真源 = release-manifest.json 的 repos.lib.tag）`)
  }
  const expectedVersion = expectedTag.replace(/^lib-v/, '')

  for (const crate of expectedCrates) {
    const decls = deps.filter((d) => d.name === crate)
    if (decls.length === 0) {
      issues.push(`${crate} 缺少依赖声明（应为 version = "${expectedVersion}" + git tag "${expectedTag}"）`)
      continue
    }
    for (const { body } of decls) {
      if (!body.includes(LIB_GIT_URL)) {
        issues.push(`${crate} 不走能力仓 git 源 ${LIB_GIT_URL}`)
        continue
      }
      const tag = body.match(/\btag\s*=\s*"([^"]+)"/)?.[1]
      if (tag !== expectedTag) {
        issues.push(`${crate} 的 tag 应为 "${expectedTag}"，实际 "${tag ?? '缺失'}"（真源 = release-manifest.json）`)
      }
      const version = body.match(/\bversion\s*=\s*"([^"]+)"/)?.[1]
      if (version !== expectedVersion) {
        issues.push(`${crate} 的 version 应为 "${expectedVersion}"（与 tag 对齐），实际 "${version ?? '缺失'}"`)
      }
    }
  }

  const unexpected = deps
    .filter((d) => d.body.includes(LIB_GIT_URL) && !expectedCrates.includes(d.name))
    .map((d) => d.name)
  if (unexpected.length > 0) {
    issues.push(`能力仓依赖清单未登记：${unexpected.join(', ')}（增删/拆分 crate 时同步 EXPECTED_LIB_CRATES）`)
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

/** 读 release-manifest.json 的 repos.lib.tag（跨仓版本唯一真源；缺失 = fail-visible） */
function readReleaseLibTag() {
  if (!existsSync(RELEASE_MANIFEST)) fail(`缺 release-manifest.json：${RELEASE_MANIFEST}`)
  let tag
  try {
    tag = JSON.parse(readFileSync(RELEASE_MANIFEST, 'utf-8'))?.repos?.lib?.tag
  } catch (error) {
    fail(`release-manifest.json 解析失败：${error.message}`)
  }
  if (typeof tag !== 'string' || tag.length === 0) {
    fail('release-manifest.json 缺 repos.lib.tag（能力仓版本真源）')
  }
  return tag
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

  const releaseTag = readReleaseLibTag()
  const publishIssues = manifestPublishabilityIssues(manifestText, { tag: releaseTag })
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
