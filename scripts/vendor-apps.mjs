#!/usr/bin/env node

/**
 * vendor-apps —— 把应用仓**已发布的成品包**校验后铺进宿主随包目录
 *
 * ## 为什么是下载而不是本地构建
 *
 * 应用仓的 `app-release.yml` 每个 `<slug>-v<X.Y.Z>` tag 都会产出该 app 的成品：
 *
 * ```
 * <slug>-<end>-v<X.Y.Z>.zip     plugin.json + index.js（前端已构建）+ icon + *.wasm
 * <slug>-<end>-v<X.Y.Z>.json    元数据：artifact.sha256 / wasm.wasmHash / source.libRef …
 * ```
 *
 * zip 是**扁平一层**，正好等于宿主 `resources/plugins/<end>/<pluginId>/` 的内容形态。
 * 所以平台发布不需要 apps 源码、不需要 wasip3 nightly、不需要 6 套 node_modules：
 * 下载 → 校验 → 解开就完事，应用集合由 `release-manifest.json` 精确钉死。
 *
 * `source.libRef` 仍随元数据记录，但**不再参与兼容判定**（只打印用于回溯）：拆包后
 * 版本级联由 `compat.witPackages` 逐包表达，能力仓非 WIT 改动 / 未 import 的包改动
 * 不再强制重发 app。
 *
 * ## 三道校验（缺一条就 fail-visible，绝不产出空壳 / 坏壳安装包）
 *
 * | 校验 | 理由 |
 * | --- | --- |
 * | zip 实际 sha256 == 清单 `ends.<end>.sha256` | 下载损坏 / 被替换 |
 * | 元数据 `compat.witVersion` == 清单 `contract.version` | 插件面包版本写在 import 名里，不等则实例化必失败 |
 * | 元数据 `compat.witPackages` 逐包 == 清单 `contract.packages` | 拆包后各能力域独立版本（ADR 0061）：app 真正 import 的包版本不一致才需重发，未 import 的包改动不牵连 |
 * | 解出的 `plugin.json`：id / version / platform / rustLibrary+'.wasm' 对齐清单 | 防止错包、错端、清单外应用混入 |
 *
 * ## 用法
 *
 * ```bash
 * # 铺进桌面宿主的随包目录（发布 / 本地验证安装包前）
 * node scripts/vendor-apps.mjs
 * node scripts/vendor-apps.mjs --dest /tmp/plugins-desktop --end desktop
 * node scripts/vendor-apps.mjs --only com.wasmnest.bedcode,com.wasmnest.monitor
 * node scripts/vendor-apps.mjs --dry-run          # 只打印计划，不下载
 * node scripts/vendor-apps.mjs --base-url https://mirror.example/dl
 * ```
 *
 * 需要系统 `unzip`（CI runner 自带；缺失即报错，不静默跳过解包）。
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_BASE_URL = 'https://github.com/7ZAI/wasmnest-apps/releases/download'
const SHA256_RE = /^[0-9a-f]{64}$/

/**
 * 从清单的 apps 段推导「要下载什么」。
 *
 * 只依赖清单，不猜仓库结构：slug 取自 `path` 的最后一段（`apps/bedcode` → `bedcode`），
 * 发布 tag / 包名按应用仓 `app-release.yml` 的固定命名拼出。
 *
 * @param {object} manifest release-manifest.json 解析结果
 * @param {{ end?: string, only?: string[] }} [options]
 * @returns {Array<{ id: string, slug: string, version: string, releaseTag: string,
 *   packageName: string, metaName: string, sha256: string, artifact: string }>}
 */
