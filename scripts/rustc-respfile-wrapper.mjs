#!/usr/bin/env node
/**
 * rustc 命令行超限响应文件包装器（Windows 发布构建专用）。
 *
 * 背景：全量 wasmtime 依赖图的 rustc 调用命令行达 ~40KB，超 Windows CreateProcess
 * 32767 字符上限（os error 206），发布构建在编译大依赖 crate 时红。cargo 拉起本
 * 包装器时命令行可携带完整参数（实测 sccache 同形态能被拉起），问题出在包装器再
 * 拉起 rustc 的一环。本包装器在总长超阈值时把参数逐行写入临时响应文件，改以
 * `sccache rustc @<file>` 拉起——rustc 响应文件格式 = 每行一个参数，行内空格/
 * 反斜杠原样保留（本机 rustc 实测：`a\b` 路径经 @file 原样生效）。
 *
 * 短命令直接透传 sccache，缓存行为与原先一致；超限命令走响应文件（sccache 对
 * @file 的哈希按文件内容，缓存键稳定）。仅发布流水线设置 RUSTC_WRAPPER 指向本
 * 文件；仓内默认包装器仍是 sccache（.cargo/config.toml），本地开发不受影响。
 *
 * 用法：product-release.yml build job 的 env：
 *   RUSTC_WRAPPER: ${{ github.workspace }}/wasmnest/scripts/rustc-respfile-wrapper.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 阈值：低于此长度直接透传（远低于 32767 上限，留足余量） */
const LIMIT = 30000

const argv = process.argv.slice(2)
const rustc = argv[0]
const args = argv.slice(1)
if (!rustc) {
  console.error('[rustc-wrapper] 缺少 rustc 路径参数（cargo 应传 RUSTC_WRAPPER <rustc> <args...>）')
  process.exit(2)
}

const total = args.reduce((s, a) => s + a.length + 1, 0)

/** 内层包装器：发布流水线由 sccache-action 保证；缺失时回退直调 rustc（fail-visible） */
const inner = process.env.RUSTC_WRAPPER_INNER ?? 'sccache'

function run(cmdArgs, onClose) {
  const child = spawn(cmdArgs[0], cmdArgs.slice(1), { stdio: 'inherit' })
  child.on('error', (e) => {
    if (e.code === 'ENOENT' && cmdArgs[0] === inner) {
      console.error(`[rustc-wrapper] 内层包装器 ${inner} 不可用，回退直调 rustc（仅在缺 sccache 的环境）`)
      const fallback = spawn(rustc, args, { stdio: 'inherit' })
      fallback.on('error', (e2) => {
        console.error(`[rustc-wrapper] rustc 拉起失败: ${e2.message}`)
        process.exit(1)
      })
      fallback.on('close', (code) => process.exit(code ?? 1))
      return
    }
    console.error(`[rustc-wrapper] 拉起失败: ${e.message}`)
    process.exit(1)
  })
  child.on('close', (code) => {
    onClose?.()
    process.exit(code ?? 1)
  })
}

if (total <= LIMIT) {
  run([inner, rustc, ...args])
} else {
  const dir = mkdtempSync(join(tmpdir(), 'rustc-resp-'))
  const file = join(dir, 'args.txt')
  writeFileSync(file, args.join('\n') + '\n', 'utf8')
  console.error(`[rustc-wrapper] 命令行 ${total} 字符超阈值，改用响应文件 ${file}`)
  run([inner, rustc, '@' + file], () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败不阻断构建（系统 tmp 会回收） */
    }
  })
}
