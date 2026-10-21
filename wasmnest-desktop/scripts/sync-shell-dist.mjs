#!/usr/bin/env node

/**
 * sync-shell-dist —— 把宿主壳前端从 `dist/` 同步进随 crate 分发的 `src-tauri/shell-dist/`
 *
 * ## 为什么需要它
 *
 * L2（`.scratch/2026-10-21-host-runtime-distribution/spec.md` D4 / CONTRACT §5.1）：
 * `wasmnest-desktop-runtime` 要能被 `cargo install` / 作为编译期依赖消费，壳上下文
 * （`tauri.conf.json` + 前端产物）必须**随 crate 走**。`dist/` 是 vite 产物（gitignore），
 * `src-tauri/shell-dist/` 是**签入**的发布物；两者由本脚本单向同步：
 *
 * ```text
 * wasmnest-desktop/dist/{index.html,assets/**,favicon.*,splash.css,mock-terminal.html,…}
 *   → wasmnest-desktop/src-tauri/shell-dist/   （排除 dist/host-desktop/ —— host:pack 产物）
 * ```
 *
 * ## 用法
 *
 * ```bash
 * cd wasmnest/wasmnest-desktop
 * node scripts/sync-shell-dist.mjs          # 同步（发布 / 更新壳后跑，产物随提交签入）
 * node scripts/sync-shell-dist.mjs --check  # 只比对：缺失 / 差异 / 多余文件 → 非零退出
 * ```
 *
 * `--check` = 壳漂移锁：`check-runtime-crate.mjs` 在 `dist/` 在场时调用它；干净
 * checkout（没有 `dist/`）由门禁打印跳过提示。源 `dist/` 缺失时本脚本 fail-visible，
 * 提示先 `pnpm run build`（不静默生成空壳）。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(__dirname, '..')
const SOURCE_DIR = join(DESKTOP_ROOT, 'dist')
const TARGET_DIR = join(DESKTOP_ROOT, 'src-tauri', 'shell-dist')

/** 顶层排除项：host:pack 产物（宿主二进制目录），不是壳前端 */
const EXCLUDED_TOP_LEVEL = new Set(['host-desktop'])

const checkMode = process.argv.includes('--check')

function fail(message) {
  console.error(`[sync-shell-dist] ${message}`)
  process.exit(1)
}

/** 递归收集文件相对路径（统一 `/` 分隔；跳过顶层排除项） */
function collectFiles(rootDir, options = {}) {
  const { excludedTopLevel = new Set() } = options
  const files = []

  function walk(current, prefix) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (prefix === '' && excludedTopLevel.has(entry.name)) continue
      if (entry.name === '.DS_Store') continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const abs = join(current, entry.name)
      if (entry.isDirectory()) walk(abs, rel)
      else if (entry.isFile()) files.push(rel)
      else if (entry.isSymbolicLink()) fail(`不支持符号链接（发布物需可复现）：${abs}`)
    }
  }

  walk(rootDir, '')
  return files.sort()
}

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function diffTrees(sourceFiles, targetFiles) {
  const sourceSet = new Set(sourceFiles)
  const targetSet = new Set(targetFiles)

  const missing = sourceFiles.filter((file) => !targetSet.has(file))
  const extra = targetFiles.filter((file) => !sourceSet.has(file))
  const changed = sourceFiles.filter((file) => {
    if (!targetSet.has(file)) return false
    const src = join(SOURCE_DIR, file)
    const dst = join(TARGET_DIR, file)
    return statSync(src).size !== statSync(dst).size || sha256Of(src) !== sha256Of(dst)
  })

  return { missing, extra, changed }
}

function formatList(title, files) {
  return files.length === 0 ? '' : `${title}:\n  - ${files.join('\n  - ')}\n`
}

function main() {
  if (!existsSync(SOURCE_DIR)) {
    fail(`源前端目录不存在：${SOURCE_DIR}\n  先构建宿主前端（cd wasmnest-desktop && pnpm run build），再跑本脚本`)
  }
  if (!existsSync(join(SOURCE_DIR, 'index.html'))) {
    fail(`源前端目录不完整（缺 index.html）：${SOURCE_DIR}\n  重新 pnpm run build 后再同步`)
  }

  const sourceFiles = collectFiles(SOURCE_DIR, { excludedTopLevel: EXCLUDED_TOP_LEVEL })
  const targetFiles = existsSync(TARGET_DIR) ? collectFiles(TARGET_DIR) : []

  if (checkMode) {
    const { missing, extra, changed } = diffTrees(sourceFiles, targetFiles)
    const drift = missing.length + extra.length + changed.length
    if (drift > 0) {
      console.error(
        `[sync-shell-dist] shell-dist 与 dist 漂移（${drift} 个文件）：\n` +
          formatList('缺同步（dist 有、shell-dist 无）', missing) +
          formatList('陈旧（shell-dist 有、dist 无）', extra) +
          formatList('内容不同', changed) +
          '  修复：node scripts/sync-shell-dist.mjs（产物随提交签入）',
      )
      process.exit(1)
    }
    console.log(`[sync-shell-dist] OK：shell-dist 与 dist 一致（${sourceFiles.length} 个文件）`)
    return
  }

  const { missing, extra, changed } = diffTrees(sourceFiles, targetFiles)
  for (const file of [...missing, ...changed]) {
    const dest = join(TARGET_DIR, ...file.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(SOURCE_DIR, ...file.split('/')), dest)
  }
  for (const file of extra) {
    rmSync(join(TARGET_DIR, ...file.split('/')), { force: true })
  }
  // 清理空目录（extra 文件删除后可能留下空壳）
  removeEmptyDirs(TARGET_DIR)

  console.log(
    `[sync-shell-dist] 已同步 ${sourceFiles.length} 个文件 → ${relative(DESKTOP_ROOT, TARGET_DIR)}` +
      `（新增 ${missing.length} / 更新 ${changed.length} / 删除 ${extra.length}）`,
  )
}

/** 自底向上删空目录（保留 shell-dist 根） */
function removeEmptyDirs(root) {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const child = join(root, entry.name)
    removeEmptyDirs(child)
    if (readdirSync(child).length === 0) rmSync(child, { recursive: true, force: true })
  }
}

main()

// 供测试 / 门禁引用的路径常量（`sep` 仅用于保持跨平台路径形态显式可见）
export const PATHS = {
  desktopRoot: DESKTOP_ROOT,
  sourceDir: SOURCE_DIR,
  targetDir: TARGET_DIR,
  relativeTarget: relative(DESKTOP_ROOT, TARGET_DIR).split(sep).join('/'),
}
