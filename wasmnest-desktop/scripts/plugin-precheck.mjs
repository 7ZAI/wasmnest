#!/usr/bin/env node
/**
 * 插件产物预检（wasmnest-app 与 servers 的最新构建保证）
 *
 * 单一入口保证「宿主起来前，6 个随包插件（4 个产品应用 + 2 个系统服务）的产物
 * 一定是最新代码构建的」——无论走哪条 dev 路径：
 *   - `pnpm run tauri:dev`（dev-run.js）：spawn 宿主前内联调用本模块；
 *   - 裸 `tauri dev`（`pnpm run tauri -- dev` / `cargo tauri dev`）：tauri.conf.json
 *     `beforeDevCommand` 串入本脚本，宿主 cargo build 前先跑。
 * 两次路径相遇时（dev-run.js 内联 + beforeDevCommand）幂等：第一遍补建完成、
 * 第二遍 mtime 判据全 OK 秒过。
 *
 * 预检四步（顺序与 dev-run.js 原内联实现一致）：
 *   1. ensurePluginWasm    各插件 WASM 缺失 / Rust 源码（端 rust/ + 应用级 ../rust/
 *                          + SDK rust/）比产物新 → 补建（`--rust-only` 或全量）
 *   2. ensurePluginFrontends 前端挂载包缺失 / 源码比产物新 → 宿主启动前预重建
 *                          （避免启动后 watch 首次构建写 resources 触发宿主重启）
 *   3. ensurePluginManifests 产物 plugin.json 的 wasmHash 基线对齐（幂等）
 *   4. pruneStalePluginDirs 剪掉不在当前注册表里的产物目录（ADR 0056 改名后的
 *                          幽灵应用清理，fail-visible 打印被删路径）
 *
 * 补建失败 fail-fast（exit 非 0）：宿主起来也只会报加载失败，早停给手动指引更可排查。
 *
 * 用法：
 *   node scripts/plugin-precheck.mjs        # 直接执行（tauri beforeDevCommand 用）
 *   import { runPluginPrecheck } from './plugin-precheck.js'   # dev-run.js 复用
 *
 * 可测性（src/__tests__/scripts/pluginPrecheck.test.ts）：四步与陈旧判定全部导出并
 * 接受可选 `deps` 注入（插件表 / 产物根 / 应用目录解析 / SDK 根 / 构建执行器 / 退出）。
 * 不注入 = 生产默认（真实注册表 + 真实 spawn 构建 + process.exit）；测试注入记录器
 * 在真实临时目录上跑行为断言，绝不触发真实构建。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appDir, hasAppDir } from '../../scripts/app-paths.mjs'
// plugin-watch 随桌面 SDK 发布（应用侧从包名导入）；宿主 dev 反向引 SDK 内同一份实现
import { syncArtifactManifest } from '../packages/plugin-sdk-desktop/bin/plugin-watch.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
/** 桌面端工程根（tauri.conf.json / src / packages 所在层） */
const ROOT = resolve(__dirname, '..')

// ==================== 注册表（单一真源） ====================

/**
 * 随包插件注册表（apps + servers 全量，单一真源）。
 *
 * 插件 watch 启动项（args 在应用工程目录内执行；wasmFile 为应用内 WASM 产物相对路径）。
 *
 * 应用源码自三仓拆分起住独立应用仓：`<WASMNEST_APPS_ROOT 或兄弟目录>/apps/<slug>/desktop`
 * 或 `servers/<slug>/desktop`（系统服务分组），路径统一经 `scripts/app-paths.mjs` 解析。
 */