export function planVendorApps(manifest, options = {}) {
  const end = options.end ?? 'desktop'
  const only = options.only && options.only.length > 0 ? new Set(options.only) : null

  const apps = manifest?.apps
  if (!apps || typeof apps !== 'object' || Array.isArray(apps)) {
    throw new Error('[vendor-apps] release-manifest.json 缺 apps 段')
  }

  const plan = []
  for (const [id, entry] of Object.entries(apps)) {
    const target = entry?.ends?.[end]
    if (!target) continue // 该端没有这个应用：跳过（不是错误）
    if (only && !only.has(id)) continue

    const slug = typeof entry.path === 'string' ? basename(entry.path) : ''
    if (!slug) throw new Error(`[vendor-apps] ${id} 的 path 缺失或非法（无法推导应用仓 slug）`)
    if (typeof entry.version !== 'string' || entry.version === '') {
      throw new Error(`[vendor-apps] ${id} 缺 version（清单必须钉住 app 版本，否则只能拿 latest，不可复现）`)
    }
    if (typeof target.package !== 'string' || target.package === '') {
      throw new Error(`[vendor-apps] ${id} 的 ends.${end} 缺 package（成品包文件名）`)
    }
    if (typeof target.sha256 !== 'string' || !SHA256_RE.test(target.sha256)) {
      throw new Error(`[vendor-apps] ${id} 的 ends.${end}.sha256 必须是 64 位小写 hex`)
    }
    if (typeof target.artifact !== 'string' || target.artifact === '') {
      throw new Error(`[vendor-apps] ${id} 的 ends.${end}.artifact 缺失（wasm 产物名）`)
    }

    const version = entry.version
    const expectedPackage = `${slug}-${end}-v${version}.zip`
    if (target.package !== expectedPackage) {
      throw new Error(
        `[vendor-apps] ${id} 的 package=${target.package} 与应用仓命名规则=${expectedPackage} 不一致`,
      )
    }

    plan.push({
      id,
      slug,
      version,
      releaseTag: `${slug}-v${version}`,
      packageName: expectedPackage,
      metaName: `${slug}-${end}-v${version}.json`,
      sha256: target.sha256,
      artifact: target.artifact,
    })
  }

  if (plan.length === 0) {
    throw new Error(
      `[vendor-apps] 清单里没有任何 end=${end} 的应用（${only ? `--only 过滤后为空：${[...only].join(', ')}` : '清单 apps 段为空'}）`,
    )
  }
  return plan
}

/** GitHub Release 资产下载地址 */
export function vendorUrl(baseUrl, releaseTag, fileName) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new Error(`[vendor-apps] base-url 必须是 http(s) 绝对地址（收到：${baseUrl}）`)
  }
  return `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(releaseTag)}/${encodeURIComponent(fileName)}`
}

/**
 * 校验应用仓的元数据 json 与清单声明一致。
 *
 * 兼容判据（ADR 0061 §6.3）：
 * 1. `compat.witVersion` == 清单 `contract.version`（`wasmnest:plugin` 公共轴）；
 * 2. `compat.witPackages` 是对象且含 `wasmnest:plugin`；
 * 3. 逐包对齐 `contract.packages`（宿主没有该包 / 版本不等即红，文案点名包与两端版本）；
 * 4. `source.libRef` **只记录不比较**（拆包后 lib tag 前进不代表任何包变化）。
 *
 * @param {object} meta `<slug>-<end>-v<ver>.json` 解析结果
 * @param {{ id: string, sha256: string, artifact: string }} plan 单条计划
 * @param {{ contractVersion: string, contractPackages: Record<string,string> }} context
 *   清单钉的契约包表（`wasmnest:plugin` 版本 + 全包 → 版本）
 */
