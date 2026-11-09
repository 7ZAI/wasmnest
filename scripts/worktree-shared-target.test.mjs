/**
 * worktree-shared-target.mjs 契约测试
 *
 * 行为契约：
 * | 契约ID | 来源 | 规则 |
 * | C-001 | parseArgs 默认 | 无参数 ⇒ 三个开关全 false、container=null |
 * | C-002 | parseArgs 开关 | --dry-run/--migrate/--force 各自独立置位；--container <p> 解析为绝对路径 |
 * | C-003 | readTargetDir | `[build] target-dir` 相对值按 **config 所在目录** 解析；绝对值原样返回 |
 * | C-004 | readTargetDir | 无 .cargo/config(.toml) 或无 target-dir ⇒ null |
 * | C-005 | nearestTargetDirConfig | 祖先（含 worktree 根）声明 target-dir ⇒ 返回其解析结果；否则 null |
 * | C-006 | collectCandidates | crate 自己声明 target-dir ⇒ 不再单独产出 `<crate>/target`（避免重复桶） |
 * | C-007 | collectCandidates | 无 target-dir 祖先配置的 crate / 宿主 src-tauri 各自产出 `<dir>/target` |
 * | C-008 | collectCandidates | 每 crate config 的落点（lib 的 `../target/server-libs`）被收进候选 |
 * | C-009 | collectCandidates | worktree 根 `target` 恒在（lib 顶层桶的父目录） |
 * | C-010 | collectCandidates | 仓根 config 声明 target-dir（apps 的 `target/wasm-apps`）⇒ 全仓只收该桶 |
 * | C-011 | collectCandidates | 指到 worktree 之外的 target-dir（绝对路径越界）被过滤 |
 * | C-012 | collectCandidates | 按路径长度升序（父目录先建，子路径被父链接覆盖） |
 * | C-013 | collectCandidates | node_modules 下的 Cargo.toml 不参与 |
 *
 * 副作用：import 本模块不应触发 main（有 import.meta.url 守卫）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  collectCandidates,
  nearestTargetDirConfig,
  parseArgs,
  readTargetDir,
} from './worktree-shared-target.mjs'

const writeFile = (file, content = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/**
 * lib/平台型 worktree：仓根 config 只有 jobs（无 target-dir），每 crate 自己声明或走默认。
 * 对应真实布局：wasmnest（平台，仓根无 target-dir）与 wasmnest-lib（每 crate 指向
 * `../target/server-libs` / `../target/host-kits`）。
 */
function makeLibLikeWorktree() {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-lib-'))
  writeFile(path.join(wt, '.cargo', 'config.toml'), '[build]\njobs = 4\n')
  writeFile(path.join(wt, 'plain', 'Cargo.toml'), '[package]\nname = "plain"\n')
  writeFile(path.join(wt, 'c1', 'Cargo.toml'), '[package]\nname = "c1"\n')
  writeFile(
    path.join(wt, 'c1', '.cargo', 'config.toml'),
    '[build]\ntarget-dir = "../target/server-libs"\n',
  )
  writeFile(path.join(wt, 'c2', 'Cargo.toml'), '[package]\nname = "c2"\n')
  writeFile(
    path.join(wt, 'c2', '.cargo', 'config.toml'),
    '[build]\ntarget-dir = "/definitely/outside/bucket"\n',
  )
  writeFile(path.join(wt, 'host', 'src-tauri', 'Cargo.toml'), '[package]\nname = "host"\n')
  writeFile(path.join(wt, 'node_modules', 'pkg', 'Cargo.toml'), '[package]\nname = "noise"\n')
  return wt
}

/** apps 型 worktree：仓根 config 统一 `target-dir = "target/wasm-apps"`。 */
function makeAppsLikeWorktree() {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-apps-'))
  writeFile(path.join(wt, '.cargo', 'config.toml'), '[build]\ntarget-dir = "target/wasm-apps"\n')
  writeFile(
    path.join(wt, 'apps', 'bedcode', 'desktop', 'rust', 'Cargo.toml'),
    '[package]\nname = "bedcode"\n',
  )
  return wt
}

