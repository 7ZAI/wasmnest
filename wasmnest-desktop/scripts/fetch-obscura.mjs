#!/usr/bin/env node
// 校验 / 打印 Obscura 浏览器组件锁。
//
// 锁是运行期唯一信任源：`bytes` 与 `sha256` 只认 `browser-runtime.lock.json`，
// 不从 release API 的「最新版」推断。本脚本只在发布准备时访问 release API，
// 用于人工核对资产名与摘要；宿主运行期不联网查版本。

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = resolve(root, 'browser-runtime.lock.json')
const ALLOWED_VARIANT = 'default-render'
const SUPPORTED_ARCHIVES = new Set(['tar.gz', 'zip'])

const args = new Set(process.argv.slice(2))
const printOnly = args.has('--print')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))

const failures = []
function check(condition, message) {
  if (!condition) failures.push(message)
}

check(lock.schema === 1, `schema 必须为 1，实际为 ${lock.schema}`)
check(
  typeof lock.obscura?.version === 'string' && lock.obscura.version.length > 0,
  'obscura.version 缺失',
)
check(
  lock.obscura?.variant === ALLOWED_VARIANT,
  `variant 只允许 ${ALLOWED_VARIANT}，实际为 ${lock.obscura?.variant}`,
)
check(
  typeof lock.obscura?.releaseApi === 'string' && lock.obscura.releaseApi.startsWith('https://'),
  'obscura.releaseApi 必须是 https 地址',
)

const artifacts = Object.entries(lock.artifacts ?? {})
check(artifacts.length > 0, 'artifacts 至少收录一个已验证平台')
for (const [platform, artifact] of artifacts) {
  check(/^(linux|macos|windows)-(x86_64|aarch64)$/.test(platform), `平台键不合法: ${platform}`)
  check(typeof artifact.asset === 'string' && artifact.asset.length > 0, `${platform}: asset 缺失`)
  check(
    Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0,
    `${platform}: bytes 必须是正整数`,
  )
  check(
    /^[0-9a-f]{64}$/.test(artifact.sha256 ?? ''),
    `${platform}: sha256 必须是 64 位小写十六进制`,
  )
  check(SUPPORTED_ARCHIVES.has(artifact.archive), `${platform}: archive 只支持 tar.gz / zip`)
  check(typeof artifact.entry === 'string' && artifact.entry.length > 0, `${platform}: entry 缺失`)
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[fetch-obscura] ${failure}`)
  process.exit(1)
}

const response = await fetch(lock.obscura.releaseApi, {
  headers: {
    accept: 'application/vnd.github+json',
    'user-agent': 'wasmnest-fetch-obscura',
  },
})
if (!response.ok) {
  console.error(`[fetch-obscura] release API 请求失败: HTTP ${response.status}`)
  process.exit(1)
}
const release = await response.json()
if (printOnly) {
  console.log(`[fetch-obscura] ${release.tag_name}（${release.assets.length} 个资产）`)
  for (const asset of release.assets) {
    console.log(`${asset.name}\t${asset.size}\t${asset.digest ?? '-'}`)
  }
  process.exit(0)
}

const assets = new Map((release.assets ?? []).map((asset) => [asset.name, asset]))
const drift = []
for (const [platform, artifact] of artifacts) {
  const asset = assets.get(artifact.asset)
  if (!asset) {
    drift.push(`${platform}: release 中不存在资产 ${artifact.asset}`)
    continue
  }
  if (asset.size !== artifact.bytes) {
    drift.push(`${platform}: bytes 漂移，lock=${artifact.bytes} release=${asset.size}`)
  }
  const expected = `sha256:${artifact.sha256}`
  if (asset.digest && asset.digest !== expected) {
    drift.push(`${platform}: sha256 漂移，lock=${expected} release=${asset.digest}`)
  }
}

if (drift.length > 0) {
  for (const item of drift) console.error(`[fetch-obscura] ${item}`)
  process.exit(1)
}
console.log(
  `[fetch-obscura] 锁校验通过：${lock.obscura.version}，${artifacts.length} 个平台，variant=${lock.obscura.variant}`,
)