export function verifyMeta(meta, plan, context) {
  const where = `[vendor-apps] ${plan.id} 的元数据`
  if (!meta || typeof meta !== 'object') throw new Error(`${where}不是对象`)

  if (meta.plugin?.id !== plan.id) {
    throw new Error(`${where} plugin.id=${meta.plugin?.id} 与清单键=${plan.id} 不一致`)
  }
  if (meta.plugin?.version !== plan.version) {
    throw new Error(`${where} plugin.version=${meta.plugin?.version} 与清单 version=${plan.version} 不一致`)
  }
  if (meta.artifact?.sha256 !== plan.sha256) {
    throw new Error(
      `${where} artifact.sha256=${meta.artifact?.sha256} 与清单=${plan.sha256} 不一致（清单过期？）`,
    )
  }
  if (meta.artifact?.file !== plan.packageName) {
    throw new Error(`${where} artifact.file=${meta.artifact?.file} 与预期=${plan.packageName} 不一致`)
  }
  if (meta.wasm?.file !== plan.artifact) {
    throw new Error(`${where} wasm.file=${meta.wasm?.file} 与清单 artifact=${plan.artifact} 不一致`)
  }

  // 1. 公共轴：wasmnest:plugin 版本
  const witVersion = meta.compat?.witVersion
  if (typeof witVersion !== 'string' || witVersion === '') {
    throw new Error(`${where} 缺 compat.witVersion（无法确认插件面包版本，拒绝安装）`)
  }
  if (witVersion !== context.contractVersion) {
    throw new Error(
      `${where} compat.witVersion=${witVersion} 与清单 contract.version=${context.contractVersion} 不一致：` +
        'wasmnest:plugin 是全部应用的公共轴，版本不等即实例化失败；请按当前 SDK 重建该 app',
    )
  }

  // 2/3. 逐包：只对 app 真正 import 的包判定（拆包后各自独立版本）
  const witPackages = meta.compat?.witPackages
  if (!witPackages || typeof witPackages !== 'object' || Array.isArray(witPackages)) {
    throw new Error(
      `${where} 缺 compat.witPackages（ADR 0061 拆包后的发布下限：构建期从组件 import/export 面权威提取）`,
    )
  }
  if (!('wasmnest:plugin' in witPackages)) {
    throw new Error(`${where} compat.witPackages 未包含 wasmnest:plugin（公共轴必须登记）`)
  }
  for (const [pkg, version] of Object.entries(witPackages)) {
    const hostVersion = context.contractPackages?.[pkg]
    if (!hostVersion) {
      throw new Error(
        `${where} 声明依赖 WIT 包 ${pkg}@${version}，但宿主契约清单（contract.packages）没有该包：` +
          '该端宿主不提供此包，装进去会实例化失败；请确认应用端 / 明细清单',
      )
    }
    if (hostVersion !== version) {
      throw new Error(
        `${where} 的 ${pkg}@${version} 与宿主 contract.packages 的 ${pkg}@${hostVersion} 不一致：` +
          '该包契约变了，请重发该 app（未 import 的包改动不会触发本判据）',
      )
    }
  }

  // 4. source.libRef 仅溯源记录（不再与 repos.lib.tag 比较）
  if (typeof meta.source?.libRef !== 'string' || meta.source.libRef === '') {
    throw new Error(`${where} 缺 source.libRef（溯源记录，用于回溯能力仓版本；不参与兼容判定）`)
  }
}

/**
 * 校验解包后的 plugin.json 与清单声明一致。
 *
 * @param {object} pluginJson 解出的 plugin.json
 * @param {{ id: string, version: string, artifact: string }} plan
 * @param {string} end 本端（desktop / mobile）
 */
export function verifyPluginJson(pluginJson, plan, end) {
  const where = `[vendor-apps] ${plan.id} 的 plugin.json`
  if (pluginJson?.id !== plan.id) {
    throw new Error(`${where} id=${pluginJson?.id} 与清单键=${plan.id} 不一致`)
  }
  if (pluginJson?.version !== plan.version) {
    throw new Error(`${where} version=${pluginJson?.version} 与清单 version=${plan.version} 不一致`)
  }
  const platform = pluginJson?.platform
  if (platform !== end && platform !== 'both') {
    throw new Error(`${where} platform=${platform} 不覆盖本端 ${end}（错端产物）`)
  }
  const expectedWasm = `${pluginJson?.rustLibrary}.wasm`
  if (expectedWasm !== plan.artifact) {
    throw new Error(`${where} rustLibrary+'.wasm'=${expectedWasm} 与清单 artifact=${plan.artifact} 不一致`)
  }
  if (typeof pluginJson?.main !== 'string' || pluginJson.main === '') {
    throw new Error(`${where} 缺 main（前端挂载入口）`)
  }
}

/** 解 zip 到目录（依赖系统 unzip；缺失 / 失败都显性报错） */
export function unzipInto(zipPath, destDir) {
  const result = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { encoding: 'utf8' })
  if (result.error) {
    throw new Error(
      `[vendor-apps] 无法执行 unzip（${result.error.message}）：请安装 unzip（CI runner 自带）`,
    )
  }
  if (result.status !== 0) {
    throw new Error(`[vendor-apps] 解包失败（exit=${result.status}）：${zipPath}\n${result.stderr ?? ''}`)
  }
}

/** 单次下载超时（本地网络拉 GitHub Release 实测会长时间无响应；对挂起直接报错，不拖死 job） */
const DOWNLOAD_TIMEOUT_MS = 120_000

