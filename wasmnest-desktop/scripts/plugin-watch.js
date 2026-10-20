/**
 * 插件前端 watch 构建（共享模块）
 *
 * 供各插件 scripts/build.js 调用：以 `vite build --watch` 长驻构建前端，
 * 每次重建完成后把产物复制到宿主资源目录（src-tauri/resources/plugins/desktop/<id>/）。
 *
 * 与宿主侧 PluginDevWatcher 配合形成完整热更新闭环：
 *   改插件源码 → vite 重建 dist/index.js → 复制到产物目录
 *   → watcher 检测 .js 变化 → emit plugin:dev-reload → 前端 reloadPlugin 重新加载
 *
 * 用法：
 *   import { startPluginWatch } from '../../scripts/plugin-watch.js'
 *   startPluginWatch({ root: ROOT, resourcesDir: RESOURCES_DIR, extraFiles: [...] })
 *
 * 只 watch 前端：WASM 产物不参与（Rust 改动仍需一次性 `node scripts/build.js` 全量构建）。
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
// 票 16：与另两个装配点（应用仓 `apps/*/desktop/scripts/build.js`、`sdk/bin/cli.js`）共用同一份
// 摘要注入实现——此前本文件漏了这一行 import，dev 期每次前端重建都在复制链最后一步
// 抛 `ReferenceError: injectWasmHash is not defined`，把已注入的 wasmHash 又抹掉。
import { injectWasmHash, sha256Hex, wasmFileName } from '../packages/plugin-sdk-desktop/bin/wasm-hash.js'

/** dist 写入事件防抖间隔（vite 重建会连续触发多次文件事件） */
const COPY_DEBOUNCE_MS = 500

/**
 * 终止信号升级间隔（ms）：SIGTERM 发出后等待该时长，vite 仍未退出则升级 SIGKILL。
 *
 * 必须小于 dev-run.js 的回收兜底超时（2000ms），否则宿主 dev 退出时本进程会被
 * 抢先 process.exit，孙进程又回到孤儿状态。
 */
const KILL_ESCALATE_MS = 1500

/**
 * 定位 vite 可执行文件：pnpm/npm workspace 可能将依赖提升到仓库根 node_modules，
 * 因此从插件目录向上逐级查找，直到仓库根（含根自身）
 */
function findViteBin(startDir) {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'node_modules/vite/bin/vite.js')
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 内容感知复制：目标字节与源一致时不写文件（返回 false）。
 *
 * 为什么不用 `cpSync` 直接覆盖：产物目录在 `src-tauri/` 下，`tauri dev` 的 file
 * watch 看到文件变化就重启整个 app。`cpSync` 即使内容相同也会刷新 mtime —— 而 watch
 * 启动时 vite 必然先完整构建一次（字节与上次一样），旧实现于是每次
 * `pnpm run tauri:dev` 都多出一次重启，用户看到的就是「前端加载两次」。内容比较后
 * 跳过写入：冷启动稳定为**一次**加载；真改了源码（字节不同）才落盘并触发重启。
 *
 * 导出供单测直接验证（`src/__tests__/scripts/pluginWatchCopy.test.ts`）。
 */
export function copyIfChanged(src, dest) {
  try {
    if (existsSync(dest) && readFileSync(src).equals(readFileSync(dest))) return false
  } catch {
    // 读失败（权限 / 半写状态）按「需要复制」处理：宁可多一次重启，也不要留半份产物
  }
  cpSync(src, dest)
  return true
}

/**
 * 计算产物目录应得的 `plugin.json` 文本：源清单 + 由产物 wasm 现算的 `wasmHash`。
 *
 * 为什么不能直接 `copyIfChanged(源, 产物)`：源清单按设计**不带** `wasmHash`
 * （见 wasm-hash.js 头注释「只写产物」），而产物清单带。两者字节永远不相等，
 * 裸字节比较会判成「需要复制」——冷启动的首次 watch 构建于是必定重写
 * `src-tauri/resources/plugins/desktop/<id>/plugin.json`，`tauri dev` 的 file
 * watch 看到变化就重启整个 app：窗口先出现、消失、再出现。
 *
 * 这里先把「源清单 + 产物 wasm 摘要」拼成 injectWasmHash 会写出的最终文本再比较，
 * 只有除 `wasmHash` 外的内容真的变了才落盘。
 *
 * 返回 null = 无法预计算（清单非法 / 声明了 rustLibrary 但产物缺 wasm）——交给
 * 原有复制 + `injectWasmHash` 流程按既有 fail-visible 语义处理。
 */
export function expectedArtifactManifest(sourcePath, artifactDir) {
  let sourceText
  let manifest
  try {
    sourceText = readFileSync(sourcePath, 'utf-8')
    manifest = JSON.parse(sourceText)
  } catch {
    return null
  }
  const wasmFile = wasmFileName(manifest)
  // 纯前端插件没有 wasmHash 可注入：预期内容就是源文件原文（保持与旧行为一致）
  if (!wasmFile) return sourceText
  const wasmPath = join(artifactDir, wasmFile)
  if (!existsSync(wasmPath)) return null
  manifest.wasmHash = sha256Hex(readFileSync(wasmPath))
  // 必须与 injectWasmHash 的写盘格式逐字一致（2 空格缩进 + 末尾换行）
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * 把产物 `plugin.json` 同步到「源清单 + 当前 wasm 摘要」的最终形态。
 *
 * @returns {{ written: boolean, reason: 'written'|'unchanged'|'not-ready' }}
 *   written=true 表示真的落盘（mtime 变了，宿主会重启）；
 *   not-ready = 缺产物 wasm / 清单非法，本次不动文件。
 */
export function syncArtifactManifest(sourcePath, artifactDir) {
  const expected = expectedArtifactManifest(sourcePath, artifactDir)
  if (expected == null) return { written: false, reason: 'not-ready' }
  const dest = join(artifactDir, 'plugin.json')
  try {
    if (existsSync(dest) && readFileSync(dest, 'utf-8') === expected) {
      return { written: false, reason: 'unchanged' }
    }
  } catch {
    // 读失败按需要写处理
  }
  writeFileSync(dest, expected, 'utf-8')
  return { written: true, reason: 'written' }
}

/**
 * watch 复制链专用的 manifest 复制：幂等，且保留「缺 wasm 时 fail-visible」语义。
 *
 * 无法预计算时退回裸字节复制，随后 `injectWasmHash` 会按原逻辑抛错（不要静默
 * 把带摘要的旧产物留成无摘要状态）。
 */
export function copyManifestIfChanged(sourcePath, artifactDir) {
  const result = syncArtifactManifest(sourcePath, artifactDir)
  if (result.reason !== 'not-ready') return result.written
  return copyIfChanged(sourcePath, join(artifactDir, 'plugin.json'))
}

/**
 * 启动前端 watch 构建并自动复制产物
 *
 * @param {object} opts
 * @param {string} opts.root 插件工程根目录（含 package.json / dist / node_modules）
 * @param {string} opts.resourcesDir 宿主资源目标目录（如 src-tauri/resources/plugins/desktop/<id>）
 * @param {string[]} [opts.extraFiles] 需要随前端一并复制的静态附加产物（相对 root，如 hook 脚本）
 * @param {string} [opts.wasmFile] WASM 产物路径（相对 root，如
 *   rust/target/.../lib.wasm）；提供时启动前检查目标 resources 目录是否已有
 *   同名 wasm，缺失则醒目提示先跑一次全量构建（watch 只建前端，首次全新
 *   目录下不提示会导致插件加载失败且无从排查）
 */
export function startPluginWatch({ root, resourcesDir, extraFiles = [], wasmFile }) {
  const distDir = resolve(root, 'dist')
  const viteBin = findViteBin(root)
  const distMain = resolve(distDir, 'index.js')

  if (!viteBin) {
    console.error(
      `[watch] vite 未找到（自 ${root} 向上查找 node_modules/vite 均无）— 先在插件目录或仓库根运行 pnpm install`,
    )
    process.exit(1)
  }

  // WASM 缺失预检：全新 resources 目录（从未跑过全量 build）时，产物复制完成后
  // 插件加载仍会因缺 .wasm 失败，此处提前给出可执行指引
  if (wasmFile) {
    const wasmDest = resolve(resourcesDir, basename(wasmFile))
    if (!existsSync(wasmDest)) {
      console.warn(`[watch] ⚠ 目标目录缺少 ${basename(wasmFile)}（${wasmDest}）`)
      console.warn(`[watch]   watch 只重建前端，不参与 WASM。首次请先执行一次全量构建：`)
      console.warn(`[watch]   cd ${root} && node scripts/build.js（含 cargo wasm32 构建）`)
    }
  }

  console.log('\n[watch] ====== 前端 watch 构建启动（vite build --watch） ======')
  console.log(`[watch] vite: ${viteBin}`)
  console.log(`[watch] 产物目录: ${resourcesDir}`)
  console.log('[watch] 修改插件前端源码后自动重建 + 复制，宿主 watcher 会触发前端热重载')
  console.log('[watch] Ctrl+C 退出\n')

  // 长驻 vite watch 构建（vite 5 CLI 支持 build --watch，首次启动即完整构建一次）
  const child = spawn(process.execPath, [viteBin, 'build', '--watch'], {
    cwd: root,
    stdio: 'inherit',
  })
  child.on('exit', (code) => process.exit(code ?? 0))

  // ==================== 孙进程回收 ====================
  //
  // Node 不会把信号转发给孙进程：dev-run.js 用 SIGTERM 硬杀本进程（build.js）时，
  // vite 的父进程即消失、被 reparent 到 init 成为孤儿常驻。已实测残留：3 个 vite
  // 各占数十 MB、持续运行数小时不退出。故本进程必须自己回收 vite。
  //
  // 残留成因：tty 的 Ctrl+C 只广播给前台进程组，而「关闭终端标签/窗口、外部 kill、
  // 宿主崩溃」等非广播路径的信号只送达 shell 与 dev-run.js 一层，vite 收不到任何
  // 信号。实测 vite 自身对 SIGINT / SIGTERM 均正常退出（不是它吞信号），问题在
  // 信号根本没送达。
  //
  // 终止序列：
  //   1. 先发 SIGTERM，给 vite 自身的清理逻辑一个机会（实测该路径即已退出）
  //   2. KILL_ESCALATE_MS 后仍未退出则升级 SIGKILL —— 防御性兜底，vite 正忙于
  //      构建、信号延迟处理等场景下 SIGTERM 可能不生效
  //
  // 升级 timer 需检查 child 状态：vite 响应 SIGTERM 时 child 已退出，
  // 此时升级只会产生误导日志（对已退出的 child kill 返回 false，无害但噪声）。
  // child.on('exit') 直接 process.exit 即可：不响应 SIGTERM 时 child 不触发 exit，
  // 本进程持续存活直到升级 SIGKILL 生效，两条路径都自然闭合。
  const killVite = (signal) => {
    try {
      child.kill(signal)
    } catch {
      // 未 spawn 成功或已退出，忽略
    }
  }

  let stopping = false
  const terminateVite = () => {
    if (stopping) return
    stopping = true
    console.error('[watch] 收到终止信号，回收 vite watch 子进程')
    killVite('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        console.error(`[watch] vite 未在 ${KILL_ESCALATE_MS}ms 内退出，升级 SIGKILL`)
        killVite('SIGKILL')
      }
    }, KILL_ESCALATE_MS)
  }

  process.on('SIGINT', terminateVite)
  process.on('SIGTERM', terminateVite)
  // 兜底：非信号路径退出（进程崩溃等）时已无法等待孙进程，直接 SIGKILL
  process.on('exit', () => killVite('SIGKILL'))

  // 复制产物到宿主资源目录（覆盖式，不删目录：宿主运行时可能正持有文件句柄）
  const copy = () => {
    // 内容没变的文件**不写**：`cpSync` 会刷新 mtime，而产物目录在 `src-tauri/` 下
    // ——`tauri dev` 的 file watch 一见变化就「Rebuilding application...」重启整个
    // app。watch 启动时 vite 必然先完整构建一次（产物字节与上次相同），旧实现无条件
    // 覆盖 → 每次 `pnpm run tauri:dev` 都会多出一次重启 = 前端**加载两次**。
    // 内容比较后跳过写入，冷启动稳定为一次加载；真改了源码才落盘触发重启（这是
    // dev 期热更新的既有形态，不变）。
    // 票 16：复制链是**多步有副作用**的序列——前几步落地后仍可能在最后一步失败。
    // 原来只打一句「复制失败」，会让人误以为什么都没复制，实际留下的是**半份产物**
    // （index.js / plugin.json 已覆盖、摘要未重算）。按步记账，失败时点名哪一步 +
    // 前半是否已落地（§8 fail-visible 口径）。
    const done = []
    let current = null
    const step = (name, fn) => {
      current = name
      fn()
      done.push(name)
      current = null
    }

    try {
      if (!existsSync(distMain)) return
      let changed = 0
      /** 记账版 copyIfChanged：返回 1 = 真的落盘（mtime 变了，宿主会重启） */
      const copyStep = (label, src, dest) => {
        let written = false
        step(label, () => {
          written = copyIfChanged(src, dest)
        })
        return written ? 1 : 0
      }
      step('创建产物目录', () => mkdirSync(resourcesDir, { recursive: true }))
      changed += copyStep('复制 index.js', distMain, resolve(resourcesDir, 'index.js'))
      // plugin.json 的预期内容 = 源清单 + 产物 wasm 摘要（源清单不带 wasmHash），
      // 不能按源字节比较——否则每次冷启动都会重写，触发 tauri dev 重启（窗口闪两次）。
      step('复制 plugin.json', () => {
        if (copyManifestIfChanged(resolve(root, 'plugin.json'), resourcesDir)) changed += 1
      })
      for (const f of extraFiles) {
        const src = resolve(root, f)
        if (existsSync(src)) changed += copyStep(`复制 ${f}`, src, resolve(resourcesDir, basename(f)))
      }
      // 源清单被覆盖后重算摘要（票 14：wasmHash 只存在于产物，dev 刷新不能把它抹掉）。
      // injectWasmHash 自己就是内容感知的（hash 未变不写文件），故它不会白刷 mtime。
      let hashChanged = false
      step('注入 wasmHash', () => {
        hashChanged = injectWasmHash(resourcesDir, { log: () => {} }).reason === 'written'
      })
      const stamp = new Date().toLocaleTimeString()
      if (changed > 0 || hashChanged) {
        console.log(`[watch] ${stamp} 产物已更新 → ${resourcesDir}`)
      } else {
        console.log(`[watch] ${stamp} 产物无变化（跳过写入，不触发宿主重启）`)
      }
    } catch (e) {
      console.error(`[watch] 复制失败：${current ? `步骤「${current}」` : '未知步骤'} —— ${e.message}`)
      console.error(
        done.length
          ? `[watch]   已完成步骤：${done.join(' → ')}（产物目录已是**半份**状态，不要按「没复制过」处理）`
          : '[watch]   尚无步骤落地（产物目录未被本次复制触碰）',
      )
    }
  }

  // dist 任意文件事件都防抖复制（Windows 上 fs.watch 的 filename 常为 null，
  // 且 vite 写入伴随临时文件/rename 多次事件，按时间聚合最稳）
  let timer = null
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(copy, COPY_DEBOUNCE_MS)
  }

  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true })
  const watcher = watch(distDir, { persistent: true }, schedule)
  watcher.on('error', (e) => console.error(`[watch] dist 监听错误: ${e.message}`))
}
