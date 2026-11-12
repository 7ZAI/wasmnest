#!/usr/bin/env node

/**
 * tauri build 包装脚本：按环境解析 updater 签名密钥
 *
 * 背景：
 * tauri.conf.json 配置了 `bundle.createUpdaterArtifacts` 与 `plugins.updater.pubkey`，
 * 生成升级包时 Tauri 强制要求 TAURI_SIGNING_PRIVATE_KEY，否则报错
 * "A public key has been found, but no private key"。
 * 正式发布构建在 GitHub Actions 中通过仓库 Secret 注入密钥（见 .github/workflows/release.yml）。
 *
 * 密钥解析优先级：
 * 1. TAURI_SIGNING_PRIVATE_KEY 环境变量（CI 或手动设置），原样使用
 * 2. TAURI_SIGNING_PRIVATE_KEY_FILE 环境变量指向的密钥文件
 * 3. 项目根 .env 文件（已 gitignore）中的 TAURI_SIGNING_PRIVATE_KEY
 *    或 TAURI_SIGNING_PRIVATE_KEY_FILE（推荐，密钥文件存放在仓库外）
 * 4. 均未提供：通过 --config 覆盖 createUpdaterArtifacts=false，
 *    构建不含升级包的本地安装包（自动更新功能不受影响，只是本次产物不作为升级源）
 *
 * 注意：签名私钥必须与 tauri.conf.json 中的 pubkey 配对（正式发布密钥），
 * 否则客户端校验更新签名会失败。
 */

import { spawnSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
// 直接调用本地 tauri CLI 入口，避免经 shell 转发导致参数引号丢失（Windows cmd 会吞掉 JSON 中的双引号）
const require = createRequire(import.meta.url)
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js')

/**
 * 从 .env 文件中提取 TAURI_SIGNING_* 变量
 * .env 已由 .gitignore 排除，仅支持单行 KEY=VALUE 格式（私钥为单行 base64）
 */
function loadSigningEnvFromFile() {
  const envPath = join(projectRoot, '.env')
  if (!existsSync(envPath)) return {}
  const result = {}
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(TAURI_SIGNING_[A-Z_]+)\s*=\s*(.*)\s*$/)
    if (!match) continue
    result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return result
}

/**
 * 解析签名密钥，返回注入的环境变量；无法解析时返回 null
 */
function resolveSigningEnv() {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
    return {}
  }

  const fromFile = loadSigningEnvFromFile()
  const keyFile =
    process.env.TAURI_SIGNING_PRIVATE_KEY_FILE || fromFile.TAURI_SIGNING_PRIVATE_KEY_FILE
  if (keyFile) {
    if (!existsSync(keyFile)) {
      console.error(`[tauri-build] TAURI_SIGNING_PRIVATE_KEY_FILE 指向的文件不存在: ${keyFile}`)
      process.exit(1)
    }
    // fromFile 中的 TAURI_SIGNING_PRIVATE_KEY_PASSWORD 等变量一并透传
    return { ...fromFile, TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyFile, 'utf8') }
  }

  if (fromFile.TAURI_SIGNING_PRIVATE_KEY) {
    return fromFile
  }

  return null
}

const signingEnv = resolveSigningEnv()
const extraArgs = []

if (signingEnv) {
  console.log('[tauri-build] 已检测到 updater 签名密钥，构建将生成签名的升级包')
} else {
  console.warn(
    '[tauri-build] 未检测到 updater 签名密钥（TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_FILE / .env）',
  )
  console.warn(
    '[tauri-build] 本次构建禁用升级包生成（createUpdaterArtifacts=false），产物不含自动更新签名',
  )
  extraArgs.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }))
}

/**
 * 转义正则特殊字符，用于以字面量匹配 productName/version
 */
