#!/usr/bin/env node
/**
 * set-host-version —— **发布时**同步宿主运行时版本（脚本本身不发布任何东西）
 *
 * 宿主运行时版本是独立版本线：真源 = `release-manifest.json` 的 `hostRuntime.version`。
 * `tauri.conf.json` / `src-tauri/Cargo.toml` 的版本只作为构建元数据由本脚本同步，
 * 不是版本真源（CONTRACT §1.3 / D13）。
 *
 * 同步三处（只改版本，不动其他字节）：
 *   1. `release-manifest.json` → `hostRuntime.version`
 *   2. `wasmnest-desktop/src-tauri/tauri.conf.json` → `version`
 *   3. `wasmnest-desktop/src-tauri/Cargo.toml` → `[package].version`
 *
 * 用法（发布动作见 docs/public/versioning.md；dev 日常不 bump）：
 *   node scripts/set-host-version.mjs 0.0.2
 *
 * 注意：`manifest.product` 不随宿主运行时版本走（平台产品版本另线）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 严格 semver 数字段（不允许前导零；预发布号 / v 前缀不在契约内） */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** 宿主运行时版本只接受 x.y.z（预发布号 / v 前缀不在契约内） */
export function assertHostVersion(version) {
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new Error(`[set-host-version] 版本必须是 semver 形式 x.y.z（收到：${version}）`)
  }
}

/** 只改 hostRuntime.version；重解析断言其余字段未变（防手滑改坏清单） */
export function updateManifestHostVersion(manifestText, version) {
  assertHostVersion(version)
  let before
  try {
    before = JSON.parse(manifestText)
  } catch (e) {
    throw new Error(`[set-host-version] release-manifest.json 解析失败：${e.message}`)
  }
  const hostRuntime = before.hostRuntime
  if (!hostRuntime || typeof hostRuntime !== 'object' || Array.isArray(hostRuntime)) {
    throw new Error('[set-host-version] release-manifest.json 缺 hostRuntime 段（版本真源不可猜）')
  }
  const re = /("hostRuntime"\s*:\s*\{[\s\S]*?"version"\s*:\s*")([^"]*)(")/
  if (!re.test(manifestText)) {
    throw new Error('[set-host-version] 未能在 release-manifest.json 的 hostRuntime 段定位 version 字段')
  }
  const nextText = manifestText.replace(re, (_, pre, _old, post) => `${pre}${version}${post}`)
  const next = JSON.parse(nextText)
  const expected = structuredClone(before)
  expected.hostRuntime.version = version
  if (JSON.stringify(next) !== JSON.stringify(expected)) {
    throw new Error('[set-host-version] hostRuntime.version 更新引入了其他字段变化（拒绝写入）')
  }
  return nextText
}

/** 只改 tauri.conf.json 的 version（保留其余字段与排版形态） */
export function updateTauriConfVersion(confText, version) {
  assertHostVersion(version)
  let before
  try {
    before = JSON.parse(confText)
  } catch (e) {
    throw new Error(`[set-host-version] tauri.conf.json 解析失败：${e.message}`)
  }
  const re = /(^|\n)(\s*"version"\s*:\s*")([^"]*)(")/
  if (!re.test(confText)) {
    throw new Error('[set-host-version] tauri.conf.json 里定位不到 "version" 字段')
  }
  const nextText = confText.replace(re, (_, lead, pre, _old, post) => `${lead}${pre}${version}${post}`)
  const next = JSON.parse(nextText)
  const expected = structuredClone(before)
  expected.version = version
  if (JSON.stringify(next) !== JSON.stringify(expected)) {
    throw new Error('[set-host-version] tauri.conf.json 的 version 更新引入了其他字段变化（拒绝写入）')
  }
  return nextText
}

/** 只改 Cargo.toml 的 `[package].version`（[dependencies] 等段的 version 原样） */
export function updateCargoPackageVersion(cargoToml, version) {
  assertHostVersion(version)
  const lines = cargoToml.split('\n')
  let inPackage = false
  let replaced = false
  const out = lines.map((line) => {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (section) {
      inPackage = section[1].trim() === 'package'
      return line
    }
    if (inPackage && !replaced && /^version\s*=\s*"[^"]*"\s*$/.test(line)) {
      replaced = true
      return line.replace(/"[^"]*"/, `"${version}"`)
    }
    return line
  })
  if (!replaced) throw new Error('[set-host-version] src-tauri/Cargo.toml 里读不到 [package].version')
  return out.join('\n')
}

/** 三个文本一起更新（纯函数；CLI 负责读写文件） */
export function applyHostVersion({ manifest, tauriConf, cargoToml }, version) {
  assertHostVersion(version)
  return {
    manifest: updateManifestHostVersion(manifest, version),
    tauriConf: updateTauriConfVersion(tauriConf, version),
    cargoToml: updateCargoPackageVersion(cargoToml, version),
  }
}

function main() {
  const version = process.argv[2]
  if (!version) {
    console.error('[set-host-version] 用法：node scripts/set-host-version.mjs <x.y.z>')
    console.error('[set-host-version] 版本只在发布时设置（dev 日常不改）；本脚本只写文件，不发布、不提交。')
    process.exit(2)
  }
  const files = {
    manifest: join(ROOT, 'release-manifest.json'),
    tauriConf: join(ROOT, 'wasmnest-desktop', 'src-tauri', 'tauri.conf.json'),
    cargoToml: join(ROOT, 'wasmnest-desktop', 'src-tauri', 'Cargo.toml'),
  }
  let out
  try {
    out = applyHostVersion(
      {
        manifest: readFileSync(files.manifest, 'utf8'),
        tauriConf: readFileSync(files.tauriConf, 'utf8'),
        cargoToml: readFileSync(files.cargoToml, 'utf8'),
      },
      version,
    )
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  writeFileSync(files.manifest, out.manifest)
  writeFileSync(files.tauriConf, out.tauriConf)
  writeFileSync(files.cargoToml, out.cargoToml)
  console.log(`[set-host-version] 已同步宿主运行时版本 → ${version}`)
  console.log(`[set-host-version]   - ${files.manifest}（hostRuntime.version）`)
  console.log(`[set-host-version]   - ${files.tauriConf}（version）`)
  console.log(`[set-host-version]   - ${files.cargoToml}（[package].version）`)
  console.log('[set-host-version] 下一步（发布）：提交 → 打 tag host-v' + version + ' → host-release workflow')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