export const PLUGIN_WATCH_CMDS = [
  {
    slug: 'ai-chatbox',
    id: 'com.wasmnest.ai-chatbox',
    args: ['scripts/build.js', '--watch'],
    // 票 03 起桌面插件统一 wasm32-wasip3（cdylib 直出 Component，免 componentize）
    wasmFile: 'rust/target/wasm32-wasip3/release/wasmnest_plugin_ai_chatbox.wasm',
  },
  {
    // terminal-session（bedcode）：前端挂载包在 dev 期**不参与 watch**——它的整包
    // 构建最重（实测 ~20s），且每次写入 resources 都会让宿主重启一次。改了它的 UI
    // 请单独重建：`pnpm run plugins:build` 或该目录 `node scripts/build.js --frontend-only`。
    // 条目保留只为 ensurePluginWasm 的 WASM 缺失/陈旧补建（Rust 侧自启照旧）。
    slug: 'bedcode',
    id: 'com.wasmnest.terminal-session',
    args: [],
    skipWatch: true,
    // 票 03 起本插件走仓库共享 wasip3 构建链（cdylib 直出 Component）
    wasmFile: 'rust/target/wasm32-wasip3/release/bedcode_plugin_terminal_session.wasm',
  },
  {
    slug: 'file-transfer',
    id: 'com.wasmnest.file-transfer',
    args: ['scripts/build.js', '--watch'],
    // 单产物口径（2026-10-13）：file-transfer 与移动端共用一份 wasm，本端也走
    // wasm32-unknown-unknown + componentize（桌面 SDK 的 `tools/componentize`，随 npm 包发布），
    // 产物落应用仓的 wasm 应用共享 target（`<appsRoot>/target/wasm-apps/…`）。
    // 注意本字段只被 `ensurePluginWasm` 取 `basename()` 定位 resources 下的目标产物
    // （陈旧判定比的是「resources 产物 vs Rust 源码 mtime」，不据此路径找源产物），
    // 故这里写的是**产物文件名口径**；补建一律走 `scripts/build.js`。
    wasmFile: 'target/wasm-apps/wasm32-unknown-unknown/release/wasmnest_plugin_file_transfer.wasm',
  },
  {
    // Agent Hub：与其余桌面 wasm 应用同一条闭环。缺席本表时 `tauri dev` 不给它起
    // vite watch，改前端只能手工 `build:frontend`，产物长期停在旧构建
    // （2026-10-06 实测：dist 里残留旧 CSS，热力图渲染成整块色块）。补上后
    // 前端改动 → vite 重建 → 复制进 resources → 宿主 emit plugin:dev-reload，
    // 与另三个应用同一条闭环；WASM 仍走 ensurePluginWasm() 的缺失/陈旧补建。
    slug: 'agent-hub',
    id: 'com.wasmnest.agent-hub',
    args: ['scripts/build.js', '--watch'],
    wasmFile: 'rust/target/wasm32-wasip3/release/wasmnest_plugin_agent_hub.wasm',
  },
  {
    // Monitor：系统服务（L2），工程住应用仓 `servers/` 分组；只读指标看板，
    // 前端与 Rust 都轻，走与其他应用同一条 watch 闭环。
    group: 'servers',
    slug: 'monitor',
    id: 'com.wasmnest.monitor',
    args: ['scripts/build.js', '--watch'],
    wasmFile: 'rust/target/wasm32-wasip3/release/wasmnest_plugin_monitor.wasm',
  },
  {
    // Auth Center（服务型 wasm，L2）：工程住应用仓 `servers/` 分组。页面轻
    // （就位三态 + 声明面），与其它应用同一条 watch 闭环。
    group: 'servers',
    slug: 'auth-center',
    id: 'com.wasmnest.auth-center',
    args: ['scripts/build.js', '--watch'],
    wasmFile: 'rust/target/wasm32-wasip3/release/wasmnest_plugin_auth_center.wasm',
  },
]

/** 宿主插件产物目录（各插件子目录名 = 插件 id，来自 plugin.json，与构建脚本复制目标一致） */
const RESOURCES_BASE = resolve(ROOT, 'src-tauri/resources/plugins/desktop')

/**
 * 宿主实际扫描的两个产物目录：源码资源目录（构建脚本的复制目标）+ tauri dev 的
 * 运行时副本（`target/debug/resources`，`tauri dev` 把 bundle resources 复制进去，
 * 源目录删除**不会**自动同步——幽灵目录只在这里活着）。
 */
