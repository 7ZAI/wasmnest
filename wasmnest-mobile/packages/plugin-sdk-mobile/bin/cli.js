#!/usr/bin/env node
/**
 * wasmnest-plugin — WasmNest 移动端插件开发工具包命令行
 *
 * 用法：
 *   wasmnest-plugin create <id> <name> [--author <author>] [--dir <dir>] [--ts-only] [--registry]
 *   wasmnest-plugin build [--resources-dir <dir>] [--frontend-only] [--rust-only] [--watch]
 *   wasmnest-plugin package [-o <file>] [--hash]
 *   wasmnest-plugin dev [pluginDir] [--entry <file>] [--port <port>] [--host] [--open]
 *   wasmnest-plugin manifest [--check]
 *   wasmnest-plugin validate [--dir <dir>]
 *   wasmnest-plugin doctor
 *
 * create  从 SDK 内置模板生成插件工程（填充 id/name/author/crate 名）；
 *          --ts-only 生成纯前端插件（无 rust/ 目录）；--registry 时引用已发布版本
 * build   串联 vite build → cargo wasm32 构建 → componentize 组件化（Component Model）；
 *          --resources-dir 时复制产物到宿主资源目录；
 *          --watch 时 vite 长驻构建前端，重建后自动复制产物（前端热更）
 * package 将产物打包为 {id}.zip 插件包（分发单元）；--hash 时计算并写入 wasmHash
 * dev     启动浏览器开发环境（dev-shell）：vite dev server + HMR，插件源码在
 *          mock 宿主的移动端骨架中实时预览（WASM 后端不在浏览器运行）；
 *          --host 时监听局域网，手机浏览器访问 http://<PC-IP>:<port> 可查看页面
 * validate 校验 plugin.json 结构与字段合法性（CI 用，exit 1 表示不合法）
 * doctor   环境自检：Node / Rust / wasm32 target / dev-shell 依赖 / SDK 构建产物
 */

import { spawn, spawnSync } from 'node:child_process'

import { join } from 'node:path'
import { parseArgs, readJson, SDK_ROOT } from './lib.js'
import { cmdCreate, cmdManifest, cmdValidate } from './scaffold.js'
import { cmdDev, cmdBuild } from './build.js'
import { cmdPackage, cmdDoctor } from './package.js'

// ==================== 入口 ====================

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const [cmd] = positional
  const rest = positional.slice(1)
  const pkg = readJson(join(SDK_ROOT, 'package.json'), 'SDK package.json')

  if (flags.version || flags.v) {
    console.log(pkg.version)
    process.exit(0)
  }

  if (flags.help || flags.h || !cmd) {
    console.log(`wasmnest-plugin v${pkg.version}`)
    console.log('\nWasmNest 移动端插件开发工具包\n')
    console.log('用法:')
    console.log(
      '  wasmnest-plugin create <id> <name> [--author <author>] [--dir <dir>] [--ts-only] [--registry]',
    )
    console.log(
      '  wasmnest-plugin build [--resources-dir <dir>] [--frontend-only] [--rust-only] [--watch]',
    )
    console.log('  wasmnest-plugin package [-o <file>] [--hash]   # --hash 写入 wasmHash 完整性校验')
    console.log(
      '  wasmnest-plugin dev [pluginDir] [--entry <file>] [--port <port>] [--host] [--open]   # 浏览器开发环境（HMR；--host 供手机访问）',
    )
    console.log('  wasmnest-plugin manifest [--check]   # 按源码自动填充 contributes/permissions')
    console.log('  wasmnest-plugin validate [--dir <dir>]   # 校验 plugin.json 结构')
    console.log('  wasmnest-plugin doctor   # 环境自检（Node/Rust/wasm32/dev-shell/SDK）')
    process.exit(0)
  }

  switch (cmd) {
    case 'create':
      cmdCreate(rest, flags)
      break
    case 'build':
      cmdBuild(flags)
      break
    case 'package':
      cmdPackage(flags)
      break
    case 'dev':
      cmdDev(rest, flags)
      break
    case 'manifest':
      cmdManifest(flags)
      break
    case 'validate':
      cmdValidate(flags)
      break
    case 'doctor':
      cmdDoctor()
      break
    default:
      console.error(`未知命令: ${cmd}（运行 wasmnest-plugin --help 查看用法）`)
      process.exit(1)
  }
}

main()
