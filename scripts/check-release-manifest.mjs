#!/usr/bin/env node
/**
 * release-manifest.json 一致性校验（三仓拆分 spec §6 / 票 06 / 宿主运行时票据 P2）
 *
 * 谁写：平台仓发布流程；谁读：Seam 1 装配校验、各仓 release workflow、
 * 本脚本。manifest 是跨仓版本的唯一表达——本脚本把它钉到三仓实际内容上。
 *
 * 判据（任一失败即 exit 1，错误逐条打印，不静默降级）：
 *  1. schema：product / repos.lib.tag / repos.apps.tag / contract{package,version,witSha256} / apps
 *     product 与平台仓根 `package.json` 版本一致；
 *  2. `repos.lib.tag` == 能力仓（兄弟目录 `../wasmnest-lib`，或 `WASMNEST_LIB_ROOT`）HEAD
 *     的精确 tag；工作树脏同样红——发布装配要求能力仓处于干净的 tag 提交；
 *  3. `contract.version` == 能力仓 `wasmnest-contract/src/lib.rs` 的 `PACKAGE_VERSION`；
 *  4. `contract.witSha256` == 双端组合 WIT 产物指纹：对
 *     `wasmnest-{desktop,mobile}/packages/plugin-sdk-{desktop,mobile}/rust/wit/**` 全部文件
 *     按仓内相对路径升序，逐文件喂 `relpath \0 content \0` 的 sha256（十六进制）；
 *     `--print-hash` 打印当前值（bump WIT 后用它更新 manifest）；
 *  5. `apps` 段覆盖应用仓全部 `apps/<slug>/<end>/plugin.json`（end 感知：同一 plugin id
 *     可双端各一份，`ends.<end>.artifact` 必须等于该端 `rustLibrary` + `.wasm`；
 *     清单多写 / 少写一个端都红）；
 *  6. `repos.apps.tag` == 应用仓 HEAD 的精确 tag（应用仓不是 git 仓时打印显式 skip，
 *     计 warning 但不失败——本地快照布局用；发布装配必须是 git checkout）；
 *  7. `hostRuntime` 段（CONTRACT §2.3）：必填字段齐全、version 为 semver、sourceCommit 为
 *     40 位 hex；libTag / witVersion / sdkVersion / mountContract 与各自真源一致；
 *     `artifacts` 的 key 必须是 CONTRACT §1.2 的 6 个平台-架构 token，`file` 必须等于
 *     `host-desktop-<version>-<platform>-<arch>.tar.gz`，`sha256` 为 64 位 hex；空
 *     `artifacts` 表示「宿主未发布」——打印提示但不失败（发布前允许）。
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
import { libRoot } from './lib-paths.mjs'
import { hostAssetFileName } from '../wasmnest-desktop/scripts/package-host.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** WIT 产物目录（相对平台仓根；与 compose-wit.mjs 的输出目录一致） */
const WIT_DIRS = [
  'wasmnest-desktop/packages/plugin-sdk-desktop/rust/wit',
  'wasmnest-mobile/packages/plugin-sdk-mobile/rust/wit',
]

/** CONTRACT §2.3：hostRuntime 必填字段（不含发布时才有的 artifacts 内容） */
export const HOST_RUNTIME_REQUIRED_FIELDS = Object.freeze([
  'version',
  'sourceCommit',
  'libTag',
  'witVersion',
  'sdkVersion',
  'mountContract',
  'artifacts',
])

/** CONTRACT §1.2：资产 token（platform-arch） */
export const HOST_ARTIFACT_KEY_RE = /^(linux|macos|windows)-(x86_64|arm64)$/

/** 严格 semver 数字段（不允许前导零） */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const HEX40_RE = /^[0-9a-f]{40}$/i
const HEX64_RE = /^[0-9a-f]{64}$/

/** 递归收集目录下全部文件（相对平台仓根的路径），目录不存在时抛错（fail-visible） */
function listFiles(relDir, root) {
  const abs = join(root, relDir)
  if (!existsSync(abs)) throw new Error(`WIT 产物目录不存在: ${abs}（先 pnpm run check:wit / 重拼）`)
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) out.push(relative(root, p))
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
export function witFingerprint(root = ROOT) {
  const files = WIT_DIRS.flatMap((relDir) => listFiles(relDir, root)).sort()
  const h = createHash('sha256')
  for (const rel of files) {
    h.update(rel, 'utf8')
    h.update('\0')
    h.update(readFileSync(join(root, rel)))
    h.update('\0')
  }
  return { hash: h.digest('hex'), files }
}

