/**
 * manifest-gen 前端权限推导：`session:read` 必须来自真实会话 API 用法
 *
 * 回归背景（2026-10-22 monitor 迁 servers）：旧规则 `\\.(session)\\b` 会把任意含
 * `.session` 的字符串当成 API 使用——i18n key `monitor.footer.session` 因此让
 * `pnpm run build` 静默给 monitor 的 plugin.json 加了一条从未使用的
 * `session:read`（最小权限被破坏，且每次构建都幂等加回，手删会被覆盖）。
 *
 * 本文件锁住两档：
 * - 负例：文案 / i18n key 里的 `.session` 不推出权限；
 * - 正例：`context.session.list()` / `.get()` / `.onStatusChange()` 仍推出权限。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateManifest } from '../bin/manifest-gen.js'

let cwd = ''

const BASE_MANIFEST = JSON.stringify(
  {
    id: 'com.example.test',
    name: 'Test Plugin',
    version: '1.0.0',
    platform: 'mobile',
    description: 'test',
    author: 'me',
    main: 'index.js',
    pluginType: 'wasm',
    rustLibrary: 'test_plugin',
    permissions: [],
    contributes: {},
  },
  null,
  2,
)

function scaffold(frontend: string): void {
  const file = join(cwd, 'src', 'index.ts')
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(file, frontend, 'utf-8')
  writeFileSync(join(cwd, 'plugin.json'), BASE_MANIFEST, 'utf-8')
}

function permissionsOf(): string[] {
  return JSON.parse(readFileSync(join(cwd, 'plugin.json'), 'utf-8')).permissions
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'mobile-manifest-gen-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('session:read 推导', () => {
  it('i18n key / 普通字符串里的 .session 不推出 session:read', () => {
    scaffold(
      [
        `const messages = { 'monitor.footer.session': 'This session · cleared on close' }`,
        `export function activate(context: any) { return messages['monitor.footer.session'] }`,
      ].join('\n'),
    )

    const { report } = generateManifest(cwd)
    expect(permissionsOf()).toEqual([])
    expect(report.join('\n')).not.toContain('session:read')
  })

  it('context.session.list() 仍推出 session:read', () => {
    scaffold(
      [
        `export async function activate(context: any) {`,
        `  const sessions = await context.session.list()`,
        `  return sessions.length`,
        `}`,
      ].join('\n'),
    )

    generateManifest(cwd)
    expect(permissionsOf()).toContain('session:read')
  })

  it('context.session.get(id) / onStatusChange() 仍推出 session:read', () => {
    scaffold(
      [
        `export async function activate(context: any) {`,
        `  await context.session.get('s-1')`,
        `  context.session.onStatusChange(() => {})`,
        `}`,
      ].join('\n'),
    )

    generateManifest(cwd)
    expect(permissionsOf()).toContain('session:read')
  })
})
