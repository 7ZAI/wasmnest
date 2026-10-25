#!/usr/bin/env node

/**
 * Plugin Build Script
 *
 * 生产构建脚本，委托给各插件的构建系统
 *
 * 用法：node scripts/plugin-build.js [--plugin <plugin-id> | --all]
 * 默认构建 com.wasmnest.bedcode（终端会话中心）插件
 * --all 遍历下方 PLUGINS 注册表（名单单一真源，CI/release 的 `pnpm run plugins:build` 走这条）
 *
 * 桌面端语义（2026-09-25）：wasm 插件对外称 wasm 应用；三仓拆分后源码目录为
 * 应用仓 `apps/<slug>/desktop`（经 `scripts/app-paths.mjs` 解析，spec §5-E7），
 * 内部代码实现与插件 ID 契约不变。
 */

import { execSync } from 'child_process'
import { existsSync, readdirSync, rmSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { platform } from 'os'
import { generateManifest } from '../packages/plugin-sdk-desktop/bin/manifest-gen.js'
import { validateManifest } from '../packages/plugin-sdk-desktop/bin/manifest-validate.js'
import { appDir } from '../../scripts/app-paths.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')
const IS_WIN = platform() === 'win32'

// 插件配置 — `group` + `slug` 经 app-paths 解析到应用仓工程目录
// （`<appsRoot>/<group>/<slug>/desktop`；group = apps 产品应用 / servers 服务型 wasm）
const PLUGINS = {
  // 名单单一真源：`--all`（= pnpm `plugins:build`，CI/release/test.yml 走这条）与
  // `--plugin <id>`（docs/commands.md §5.2 的单应用调试命令）都从这里取。
  // 五个 wasm 应用必须齐全：agent-hub 曾只存在于源码目录而不在本表，
  // 于是批量构建漏掉它（CI 全新 checkout 里产物不生成）、单应用命令报
  // Unknown plugin 直接退出，前端只能手工 vite build —— 产物长期停在旧构建，
  // 热力图按旧 CSS 渲染成整块色块（2026-10-06 实测）。新增工程同理必须同步本表。
  'com.wasmnest.agent-hub': {
    group: 'apps',
    slug: 'agent-hub',
  },
  'com.wasmnest.ai-chatbox': {
    group: 'apps',
    slug: 'ai-chatbox',
  },
  'com.wasmnest.file-transfer': {
    group: 'apps',
    slug: 'file-transfer',
  },
  'com.wasmnest.monitor': {
    // 系统服务（L2 内部业务）：工程迁入应用仓 `servers/` 分组
    group: 'servers',
    slug: 'monitor',
  },
  'com.wasmnest.bedcode': {
    group: 'apps',
    slug: 'bedcode',
  },
  // 服务型 wasm（L2 内部业务）：认证中心。工程住应用仓 `servers/` 分组。
  'com.wasmnest.auth-center': {
    group: 'servers',
    slug: 'auth-center',
  },
}

// 解析参数
const args = process.argv.slice(2)
let targetPlugin = 'com.wasmnest.bedcode'
let buildAll = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--plugin' && args[i + 1]) {
    targetPlugin = args[i + 1]
    i++
  } else if (args[i] === '--all') {
    buildAll = true
  }
}

// `--all` 遍历本文件的 PLUGINS 注册表（名单单一真源，package.json 的
// `plugins:build` 只调这一条，不再另抄一份）；`--plugin <id>` 走单应用路径。
// 两者都 fail-fast：任一应用失败即 exit(1)，不带着半份产物继续。
if (buildAll) {
  const ids = Object.keys(PLUGINS)
  console.log(`\n=== Plugin Build: all (${ids.length}) ===\n  ${ids.join('\n  ')}`)
  for (const id of ids) buildPlugin(id)
} else {
  buildPlugin(targetPlugin)
}

// 构建后清理退役产物目录（ADR 0056 id 改名遗留：com.bedcode.* / 已删应用）。
// 各 app 的 build.js 只写自己的目录、从不剪别人的，残留目录会被宿主扫描成
// 「装得上、点必失败」的幽灵应用（2026-10-17 验证 P1-5）。只删不在注册表里的目录，
// 并逐个打印（fail-visible，不静默清理）。
pruneStalePluginDirs()

