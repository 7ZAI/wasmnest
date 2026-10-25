/**
 * `wasmnest-plugin validate` 权限白名单回归
 *
 * CLI 的 `VALID_PERMISSIONS` 是权限词汇在 JS 侧的硬编码副本（真源是
 * `rust/src/permission.rs`）。本用例直接跑真实子进程，确保新增权限位在
 * `validate` 里被接受——只改常量的单测会漏掉「忘了同步白名单」的 P0。
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// VALID_* 常量 2026-10-25 随 CLI 拆分迁 bin/scaffold.js（白名单真源随迁）
// VALID_* 常量 2026-10-25 随 CLI 拆分迁 bin/scaffold.js（源码扫描目标随迁）
const CLI = fileURLToPath(new URL('../bin/scaffold.js', import.meta.url))
// 运行时入口仍是 bin/cli.js（门面持有 main 派发）
const CLI_ENTRY = fileURLToPath(new URL('../bin/cli.js', import.meta.url))
const RUST_PERMISSION = fileURLToPath(new URL('../rust/src/permission.rs', import.meta.url))

/** CLI 里的 JS 白名单（解析 Set 字面量，避免为测试导出运行时内部常量） */
function cliPermissions(): string[] {
  const source = readFileSync(CLI, 'utf-8')
  const block = source.match(/const VALID_PERMISSIONS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? ''
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
}

/** Rust 真源 `VALID_PERMISSIONS`（解析常量定义 + static 列表，只取真正在册的） */
function rustPermissions(): string[] {
  const source = readFileSync(RUST_PERMISSION, 'utf-8')
  const constants = new Map(
    [...source.matchAll(/pub const (PERMISSION_[A-Z0-9_]+): &str = "([^"]+)";/g)].map((m) => [
      m[1],
      m[2],
    ]),
  )
  const block =
    source.match(/pub static VALID_PERMISSIONS: &\[&str\] = &\[([\s\S]*?)\];/)?.[1] ?? ''
  return [...block.matchAll(/(PERMISSION_[A-Z0-9_]+)/g)]
    .map((m) => constants.get(m[1]))
    .filter((permission): permission is string => Boolean(permission))
    .sort()
}

function runValidate(permissions: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'wasmnest-cli-'))
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      id: 'com.example.cli-fixture',
      name: 'CLI Fixture',
      version: '0.0.1',
      platform: 'mobile',
      main: 'index.js',
      pluginType: 'wasm',
      rustLibrary: 'wasmnest_plugin_cli_fixture',
      permissions,
      contributes: {},
    }),
  )
  try {
    return spawnSync(process.execPath, [CLI_ENTRY, 'validate', '--dir', dir], {
      encoding: 'utf-8',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('wasmnest-plugin validate 权限白名单', () => {
  it('白名单与 Rust 权限真源逐项一致（防第五份副本漂移）', () => {
    expect(cliPermissions()).toEqual(rustPermissions())
  })

  it('接受 metrics:read（与 SDK 权限真源同步）', () => {
    const result = runValidate(['metrics:read'])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('validate 通过')
  })

  it('仍然拒绝未知权限（白名单不是放行一切）', () => {
    const result = runValidate(['quantum:entangle'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('未知权限: quantum:entangle')
  })
})
