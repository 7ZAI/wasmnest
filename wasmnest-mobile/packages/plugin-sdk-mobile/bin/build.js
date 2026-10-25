/**
 * wasmnest-plugin 构建命令：dev / build（含 watch）（自 cli.js 拆出）
 */
import { copyFileSync, existsSync, mkdirSync, watch } from "node:fs"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { generateManifest } from "./manifest-gen.js"
import { resolveComponentizeManifest, resolveCargoTargetDir, resolveWasmPath, resolveDevShellDir, copyDirContents, readJson, run, toPosix } from "./lib.js"

// ==================== 命令：dev（浏览器开发环境） ====================

/** 启动 dev-shell：缺依赖时自动安装，然后以长驻 vite 进程运行 */
function cmdDev(positional, flags) {
  const cwd = process.cwd()
  const pluginDir = resolve(cwd, positional[0] || '.')
  const entry = flags.entry ? resolve(cwd, flags.entry) : resolve(pluginDir, 'src/index.ts')

  if (!existsSync(join(pluginDir, 'plugin.json')) && !existsSync(entry)) {
    console.error(`[wasmnest-plugin] 目标不是插件工程（缺少 plugin.json 与 ${entry}）: ${pluginDir}`)
    console.error('用法: wasmnest-plugin dev [pluginDir] [--entry <file>] [--port <port>] [--open]')
    process.exit(1)
  }

  const devShellDir = resolveDevShellDir(pluginDir)
  if (!existsSync(devShellDir)) {
    console.error(`[wasmnest-plugin] dev-shell 不存在: ${devShellDir}（SDK 包不完整）`)
    process.exit(1)
  }

  // dev-shell 首次运行需要安装自身依赖（vue / vite / tailwind 等）。
  // 不加任何 pnpm 参数：dev-shell 自带 pnpm-workspace.yaml（packages: - .）既锚定安装
  // 目录又是 allowBuilds 白名单的载体，而 --ignore-workspace 会连白名单一起忽略，
  // 导致依赖构建脚本被跳过、pnpm 以 ERR_PNPM_IGNORED_BUILDS 非零退出（pnpm 12 已无
  // --no-audit / --no-fund，传了直接报未知参数）
  const viteBin = join(devShellDir, DEV_SHELL_VITE)
  if (!existsSync(viteBin)) {
    console.log('[wasmnest-plugin] dev-shell 依赖缺失，正在安装（仅首次）…')
    run('pnpm', ['install'], devShellDir)
  }

  const args = [
    viteBin,
    '--config',
    join(devShellDir, 'vite.config.ts'),
    '--port',
    String(flags.port || 5173),
    // --force：依赖预构建缓存（dev-shell/node_modules/.vite）会残留插件改名 / 搬目录前的
    // 绝对路径，vite 重跑优化器时读到即ENOENT，且只对前端返 504、页面空白且不自愈；
    // 强制忽略缓存重建是唯一自愈手段（dev-shell 启动成本可接受）
    '--force',
  ]
  // --host：监听局域网（vite 默认仅 localhost），手机浏览器可访问查看页面
  if (flags.host) args.push('--host', typeof flags.host === 'string' ? flags.host : '0.0.0.0')
  if (flags.open) args.push('--open')

  console.log(`[wasmnest-plugin] 启动 dev-shell（插件: ${pluginDir}）`)
  if (flags.host) {
    console.log(
      `[wasmnest-plugin] 已监听局域网 — 手机与电脑同一 WiFi 时，手机浏览器打开 http://<电脑IP>:${flags.port || 5173}/ 查看（建议关掉手机框开关）`,
    )
  }
  console.log(
    `[wasmnest-plugin] 浏览器打开 http://localhost:${flags.port || 5173}/ 预览（Ctrl+C 退出）`,
  )
  const child = spawn(process.execPath, args, {
    cwd: devShellDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      WASMNEST_DEV_PLUGINS: `${pluginDir}::${entry}`,
    },
  })
  child.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}


// ==================== 命令：build（watch 模式） ====================

/**
 * watch 模式：vite build --watch 长驻构建前端，重建完成后自动复制产物到宿主资源目录。
 *
 * 只 watch 前端：WASM 产物不参与（已构建时随复制一并带上；Rust 改动需一次性 `wasmnest-plugin build`）。
 */