/**
 * 宿主壳 ↔ app 整包挂载契约版本（宿主侧真源 `MOUNT_CONTRACT` 常量）。
 * 常量尚未落地（X1 未合并）时返回 null——调用方打印显式 warning，不静默跳过。
 */
export function readMountContractConstant(root = ROOT) {
  const file = join(root, 'wasmnest-desktop', 'src', 'shell', 'mount', 'useAppMount.ts')
  if (!existsSync(file)) return null
  const m = /export const MOUNT_CONTRACT\s*=\s*'([^']+)'/.exec(readFileSync(file, 'utf8'))
  return m ? m[1] : null
}

/**
 * hostRuntime 段校验（CONTRACT §2.3 / §1.2 / §1.4）。
 *
 * @param {object} manifest 已解析的 release-manifest.json
 * @param {{ sdkVersion?: string, mountContract?: string }} truth 各自真源（桌面 SDK 版本 / 宿主 MOUNT_CONTRACT）
 * @returns {{ errors: string[], notices: string[] }} errors 非空即红；notices 只提示（如宿主未发布）
 */
export function validateHostRuntime(manifest, { sdkVersion, mountContract } = {}) {
  const errors = []
  const notices = []
  const fail = (msg) => errors.push(msg)

  const hostRuntime = manifest?.hostRuntime
  if (!hostRuntime || typeof hostRuntime !== 'object' || Array.isArray(hostRuntime)) {
    fail('缺 hostRuntime 段（宿主运行时版本事实；CONTRACT §2.3）')
    return { errors, notices }
  }

  for (const field of HOST_RUNTIME_REQUIRED_FIELDS) {
    const value = hostRuntime[field]
    if (value === undefined || value === null || value === '') fail(`缺 hostRuntime.${field}`)
  }

  if (typeof hostRuntime.version === 'string' && !SEMVER_RE.test(hostRuntime.version)) {
    fail(`hostRuntime.version=${hostRuntime.version} 非 semver（CONTRACT §2.3）`)
  }
  if (typeof hostRuntime.sourceCommit === 'string' && !HEX40_RE.test(hostRuntime.sourceCommit)) {
    fail(`hostRuntime.sourceCommit 必须是 40 位 hex（收到 ${hostRuntime.sourceCommit}）`)
  }
  if (
    typeof hostRuntime.libTag === 'string' &&
    manifest.repos?.lib?.tag &&
    hostRuntime.libTag !== manifest.repos.lib.tag
  ) {
    fail(
      `hostRuntime.libTag=${hostRuntime.libTag} 与 repos.lib.tag=${manifest.repos.lib.tag} 不一致`,
    )
  }
  if (
    typeof hostRuntime.witVersion === 'string' &&
    manifest.contract?.version &&
    hostRuntime.witVersion !== manifest.contract.version
  ) {
    fail(
      `hostRuntime.witVersion=${hostRuntime.witVersion} 与 contract.version=${manifest.contract.version} 不一致（WIT 始终继承宿主 WIT 版本）`,
    )
  }
  if (sdkVersion !== undefined && hostRuntime.sdkVersion !== sdkVersion) {
    fail(`hostRuntime.sdkVersion=${hostRuntime.sdkVersion} 与桌面 SDK 版本=${sdkVersion} 不一致`)
  }
  if (mountContract !== undefined && hostRuntime.mountContract !== mountContract) {
    fail(
      `hostRuntime.mountContract=${hostRuntime.mountContract} 与宿主 MOUNT_CONTRACT=${mountContract} 不一致`,
    )
  }

  const artifacts = hostRuntime.artifacts
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    fail('hostRuntime.artifacts 必须是对象（无发布物时写 {}；CONTRACT §2.3）')
    return { errors, notices }
  }
  const keys = Object.keys(artifacts)
  if (keys.length === 0) {
    notices.push('宿主未发布：hostRuntime.artifacts 为空（tar.gz / sha256 待 host-release workflow 填充）')
  }
  for (const key of keys) {
    const entry = artifacts[key]
    if (!HOST_ARTIFACT_KEY_RE.test(key)) {
      fail(
        `hostRuntime.artifacts 的 key=${key} 不在 CONTRACT §1.2 矩阵内（linux|macos|windows)-(x86_64|arm64）`,
      )
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`hostRuntime.artifacts["${key}"] 必须是对象（file + sha256）`)
      continue
    }
    const [platform, arch] = key.split('-')
    const expectedFile = hostAssetFileName({
      hostVersion: hostRuntime.version,
      platform,
      arch,
    })
    if (entry.file !== expectedFile) {
      fail(`hostRuntime.artifacts["${key}"].file=${entry.file} 与命名规则=${expectedFile} 不一致`)
    }
    if (typeof entry.sha256 !== 'string' || !HEX64_RE.test(entry.sha256)) {
      fail(`hostRuntime.artifacts["${key}"].sha256 必须是 64 位 hex`)
    }
  }

  return { errors, notices }
}