const RUNTIME_RESOURCES_BASE = resolve(ROOT, 'src-tauri/target/debug/resources/plugins/desktop')

/**
 * 桌面 SDK 根（陈旧判据的共享源码面：`packages/plugin-sdk-desktop`）。
 * 作为可注入依赖的默认值存在：前端判据取其 `src/`，WASM 判据取其 `rust/`。
 */
const DEFAULT_SDK_ROOT = resolve(ROOT, 'packages/plugin-sdk-desktop')

/**
 * 剪掉不属于当前注册表的插件产物目录。
 *
 * **为什么必须有**：插件 id 改名（ADR 0056 `com.bedcode.*` → `com.wasmnest.*`）后，
 * 构建/复制只写新目录、从不剪旧目录，于是扫描面同时存在两代产物——主屏、应用管理、
 * 权限页、命令面板都会把幽灵应用当真应用列出来（可点、必失败）。AGENTS §5.1.4 要求
 * 真源搬迁 fail-visible，静默注册成双份正是它要防的形态，所以这里在启动前强制对齐，
 * 并逐个打印被删的路径（不是偷偷清理）。
 *
 * 只删「不在注册表里的目录」：用户安装的插件在 app_data_dir/plugins（不在这里），
 * 内置资源目录里出现的未知 id 只可能是退役产物。
 */
/**
 * 只删「不在注册表里的目录」：用户安装的插件在 app_data_dir/plugins（不在这里），
 * 内置资源目录里出现的未知 id 只可能是退役产物。
 */
export function pruneStalePluginDirs(deps = {}) {
  const {
    plugins = PLUGIN_WATCH_CMDS,
    resourcesBase = RESOURCES_BASE,
    runtimeResourcesBase = RUNTIME_RESOURCES_BASE,
  } = deps
  const knownPluginIds = new Set(plugins.map((p) => p.id))
  for (const base of [resourcesBase, runtimeResourcesBase]) {
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || knownPluginIds.has(entry.name)) continue
      const target = join(base, entry.name)
      try {
        rmSync(target, { recursive: true, force: true })
        console.warn(`[plugin-precheck] 已清理退役插件产物目录（不在当前注册表）：${target}`)
      } catch (e) {
        // 清理失败不阻断 dev 启动，但必须喊出来：幽灵应用会继续出现在面上
        console.error(`[plugin-precheck] ⚠ 退役插件产物清理失败：${target}（${e.message}）`)
      }
    }
  }
}

// ==================== 陈旧判定 ====================

/** 返回前端产物需要重建的原因（null = 产物最新，无需动作） */
export function frontendStaleReason(
  pluginRoot,
  bundleDest,
  { sdkSrcRoot = join(DEFAULT_SDK_ROOT, 'src') } = {},
) {
  let bundleStat
  try {
    bundleStat = statSync(bundleDest)
  } catch {
    return `产物缺失：${bundleDest}`
  }
  // 产物由 app 前端源码 + 共享 SDK 组件 + 打包配置共同决定：任一 newer 都要重建，
  // 否则冷启动后的首次 watch 构建会把差异写进 resources → 宿主重启（加载两次）
  const newestSrc = Math.max(
    latestSourceMtime(join(pluginRoot, 'src')),
    latestSourceMtime(sdkSrcRoot),
    fileMtime(join(pluginRoot, 'plugin.json')),
    fileMtime(join(pluginRoot, 'tailwind.config.js')),
    fileMtime(join(pluginRoot, 'vite.config.ts')),
  )
  if (newestSrc > bundleStat.mtimeMs) return '前端源码比产物新（需重建）'
  return null
}

