#!/usr/bin/env node
/**
 * Dev Runner — 并行启动插件前端 watch 构建与宿主 dev 命令
 * `pnpm run tauri:dev` 一条命令即完成：
 *   - 插件产物预检（`./plugin-precheck.js`，裸 `tauri dev` 经 beforeDevCommand 同样执行）：
 *     WASM 缺失/陈旧补建 + 前端挂载包陈旧预重建，一律 `--out` **直写宿主 resources**
 *     （不经 --out 只写应用仓 .build/plugins，resources 不更新 = 宿主加载旧产物）；
 *     产物 plugin.json 摘要基线对齐 + 退役目录清理，全幂等
 *   - 宿主 dev 进程（tauri dev）——先启动
 *   - 各插件前端 watch：改源码自动重建 + 复制产物（配合宿主 PluginDevWatcher 触发前端热重载）
 *     ——等宿主首次构建完成后启动，见下方「首次构建门控」
 * 任一子进程退出（Ctrl+C / 宿主崩溃）时统一回收全部。
 *
 * 用法：
 *   node scripts/dev-run.js              # 默认：六个插件（4 apps + 2 servers）watch + tauri dev
 *   node scripts/dev-run.js --host-cmd "<命令>"   # 覆盖宿主命令（按空格拆分）
 *   node scripts/dev-run.js --no-watch   # 不起插件前端 watch（默认开启，行为不变）
 *
 * 首次构建门控（2026-10-13 加固）：宿主先启动，插件前端 watch 等宿主输出出现 cargo
 * `Finished `dev` profile`（兜底 `Running `target/debug/...``）后再启动。原因：watch 首次
 * vite 构建会把产物复制进 `src-tauri/resources/plugins/desktop/<id>/`，而 `tauri dev` 的
 * file watch 覆盖整个 `src-tauri/`，每次复制都触发 Tauri「Rebuilding application...」重启
 * DevCommand。宿主冷构建（首次 / 大依赖变更 / cargo clean 后，wasmtime 等分钟级）期间复制
 * = 上一轮 rustc 与重启后的构建重叠、同写 `target/debug/deps/*.rcgu.o`：先完成者归档后清理
 * 中间文件，另一进程归档即 `failed to build archive ... failed to open object file`（cargo
 * 不落 fingerprint，报错会反复出现、重跑才恢复）。`--host-cmd` 定制命令不保证有 cargo 输出、
 * 无法可靠判据，跳过门控（保持旧的立即启动）。
 *
 * `--no-watch` 的存在理由：插件 watch 会把 vite 产物复制进
 * `src-tauri/resources/plugins/desktop/<id>/`，而 `tauri dev` 的 file watch 覆盖整个
 * `src-tauri/`——于是**每次插件前端重建都会重启一次宿主 app 并清空当日日志**。
 * 需要在稳定 app 上连续观察的场景（票 01 桌面功能等价人工基线：十项清单要一口气走完）
 * 用这条把该重启源关掉；产物已由启动前的一次性预检保证不缺（ensurePluginWasm 仍跑）。
 */

import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, createWriteStream, mkdirSync } from 'node:fs'
import net from 'node:net'
import { resolve, basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appDir, hasAppDir } from '../../scripts/app-paths.mjs'
// 插件产物预检（wasm/前端陈旧补建 + 清单基线 + 退役清理）抽为共享模块：
// 裸 `tauri dev` 经 tauri.conf.json beforeDevCommand 同样执行（幂等，双路径相遇秒过）
import { PLUGIN_WATCH_CMDS, runPluginPrecheck } from './plugin-precheck.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')
const IS_WIN = process.platform === 'win32'

// ==================== 端口预检 ====================

/**
 * 宿主 beforeDevCommand（vite dev server）端口预检。
 *
 * tauri dev 启动时自动运行 beforeDevCommand（npm run dev → vite），若端口被残留进程
 * 占用（常见于上次 dev 会话 Ctrl+C 后 vite 未退出），宿主启动必失败且表现像卡死
 * （无提示等待 → “Port is already in use” 报错）。此处提前检测并给出明确指引。
 */
