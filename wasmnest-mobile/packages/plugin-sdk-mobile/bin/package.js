/**
 * wasmnest-plugin 打包与自检命令：package / doctor（自 cli.js 拆出）
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { generateManifest } from "./manifest-gen.js"
import { SDK_ROOT, DEV_SHELL_VITE, resolveWasmPath, resolveDevShellDir, buildZip, readJson, toPosix } from "./lib.js"

// ==================== 命令：package ====================

function cmdPackage(flags) {
  const cwd = process.cwd()
  const manifestPath = join(cwd, 'plugin.json')
  if (!existsSync(manifestPath)) {
    console.error(`[wasmnest-plugin] 当前目录不是插件工程（缺少 plugin.json）: ${cwd}`)
    process.exit(1)
  }
  const manifest = readJson(manifestPath, 'plugin.json')
  const { id, main, rustLibrary, pluginType } = manifest
  const hasWasm = pluginType === 'wasm' && rustLibrary

  // 打包前自动填充，保证 zip 内 plugin.json 与源码一致
  try {
    const { changed, report } = generateManifest(cwd)
    if (changed) {
      for (const line of report) console.log(`[wasmnest-plugin]   ${line}`)
      console.log('[wasmnest-plugin] plugin.json 已自动填充')
    }
  } catch (e) {
    console.error(`[wasmnest-plugin] manifest 自动填充失败: ${e.message}`)
    process.exit(1)
  }

  const distDir = join(cwd, 'dist')
  const distMain = join(distDir, main || 'index.js')
  const wasmPath = hasWasm ? resolveWasmPath(cwd, rustLibrary) : null

  if (!existsSync(distMain)) {
    console.error(`[wasmnest-plugin] dist/${main || 'index.js'} 缺失 — 先运行 pnpm run build`)
    process.exit(1)
  }
  if (hasWasm && !existsSync(wasmPath)) {
    console.error(`[wasmnest-plugin] ${rustLibrary}.wasm 缺失 — 先运行 pnpm run build`)
    process.exit(1)
  }

  // --hash：计算 WASM SHA256 写入 plugin.json（安装时宿主按 wasmHash 校验完整性）
  if (hasWasm && flags.hash) {
    const hash = `sha256-${createHash('sha256').update(readFileSync(wasmPath)).digest('hex')}`
    const current = readJson(manifestPath, 'plugin.json')
    if (current.wasmHash !== hash) {
      current.wasmHash = hash
      writeFileSync(manifestPath, JSON.stringify(current, null, 2) + '\n', 'utf-8')
      console.log(`[wasmnest-plugin] 已写入 wasmHash: ${hash.slice(0, 20)}…`)
    }
  }

  // 打包条目：plugin.json + dist 全部产物 + wasm，全部位于 zip 根目录
  const entries = [{ name: 'plugin.json', data: readFileSync(manifestPath) }]
  for (const f of readdirSync(distDir)) {
    const full = join(distDir, f)
    if (statSync(full).isFile()) entries.push({ name: f, data: readFileSync(full) })
  }
  if (hasWasm) entries.push({ name: `${rustLibrary}.wasm`, data: readFileSync(wasmPath) })

  const outFile = flags.o ? resolve(cwd, flags.o) : join(distDir, `${id}.zip`)
  writeFileSync(outFile, buildZip(entries))

  console.log(`\n[wasmnest-plugin] 已打包 ${entries.length} 个文件 -> ${outFile}`)
}


// ==================== 命令：doctor（环境自检） ====================

function cmdDoctor() {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })

  // Node 版本
  const nodeMajor = Number(process.versions.node.split('.')[0])
  add('Node.js >= 20', nodeMajor >= 20, process.version)

  // Rust + wasm32 target
  let rustOk = false
  let rustDetail = '未安装'
  try {
    const r = spawnSync('cargo', ['--version'], { stdio: 'pipe' })
    if (r.status === 0) {
      rustOk = true
      rustDetail = r.stdout.toString().trim()
    }
  } catch {
    // 未安装
  }
  add('Rust (cargo)', rustOk, rustDetail)
  if (rustOk) {
    const t = spawnSync('rustup', ['target', 'list', '--installed'], { stdio: 'pipe' })
    const hasWasm = t.status === 0 && t.stdout.toString().includes('wasm32-unknown-unknown')
    add(
      'wasm32-unknown-unknown target',
      hasWasm,
      hasWasm ? '已安装' : '缺失 — 运行 rustup target add wasm32-unknown-unknown',
    )
  } else {
    add('wasm32-unknown-unknown target', false, '需先安装 Rust')
  }

  // 当前目录是否为插件工程
  const manifestPath = join(process.cwd(), 'plugin.json')
  if (existsSync(manifestPath)) {
    try {
      const m = readJson(manifestPath, 'plugin.json')
      add('当前目录是插件工程', true, `${m.id} (${m.pluginType})`)
    } catch {
      add('当前目录是插件工程', false, 'plugin.json 解析失败')
    }
  } else {
    add('当前目录是插件工程', false, '缺少 plugin.json — 在插件目录内运行本命令时检查才有意义')
  }

  // dev-shell 依赖（dev 命令就绪性）
  const devShellVite = join(resolveDevShellDir(process.cwd()), DEV_SHELL_VITE)
  add(
    'dev-shell 依赖（dev 命令）',
    existsSync(devShellVite),
    existsSync(devShellVite) ? '已安装' : '首次运行 dev 命令时自动安装',
  )

  // SDK dist（file: 依赖的插件需要）
  const sdkDist = join(SDK_ROOT, 'dist/index.js')
  add(
    'SDK 构建产物（file: 依赖）',
    existsSync(sdkDist),
    existsSync(sdkDist) ? '已构建' : '缺失 — 运行 pnpm run build（SDK 目录内）',
  )

  let failed = 0
  for (const c of checks) {
    const icon = c.ok ? '✓' : '✗'
    if (!c.ok) failed++
    console.log(`  ${icon} ${c.name} — ${c.detail}`)
  }
  console.log(`\n[wasmnest-plugin] doctor 完成: ${checks.length - failed}/${checks.length} 通过`)
  if (failed) process.exit(1)
}


export { cmdPackage, cmdDoctor }
