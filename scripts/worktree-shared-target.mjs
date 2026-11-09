#!/usr/bin/env node
/**
 * worktree-shared-target.mjs —— 让四仓的 git worktree 共用仓外的 target 桶，止住「每棵
 * worktree 一份完整 Rust 依赖图」导致的磁盘爆仓（2026-11-08 方案 A 的落地实现）。
 *
 * —— 问题 ——
 * 四仓的 `.cargo/config.toml` 用**相对路径**（`target/wasm-apps`、`../target/server-libs`），
 * 而 cargo 按**config 所在目录**解析相对路径。worktree 里 config 跟着代码走，于是每棵
 * worktree 各自长出一整套 target：桌面宿主 8~12G、移动宿主 8~9G、lib 的 server-libs /
 * host-kits 9~24G。多会话并行时磁盘按「worktree 数量 × 上述体量」爆掉（2026-11-08 一天
 * 清了 3 轮共 ~190G）。
 *
 * cargo 不支持「相对路径指到 checkout 之外」（主树 depth 0，worktree depth ≥ 2），
 * `[env] CARGO_TARGET_DIR` 也不影响 cargo 自己的 target 解析（2026-11-08 实测：产物仍落
 * `<crate>/target`）。因此本脚本用**符号链接**把 cargo 会写到的那批路径重定向到共享桶：
 *   <worktree>/target                      → <container>/target-shared/<repo>/target
 *   <worktree>/<crate>/target              → …/<repo>/<crate>/target
 *   <worktree>/<host>/src-tauri/target     → …/<repo>/<host>/src-tauri/target
 * 仓库里既有的相对 `target-dir`（含 `../target/server-libs`、`target/wasm-apps`）会**穿过
 * 链接**落到共享桶的对应子路径 —— 主树配置零改动、CI 零影响（脚本与共享桶都在仓外 / 仅本机），
 * 不同 repo 仍是各自独立的桶（不把四仓塞进一个 target 抢同一把 cargo 锁）。
 *
 * —— 边界 ——
 * - 只处理 `git worktree list` 登记、且**不是主树**的 worktree；主树布局完全不动。
 * - **正在构建的 worktree 整体跳过**（按 `/proc/<pid>/cwd` 判定）：在活构建里换链接会直接
 *   打断对方（2026-11-08 实测事故两次）。脚本幂等，随时可重跑。
 * - 目标位已是真实目录（有历史产物）：默认只报告不动，`--migrate` 才把内容并入共享桶再建链接。
 * - 链接指错地方：只报告，`--force` 才替换。
 * - `rm -rf <worktree>/target` 只删链接、不省空间；清理请删 `<container>/target-shared`。
 *
 * —— 用法 ——
 *   node scripts/worktree-shared-target.mjs --dry-run     # 只看会做什么
 *   node scripts/worktree-shared-target.mjs               # 建链接（不迁移既有产物）
 *   node scripts/worktree-shared-target.mjs --migrate     # 并把既有 target 内容并入共享桶
 *   node scripts/worktree-shared-target.mjs --force       # 替换指错地方的链接
 *   node scripts/worktree-shared-target.mjs --container <容器根绝对路径>
 * 容器根默认按脚本位置推断（`<container>/wasmnest/scripts/`）。
 *
 * —— 并行构建逃生阀 ——
 * 同一 repo 的多棵 worktree 现在共用一个桶，同时构建会互相等 cargo 的 target 锁。确需并行时
 * 让该会话自带独立桶：`CARGO_TARGET_DIR=/tmp/wt-<name> pnpm run test:run`（env 压过一切
 * config/链接），用完自行清理。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPOS = ['wasmnest', 'wasmnest-lib', 'wasmnest-apps', 'wasmnest-test']
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'gen', 'dist', 'dist-host'])
const MAX_DEPTH = 6

export function parseArgs(argv) {
  const flag = (name) => argv.includes(name)
  const i = argv.indexOf('--container')
  return {
    dryRun: flag('--dry-run'),
    migrate: flag('--migrate'),
    force: flag('--force'),
    container: i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : null,
  }
}

const isSymlink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

const exists = (p) => {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** 读 configDir/.cargo/config(.toml) 的 `[build] target-dir`；无则 null。 */
export function readTargetDir(configDir) {
  for (const name of ['config.toml', 'config']) {
    const cfg = path.join(configDir, '.cargo', name)
    if (!exists(cfg)) continue
    const m = fs.readFileSync(cfg, 'utf8').match(/^\s*target-dir\s*=\s*["']([^"']+)["']/m)
    if (!m) continue
    return path.isAbsolute(m[1]) ? m[1] : path.resolve(configDir, m[1])
  }
  return null
}

