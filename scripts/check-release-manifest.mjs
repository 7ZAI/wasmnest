#!/usr/bin/env node
/**
 * release-manifest.json 一致性校验（三仓拆分 spec §6 / 票 06）
 *
 * 谁写：平台仓发布流程；谁读：Seam 1 装配校验、各仓 release workflow、
 * 本脚本。manifest 是跨仓版本的唯一表达——本脚本把它钉到三仓实际内容上。
 *
 * 判据（任一失败即 exit 1，错误逐条打印，不静默降级）：
 *  1. schema：product / repos.lib.tag / repos.apps.tag / contract{package,version,witSha256} / apps
 *     product 与平台仓根 `package.json` 版本一致；
 *  2. `repos.lib.tag` == 平台仓 submodule `packages/` 的精确 tag（submodule 指针漂移即红；
 *     工作树脏同样红——发布装配要求干净 submodule）；
 *  3. `contract.version` == `packages/contracts/wasmnest-plugin-package.rs` 的 `PACKAGE_VERSION`；
 *  4. `contract.witSha256` == 双端组合 WIT 产物指纹：对
 *     `wasmnest-{desktop,mobile}/packages/plugin-sdk-{desktop,mobile}/rust/wit/**` 全部文件
 *     按仓内相对路径升序，逐文件喂 `relpath \0 content \0` 的 sha256（十六进制）；
 *     `--print-hash` 打印当前值（bump WIT 后用它更新 manifest）；
 *  5. `apps` 段覆盖应用仓全部 `apps/<slug>/<end>/plugin.json`（end 感知：同一 plugin id
 *     可双端各一份，`ends.<end>.artifact` 必须等于该端 `rustLibrary` + `.wasm`；
 *     清单多写 / 少写一个端都红）；
 *  6. `repos.apps.tag` == 应用仓 HEAD 的精确 tag（应用仓不是 git 仓时打印显式 skip，
 *     计 warning 但不失败——本地快照布局用；发布装配必须是 git checkout）。
 *
 * 用法：
 *   node scripts/check-release-manifest.mjs               # 校验
 *   node scripts/check-release-manifest.mjs --print-hash  # 只打印当前 WIT 指纹
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appsRoot } from './app-paths.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = join(ROOT, 'release-manifest.json')
const CONTRACTS_PATH = join(ROOT, 'packages', 'contracts', 'wasmnest-plugin-package.rs')

/** WIT 产物目录（相对平台仓根；与 compose-wit.mjs 的输出目录一致） */
const WIT_DIRS = [
  'wasmnest-desktop/packages/plugin-sdk-desktop/rust/wit',
  'wasmnest-mobile/packages/plugin-sdk-mobile/rust/wit',
]

const PRINT_HASH = process.argv.includes('--print-hash')

const errors = []
const warnings = []
function fail(msg) {
  errors.push(msg)
}
function warn(msg) {
  warnings.push(msg)
}

/** 递归收集目录下全部文件（相对平台仓根的路径），目录不存在时抛错（fail-visible） */
function listFiles(relDir) {
  const abs = join(ROOT, relDir)
  if (!existsSync(abs)) throw new Error(`WIT 产物目录不存在: ${abs}（先 pnpm run check:wit / 重拼）`)
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) out.push(relative(ROOT, p))
    }
  }
  walk(abs)
  return out
}

/**
 * 双端组合 WIT 产物指纹。
 *
 * 口径说明：由于 desktop / mobile 的产物目录不同，路径本身参与哈希，
 * 同一版本组合在任何一次装配里得到同一值；任一端 WIT 变一个字节即变值。
 */
export function witFingerprint() {
  const files = WIT_DIRS.flatMap(listFiles).sort()
  const h = createHash('sha256')
  for (const rel of files) {
    h.update(rel, 'utf8')
    h.update('\0')
    h.update(readFileSync(join(ROOT, rel)))
    h.update('\0')
  }
  return { hash: h.digest('hex'), files }
}

if (PRINT_HASH) {
  const { hash, files } = witFingerprint()
  console.log(`WIT 指纹（${files.length} 文件）: sha256:${hash}`)
  process.exit(0)
}

// ==================== 1. schema + product 版本 ====================
let manifest
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
} catch (e) {
  console.error(`[manifest] 读取/解析失败: ${e.message}`)
  process.exit(1)
}

const requireField = (cond, msg) => {
  if (!cond) fail(msg)
}
requireField(manifest.product, '缺 product（平台仓 tag）')
requireField(manifest.repos?.lib?.tag, '缺 repos.lib.tag')
requireField(manifest.repos?.apps?.tag, '缺 repos.apps.tag')
requireField(manifest.contract?.package, '缺 contract.package')
requireField(manifest.contract?.version, '缺 contract.version')
requireField(manifest.contract?.witSha256, '缺 contract.witSha256')
requireField(
  manifest.apps && Object.keys(manifest.apps).length > 0,
  '缺 apps 段（或为空）',
)

const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
requireField(
  manifest.product === pkgJson.version,
  `product=${manifest.product} 与平台仓 package.json 版本=${pkgJson.version} 不一致`,
)