/** 桌面 SDK 版本（发布渠道的 npm 包版本；CONTRACT §2.2） */
function readDesktopSdkVersion(root) {
  const pkgPath = join(root, 'wasmnest-desktop', 'packages', 'plugin-sdk-desktop', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  return pkg.version
}

/**
 * 全量校验：返回 { errors, warnings, notices, manifest }。不打印、不退出（CLI 入口负责）。
 */
export function runManifestCheck({ root = ROOT } = {}) {
  const errors = []
  const warnings = []
  const notices = []
  const fail = (msg) => errors.push(msg)
  const warn = (msg) => warnings.push(msg)

  const manifestPath = join(root, 'release-manifest.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    fail(`读取/解析 release-manifest.json 失败: ${e.message}`)
    return { errors, warnings, notices, manifest: null }
  }

  // ==================== 1. schema + product 版本 ====================
  const requireField = (cond, msg) => {
    if (!cond) fail(msg)
  }
  requireField(manifest.product, '缺 product（平台仓 tag）')
  requireField(manifest.repos?.lib?.tag, '缺 repos.lib.tag')
  requireField(manifest.repos?.apps?.tag, '缺 repos.apps.tag')
  requireField(manifest.contract?.package, '缺 contract.package')
  requireField(manifest.contract?.version, '缺 contract.version')
  requireField(manifest.contract?.witSha256, '缺 contract.witSha256')
  requireField(manifest.apps && Object.keys(manifest.apps).length > 0, '缺 apps 段（或为空）')

  const pkgJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  requireField(
    manifest.product === pkgJson.version,
    `product=${manifest.product} 与平台仓 package.json 版本=${pkgJson.version} 不一致`,
  )

  // ==================== 2. 能力仓 HEAD tag == 清单 lib.tag ====================
  // 平台仓不再用 submodule 记录指针，改由 manifest 的 repos.lib.tag 钉住能力仓版本；
  // 校验同时要求工作树干净——脏工作树意味着「构建读到的源码」与「tag 记录的版本」不是
  // 同一个事实，发布装配必须拒绝。
  let libDir = null
  try {
    libDir = libRoot()
  } catch (e) {
    fail(`能力仓路径解析失败: ${e.message}`)
  }
  if (libDir) {
    try {
      const tag = execFileSync('git', ['-C', libDir, 'describe', '--tags', '--exact-match'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      requireField(
        tag === manifest.repos.lib.tag,
        `能力仓 HEAD tag=${tag} 与 repos.lib.tag=${manifest.repos.lib.tag} 不一致（checkout 对应 tag / 改 manifest）`,
      )
      const dirty = execFileSync('git', ['-C', libDir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
      requireField(dirty === '', `能力仓工作树不干净（发布装配要求 clean）：\n${dirty}`)
    } catch (e) {
      fail(`能力仓版本校验失败: ${e.message}（${libDir} 不是 git 仓或 HEAD 无精确 tag）`)
    }
  }

  // ==================== 3. contract.version == 契约真源 ====================
  const contractsPath = libDir && join(libDir, 'wasmnest-contract', 'src', 'lib.rs')
  if (contractsPath) {
    try {
      const src = readFileSync(contractsPath, 'utf8')
      const m = /pub const PACKAGE_VERSION: &str = "([^"]+)"/.exec(src)
      const nameM = /pub const PACKAGE_NAME: &str = "([^"]+)"/.exec(src)
      if (!m) fail(`未能从 ${relative(root, contractsPath)} 解析 PACKAGE_VERSION`)
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
      fail(`contract 真源读取失败: ${e.message}（${relative(root, contractsPath)}）`)
    }
  }

  // ==================== 4. contract.witSha256 == 双端组合 WIT 指纹 ====================
  try {
    const { hash } = witFingerprint(root)
    requireField(
      hash === manifest.contract.witSha256,
      `contract.witSha256 漂移：manifest=${manifest.contract.witSha256} 实际=${hash}\n` +
        `  （WIT 变更后重拼并更新 manifest：pnpm run check:wit && node scripts/check-release-manifest.mjs --print-hash）`,
    )
  } catch (e) {
    fail(`WIT 指纹计算失败: ${e.message}`)
  }

  // ==================== 5. apps 段覆盖应用仓全部端 ====================
  //
  // 工程分组：`apps/`（L3 产品应用）与 `servers/`（服务型 wasm：L1 基础服务 /
  // L2 内部业务）同一个 `apps` 段表达 —— 判据是 plugin id → 端 → wasm 产物名，
  // 与分组无关；`path` 字段
  // 记录真实相对路径（`apps/<slug>` 或 `servers/<slug>`），装配链据此定位工程。
  try {
    const actual = new Map() // pluginId -> { group, slug, ends: Map<end, rustLibrary> }
    for (const group of ['apps', 'servers']) {
      const groupDir = join(appsRoot(), group)
      if (!existsSync(groupDir)) continue
      for (const slug of readdirSync(groupDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()) {
        for (const end of ['desktop', 'mobile']) {
          const manifestPath = join(groupDir, slug, end, 'plugin.json')
          if (!existsSync(manifestPath)) continue
          const plugin = JSON.parse(readFileSync(manifestPath, 'utf8'))
          if (!plugin.id || !plugin.rustLibrary) {
            fail(`${relative(root, manifestPath)} 缺 id / rustLibrary`)
            continue
          }
          if (!actual.has(plugin.id)) actual.set(plugin.id, { group, slug, ends: new Map() })
          actual.get(plugin.id).ends.set(end, plugin.rustLibrary)
        }
      }
    }

    for (const [id, { group, slug, ends }] of actual) {
      const entry = manifest.apps[id]
      if (!entry) {
        fail(
          `manifest.apps 缺 plugin id ${id}（应用仓 ${group}/${slug}，端 ${[...ends.keys()].join('/')}）`,
        )
        continue
      }
      requireField(
        entry.path === `${group}/${slug}`,
        `manifest.apps["${id}"].path=${entry.path} 与应用仓实际 ${group}/${slug} 不一致`,
      )
      const declaredEnds = Object.keys(entry.ends ?? {})
      for (const [end, rustLibrary] of ends) {
        if (!declaredEnds.includes(end)) {
          fail(`manifest.apps["${id}"].ends 缺 ${end}（应用仓 ${group}/${slug}/${end} 实存）`)
          continue
        }
        const expectedArtifact = `${rustLibrary}.wasm`
        requireField(
          entry.ends[end].artifact === expectedArtifact,
          `manifest.apps["${id}"].ends.${end}.artifact=${entry.ends[end].artifact} ` +
            `与 ${relative(root, join(appsRoot(), group, slug, end, 'plugin.json'))} rustLibrary 推导值=${expectedArtifact} 不一致`,
        )
      }
      for (const end of declaredEnds) {
        if (!ends.has(end))
          fail(
            `manifest.apps["${id}"].ends 多写 ${end}（应用仓 ${group}/${slug}/${end} 无 plugin.json）`,
          )
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

  // ==================== 7. hostRuntime 段 ====================
  try {
    const sdkVersion = readDesktopSdkVersion(root)
    const mountContract = readMountContractConstant(root)
    if (mountContract === null) {
      warn(
        '宿主 MOUNT_CONTRACT 常量尚未落地（wasmnest-desktop/src/shell/mount/useAppMount.ts），' +
          'hostRuntime.mountContract 暂只做存在性校验',
      )
    }
    const result = validateHostRuntime(manifest, {
      sdkVersion,
      mountContract: mountContract ?? undefined,
    })
    for (const e of result.errors) fail(`hostRuntime: ${e}`)
    for (const n of result.notices) notices.push(n)
  } catch (e) {
    fail(`hostRuntime 段校验失败: ${e.message}`)
  }

  return { errors, warnings, notices, manifest }
}

// ==================== CLI ====================
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  if (process.argv.includes('--print-hash')) {
    const { hash, files } = witFingerprint()
    console.log(`WIT 指纹（${files.length} 文件）: sha256:${hash}`)
    process.exit(0)
  }

  const { errors, warnings, notices, manifest } = runManifestCheck()
  for (const w of warnings) console.warn(`[manifest][warn] ${w}`)
  for (const n of notices) console.log(`[manifest][info] ${n}`)
  if (errors.length > 0) {
    console.error(`[manifest] 失败 ${errors.length} 项：`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  const hostRuntime = manifest.hostRuntime
  console.log(
    `[manifest] ok：product=${manifest.product} lib=${manifest.repos.lib.tag} apps=${manifest.repos.apps.tag} ` +
      `contract=${manifest.contract.package}@${manifest.contract.version}（${Object.keys(manifest.apps).length} app id） ` +
      `host=${hostRuntime.version}（artifacts=${Object.keys(hostRuntime.artifacts).length}）`,
  )
}