/** 从 dir 向上（含 worktree 根）找最近一个声明了 target-dir 的 .cargo/config 解析结果。 */
export function nearestTargetDirConfig(dir, worktree) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (d.startsWith(worktree)) {
      const target = readTargetDir(d)
      if (target) return target
    }
    if (d === worktree || path.dirname(d) === d) return null
  }
}

/**
 * 收集「cargo 会在本 worktree 里写产物」的候选路径（绝对路径，均位于 worktree 内）。
 * 规则：① 含 Cargo.toml 且祖先无 target-dir 配置的目录 → `<dir>/target`；
 *       ② 所有声明了 target-dir 的 .cargo/config → 解析出的目录（含仓根，如 apps 的
 *          `target/wasm-apps`、lib 每 crate 的 `../target/server-libs`）；③ worktree 根 `target`。
 */
export function collectCandidates(worktree) {
  const out = new Set()
  const crateDirs = []

  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.isFile() && e.name === 'Cargo.toml')) crateDirs.push(dir)
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), depth + 1)
    }
  }
  walk(worktree, 0)

  for (const dir of crateDirs) {
    if (nearestTargetDirConfig(dir, worktree)) continue
    out.add(path.join(dir, 'target'))
  }

  const collectConfigs = (dir, depth) => {
    if (depth > MAX_DEPTH) return
    const target = readTargetDir(dir)
    if (target) out.add(target)
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue
      collectConfigs(path.join(dir, e.name), depth + 1)
    }
  }
  collectConfigs(worktree, 0)

  out.add(path.join(worktree, 'target'))

  return [...out]
    .filter((p) => {
      const rel = path.relative(worktree, p)
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    })
    .sort((a, b) => a.length - b.length)
}

/** 正在构建的目录（cargo/rustc/rust-analyzer 进程的 cwd，已 realpath）。 */
export function liveBuildDirs() {
  const dirs = []
  let pids = []
  try {
    pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))
  } catch {
    return dirs
  }
  for (const pid of pids) {
    let cmd = ''
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    } catch {
      continue
    }
    if (!/(^|\0|\/)(cargo|rustc|rust-analyzer)\0/.test(cmd)) continue
    try {
      dirs.push(fs.realpathSync(`/proc/${pid}/cwd`))
    } catch {
      /* 进程已退出 */
    }
  }
  return dirs
}

function listWorktrees(repoDir) {
  let raw
  try {
    raw = execFileSync('git', ['-C', repoDir, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    })
  } catch {
    return null
  }
  return raw
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
}