// ==================== 2. submodule 指针 == 长 lib.tag ====================
const packagesDir = join(ROOT, 'packages')
try {
  const tag = execFileSync('git', ['-C', packagesDir, 'describe', '--tags', '--exact-match'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  requireField(
    tag === manifest.repos.lib.tag,
    `submodule 指针 tag=${tag} 与 repos.lib.tag=${manifest.repos.lib.tag} 不一致（git submodule update / 改 manifest）`,
  )
  const dirty = execFileSync('git', ['-C', packagesDir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
  requireField(dirty === '', `submodule 工作树不干净（发布装配要求 clean）：\n${dirty}`)
} catch (e) {
  fail(`submodule 指针校验失败: ${e.message}（packages/ 未挂载或 HEAD 无精确 tag）`)
}

// ==================== 3. contract.version == 契约真源 ====================
try {
  const src = readFileSync(CONTRACTS_PATH, 'utf8')
  const m = /pub const PACKAGE_VERSION: &str = "([^"]+)"/.exec(src)
  const nameM = /pub const PACKAGE_NAME: &str = "([^"]+)"/.exec(src)
  if (!m) fail(`未能从 ${relative(ROOT, CONTRACTS_PATH)} 解析 PACKAGE_VERSION`)
  else
    requireField(
      m[1] === manifest.contract.version,
      `contract.version=${manifest.contract.version} 与 PACKAGE_VERSION=${m[1]} 不一致`,
    )
  if (nameM)
    requireField(
      nameM[1] === manifest.contract.package,
      `contract.package=${manifest.contract.package} 与 PACKAGE_NAME=${nameM[1]} 不一致`,
    )
} catch (e) {
  fail(`contract 真源读取失败: ${e.message}（${relative(ROOT, CONTRACTS_PATH)}）`)
}

// ==================== 4. contract.witSha256 == 双端组合 WIT 指纹 ====================
try {
  const { hash } = witFingerprint()
  requireField(
    hash === manifest.contract.witSha256,
    `contract.witSha256 漂移：manifest=${manifest.contract.witSha256} 实际=${hash}\n` +
      `  （WIT 变更后重拼并更新 manifest：pnpm run check:wit && node scripts/check-release-manifest.mjs --print-hash）`,
  )
} catch (e) {
  fail(`WIT 指纹计算失败: ${e.message}`)
}

// ==================== 5. apps 段覆盖应用仓全部端 ====================
try {
  const appsDir = join(appsRoot(), 'apps')
  const actual = new Map() // pluginId -> { slug, ends: Map<end, rustLibrary> }
  for (const slug of readdirSync(appsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    for (const end of ['desktop', 'mobile']) {
      const manifestPath = join(appsDir, slug, end, 'plugin.json')
      if (!existsSync(manifestPath)) continue
      const plugin = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (!plugin.id || !plugin.rustLibrary) {
        fail(`${relative(ROOT, manifestPath)} 缺 id / rustLibrary`)
        continue
      }
      if (!actual.has(plugin.id)) actual.set(plugin.id, { slug, ends: new Map() })
      actual.get(plugin.id).ends.set(end, plugin.rustLibrary)
    }
  }

  for (const [id, { slug, ends }] of actual) {
    const entry = manifest.apps[id]
    if (!entry) {
      fail(`manifest.apps 缺 plugin id ${id}（应用仓 ${slug}，端 ${[...ends.keys()].join('/')}）`)
      continue
    }
    requireField(
      entry.path === `apps/${slug}`,
      `manifest.apps["${id}"].path=${entry.path} 与应用仓实际 apps/${slug} 不一致`,
    )
    const declaredEnds = Object.keys(entry.ends ?? {})
    for (const [end, rustLibrary] of ends) {
      if (!declaredEnds.includes(end)) {
        fail(`manifest.apps["${id}"].ends 缺 ${end}（应用仓 apps/${slug}/${end} 实存）`)
        continue
      }
      const expectedArtifact = `${rustLibrary}.wasm`
      requireField(
        entry.ends[end].artifact === expectedArtifact,
        `manifest.apps["${id}"].ends.${end}.artifact=${entry.ends[end].artifact} ` +
          `与 ${relative(ROOT, join(appsDir, slug, end, 'plugin.json'))} rustLibrary 推导值=${expectedArtifact} 不一致`,
      )
    }
    for (const end of declaredEnds) {
      if (!ends.has(end))
        fail(`manifest.apps["${id}"].ends 多写 ${end}（应用仓 apps/${slug}/${end} 无 plugin.json）`)
    }
  }
  for (const id of Object.keys(manifest.apps)) {
    if (!actual.has(id)) fail(`manifest.apps 多写 plugin id ${id}（应用仓不存在）`)
  }
} catch (e) {
  fail(`apps 段校验失败: ${e.message}（应用仓缺失时按 R1 布局摆放或设 WASMNEST_APPS_ROOT）`)
}

// ==================== 6. repos.apps.tag == 应用仓 HEAD tag ====================
try {
  const appsDir = appsRoot()
  if (existsSync(join(appsDir, '.git'))) {
    const tag = execFileSync('git', ['-C', appsDir, 'describe', '--tags', '--exact-match'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    requireField(
      tag === manifest.repos.apps.tag,
      `应用仓 HEAD tag=${tag} 与 repos.apps.tag=${manifest.repos.apps.tag} 不一致`,
    )
  } else {
    warn(`[skip] 应用仓 ${appsDir} 不是 git 仓（本地快照布局），无法核对 repos.apps.tag——发布装配必须 git checkout`)
  }
} catch (e) {
  fail(`应用仓 tag 校验失败: ${e.message}（HEAD 无精确 tag？拉取时按 tag checkout）`)
}

// ==================== 汇总 ====================
for (const w of warnings) console.warn(`[manifest][warn] ${w}`)
if (errors.length > 0) {
  console.error(`[manifest] 失败 ${errors.length} 项：`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(
  `[manifest] ok：product=${manifest.product} lib=${manifest.repos.lib.tag} apps=${manifest.repos.apps.tag} ` +
    `contract=${manifest.contract.package}@${manifest.contract.version}（${Object.keys(manifest.apps).length} app id）`,
)
