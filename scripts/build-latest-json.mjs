#!/usr/bin/env node

/**
 * build-latest-json —— 组装 Tauri updater 的 `latest.json`（「就地升级」的唯一入口文件）
 *
 * ## 为什么需要它
 *
 * 宿主 `tauri.conf.json` 的 `plugins.updater.endpoints` 指向
 * `https://github.com/7ZAI/wasmnest/releases/latest/download/latest.json`。
 * `releases/latest` 只认**非 prerelease** 的最新 release：机器工件线 `host-v*` 是
 * prerelease（见 `.github/workflows/host-release.yml`），所以「Latest」永远落在产品
 * 安装包发布上，`latest.json` 也只能由本脚本产出，不能手写（手写必然与真实安装包
 * 文件名 / 签名漂移，客户端 check 时 404 或验签失败 → 静默失去升级能力）。
 *
 * ## 平台映射（Tauri updater 的 target key）
 *
 * | target key        | 产物（`tauri-build.js` 重命名后的形态）              | 说明 |
 * | ----------------- | --------------------------------------------------- | ---- |
 * | `windows-x86_64`  | `WasmNest-<ver>-release-x64-setup.exe` + `.sig`       | NSIS（perMachine 安装） |
 * | `windows-aarch64` | `WasmNest-<ver>-release-arm64-setup.exe` + `.sig`     | 当前矩阵未启用 |
 * | `linux-x86_64`    | `WasmNest_<ver>_amd64.AppImage.tar.gz` + `.sig`       | v2 的 Linux 更新包形态 |
 * | `linux-aarch64`   | `WasmNest_<ver>_aarch64.AppImage.tar.gz` + `.sig`     | 当前矩阵未启用 |
 *
 * `.deb` **不进** `platforms`：Tauri updater 在 Linux 只支持 AppImage 就地替换，
 * deb 仍照常作为发布资产提供（新装用户用），只是不能走自动升级。
 *
 * ## 失败口径
 *
 * 同一 target 命中 0 个或多于 1 个产物 / 缺 `.sig` / 缺必填参数 —— 一律抛错并点名
 * 缺什么、目录里实际有什么（不静默产出残缺 latest.json：那会让所有已安装客户端
 * 的升级检查长期 404 且无人知道）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/build-latest-json.mjs \
 *   --assets-dir release-assets \
 *   --base-url https://github.com/7ZAI/wasmnest/releases/download/v0.0.1 \
 *   --version 0.0.1 \
 *   --notes-file release-notes.md \
 *   --out release-assets/latest.json
 * ```
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 产物判定规则：顺序敏感 —— `.AppImage.tar.gz` 必须排在 `.AppImage` 之前，
 * 否则更新包会被当成裸 AppImage 匹配到同一 target（重复命中）。
 */
const ASSET_RULES = [
  // 同时兼容两种命名：Tauri 原生 `_x64-setup.exe` 与 tauri-build.js 重命名后的
  // `-release-x64-setup.exe`（本地与 CI 统一走重命名，见 scripts/tauri-build.js）
  { target: 'windows-x86_64', pattern: /[-_]x64-setup\.exe$/i },
  { target: 'windows-aarch64', pattern: /[-_]arm64-setup\.exe$/i },
  { target: 'linux-x86_64', pattern: /[-_]amd64\.AppImage\.tar\.gz$/i },
  { target: 'linux-aarch64', pattern: /[-_]aarch64\.AppImage\.tar\.gz$/i },
  // 裸 AppImage（无 .tar.gz）：老版本 Tauri / 手工构建可能直接给这种形态
  { target: 'linux-x86_64', pattern: /[-_]amd64\.AppImage$/i },
  { target: 'linux-aarch64', pattern: /[-_]aarch64\.AppImage$/i },
]

/** 不是更新载体、但允许出现在资产目录里的文件（不报错、不进 platforms） */
const IGNORED_RULES = [/\.deb$/i, /^latest\.json$/i, /\.sha256$/i, /\.sig$/i]

/**
 * 把一个文件名归类到 Tauri updater 的 target key。
 *
 * @param {string} fileName 纯文件名（不含目录）
 * @returns {string|null} target key；不认识返回 null
 */
export function classifyAsset(fileName) {
  if (typeof fileName !== 'string' || fileName.length === 0) return null
  if (IGNORED_RULES.some((re) => re.test(fileName))) return null
  for (const rule of ASSET_RULES) {
    if (rule.pattern.test(fileName)) return rule.target
  }
  return null
}

/**
 * 从资产目录收集更新载体：命中规则的产物 + 同名 `.sig`。
 *
 * @param {string} assetsDir 平铺目录（CI 里是 download-artifact 的 merge 落点）
 * @param {{readFile?: typeof readFileSync}} [deps]
 * @returns {Array<{ target: string, name: string, signature: string }>} 按 target + 文件名排序
 */
