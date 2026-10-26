#!/usr/bin/env node
/**
 * markdown 死链检查（issue #14 / spec `.scratch/2026-10-23-quality-hardening` §9.3）
 *
 * 谁写：平台仓文档维护；谁读：husky pre-commit（暂存含 .md 时）与开发者手动跑。
 * 四仓统一的轻量脚本，零第三方依赖（仅 node 内置）。
 *
 * 覆盖面（明确说清，不做假绿）：
 *  - 仓内**跟踪**的 markdown 文件（`git ls-files '*.md'`——node_modules / dist /
 *    target / resources 产物天然不在内）；
 *  - 解析形态：行内链接 `[t](target)`、图片 `![alt](target)`、链接引用定义
 *    `[label]: target`；代码围栏（``` / ~~~）内的样本不检查；
 *  - **相对链接必查**：剥掉 `#anchor` 后按文件所在目录解析，目标（文件或目录）
 *    必须存在；`/` 开头按仓库根解析；`%xx` 百分号编码先解码；
 *  - **外链 URL（http(s) / mailto 等带 scheme 的）与纯锚点（#xxx）不查**——
 *    外链探测受网络环境（代理）影响，不探测就不冒充绿灯；锚点一致性不在此锁内；
 *  - 脚注（`[^x]`）不是链接，跳过。
 *
 * 用法：
 *   node scripts/check-markdown-links.mjs          # 全量（pnpm run check:links）
 * 退出码：0 = 无死链；1 = 有死链（逐条列出文件:行号 -> 目标与解析结果）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 仓库内跟踪的 markdown 清单（产物目录天然不在 git 索引里） */
function trackedMarkdownFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '*.md'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return out.split('\n').filter(Boolean).map((p) => p.replace(/\\/g, '/'))
  } catch (err) {
    console.error(`:: 无法列出跟踪文件（git ls-files 失败：${err.message}）。`)
    process.exit(1)
  }
}

/** 带 scheme 前缀（http: / https: / mailto: / data: …）视为外链，跳过 */
const EXTERNAL = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/

/**
 * 提取一个 markdown 文件里的相对链接目标。
 * 返回 [{ line, target }]（行号从 1 起）；跳过代码围栏内的内容。
 */
function extractLinks(text) {
  const links = []
  const lines = text.split('\n')
  let inFence = false
  lines.forEach((raw, i) => {
    const fence = raw.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fence) {
      inFence = !inFence
      return
    }
    if (inFence) return

    const line = raw

    // 行内链接与图片：[text](target) / ![alt](target)，target 可带 <>
    for (const m of line.matchAll(/(!?)\[((?:[^[\]]|\[[^\]]*\])*)\]\(<*([^)<>\s]+)(?:\s+"[^"]*")?>*\)/g)) {
      const label = m[2]
      if (label.startsWith('^')) continue // 脚注
      links.push({ line: i + 1, target: m[3] })
    }

    // 链接引用定义：[label]: target "title"（脚注定义跳过）
    const def = line.match(/^\s{0,3}\[([^\]^][^\]]*)\]:\s*<*(\S+?)>*(?:\s+"[^"]*")?\s*$/)
    if (def) links.push({ line: i + 1, target: def[2] })
  })
  return links
}

/** 相对目标解析为仓库内绝对路径；返回 null 表示不在检查范围（外链 / 纯锚点 / 空） */
function resolveTarget(fromFile, target) {
  const t = target.trim()
  if (!t || t.startsWith('#')) return null
  if (EXTERNAL.test(t)) return null
  let pathPart = t.split('#')[0]
  if (!pathPart) return null
  try {
    pathPart = decodeURIComponent(pathPart)
  } catch {
    // 非法编码按原样检查
  }
  const base = pathPart.startsWith('/') ? repoRoot : resolve(repoRoot, dirname(fromFile))
  return resolve(base, pathPart)
}

const files = trackedMarkdownFiles()
const dead = []
let relativeCount = 0
let externalCount = 0

for (const file of files) {
  const text = readFileSync(resolve(repoRoot, file), 'utf-8')
  for (const { line, target } of extractLinks(text)) {
    const resolved = resolveTarget(file, target)
    if (resolved === null) {
      externalCount += 1
      continue
    }
    relativeCount += 1
    if (!existsSync(resolved)) {
      dead.push({ file, line, target, resolved })
    }
  }
}

if (dead.length > 0) {
  console.error(`:: markdown 死链 ${dead.length} 处：`)
  for (const { file, line, target, resolved } of dead) {
    console.error(`  - ${file}:${line} -> ${target}（解析为 ${resolved}，不存在）`)
  }
  console.error('   修复目标文件 / 链接后重跑：pnpm run check:links')
  process.exit(1)
}

console.log(
  `✓ markdown 死链检查：扫描 ${files.length} 个文件，相对链接 ${relativeCount} 条，死链 0` +
    `（外链 / 锚点 ${externalCount} 条不在检查范围，未探测——不做假绿）`,
)
