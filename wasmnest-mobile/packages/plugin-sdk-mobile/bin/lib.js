#!/usr/bin/env node
/**
 * wasmnest-plugin CLI 共享基建：常量 / 工具函数 / 零依赖 ZIP（自 cli.js 拆出）
 *
 * SDK_ROOT 依赖本文件位于 bin/ 下的相对位置，勿移动。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { crc32 } from "node:zlib"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE_DIR = join(SDK_ROOT, 'template')

/**
 * 组件化工具 manifest 的相对定位链（按优先级，逐级向上查找时依次尝试）：
 *
 * 1. 桌面 SDK 自带 `tools/componentize`（P1 起的发布落点：平台仓内为
 *    `wasmnest-desktop/packages/plugin-sdk-desktop/tools/…`，npm 安装后同相对形状）；
 * 2. `node_modules/@binblink/wasmnest-plugin-sdk-desktop/tools/…`（应用工程只装了 npm 包）；
 * 3. 旧平台仓级 `tools/componentize`（P1 前的落点，兼容兜底）；
 * 4. 三仓兄弟布局 `wasmnest/tools/componentize`（旧布局，兼容兜底）。
 */
const COMPONENTIZE_CANDIDATES = [
  join('wasmnest-desktop', 'packages', 'plugin-sdk-desktop', 'tools', 'componentize', 'Cargo.toml'),
  join('node_modules', '@binblink', 'wasmnest-plugin-sdk-desktop', 'tools', 'componentize', 'Cargo.toml'),
  join('tools', 'componentize', 'Cargo.toml'),
  join('wasmnest', 'tools', 'componentize', 'Cargo.toml'),
]

// ==================== 工具函数 ====================

/**
 * 定位组件化工具 `tools/componentize/Cargo.toml`。
 *
 * 工具原住仓库级 `packages/wasmnest-componentize`，三仓拆分后迁平台仓 `tools/componentize`，
 * 随后（P1）收进桌面 SDK 的 `tools/` 随 npm 包发布——应用侧不再依赖平台仓工作树。
 * 不能按固定深度从 SDK 根拼绝对路径：SDK 作为依赖安装时（pnpm 把 `file:` 依赖**复制**进
 * `node_modules/.pnpm/…`，node 解析入口脚本不会回落到源码目录），那个深度指向包仓库内部
 * ⇒ manifest 找不到，`cargo run --manifest-path` 直接失败。故按下列顺序定位：
 *
 * 1. `WASMNEST_COMPONENTIZE_MANIFEST`（显式覆盖；已设但不存在则直接报错，不静默回退）；
 * 2. 自 SDK 根与插件工作目录向上逐级查找 `COMPONENTIZE_CANDIDATES`
 *    （桌面 SDK 落点优先，旧平台仓落点仅作兼容兜底）。
 *
 * 全部未命中时报错并给出获取方式（此时通常意味着插件工程不在三仓布局内）。
 *
 * @param {string} cwd 插件工程目录（构建时的工作目录）
 * @returns {string} 组件化工具 manifest 的绝对路径
 */
function resolveComponentizeManifest(cwd) {
  const override = process.env.WASMNEST_COMPONENTIZE_MANIFEST
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `WASMNEST_COMPONENTIZE_MANIFEST 指向的 manifest 不存在: ${override}`,
      )
    }
    return override
  }
  for (const start of [SDK_ROOT, resolve(cwd)]) {
    let dir = start
    for (;;) {
      for (const rel of COMPONENTIZE_CANDIDATES) {
        const candidate = join(dir, rel)
        if (existsSync(candidate)) return candidate
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  throw new Error(
    `找不到组件化工具（已按 WASMNEST_COMPONENTIZE_MANIFEST、SDK 目录与插件目录 ` +
      `${cwd} 向上查找桌面 SDK 的 tools/componentize 与旧平台仓落点）。` +
      '该工具随 @binblink/wasmnest-plugin-sdk-desktop 发布（tools/componentize）：' +
      '插件工程需安装该 SDK，或用 WASMNEST_COMPONENTIZE_MANIFEST 指向其 Cargo.toml。',
  )
}

/** 解析命令行参数：positional 数组 + flags 映射（--flag value / --flag=value / 布尔 --flag） */
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[arg.slice(2)] = argv[++i]
      } else {
        flags[arg.slice(2)] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function toPosix(p) {
  return p.replace(/\\/g, '/')
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    console.error(`[wasmnest-plugin] 读取 ${what} 失败: ${path} — ${e.message}`)
    process.exit(1)
  }
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`[wasmnest-plugin] 命令失败 (${cmd} ${args.join(' ')})`)
    process.exit(1)
  }
}

/**
 * 解析 cargo 实际产物目录（`target_directory`）。
 *
 * 应用仓根 `.cargo/config.toml` 的 `[build] target-dir = "target/wasm-apps"` 会把
 * 仓内一切 cargo 调用的产物重定向到共享目录（见该文件注释：避免各 app 重复编译
 * 同一份依赖图）。因此不能写死 `<插件>/rust/target`——旧硬编码成立于插件住平台仓、
 * 尚无该 config 的时期；改写后 cargo 在共享目录产出，此处仍找 `rust/target` 就会
 * 出现「cargo 构建成功但未产出 wasm」的假失败。
 *
 * 以 `cargo metadata` 的 target_directory 为准（cargo 自行计算，覆盖仓内 config、
 * `CARGO_TARGET_DIR` 与 `--target-dir`）；metadata 失败时退回 `<插件>/rust/target`，
 * 后续「产物缺失」报错仍是显性失败，不静默挑一个存在的目录。
 */