async function precheckDevPort() {
  let devUrl = null
  try {
    const conf = JSON.parse(readFileSync(resolve(ROOT, 'src-tauri/tauri.conf.json'), 'utf-8'))
    devUrl = conf?.build?.devUrl
  } catch {
    return // 读取配置失败不阻塞（预检是防御性的）
  }
  if (!devUrl) return

  let port = 0
  try {
    port = Number(new URL(devUrl).port)
  } catch {
    return
  }
  if (!port) return

  // 尝试监听：成功 = 空闲；失败（EADDRINUSE）= 被占用。
  // 占用者监听 0.0.0.0 时绑定 127.0.0.1 同样会冲突，覆盖两种监听方式
  const inUse = await new Promise((resolve_) => {
    const srv = net.createServer()
    srv.once('error', () => resolve_(true))
    srv.once('listening', () => srv.close(() => resolve_(false)))
    srv.listen(port, '127.0.0.1')
  })
  if (!inUse) return

  console.error(
    `[dev-run] ⚠ 端口 ${port}（${devUrl}，宿主 beforeDevCommand vite dev server）已被占用`,
  )
  console.error(
    '[dev-run]   通常是上次 dev 会话残留的 vite 进程，宿主启动必失败。请先结束占用进程：',
  )
  console.error(`[dev-run]   netstat -ano | findstr :${port}   然后   taskkill /F /PID <pid>`)
  process.exit(1)
}

/**
 * HMR 端口预检（仅局域网模式）。
 *
 * 设置了 TAURI_DEV_HOST 时 vite 监听 0.0.0.0:1420，HMR WebSocket 走独立端口 1421
 * （见 vite.config.ts server.hmr）。若 1421 被其他进程/残留 dev 会话占用，页面可正常
 * 加载（1420 通）但热更新静默失效——最隐蔽的“改代码不刷新”。仅检测不阻断：
 * 占用者可能是另一个正在运行的 dev 会话（本就该共存），此时提示排查方向即可。
 */
async function precheckHmrPort() {
  if (!process.env.TAURI_DEV_HOST) return
  const port = 1421

  const inUse = await new Promise((resolve_) => {
    const srv = net.createServer()
    srv.once('error', () => resolve_(true))
    srv.once('listening', () => srv.close(() => resolve_(false)))
    srv.listen(port, '127.0.0.1')
  })
  if (!inUse) return

  console.warn(
    `[dev-run] ⚠ 检测到 TAURI_DEV_HOST=${process.env.TAURI_DEV_HOST}（局域网模式），但 HMR 端口 ${port} 已被占用`,
  )
  console.warn(
    '[dev-run]   页面可正常加载但热更新会失效（改代码不刷新）。占用者通常是残留 dev 会话：',
  )
  console.warn(`[dev-run]   netstat -ano | findstr :${port}   然后   taskkill /F /PID <pid>`)
  console.warn(
    '[dev-run]   若不再需要局域网调试，删除环境变量后重启 dev 即回到本机模式（HMR 同端口 1420）',
  )
}

// 包管理器 CLI 绝对路径：优先取 pnpm 注入的 pnpm_execpath（pnpm 运行生命周期脚本时
// 同时设置 npm_execpath / pnpm_execpath，任何安装布局下都正确）；回退到 npm_execpath
// （仍以 npm 安装/调用时临时兼容）；最后退回 Windows Node 安装器标准布局
// （node.exe 与 node_modules/npm 同目录）——Linux/macOS 的 npm 在系统目录
// （/usr/lib/node_modules/npm 等），与 node 二进制不同目录，故不能只用回退路径
const PKG_MGR_CLI =
  process.env.pnpm_execpath ??
  process.env.npm_execpath ??
  resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')

/** 宿主 dev 命令（可用 --host-cmd 覆盖）
 *
 * 直接 spawn 包管理器 CLI（pnpm/npm）作为命令入口——ELF/可执行文件自带
 * shebang 或自身就是解释器（pnpm 12+ 是单文件 ELF），无需 node 套壳。
 * 历史误写成 `[process.execPath, [PKG_MGR_CLI, ...]]` 会让 node 把 pnpm ELF
 * 当 JS 加载，在 Node 24 下抛 `SyntaxError: Invalid or unexpected token`（pnpm:1 ELF>...）。
 * 注意 pnpm 12 会把 `run tauri -- dev` 中的 `--` 原样透传给 tauri CLI，
 * 导致 `tauri -- dev` 报 unexpected argument——因此不能加 `--` 分隔符。
 */
const DEFAULT_HOST_CMD = [PKG_MGR_CLI, ['run', 'tauri', 'dev']]

// ==================== 进程管理 ====================

const children = []
let shuttingDown = false

/**
 * dev 会话输出落盘（tee）：宿主/webview console（Tauri dev 转发到 stdout）不写入
 * 其他日志文件——插件前端裸 `console.*` 排障时只在这里可见。统一追加写入
 * `.dev-logs/dev-run.YYYY-MM-DD.log`（已被 .gitignore 忽略），控制台输出行为不变。
 */
