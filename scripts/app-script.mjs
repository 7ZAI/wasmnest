#!/usr/bin/env node
/**
 * 在应用仓的某个 app 工程里跑一条 package.json 脚本 —— 三仓拆分 spec §5-E7。
 *
 * 用法：`node scripts/app-script.mjs <slug> <desktop|mobile> <script> [args...]`
 *
 * 为什么需要它：平台仓 `package.json` 的脚本不能跨仓 `pnpm -C <相对路径>` 写死
 * 应用工程路径（apps 仓位置由 `WASMNEST_APPS_ROOT` / R1 兄弟布局决定，见
 * `scripts/app-paths.mjs`）。本脚本解析出应用工程目录后转发 `pnpm run <script>`，
 * 子进程退出码原样透传（失败不被吞）。
 */
import { spawn } from 'node:child_process'
import { appDir } from './app-paths.mjs'

const [, , slug, end, script, ...extra] = process.argv
if (!slug || !end || !script) {
  console.error('用法：node scripts/app-script.mjs <slug> <desktop|mobile> <script> [args...]')
  process.exit(2)
}

const cwd = appDir(slug, end)
console.log(`[app-script] pnpm run ${script} @ ${cwd}`)
const child = spawn('pnpm', ['run', script, ...extra], {
  cwd,
  stdio: 'inherit',
  // Windows 上 pnpm 是 .cmd，需要 shell 才能解析
  shell: process.platform === 'win32',
})
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : code ?? 1)
})