/** 单文件 mtime（ms）；缺失返回 0 */
function fileMtime(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** 返回 wasm 需要补建的原因（null = 产物最新，无需动作） */
export function wasmStaleReason(
  pluginRoot,
  wasmDest,
  { sdkRustRoot = join(DEFAULT_SDK_ROOT, 'rust') } = {},
) {
  let wasmStat
  try {
    wasmStat = statSync(wasmDest)
  } catch {
    return `产物缺失：${wasmDest}`
  }
  // 源码面含两处 rust：端目录内 `rust/`（一般插件 / servers 工程自持 rust）+ 应用级
  // `../rust/`（file-transfer 双端同构：crate 收在 `apps/file-transfer/rust/{core,plugin}`，
  // 端目录只剩前端——只扫端目录会让它的 wasm 陈旧判据静默失效）。
  // 无应用级 rust 层的插件该目录缺失，`latestSourceMtime` 返回 0，不干扰判据。
  // SDK rust 面：WIT / 权限表 / HostApp trait 任一变更都会改变所有插件的编译面，
  // 必须全量补建（2026-10-23：app:path 加入后旧插件 wasm 缺 path_register 导出）。
  const newestSrc = Math.max(
    latestSourceMtime(join(pluginRoot, 'rust')),
    latestSourceMtime(join(pluginRoot, '..', 'rust')),
    latestSourceMtime(sdkRustRoot),
  )
  if (newestSrc > wasmStat.mtimeMs) return 'Rust 源码比产物新（需重建）'
  return null
}

/**
 * 目录下所有文件的最新 mtime（ms）；跳过构建产物目录（target/dist/node_modules），
 * 避免 cargo 增量产物 / vite 输出的 mtime 干扰源码新鲜度判断。
 */
function latestSourceMtime(root) {
  let latest = 0
  const skip = new Set(['target', 'dist', 'node_modules'])
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 目录缺失/不可读：无源码，视为 0
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue
        stack.push(join(dir, e.name))
      } else {
        try {
          const m = statSync(join(dir, e.name)).mtimeMs
          if (m > latest) latest = m
        } catch {
          // 单文件 stat 失败忽略
        }
      }
    }
  }
  return latest
}

// ==================== 预检四步 ====================

// ---- 可注入依赖的默认实现（不注入 = 生产行为；测试注入替身见 pluginPrecheck.test.ts） ----

/** 应用工程目录解析（按注册表条目的 slug/group） */
function defaultAppDirOf(slug, group) {
  return appDir(slug, 'desktop', { group })
}

/** 真实构建执行器：spawn `node scripts/build.js …`（与注入前行为逐参数一致） */
function defaultRunBuild(script, cwd) {
  return spawnSync(process.execPath, script, { cwd, stdio: 'inherit' })
}

/** 补建失败 fail-fast（测试注入记录器 / 抛错替身，不真杀测试进程） */
function defaultExit(code) {
  process.exit(code)
}

/**
 * 各插件 WASM 产物缺失或过期时串行补建一次。
 *
 * dev watch 只构建前端（见 PLUGIN_WATCH_CMDS 注释），WASM 靠一次性全量构建
 * 产出——资源目录里的旧产物不会被自动重建，会造成「新前端 + 旧 WASM」静默
 * 错配（历史事故：file-transfer 暂停按钮报 unsupported: transfer lifecycle
 * is plugin-store managed，见 .scratch/file-transfer-pause-concurrency）。
 * 这里在启动 watch 前检测：
 *   - resources/{id}/ 下 .wasm 缺失 → 补建
 *   - Rust 源码（插件 rust/ + 应用级 ../rust/ + SDK rust/）最新 mtime 晚于产物 → 补建
 *   - dist/index.js 已存在 → node scripts/build.js --rust-only（跳过 vite，最快路径）
 *   - 全新目录（dist 也没有）→ node scripts/build.js 全量构建一次（含前端），
 *     其后 watch 接管前端增量
 * 补建失败 fail-fast：宿主起来也只会报加载失败，早停并给手动指引更可排查。
 */