function startBuildWatch(cwd, resourcesDir, manifest) {
  const { id, main = 'index.js', rustLibrary, pluginType } = manifest
  // 形态三档（wasmnest-apps#21）：backend / full 都携带 wasm 后端
  const hasWasm = (pluginType === 'full' || pluginType === 'backend') && rustLibrary
  const viteBin = findViteBin(cwd)
  if (!viteBin) {
    console.error(
      '[wasmnest-plugin] vite 未找到（自插件目录向上查找 node_modules/vite 均无）— 先在插件目录或仓库根运行 pnpm install',
    )
    process.exit(1)
  }

  const dest = join(resolve(cwd, resourcesDir), id)
  const distDir = join(cwd, 'dist')
  const wasmPath = hasWasm ? resolveWasmPath(cwd, rustLibrary) : null

  console.log('\n[wasmnest-plugin] ====== watch 前端构建（vite build --watch） ======')
  console.log(`[wasmnest-plugin] 产物自动复制到: ${dest}`)
  console.log(
    '[wasmnest-plugin] 修改插件前端源码后自动重建 + 复制（WASM 改动需一次性 pnpm run build）',
  )
  console.log('[wasmnest-plugin] Ctrl+C 退出\n')

  // WASM 缺失预检：全新 resources 目录（从未跑过全量 build）时，复制完成后插件
  // 加载仍会因缺 .wasm 失败，提前给出可执行指引
  if (hasWasm && !existsSync(wasmPath)) {
    console.warn(`[wasmnest-plugin] ⚠ WASM 产物缺失：${wasmPath}`)
    console.warn('[wasmnest-plugin]   watch 只重建前端。首次请先执行一次全量构建：')
    console.warn('[wasmnest-plugin]   pnpm run build（含 cargo wasm32 构建）')
  }

  // 长驻 vite watch 构建（首次启动即完整构建一次）
  const child = spawn(process.execPath, [viteBin, 'build', '--watch'], { cwd, stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))

  // 复制产物到宿主资源目录（覆盖式，不删目录：宿主运行时可能正持有文件句柄）
  const copy = () => {
    try {
      if (!existsSync(join(distDir, main))) return
      mkdirSync(dest, { recursive: true })
      copyDirContents(distDir, dest)
      copyFileSync(join(cwd, 'plugin.json'), join(dest, 'plugin.json'))
      // 插件图标（PluginIcon 经 asset protocol 加载 icon.svg）
      const iconSrc = join(cwd, 'icon.svg')
      if (existsSync(iconSrc)) copyFileSync(iconSrc, join(dest, 'icon.svg'))
      // WASM 已构建则一并带上（缺失不报错：watch 场景以前端热更为主）
      if (hasWasm && wasmPath && existsSync(wasmPath)) {
        copyFileSync(wasmPath, join(dest, `${rustLibrary}.wasm`))
      }
      console.log(`[wasmnest-plugin] ${new Date().toLocaleTimeString()} 产物已复制 → ${dest}`)
    } catch (e) {
      console.error(`[wasmnest-plugin] 复制失败: ${e.message}`)
    }
  }

  // dist 任意文件事件都防抖复制（Windows 上 fs.watch 的 filename 常为 null，按时间聚合最稳）
  let timer = null
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(copy, 500)
  }

  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true })
  const watcher = watch(distDir, { persistent: true }, schedule)
  watcher.on('error', (e) => console.error(`[wasmnest-plugin] dist 监听错误: ${e.message}`))
}

// ==================== 命令：build ====================

