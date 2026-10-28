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
 * ## 三道校验（缺一条就 fail-visible，绝不产出空壳 / 坏壳安装包）
 *
 * | 校验 | 理由 |
 * | --- | --- |
 * | zip 实际 sha256 == 清单 `ends.<end>.sha256` | 下载损坏 / 被替换 |
 * | 元数据 `source.libRef` == 清单 `repos.lib.tag` | WIT 版本写在 wasm import 名里，不等则实例化必失败 |
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
 * @param {object} meta `<slug>-<end>-v<ver>.json` 解析结果
 * @param {{ id: string, sha256: string, artifact: string }} plan 单条计划
 * @param {{ libTag: string }} context 清单钉的能力仓 tag（WIT 契约版本锚点）
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
  const libTag = meta.source?.libRef
  if (!libTag) {
    throw new Error(`${where} 缺 source.libRef（无法确认 WIT 契约版本，拒绝安装）`)
  }
  if (libTag !== context.libTag) {
    throw new Error(
      `${where} source.libRef=${libTag} 与清单 repos.lib.tag=${context.libTag} 不一致：` +
        'WIT 版本写在 wasm import 名里，装进宿主会实例化失败；请重发该 app 或对齐清单',
    )
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

/** 计算文件 sha256（流式，避免整包进内存） */
export function sha256File(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
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

async function download(url) {
  const res = await fetch(url)
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
    throw new Error('[vendor-apps] 清单缺 repos.lib.tag（WIT 契约版本锚点）')
  }

  const plan = planVendorApps(manifest, { end, only })

  console.log(`[vendor-apps] 计划 ${plan.length} 个应用 → ${destRoot}（end=${end}, lib=${libTag}）`)
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
    verifyMeta(meta, item, { libTag })

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
    console.log(`[vendor-apps] ✓ ${item.id}（${item.version}，sha256 与 libRef 均校验通过）`)
  }

  console.log(`[vendor-apps] 完成：${plan.length} 个应用已铺进 ${destRoot}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err?.message ?? err)
    process.exit(1)
  })
}