export function ensurePluginWasm(deps = {}) {
  const {
    plugins = PLUGIN_WATCH_CMDS,
    resourcesBase = RESOURCES_BASE,
    appDirOf = defaultAppDirOf,
    sdkRoot = DEFAULT_SDK_ROOT,
    runBuild = defaultRunBuild,
    exit = defaultExit,
  } = deps
  for (const { group, slug, id, wasmFile } of plugins) {
    if (!wasmFile) continue
    const pluginRoot = appDirOf(slug, group)
    const wasmDest = resolve(resourcesBase, id, basename(wasmFile))
    const reason = wasmStaleReason(pluginRoot, wasmDest, { sdkRustRoot: join(sdkRoot, 'rust') })
    if (!reason) continue

    console.warn(`[plugin-precheck] ⚠ 插件 ${slug} WASM 需要补建：${reason}`)
    const hasFrontend = existsSync(resolve(pluginRoot, 'dist', 'index.js'))
    // 必须 `--out <resourcesBase>` 直写宿主产物目录：apps 仓 build.js 默认只写
    // 仓内 `.build/plugins`（G2 设计），不经 `--out` 时 resources 里的旧 wasm 不会被
    // 更新（watch 只复制前端、不碰 wasm），宿主启动仍加载旧产物——「保证最新」
    // 正落在这一步（2026-10-23 修复：dev-run 原内联实现同样未带 --out）。
    const outArgs = ['--out', resourcesBase]
    const script = hasFrontend
      ? ['scripts/build.js', '--rust-only', ...outArgs]
      : ['scripts/build.js', ...outArgs]
    console.log(`[plugin-precheck] 自动补建 WASM（${hasFrontend ? '--rust-only' : '全量'}）：node ${script.join(' ')}`)
    const res = runBuild(script, pluginRoot)
    if (res.status !== 0) {
      console.error(`[plugin-precheck] ✗ WASM 补建失败（${slug}）。请手动执行后重试：`)
      console.error(`[plugin-precheck]   cd ${pluginRoot} && node scripts/build.js --out <宿主 resources/plugins/desktop>`)
      exit(res.status ?? 1)
    }
  }
}

/**
 * 各插件前端挂载包（`resources/<id>/index.js`）陈旧时**在宿主启动前**补建一次。
 *
 * 为什么必须赶在宿主启动前：插件 watch 的首次 `vite build` 若产出与 resources 里的
 * 字节不同，就会命中 `tauri dev` 的 file watch → 「Rebuilding application...」重启
 * app，用户看到的就是**前端加载两次**。`plugin-watch.js` 的内容感知复制只保证
 * 「字节相同不写」；字节真的不同（改了 app 源码直接起 dev）仍会重启一次。把它挪到
 * 宿主启动前重建，冷启动就稳定只有一次加载（dev-run.js 2026-10-17 引入；本模块
 * 2026-10-23 抽取后对裸 `tauri dev` 同样生效）。
 *
 * 判据与 WASM 补建同款：产物缺失，或前端源码 / 产物清单比产物新。
 */
export function ensurePluginFrontends(deps = {}) {
  const {
    plugins = PLUGIN_WATCH_CMDS,
    resourcesBase = RESOURCES_BASE,
    appDirOf = defaultAppDirOf,
    sdkRoot = DEFAULT_SDK_ROOT,
    runBuild = defaultRunBuild,
    exit = defaultExit,
  } = deps
  for (const { group, slug, id, skipWatch } of plugins) {
    // 只处理「有前端 watch」的插件：启动后的二次加载正是它们的首次构建触发宿主重启；
    // 无 watch 的（bedcode）启动后不会再写 resources，不存在重启风险，且其整包构建较重
    if (skipWatch) continue
    const pluginRoot = appDirOf(slug, group)
    const bundleDest = resolve(resourcesBase, id, 'index.js')
    const reason = frontendStaleReason(pluginRoot, bundleDest, { sdkSrcRoot: join(sdkRoot, 'src') })
    if (!reason) continue

    console.warn(`[plugin-precheck] ⚠ 插件 ${slug} 前端产物需要重建：${reason}`)
    console.log(`[plugin-precheck] 预重建前端挂载包（宿主启动前完成，避免启动后重启）：node scripts/build.js --frontend-only --out <resources>`)
    // 同样必须 `--out` 直写 resources：否则 resources 的 index.js 仍旧，宿主启动后
    // watch 首次复制（dist 字节不同）才会落盘 → tauri file watch 重启 → 前端加载两次。
    const res = runBuild(
      ['scripts/build.js', '--frontend-only', '--out', resourcesBase],
      pluginRoot,
    )
    if (res.status !== 0) {
      console.error(`[plugin-precheck] ✗ 前端产物重建失败（${slug}）。请手动执行后重试：`)
      console.error(`[plugin-precheck]   cd ${pluginRoot} && node scripts/build.js --frontend-only --out <宿主 resources/plugins/desktop>`)
      exit(res.status ?? 1)
    }
  }
}

