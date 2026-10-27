#!/usr/bin/env node
/**
 * update-host-runtime-artifacts —— **发布后**把三平台真实 sha256 与 sourceCommit 写回 manifest
 *
 * host-release workflow 的「manifest 更新」job 用本脚本：宿主 tag 发布成功后，
 * 收集三平台 `host-desktop-<version>-<platform>-<arch>.tar.gz` + `.sha256`，
 * 写入 `release-manifest.json` 的 `hostRuntime.artifacts`（CONTRACT §2.3）与
 * `hostRuntime.sourceCommit`；随后由 workflow 在分支上提交并开 PR（不直接 push main）。
 *
 * 只改 hostRuntime 块：其余字节 / JSON 字段保持不变（拒绝引入额外字段变化）。
 *
 * 用法：
 *   node scripts/update-host-runtime-artifacts.mjs --dir <资产目录> [--source-commit <sha>] [--manifest <path>]
 *
 * 缺产物 / 缺边车 / 边车非法一律 fail-visible——发布态必须可校验，不写半份清单。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const ARTIFACT_FILE_RE =
  /^host-desktop-(\d+\.\d+\.\d+)-((linux|macos|windows)-(x86_64|arm64))\.tar\.gz$/

/** 扫描资产目录：文件名 → { key: { file, sha256 } }（CONTRACT §1.2 / §1.4） */
export function collectArtifacts(dir) {
  if (!existsSync(dir)) {
    throw new Error(`[host-artifacts] 资产目录不存在：${dir}（先跑 host:pack 并收集三平台产物）`)
  }
  const tarballs = readdirSync(dir)
    .filter((name) => name.endsWith('.tar.gz'))
    .sort()
  if (tarballs.length === 0) {
    throw new Error(`[host-artifacts] 未找到 host-desktop-*.tar.gz：${dir}（发布态至少需要一个平台产物）`)
  }
  const artifacts = {}
  for (const file of tarballs) {
    const match = ARTIFACT_FILE_RE.exec(file)
    if (!match) {
      throw new Error(`[host-artifacts] 文件名不合 CONTRACT §1.2：${file}`)
    }
    const key = match[2]
    if (key in artifacts) throw new Error(`[host-artifacts] 同一平台-架构出现多份产物：${key}`)
    const sidecar = join(dir, `${file}.sha256`)
    if (!existsSync(sidecar)) {
      throw new Error(`[host-artifacts] 缺 sha256 边车：${sidecar}（CONTRACT §1.4）`)
    }
    const sha256 = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] ?? ''
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`[host-artifacts] 边车 sha256 非法：${sidecar}`)
    }
    artifacts[key] = { file, sha256 }
  }
  return artifacts
}

/** 找到 `"<key>": { ... }` 的对象块（字符串感知的括号配对） */
function findObjectBlock(text, key) {
  const marker = `"${key}"`
  const keyIndex = text.indexOf(marker)
  if (keyIndex === -1) throw new Error(`[host-artifacts] release-manifest.json 缺 ${key} 段`)
  const start = text.indexOf('{', keyIndex)
  if (start === -1) throw new Error(`[host-artifacts] ${key} 段后没有对象`)
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { start, end: i }
    }
  }
  throw new Error(`[host-artifacts] ${key} 段对象括号不闭合`)
}

/**
 * 写入 artifacts 与 sourceCommit（纯函数）。
 * 重解析断言：除这两个字段外，清单其余内容逐字段不变。
 */
export function applyHostRuntimeArtifacts(manifestText, { artifacts, sourceCommit }) {
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(sourceCommit)) {
    throw new Error(`[host-artifacts] sourceCommit 必须是 40 位 hex（收到：${sourceCommit}）`)
  }
  let before
  try {
    before = JSON.parse(manifestText)
  } catch (e) {
    throw new Error(`[host-artifacts] release-manifest.json 解析失败：${e.message}`)
  }
  if (!before.hostRuntime || typeof before.hostRuntime !== 'object' || Array.isArray(before.hostRuntime)) {
    throw new Error('[host-artifacts] release-manifest.json 缺 hostRuntime 段（CONTRACT §2.3）')
  }

  const { start, end } = findObjectBlock(manifestText, 'hostRuntime')
  const block = JSON.parse(manifestText.slice(start, end + 1))
  block.artifacts = artifacts
  block.sourceCommit = sourceCommit
  // 缩进跟住原位置：`{` 所在行的前导空白就是本对象的基准缩进。JSON.stringify 只给
  // 两空格级差，不整体平移到基准就会把对象写得比同级字段浅一级（首次发布实测：
  // `hostRuntime` 内部字段被写到 2 空格，与 `apps` 段错位）。
  const lineStart = manifestText.lastIndexOf('\n', start) + 1
  const baseIndent = /^[ \t]*/.exec(manifestText.slice(lineStart, start))[0]
  const serialized = JSON.stringify(block, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : baseIndent + line))
    .join('\n')
  const nextText = manifestText.slice(0, start) + serialized + manifestText.slice(end + 1)

  const after = JSON.parse(nextText)
  const expected = structuredClone(before)
  expected.hostRuntime.artifacts = artifacts
  expected.hostRuntime.sourceCommit = sourceCommit
  if (JSON.stringify(after) !== JSON.stringify(expected)) {
    throw new Error('[host-artifacts] artifacts / sourceCommit 更新引入了额外字段变化（拒绝写入）')
  }
  return nextText
}

function main() {
  const argv = process.argv.slice(2)
  const valueOf = (flag, fallback) => {
    const i = argv.indexOf(flag)
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
  }
  const dir = resolve(valueOf('--dir', join(ROOT, 'wasmnest-desktop', 'dist-host')))
  const manifestPath = resolve(valueOf('--manifest', join(ROOT, 'release-manifest.json')))
  let sourceCommit = valueOf('--source-commit', null)
  if (!sourceCommit) {
    try {
      sourceCommit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch (e) {
      console.error(`[host-artifacts] 读不到平台仓 HEAD（--source-commit 未给）：${e.message}`)
      process.exit(1)
    }
  }

  let artifacts
  try {
    artifacts = collectArtifacts(dir)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  let nextText
  try {
    nextText = applyHostRuntimeArtifacts(readFileSync(manifestPath, 'utf8'), { artifacts, sourceCommit })
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  writeFileSync(manifestPath, nextText)
  console.log(`[host-artifacts] 已写入 ${Object.keys(artifacts).length} 个平台产物（sourceCommit=${sourceCommit}）`)
  for (const [key, entry] of Object.entries(artifacts)) {
    console.log(`[host-artifacts]   ${key}: ${entry.file} sha256=${entry.sha256}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