function openDevLog() {
  try {
    const dir = resolve(ROOT, '.dev-logs')
    mkdirSync(dir, { recursive: true })
    const d = new Date()
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`
    return createWriteStream(resolve(dir, `dev-run.${stamp}.log`), { flags: 'a' })
  } catch {
    // 落盘失败不影响 dev 启动（仅失去可回读能力）
    return null
  }
}

const devLog = openDevLog()

function start(cmd, args, cwd, onOutput) {
  // POSIX：detached 让子进程自成进程组长（pgid = 自己的 pid），shutdown 时可用
  // 负 pgid 一次杀整棵子树（已实测：孙进程自动继承该 pgid，无需各自 detached）。
  // Windows 必须排除：detached 会传 CREATE_NEW_CONSOLE 弹出额外控制台窗口，
  // Windows 侧走下方 taskkill /T /F 分支
  //
  // stdio 用管道而非 inherit：既保持控制台输出（手动转发），又同时落盘排障日志
  const child = spawn(cmd, args, { cwd, stdio: ['inherit', 'pipe', 'pipe'], detached: !IS_WIN })
  for (const [stream, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    stream?.on('data', (chunk) => {
      target.write(chunk)
      devLog?.write(chunk)
      // 门控按 chunk 消费宿主输出（stdout/stderr 都走这里：cargo 构建进度在 stderr）
      onOutput?.(chunk)
    })
  }
  children.push(child)
  return child
}

// ==================== 宿主首次构建门控（2026-10-13） ====================

/**
 * 等宿主输出里出现 cargo「构建完成」标记后回调一次（仅一次）。
 *
 * 判据先去掉 `--color always` 的 ANSI 控制序列（颜色 CSI + cargo `Finished` 行里指向文档的
 * OSC 8 超链接）；标记可能被 chunk 切断，保留尾部窗口拼接：
 *   - `Finished `dev` profile`：cargo 构建完成（正常路径）
 *   - `Running `target/debug/...``：cargo run 启动二进制（兜底，防 cargo 文案变化）
 *
 * 背景与必要性见文件头「首次构建门控」段。宿主命令由 `--host-cmd` 覆盖时输出不保证
 * 含上述标记，调用方直接跳过门控；触发时若会话已在回收（shuttingDown），
 * 由 startPluginWatches 自行短路。
 */
function createHostBuildGate(onReady) {
  let ready = false
  let tail = ''
  return {
    onOutput(chunk) {
      if (ready || shuttingDown) return
      const text = chunk
        .toString()
        // 去 ANSI：OSC（cargo 的 Finished 行里带指向文档的 OSC 8 超链接）+ CSI（颜色/光标）
        .replace(/\u001b\][^\u001b\u0007]*(?:\u0007|\u001b\\)/g, '')
        .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
      tail = (tail + text).slice(-4096)
      if (/Finished\s+`dev`\s+profile/.test(tail) || /Running\s+`target\/debug\//.test(tail)) {
        ready = true
        onReady()
      }
    },
  }
}

/** 回收所有子进程并退出（防重入：kill 触发的 exit 不再进入 shutdown） */
function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  const exitCode = code ?? 0

  if (IS_WIN) {
    // Windows：child.kill() 只杀直接子进程，且 process.exit 可能先于信号送达；
    // 插件 watch 的孙进程（vite）会孤儿化残留。taskkill /T /F 杀整个进程树
    for (const c of children) {
      if (c.pid) {
        try {
          execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
          // 已退出，忽略
        }
      }
    }
    process.exit(exitCode)
  }

  // POSIX：按进程组回收整棵子树（对齐 Windows taskkill /T /F）
  //
  // 负 pgid 一次覆盖组长及其全部子孙——build.js 的 vite 孙进程、宿主的 tauri
  // CLI / cargo / 宿主进程 / vite dev server 全部在内。这是 plugin-watch.js 自清理
  // （应用层）在调度层的对称实现，覆盖「宿主崩溃、关闭终端标签/窗口、外部 kill」
  // 等信号无法送达孙进程的路径；此前这些路径会残留 vite（实测累积到 3 个、数十 MB、
  // 数小时不退出）以及宿主 vite dev server 占住 1420 端口
  for (const c of children) {
    if (!c.pid) continue
    try {
      process.kill(-c.pid, 'SIGTERM')
    } catch {
      // 已退出或不是组长（detached 未生效），退回单进程 kill
      try {
        c.kill('SIGTERM')
      } catch {
        // 已退出，忽略
      }
    }
  }

  // 等 direct children 退出即可（子树内其他进程由组信号覆盖，无需逐个等待）
  const alive = children.filter((c) => c.exitCode === null)
  if (alive.length === 0) {
    process.exit(exitCode)
    return
  }
  for (const c of alive) {
    c.on('exit', () => {
      if (children.every((x) => x.exitCode !== null)) process.exit(exitCode)
    })
  }

  // 升级兜底：2 秒后对组发 SIGKILL 并退出。plugin-watch.js 自身的升级链是 1500ms，
  // 早于此处，两者不冲突；unref 避免子进程全部退出后阻塞退出
  setTimeout(() => {
    for (const c of children) {
      if (!c.pid) continue
      try {
        process.kill(-c.pid, 'SIGKILL')
      } catch {
        // 已退出，忽略
      }
    }
    process.exit(exitCode)
  }, 2000).unref()
}