/**
 * 启动前把产物 `plugin.json` 的 `wasmHash` 基线对齐（内容不变则不写）。
 *
 * 为什么需要这一步：源清单按设计不带 `wasmHash`，产物清单带。若只在 watch 的
 * 首次复制里做「源字节 vs 产物字节」比较，两者永远不相等 → 每次冷启动都重写
 * `src-tauri/resources/.../plugin.json` → `tauri dev` 重启 app → 窗口出现、消失、
 * 再出现。`plugin-watch.js` 的 `copyManifestIfChanged` 已按「源清单 + wasm 摘要」
 * 预计算最终内容；这里在**宿主启动前**再对齐一次，把「摘要确实过期」这类合法写入
 * 也挪到窗口出现之前，冷启动零重启。
 *
 * 缺 wasm / 清单非法时不动文件（not-ready），交给 watch 原有的 fail-visible 预检。
 */
export function ensurePluginManifests(deps = {}) {
  const {
    plugins = PLUGIN_WATCH_CMDS,
    resourcesBase = RESOURCES_BASE,
    appDirOf = defaultAppDirOf,
    hasApp = (slug, group) => hasAppDir(slug, 'desktop', { group }),
    sync = syncArtifactManifest,
  } = deps
  for (const { group, slug, id, skipWatch } of plugins) {
    if (skipWatch || !hasApp(slug, group)) continue
    const artifactDir = resolve(resourcesBase, id)
    if (!existsSync(artifactDir)) continue
    let result
    try {
      result = sync(resolve(appDirOf(slug, group), 'plugin.json'), artifactDir)
    } catch (e) {
      // 同步只是把潜在写入提前，失败不该阻断宿主启动；留痕后交给 watch 原有的复制链报错
      console.warn(`[plugin-precheck] ⚠ 插件清单摘要同步失败（${id}）：${e.message}`)
      continue
    }
    if (result.written) {
      console.warn(`[plugin-precheck] 启动前同步插件清单摘要（避免启动后重启）：${id}`)
    } else if (result.reason === 'not-ready') {
      console.warn(
        `[plugin-precheck] ⚠ 插件清单摘要暂不可同步（${id}）：产物 wasm 缺失或清单非法，交给 watch 预检报错`,
      )
    }
  }
}

// ==================== 统一入口 ====================

/**
 * 跑完整插件产物预检（顺序 = 原 dev-run.js 内联实现：WASM 补建 → 前端预重建 →
 * 清单基线 → 退役产物清理）。幂等：产物全部最新时无副作用，秒过。
 *
 * `deps` 透传给四步（生产不注入 = 真实注册表 / 真实构建；测试注入替身后可在
 * 临时目录上断言四步**顺序**与各自行为，见 pluginPrecheck.test.ts）。
 * 返回每个插件最终状态（供调试/日志）；预检失败（补建 exit≠0）直接 process.exit。
 */
export function runPluginPrecheck(deps = {}) {
  ensurePluginWasm(deps)
  ensurePluginFrontends(deps)
  ensurePluginManifests(deps)
  pruneStalePluginDirs(deps)
  return PLUGIN_WATCH_CMDS.map(({ group, slug, id }) => ({ group, slug, id }))
}

// 直接执行（tauri.conf.json beforeDevCommand：`node scripts/plugin-precheck.mjs`）
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  runPluginPrecheck()
  console.log('[plugin-precheck] 插件产物预检完成（全部最新，无需补建）')
}