function resolveCargoTargetDir(cwd) {
  const r = spawnSync(
    'cargo',
    ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', 'rust/Cargo.toml'],
    { cwd, encoding: 'utf8' },
  )
  if (r.status === 0) {
    try {
      const dir = JSON.parse(r.stdout).target_directory
      if (dir) return dir
    } catch {
      // 解析失败：走兜底路径
    }
  }
  return join(cwd, 'rust', 'target')
}

/** wasm 产物路径（按 cargo 实际 target 目录解析，见 resolveCargoTargetDir） */
function resolveWasmPath(cwd, rustLibrary) {
  return join(
    resolveCargoTargetDir(cwd),
    'wasm32-unknown-unknown',
    'release',
    `${rustLibrary}.wasm`,
  )
}

/** dev-shell 的 vite 入口（存在即代表该 dev-shell 目录已装好依赖） */
const DEV_SHELL_VITE = 'node_modules/vite/bin/vite.js'

/**
 * 定位可用的 dev-shell 目录：优先已装依赖的仓库内 SDK 检出。
 *
 * 内置插件用 `file:` 说明符依赖 SDK 时，pnpm 把 SDK 硬链注入插件 node_modules：
 * 注入副本带 dev-shell 源码但不带其 node_modules，直接用它等于每次 dev 都重装一遍。
 * 插件 package.json 的 `file:` 说明符能指回仓库内 SDK 检出，检出已装依赖时优先用它。
 * 外部脚手架（npm 发布的 SDK）没有 file: 说明符，走 SDK 自带 dev-shell 自行安装。
 */
function resolveDevShellDir(pluginDir) {
  const bundled = join(SDK_ROOT, 'dev-shell')
  const installed = (dir) => existsSync(join(dir, DEV_SHELL_VITE))
  if (installed(bundled)) return bundled
  // 尽力探测：读不到就退回自带 dev-shell，缺失时由调用方报错（此处不能用 readJson，
  // 它遇解析失败直接 process.exit，会把 doctor 这类自检命令一起带走）
  const readPkg = (path) => JSON.parse(readFileSync(path, 'utf-8'))
  try {
    const sdkName = readPkg(join(SDK_ROOT, 'package.json')).name
    const deps = readPkg(join(pluginDir, 'package.json'))
    const spec = deps.dependencies?.[sdkName] ?? deps.devDependencies?.[sdkName]
    if (typeof spec === 'string' && spec.startsWith('file:')) {
      const checkout = join(resolve(pluginDir, spec.slice('file:'.length)), 'dev-shell')
      if (installed(checkout)) return checkout
    }
  } catch {
    // 忽略：非 file: 依赖（npm 发布包）或读不到说明符
  }
  return bundled
}

/** 递归收集目录下所有文件 */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** 判断文件是否为文本（含 NUL 字节视为二进制，跳过占位符替换） */
function isText(file) {
  const buf = readFileSync(file)
  return !buf.includes(0)
}

/** 递归替换文件中的占位符 */
function fillPlaceholders(files, repl) {
  for (const file of files) {
    if (!isText(file)) continue
    let content = readFileSync(file, 'utf-8')
    let changed = false
    for (const [key, value] of Object.entries(repl)) {
      if (content.includes(key)) {
        content = content.split(key).join(value)
        changed = true
      }
    }
    if (changed) writeFileSync(file, content, 'utf-8')
  }
}

/** 复制目录内容（不含顶层目录本身） */
function copyDirContents(src, dest) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true })
      copyDirContents(from, to)
    } else {
      copyFileSync(from, to)
    }
  }
}

// ==================== ZIP 打包（store 模式，零依赖） ====================

/** 构造 store 模式 zip 字节流 */
function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0

  // DOS 时间戳（本地时间）
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8')
    const data = entry.data
    const crc = crc32(data) >>> 0

    // 本地文件头
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0) // signature
    lh.writeUInt16LE(20, 4) // version needed
    lh.writeUInt16LE(0, 6) // flags
    lh.writeUInt16LE(0, 8) // method: store
    lh.writeUInt16LE(dosTime, 10)
    lh.writeUInt16LE(dosDate, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18) // compressed size
    lh.writeUInt32LE(data.length, 22) // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28) // extra len
    chunks.push(lh, nameBuf, data)

    // 中央目录项
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0) // signature
    ch.writeUInt16LE(20, 4) // version made by
    ch.writeUInt16LE(20, 6) // version needed
    ch.writeUInt16LE(0, 8) // flags
    ch.writeUInt16LE(0, 10) // method
    ch.writeUInt16LE(dosTime, 12)
    ch.writeUInt16LE(dosDate, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt16LE(0, 30) // extra len
    ch.writeUInt16LE(0, 32) // comment len
    ch.writeUInt16LE(0, 34) // disk start
    ch.writeUInt16LE(0, 36) // internal attrs
    ch.writeUInt32LE(0, 38) // external attrs
    ch.writeUInt32LE(offset, 42) // local header offset
    central.push(ch, nameBuf)

    offset += lh.length + nameBuf.length + data.length
  }

  const centralSize = central.reduce((sum, b) => sum + b.length, 0)

  // 中央目录结束记录
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // signature
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // cd start disk
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment len

  return Buffer.concat([...chunks, ...central, eocd])
}


function findViteBin(startDir) {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules/vite/bin/vite.js')
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}


export {
  SDK_ROOT,
  TEMPLATE_DIR,
  COMPONENTIZE_CANDIDATES,
  DEV_SHELL_VITE,
  resolveComponentizeManifest,
  parseArgs,
  toPosix,
  readJson,
  run,
  resolveCargoTargetDir,
  resolveWasmPath,
  resolveDevShellDir,
  walk,
  fillPlaceholders,
  copyDirContents,
  buildZip,
  findViteBin,
}