function cmdBuild(flags) {
  const cwd = process.cwd()
  const manifestPath = join(cwd, 'plugin.json')
  if (!existsSync(manifestPath)) {
    console.error(`[wasmnest-plugin] 当前目录不是插件工程（缺少 plugin.json）: ${cwd}`)
    console.error('请在插件目录内运行，或先用 wasmnest-plugin create 生成工程')
    process.exit(1)
  }
  const manifest = readJson(manifestPath, 'plugin.json')
  const { id, main, rustLibrary, pluginType } = manifest
  // 形态三档（wasmnest-apps#21）：backend / full 都携带 wasm 后端
  const hasWasm = (pluginType === 'full' || pluginType === 'backend') && rustLibrary
  const frontendOnly = flags['frontend-only'] === true
  const rustOnly = flags['rust-only'] === true
  const resourcesDir = flags['resources-dir']

  // 0. 根据源码自动填充 contributes/permissions（构建前同步，保证产物与源码一致）
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

  // 0.5 watch 模式：vite 长驻构建 + 产物变化自动复制（需 --resources-dir 指定复制目标）
  if (flags.watch) {
    if (!resourcesDir) {
      console.error(
        '[wasmnest-plugin] --watch 需要 --resources-dir <宿主资源目录>（前端产物复制目标）',
      )
      process.exit(1)
    }
    startBuildWatch(cwd, resourcesDir, manifest)
    return
  }

  const distMain = join(cwd, 'dist', main || 'index.js')
  const wasmPath = hasWasm ? resolveWasmPath(cwd, rustLibrary) : null

  // 1. 前端构建
  if (!rustOnly) {
    const viteBin = join(cwd, 'node_modules/vite/bin/vite.js')
    if (!existsSync(viteBin)) {
      console.error(`[wasmnest-plugin] vite 未安装 — 先在插件目录运行 pnpm install`)
      process.exit(1)
    }
    console.log('\n[wasmnest-plugin] ====== 构建前端 (vite) ======')
    run(process.execPath, [viteBin, 'build'], cwd)
    if (!existsSync(distMain)) {
      console.error(`[wasmnest-plugin] vite 构建未产出 dist/${main || 'index.js'}`)
      process.exit(1)
    }
  }

  // 2. WASM 构建
  if (hasWasm && !frontendOnly) {
    console.log('\n[wasmnest-plugin] ====== 构建 WASM (cargo) ======')
    run(
      'cargo',
      [
        'build',
        '--target',
        'wasm32-unknown-unknown',
        '--no-default-features',
        '--features',
        'wasm',
        '--manifest-path',
        'rust/Cargo.toml',
        '--release',
      ],
      cwd,
    )
    if (!existsSync(wasmPath)) {
      console.error(`[wasmnest-plugin] WASM 构建未产出 ${rustLibrary}.wasm`)
      console.error('  若提示 target 缺失: rustup target add wasm32-unknown-unknown')
      process.exit(1)
    }

    // 组件化：将 wit-bindgen 产出的 core module（含 component-type 自定义段）
    // 编码为 Component Model 组件（等价 wasm-tools component new）。
    // 工具幂等——产物已是组件（0d 00 01 00）时直接复制，支持增量构建。
    // 迁移 spec §4 S2：产物字节形态 `00 61 73 6d 0d 00 01 00`（模块段在组件头前）
    // 工具随桌面 SDK 发布（`tools/componentize`；P1 起从平台仓级 `tools/` 迁入；file-transfer
    // 单产物后双端共用同一编码路径，2026-10-13 自 SDK rust/tools/ 提升）
    console.log('\n[wasmnest-plugin] ====== 组件化 WASM (Component Model) ======')
    const componentizeManifest = resolveComponentizeManifest(cwd)
    run(
      'cargo',
      ['run', '--release', '--manifest-path', componentizeManifest, '--', wasmPath, '-o', wasmPath],
      cwd,
    )
  }

  // 3. 复制产物到宿主资源目录（--resources-dir <父目录>，按插件 id 建子目录）
  if (resourcesDir) {
    const dest = join(resolve(cwd, resourcesDir), id)
    mkdirSync(dest, { recursive: true })
    copyDirContents(join(cwd, 'dist'), dest)
    copyFileSync(manifestPath, join(dest, 'plugin.json'))
    // 插件图标（PluginIcon 经 asset protocol 加载 icon.svg）
    const iconSrc = join(cwd, 'icon.svg')
    if (existsSync(iconSrc)) copyFileSync(iconSrc, join(dest, 'icon.svg'))
    if (hasWasm && !frontendOnly) {
      copyFileSync(wasmPath, join(dest, `${rustLibrary}.wasm`))
    }
    console.log(`\n[wasmnest-plugin] 产物已复制到: ${dest}`)
  }

  console.log('\n[wasmnest-plugin] 构建完成')
}


export { cmdDev, cmdBuild }