// ==================== 启动 ====================

// 解析 --host-cmd 覆盖（测试/定制用）
const hostIdx = process.argv.indexOf('--host-cmd')
const hostOverride = hostIdx !== -1 && process.argv[hostIdx + 1] ? process.argv[hostIdx + 1] : null
const [hostBin, ...hostArgs] = hostOverride ? hostOverride.split(' ') : DEFAULT_HOST_CMD[1]
const hostCmd = hostOverride ? [hostBin, hostArgs] : DEFAULT_HOST_CMD

// 插件前端 watch 开关（默认开启 = 原行为）；见文件头 `--no-watch` 那段的理由
const noWatch = process.argv.includes('--no-watch')

// 0. 宿主 devUrl 端口预检（被残留 vite 占用时提前报错，避免“执行不动”假象）
//    + HMR 端口预检（仅 TAURI_DEV_HOST 局域网模式，防“页面正常但热更失效”隐蔽坑）
await precheckDevPort()
await precheckHmrPort()

// 1. 插件产物预检（WASM 补建 → 前端预重建 → 清单基线 → 退役清理，幂等）：
//    与裸 `tauri dev`（beforeDevCommand）共用 plugin-precheck.mjs，双路径相遇时第二遍秒过
runPluginPrecheck()

/**
 * 启动全部插件前端 watch。
 * 插件目录可能被临时移除（停用/排查）：缺失时跳过而非 fail-fast 整组回收，
 * 否则单个插件下线会连带杀死宿主 dev 会话。
 */
function startPluginWatches() {
  if (shuttingDown) return
  for (const { group, slug, args, skipWatch } of PLUGIN_WATCH_CMDS) {
    // bedcode：dev 期跳过前端 watch（整包构建最重且每次写入都触发宿主重启，
    // 理由见 PLUGIN_WATCH_CMDS 条目注释）——跳过而非保持死链
    if (skipWatch) {
      console.log(`[dev-run] 跳过前端 watch：${slug}（前端已并入宿主 vite）`)
      continue
    }
    if (!hasAppDir(slug, 'desktop', { group })) {
      console.warn(`[dev-run] 应用目录不存在，跳过 watch：${slug}`)
      continue
    }
    const child = start(process.execPath, args, appDir(slug, 'desktop', { group }))
    // 插件 watch 异常退出 → 整组回收（fail fast，避免宿主运行在过期产物上）
    child.on('exit', (code) => {
      if (!shuttingDown) {
        console.error(`[dev-run] 插件 watch 退出（${slug}, code=${code}），回收全部进程`)
        shutdown(code ?? 0)
      }
    })
  }
}

// 2. 宿主 dev 进程（先启动；默认路径下由它的首次构建完成信号触发插件 watch）
//    --no-watch：不起 watch，无需门控；--host-cmd：定制命令无 cargo 标记，跳过门控
const watchGate = (noWatch || hostOverride)
  ? null
  : createHostBuildGate(() => {
      console.log('[dev-run] 宿主首次构建完成，启动插件前端 watch')
      startPluginWatches()
    })
const host = start(hostCmd[0], hostCmd[1], ROOT, watchGate?.onOutput)
host.on('exit', (code) => {
  if (!shuttingDown) {
    console.log(`[dev-run] 宿主 dev 退出（code=${code}），回收插件 watch`)
    shutdown(code ?? 0)
  }
})

// 3. 插件前端 watch
if (noWatch) {
  console.warn('[dev-run] 插件前端 watch 已关闭（--no-watch）：resources 产物不会随插件源码改动刷新。')
  console.warn('[dev-run]   改了插件前端要自己重建：cd <应用仓>/apps/<slug>/desktop && node scripts/build.js')
} else if (hostOverride) {
  console.warn('[dev-run] --host-cmd 定制宿主：跳过首次构建门控，插件前端 watch 立即启动')
  startPluginWatches()
} else {
  console.log('[dev-run] 宿主首次构建中：插件前端 watch 延后到构建完成后启动（避免构建期重启竞争）')
}

// Ctrl+C / 终止信号：广播回收
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
// 关闭终端标签页/窗口：终端只发 SIGHUP（SIGINT 不送 detached 子进程组），
// 不处理则 shutdown 不执行、整棵 detached 子树孤儿化残留
process.on('SIGHUP', () => shutdown(0))