function main() {
  const { dryRun, migrate, force, container: containerArg } = parseArgs(process.argv.slice(2))
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const container = containerArg ?? path.resolve(scriptDir, '..', '..')
  const sharedRoot = path.join(container, 'target-shared')
  const log = (...a) => console.log(...a)
  const rel = (p) => path.relative(container, p)

  const stats = {
    created: 0,
    linked: 0,
    skippedReal: 0,
    skippedWrong: 0,
    replaced: 0,
    migrated: 0,
    skippedBusy: 0,
    failed: 0,
  }

  const busyDirs = liveBuildDirs()
  log(`容器根：${container}`)
  log(`共享桶：${sharedRoot}`)
  log(dryRun ? '模式：--dry-run（不落盘）' : '模式：执行')
  if (busyDirs.length > 0) {
    log(`\n构建中的目录（其所在 worktree 本轮跳过）：`)
    for (const d of new Set(busyDirs)) log(`   · ${d}`)
  }
  log('')

  for (const repo of REPOS) {
    const repoDir = path.join(container, repo)
    if (!exists(repoDir)) {
      log(`⚠️  ${repo} 不存在，跳过`)
      continue
    }
    let repoMain
    try {
      repoMain = execFileSync('git', ['-C', repoDir, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      }).trim()
    } catch {
      log(`⚠️  ${repo} 不是 git 仓库，跳过`)
      continue
    }
    const worktrees = (listWorktrees(repoDir) ?? []).filter(
      (wt) => path.resolve(wt) !== path.resolve(repoMain),
    )
    if (worktrees.length === 0) continue

    log(`== ${repo}（${worktrees.length} 棵 worktree）`)
    const repoShared = path.join(sharedRoot, repo)

    for (const wt of worktrees) {
      const wtReal = (() => {
        try {
          return fs.realpathSync(wt)
        } catch {
          return path.resolve(wt)
        }
      })()
      if (busyDirs.some((d) => d === wtReal || d.startsWith(wtReal + path.sep))) {
        log(`-- ${rel(wt)}：⏳ 构建中，跳过（稍后重跑本脚本）`)
        stats.skippedBusy += 1
        continue
      }
      log(`-- ${rel(wt)}`)

      const seenLinks = new Set()
      for (const cand of collectCandidates(wt)) {
        const candRel = path.relative(wt, cand)
        const dest = path.join(repoShared, candRel)
        const display = `${candRel} → ${rel(dest)}`

        let covered = false
        for (let anc = path.dirname(cand); anc.length > wt.length; anc = path.dirname(anc)) {
          if (seenLinks.has(anc) || isSymlink(anc)) {
            covered = true
            break
          }
        }
        if (covered) {
          stats.linked += 1
          continue
        }

        if (isSymlink(cand)) {
          const target = path.resolve(path.dirname(cand), fs.readlinkSync(cand))
          if (target === path.resolve(dest)) {
            stats.linked += 1
            continue
          }
          if (!force) {
            log(`   ⚠️  ${display}：已是指向 ${target} 的链接，未动（--force 可替换）`)
            stats.skippedWrong += 1
            continue
          }
          if (!dryRun) fs.unlinkSync(cand)
          stats.replaced += 1
          log(`   🔁 替换错误链接 ${display}`)
        } else if (exists(cand)) {
          if (!migrate) {
            log(`   ⚠️  ${display}：已是真实目录，未动（--migrate 可并入共享桶）`)
            stats.skippedReal += 1
            continue
          }
          stats.migrated += 1
          log(`   📦 迁移 ${display}`)
          if (!dryRun) {
            fs.mkdirSync(dest, { recursive: true })
            for (const entry of fs.readdirSync(cand)) {
              fs.renameSync(path.join(cand, entry), path.join(dest, entry))
            }
            fs.rmdirSync(cand)
          }
        } else {
          log(`   ✅ 新建链接 ${display}`)
          stats.created += 1
        }

        seenLinks.add(cand)
        if (dryRun) continue
        try {
          fs.mkdirSync(dest, { recursive: true })
          fs.mkdirSync(path.dirname(cand), { recursive: true })
          fs.symlinkSync(dest, cand, 'dir')
        } catch (err) {
          stats.failed += 1
          log(`   ❌ 建链接失败 ${display}：${err.code} ${err.message}`)
        }
      }
    }
  }

  log(
    `\n汇总：新建 ${stats.created} · 迁移 ${stats.migrated} · 替换 ${stats.replaced} · ` +
      `已就绪(链接/被父链接覆盖) ${stats.linked} · 真实目录跳过 ${stats.skippedReal} · ` +
      `错链跳过 ${stats.skippedWrong} · 构建中跳过 ${stats.skippedBusy} · 失败 ${stats.failed}`,
  )
  if (dryRun) log('（--dry-run：以上均未落盘）')
  log(`\n清理产物请删 ${sharedRoot} 下的内容；删 worktree 里的 target 只删链接，不省空间。`)
  if (stats.failed > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