export function collectArtifacts(assetsDir, deps = {}) {
  const readFile = deps.readFile ?? readFileSync
  const dir = resolve(assetsDir)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    throw new Error(`[latest-json] 资产目录不可读：${dir}（${e.message}）`)
  }

  const files = entries.filter((e) => e.isFile()).map((e) => e.name)
  const candidates = files.filter((name) => classifyAsset(name) !== null)

  if (candidates.length === 0) {
    throw new Error(
      `[latest-json] 资产目录里没有任何更新载体（期望 *-setup.exe / *.AppImage[.tar.gz]）：${dir}\n` +
        `  目录实际内容：${files.length === 0 ? '(空)' : files.join(', ')}`,
    )
  }

  return candidates.map((name) => {
    const target = classifyAsset(name)
    const sigName = `${name}.sig`
    if (!files.includes(sigName)) {
      throw new Error(
        `[latest-json] 缺少签名边车 ${sigName}（${name} 无法作为自动升级源）\n` +
          `  → 检查构建时是否提供了 TAURI_SIGNING_PRIVATE_KEY（tauri.conf.json 的 createUpdaterArtifacts）`,
      )
    }
    const signature = readFile(join(dir, sigName), 'utf8').trim()
    if (signature.length === 0) {
      throw new Error(`[latest-json] ${sigName} 为空（签名内容不能是空串）`)
    }
    return { target, name, signature }
  })
    // readdir 顺序随平台 / 文件系统而变：按 target + 文件名排序，保证同输入产出同字节
    .sort((a, b) => a.target.localeCompare(b.target) || a.name.localeCompare(b.name))
}

/**
 * 组装最终 `latest.json` 文档。
 *
 * @param {object} input
 * @param {Array<{ target: string, name: string, signature: string }>} input.artifacts
 * @param {string} input.version 产品版本（= release-manifest.json 的 product）
 * @param {string} [input.notes] 发布说明（纯文本 / markdown）
 * @param {string} [input.pubDate] ISO 8601 时间戳
 * @param {string} input.baseUrl 资产下载前缀（末尾不带 /）
 * @returns {{version: string, notes: string, pub_date: string, platforms: Record<string, {signature: string, url: string}>}}
 */
export function buildLatestJson({ artifacts, version, notes = '', pubDate, baseUrl }) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`[latest-json] version 必须是 x.y.z（收到：${version}）`)
  }
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new Error(`[latest-json] base-url 必须是 http(s) 绝对地址（收到：${baseUrl}）`)
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error('[latest-json] artifacts 为空（没有可发布的更新载体）')
  }

  const byTarget = new Map()
  for (const item of artifacts) {
    const prev = byTarget.get(item.target)
    if (prev) {
      throw new Error(
        `[latest-json] target ${item.target} 命中多个产物：${prev.name} / ${item.name}\n` +
          '  → 每个 target 只能有一个更新载体（删掉多余产物或显式区分架构）',
      )
    }
    byTarget.set(item.target, item)
  }

  const platforms = {}
  for (const [target, item] of [...byTarget.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    platforms[target] = {
      signature: item.signature,
      url: `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(item.name)}`,
    }
  }

  return {
    version,
    notes,
    pub_date: pubDate ?? new Date().toISOString(),
    platforms,
  }
}

/** `--flag value` / `--flag=value` 解析（缺值即抛错，不静默取空） */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new Error(`[latest-json] 无法识别的参数：${token}`)
    const eq = token.indexOf('=')
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const key = token.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`[latest-json] 参数 --${key} 缺值`)
    }
    out[key] = value
    i += 1
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const required = ['assets-dir', 'base-url', 'version', 'out']
  const missing = required.filter((k) => !args[k])
  if (missing.length > 0) {
    console.error(`[latest-json] 缺必填参数：${missing.map((k) => `--${k}`).join(' ')}`)
    process.exit(1)
  }

  const notes = args['notes-file']
    ? readFileSync(resolve(args['notes-file']), 'utf8').trim()
    : (args.notes ?? '')

  const artifacts = collectArtifacts(args['assets-dir'])
  const doc = buildLatestJson({
    artifacts,
    version: args.version,
    notes,
    pubDate: args['pub-date'],
    baseUrl: args['base-url'],
  })

  const outPath = resolve(args.out)
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`)

  console.log(
    `[latest-json] 已写入 ${outPath}：version=${doc.version} platforms=${Object.keys(doc.platforms).join(', ')}`,
  )
}

// 测试 import 本模块时不得触发 CLI（与 package-host.mjs 同口径）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main()
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