async function download(url) {
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (err) {
    throw new Error(
      `[vendor-apps] 下载失败（${err?.name === 'TimeoutError' ? `${DOWNLOAD_TIMEOUT_MS}ms 超时` : err?.message}）：${url}`,
    )
  }
  if (!res.ok) {
    throw new Error(`[vendor-apps] 下载失败 ${res.status} ${res.statusText}：${url}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new Error(`[vendor-apps] 无法识别的参数：${token}`)
    const eq = token.indexOf('=')
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const key = token.slice(2)
    if (key === 'dry-run') {
      out[key] = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`[vendor-apps] 参数 --${key} 缺值`)
    out[key] = value
    i += 1
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const manifestPath = resolve(args.manifest ?? join(ROOT, 'release-manifest.json'))
  const destRoot = resolve(args.dest ?? join(ROOT, 'wasmnest-desktop/src-tauri/resources/plugins/desktop'))
  const end = args.end ?? 'desktop'
  const baseUrl = args['base-url'] ?? DEFAULT_BASE_URL
  const only = args.only ? args.only.split(',').map((s) => s.trim()).filter(Boolean) : null
  const dryRun = args['dry-run'] === true

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const libTag = manifest?.repos?.lib?.tag
  if (typeof libTag !== 'string' || libTag === '') {
    throw new Error('[vendor-apps] 清单缺 repos.lib.tag（溯源记录）')
  }
  const contractVersion = manifest?.contract?.version
  const contractPackages = manifest?.contract?.packages
  if (typeof contractVersion !== 'string' || contractVersion === '') {
    throw new Error('[vendor-apps] 清单缺 contract.version（wasmnest:plugin 版本锚点）')
  }
  if (!contractPackages || typeof contractPackages !== 'object' || Array.isArray(contractPackages)) {
    throw new Error('[vendor-apps] 清单缺 contract.packages（ADR 0061 逐包兼容判据的真源）')
  }

  const plan = planVendorApps(manifest, { end, only })

  console.log(
    `[vendor-apps] 计划 ${plan.length} 个应用 → ${destRoot}（end=${end}, ` +
      `plugin=${contractVersion}, lib=${libTag} 仅溯源）`,
  )
  for (const item of plan) {
    console.log(`[vendor-apps]   - ${item.id}  ${item.releaseTag}  ${item.packageName}`)
  }
  if (dryRun) {
    console.log('[vendor-apps] --dry-run：不下载、不落盘')
    return
  }

  rmSync(destRoot, { recursive: true, force: true })
  mkdirSync(destRoot, { recursive: true })

  for (const item of plan) {
    const metaUrl = vendorUrl(baseUrl, item.releaseTag, item.metaName)
    const zipUrl = vendorUrl(baseUrl, item.releaseTag, item.packageName)

    const meta = JSON.parse((await download(metaUrl)).toString('utf8'))
    verifyMeta(meta, item, { contractVersion, contractPackages })

    const zipBuf = await download(zipUrl)
    const actualSha = createHash('sha256').update(zipBuf).digest('hex')
    if (actualSha !== item.sha256) {
      throw new Error(
        `[vendor-apps] ${item.id} 的 ${item.packageName} sha256 不匹配：清单=${item.sha256}，实际=${actualSha}`,
      )
    }

    const appDir = join(destRoot, item.id)
    mkdirSync(appDir, { recursive: true })
    const tmpDir = mkdtempSync(join(tmpdir(), 'vendor-apps-'))
    try {
      const zipPath = join(tmpDir, item.packageName)
      writeFileSync(zipPath, zipBuf)
      unzipInto(zipPath, appDir)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }

    const pluginJsonPath = join(appDir, 'plugin.json')
    if (!existsSync(pluginJsonPath)) {
      throw new Error(`[vendor-apps] ${item.id} 解包后缺 plugin.json（zip 形态不符：应扁平一层）`)
    }
    verifyPluginJson(JSON.parse(readFileSync(pluginJsonPath, 'utf8')), item, end)
    console.log(`[vendor-apps] ✓ ${item.id}（${item.version}，sha256 与 witPackages 均校验通过）`)
  }

  console.log(`[vendor-apps] 完成：${plan.length} 个应用已铺进 ${destRoot}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err?.message ?? err)
    process.exit(1)
  })
}