describe('parseArgs', () => {
  it('C-001：无参数 ⇒ 全 false、container=null', () => {
    assert.deepEqual(parseArgs([]), {
      dryRun: false,
      migrate: false,
      force: false,
      container: null,
    })
  })

  it('C-002：开关独立置位，--container 解析为绝对路径', () => {
    assert.deepEqual(parseArgs(['--dry-run', '--migrate', '--force', '--container', '/tmp/ct']), {
      dryRun: true,
      migrate: true,
      force: true,
      container: '/tmp/ct',
    })
  })
})

describe('readTargetDir / nearestTargetDirConfig', () => {
  it('C-003：相对值按 config 所在目录解析；绝对值原样', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-rd-'))
    writeFile(
      path.join(root, 'rel', '.cargo', 'config.toml'),
      '[build]\ntarget-dir = "../target/server-libs"\n',
    )
    writeFile(
      path.join(root, 'abs', '.cargo', 'config.toml'),
      '[build]\ntarget-dir = "/abs/bucket"\n',
    )
    assert.equal(readTargetDir(path.join(root, 'rel')), path.join(root, 'target', 'server-libs'))
    assert.equal(readTargetDir(path.join(root, 'abs')), '/abs/bucket')
  })

  it('C-004：无 config 或无 target-dir ⇒ null', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-rd2-'))
    writeFile(path.join(root, 'none', 'Cargo.toml'), '')
    writeFile(path.join(root, 'empty', '.cargo', 'config.toml'), '[build]\njobs = 4\n')
    assert.equal(readTargetDir(path.join(root, 'none')), null)
    assert.equal(readTargetDir(path.join(root, 'empty')), null)
  })

  it('C-005：祖先配置命中返回解析值；无祖先配置返回 null', () => {
    const wt = makeLibLikeWorktree()
    assert.equal(
      nearestTargetDirConfig(path.join(wt, 'c1'), wt),
      path.join(wt, 'target', 'server-libs'),
    )
    assert.equal(nearestTargetDirConfig(path.join(wt, 'plain'), wt), null)
  })
})

describe('collectCandidates（lib/平台型 worktree）', () => {
  const wt = makeLibLikeWorktree()
  const got = collectCandidates(wt)
  const has = (p) => got.includes(path.join(wt, p))

  it('C-006：crate 自己声明 target-dir ⇒ 不产出自己的 <crate>/target', () => {
    assert.equal(has('c1/target'), false, 'c1 的落点由配置决定，不应再建 c1/target')
  })

  it('C-007：无配置 crate 与宿主 src-tauri 各自产出 <dir>/target', () => {
    assert.equal(has('plain/target'), true)
    assert.equal(has(path.join('host', 'src-tauri', 'target')), true)
  })

  it('C-008：每 crate config 的落点被收集', () => {
    assert.equal(has(path.join('target', 'server-libs')), true)
  })

  it('C-009：worktree 根 target 恒在', () => {
    assert.equal(has('target'), true)
  })

  it('C-011：指到 worktree 之外的 target-dir 被过滤', () => {
    assert.equal(
      got.some((p) => p.startsWith('/definitely/outside')),
      false,
    )
    for (const p of got) {
      const relToWt = path.relative(wt, p)
      assert.ok(relToWt && !relToWt.startsWith('..'), `候选必须位于 worktree 内：${p}`)
    }
  })

  it('C-012：按路径长度升序（父目录先建）', () => {
    const lens = got.map((p) => p.length)
    assert.deepEqual(
      lens,
      [...lens].sort((a, b) => a - b),
    )
  })

  it('C-013：node_modules 下的 Cargo.toml 不参与', () => {
    assert.equal(
      got.some((p) => p.includes('node_modules')),
      false,
    )
  })
})

describe('collectCandidates（apps 型 worktree）', () => {
  const wt = makeAppsLikeWorktree()
  const got = collectCandidates(wt)

  it('C-010：仓根 config 的 target-dir 生效 ⇒ 只收该桶（app crate 不再各建 target）', () => {
    const rels = got.map((p) => path.relative(wt, p))
    assert.deepEqual(rels, ['target', 'target/wasm-apps'])
  })
})