/**
 * 定位 bundle 子目录。
 *
 * 不带 `--target` 时产物在 `target/release/bundle/<kind>`；带 `--target <triple>` 时在
 * `target/<triple>/release/bundle/<kind>`（CI 发布固定带 --target，2026-10-28 实测：
 * 只认无 target 的路径会让重命名静默空转，Release 上的文件名与本地产出不一致）。
 */
function resolveBundleDir(kind) {
  const base = join(projectRoot, 'src-tauri', 'target')
  const direct = join(base, 'release', 'bundle', kind)
  if (existsSync(direct)) return direct
  if (!existsSync(base)) return null
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(base, entry.name, 'release', 'bundle', kind)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 把 Tauri 的 `{productName}_{version}_{arch}…` 改成 `{name}-{version}-release-{arch}…`，
 * 与移动端 APK 的 `{name}-{version}-release.apk` 风格一致；`.sig` 同步改名
 * （签名覆盖文件内容、与文件名无关）。
 *
 * 版本与产品名**从实际文件名解析**，不读 tauri.conf.json：发布构建用
 * `--config '{"version":"<product>"}'` 覆盖版本，配置里的 version 可能与之不同，
 * 按配置匹配会静默匹配不上。
 *
 * 本地与 CI 都必须改名（2026-10-28 用户裁决）：CI 发布同样走本脚本，跳过会让
 * 文档里的文件名与用户下载到的对不上。
 */
function renameWithReleaseSuffix({ kind, pattern, toName, label }) {
  const dir = resolveBundleDir(kind)
  if (!dir) return
  for (const file of readdirSync(dir)) {
    const match = file.match(pattern)
    if (!match) continue
    const renamed = toName(match)
    if (renamed === file) continue
    for (const suffix of ['', '.sig']) {
      const from = join(dir, file + suffix)
      const to = join(dir, renamed + suffix)
      if (!existsSync(from)) continue
      try {
        renameSync(from, to)
        console.log(`[tauri-build] ${label}已重命名: ${file}${suffix} -> ${renamed}${suffix}`)
      } catch (err) {
        console.warn(`[tauri-build] 重命名 ${file}${suffix} 失败: ${err.message}`)
      }
    }
  }
}

/** NSIS：WasmNest_0.0.1_x64-setup.exe → WasmNest-0.0.1-release-x64-setup.exe */
function renameInstallerWithReleaseSuffix() {
  renameWithReleaseSuffix({
    kind: 'nsis',
    pattern: /^(.+)_([0-9][^_-]*)_(\w+)-setup\.exe$/,
    toName: (m) => `${m[1]}-${m[2]}-release-${m[3]}-setup.exe`,
    label: '安装包',
  })
}

/** DEB：WasmNest_0.0.1_amd64.deb → WasmNest-0.0.1-release-amd64.deb */
function renameDebWithReleaseSuffix() {
  renameWithReleaseSuffix({
    kind: 'deb',
    pattern: /^(.+)_([0-9][^_-]*)_(\w+)\.deb$/,
    toName: (m) => `${m[1]}-${m[2]}-release-${m[3]}.deb`,
    label: 'DEB 包',
  })
}

// pnpm run 会在脚本参数前注入一个 `--`（pnpm 的参数分隔符，非 tauri CLI 参数）；
// 若原样透传，tauri CLI 会把 `--` 当作“转发给底层 cargo build”的分隔符，导致
// `pnpm run tauri:build -- --bundles deb` 时 --bundles 被抛给 cargo 而报错。
// 这里剥离一个前导 `--`；如需向 cargo 透传参数，连写两个 `--` 即可（剥离一个后仍保留一个）。
const rawArgs = process.argv.slice(2)
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
const result = spawnSync(process.execPath, [tauriCli, 'build', ...extraArgs, ...args], {
  stdio: 'inherit',
  env: { ...process.env, ...signingEnv },
})

const status = result.status ?? 1
if (status === 0) {
  renameInstallerWithReleaseSuffix()
  renameDebWithReleaseSuffix()
}
process.exit(status)
