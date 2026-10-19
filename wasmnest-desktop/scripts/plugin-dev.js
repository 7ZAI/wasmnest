#!/usr/bin/env node

/**
 * Plugin Dev Script
 *
 * 开发模式统一构建脚本，委托给各插件的构建系统
 *
 * 用法：node scripts/plugin-dev.js [--plugin <plugin-id>]
 * 默认构建 com.wasmnest.terminal-session（终端会话中心）插件
 */

import { spawn } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { platform } from 'os'
import { appDir } from '../../scripts/app-paths.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')
const IS_WIN = platform() === 'win32'

// 插件配置 — `slug` 经 app-paths 解析到应用仓工程目录（<appsRoot>/apps/<slug>/desktop）
const PLUGINS = {
  // 与 plugin-build.js 同表同序（docs/commands.md §5.2 记的 agent-hub 独立命令）
  'com.wasmnest.agent-hub': {
    slug: 'agent-hub',
  },
  'com.wasmnest.ai-chatbox': {
    slug: 'ai-chatbox',
  },
  'com.wasmnest.file-transfer': {
    slug: 'file-transfer',
  },
  // terminal-session（bedcode）：dev 期前端**不参与 watch**（整包构建最重且每次
  // 写入 resources 都触发宿主重启，见 dev-run.js PLUGIN_WATCH_CMDS 条目注释）。
  // 保留条目 + frontendRetired 只为显性提示：改它的前端请单独重建
  // `pnpm run plugins:build` 或应用目录 `node scripts/build.js --frontend-only`，
  // Rust 侧 = 应用目录 `node scripts/build.js`；走 `plugins:dev` 直接报错引导。
  // （desktop-host-frontend-downsink 遗留：曾并入宿主 vite，壳恢复后为独立挂载包，
  //   hostAppBoundaryLock 钉住其 src/entry.ts mountApp 契约。）
  'com.wasmnest.terminal-session': {
    slug: 'bedcode',
    frontendRetired: true,
  },
}

// 解析参数
const args = process.argv.slice(2)
let targetPlugin = 'com.wasmnest.terminal-session'
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--plugin' && args[i + 1]) {
    targetPlugin = args[i + 1]
    i++
  }
}

const config = PLUGINS[targetPlugin]
if (!config) {
  console.error(`Unknown plugin: ${targetPlugin}`)
  console.error(`Available: ${Object.keys(PLUGINS).join(', ')}`)
  process.exit(1)
}

console.log(`\n=== Plugin Dev: ${targetPlugin} ===\n`)

// terminal-session（bedcode）走 plugins:dev 没有前端可 watch（整包 dev 期不参与
// watch，理由见 PLUGINS 条目注释）——显性提示替代 pnpm 的 Missing script（fail-visible）
if (config.frontendRetired) {
  console.error(`[plugin-dev] ${targetPlugin} 前端不参与 dev watch（bedcode 整包构建重，见 dev-run.js PLUGIN_WATCH_CMDS 条目注释）：`)
  console.error('[plugin-dev]   改前端 → 应用仓 apps/bedcode/desktop 下 node scripts/build.js --frontend-only（或桌面端 pnpm run plugins:build）')
  console.error('[plugin-dev]   改 Rust → 应用仓 apps/bedcode/desktop 下 node scripts/build.js')
  process.exit(1)
}

// 插件调试模式提示（WASMNEST_PLUGIN_DEBUG 经 env 透传给插件构建脚本，
// 其 build.js 按开关切 debug profile 产物）
if (process.env.WASMNEST_PLUGIN_DEBUG) {
  console.log('[plugin-dev] WASMNEST_PLUGIN_DEBUG 已设置——插件将以 debug profile 构建（DWARF 行号）')
}

// 委托给插件的构建脚本
const pluginDir = appDir(config.slug, 'desktop')
console.log(`Running plugin dev build in: ${pluginDir}`)

const proc = spawn(IS_WIN ? 'pnpm.cmd' : 'pnpm', ['run', 'dev'], {
  cwd: pluginDir,
  stdio: 'inherit',
  env: { ...process.env },
})

proc.on('error', (err) => {
  console.error('Plugin dev process error:', err)
})

proc.on('close', (code) => {
  console.log(`Plugin dev process exited with code ${code}`)
  process.exit(code || 0)
})

process.on('SIGINT', () => {
  console.log('\nShutting down plugin dev...')
  proc.kill('SIGINT')
  process.exit(0)
})

process.on('SIGTERM', () => {
  proc.kill('SIGTERM')
  process.exit(0)
})