/** 删除 `src-tauri/resources/plugins/desktop` 下不在 PLUGINS 注册表中的目录 */
function pruneStalePluginDirs() {
  const base = resolve(ROOT, 'src-tauri/resources/plugins/desktop')
  if (!existsSync(base)) return
  const known = new Set(Object.keys(PLUGINS))
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || known.has(entry.name)) continue
    const target = join(base, entry.name)
    try {
      rmSync(target, { recursive: true, force: true })
      console.log(`[plugin-build] 已清理退役插件产物目录（不在注册表）：${target}`)
    } catch (e) {
      console.error(`[plugin-build] ⚠ 退役产物清理失败：${target}（${e.message}）`)
    }
  }
}

function buildPlugin(targetPlugin) {
  const config = PLUGINS[targetPlugin]
  if (!config) {
    console.error(`Unknown plugin: ${targetPlugin}`)
    console.error(`Available: ${Object.keys(PLUGINS).join(', ')}`)
    process.exit(1)
  }

  console.log(`\n=== Plugin Build: ${targetPlugin} ===\n`)

  // 插件调试模式提示（WASMNEST_PLUGIN_DEBUG 经 env 透传给插件构建脚本；
  // release 构建不应设置该变量，宿主以 cfg!(debug_assertions) 兜底）
  if (process.env.WASMNEST_PLUGIN_DEBUG) {
    console.log('[plugin-build] 注意：WASMNEST_PLUGIN_DEBUG 已设置——插件将以 debug profile 构建（仅供调试）')
  }

  // 委托给插件的构建脚本（工程分组 apps / servers 都在同一个注册表里）
  const pluginDir = appDir(config.slug, 'desktop', { group: config.group })
  console.log(`Running plugin build in: ${pluginDir}`)

  // 构建前：按源码自动填充 plugin.json 的 contributes/permissions
  // （与插件源码单一真源约定，保证产物与源码一致——一致的口径是「除构建注入的 wasmHash 外逐字一致」，
  //   wasmHash 只存在于产物目录，源清单不带；见 packages/plugin-sdk-desktop/bin/wasm-hash.js）
  try {
    const { changed, report } = generateManifest(pluginDir)
    if (changed) {
      console.log('[plugin-build] plugin.json 已根据源码自动填充:')
      for (const line of report) console.log(`  ${line}`)
    } else {
      console.log('[plugin-build] plugin.json 已是最新，无需更新')
    }
  } catch (e) {
    console.error(`[plugin-build] manifest 自动填充失败: ${e.message}`)
    process.exit(1)
  }

  // 构建前：校验 plugin.json（与 CLI `wasmnest-plugin-desktop validate` 同一套规则）
  // 词汇/结构不合法的清单过去只在人工跑 CLI 时才被发现，声明了不存在的权限位会
  // 在宿主授权时被静默过滤（等于没声明），因此挂在构建链上强制拦一次。
  let validation
  try {
    validation = validateManifest(pluginDir)
  } catch (e) {
    console.error(`[plugin-build] manifest 校验不可用: ${e.message}`)
    process.exit(1)
  }
  for (const w of validation.warnings) console.log(`[plugin-build] manifest ⚠ ${w}`)
  if (validation.errors.length) {
    for (const e of validation.errors) console.error(`[plugin-build] manifest ✗ ${e}`)
    console.error(
      `[plugin-build] plugin.json 校验失败: ${validation.errors.length} 个错误（${pluginDir}）`,
    )
    process.exit(1)
  }
  console.log('[plugin-build] manifest 校验通过')

  try {
    const pkgMgrCmd = IS_WIN ? 'pnpm.cmd' : 'pnpm'
    execSync(`${pkgMgrCmd} run build`, {
      cwd: pluginDir,
      stdio: 'inherit',
      env: { ...process.env },
    })
  } catch (e) {
    console.error(`Plugin build failed: ${targetPlugin}`)
    process.exit(1)
  }

  console.log(`\n=== Plugin build complete: ${targetPlugin} ===\n`)
}
