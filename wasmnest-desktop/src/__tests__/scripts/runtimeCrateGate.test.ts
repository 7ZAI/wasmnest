import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// 门禁脚本不是 TS 工程的一部分，这里直接引真实实现（只导出纯函数，无副作用）
import {
  REQUIRED_PACKAGE_ENTRIES,
  missingRequiredEntries,
  parseCargoPackageList,
  parseCrateIdentity,
} from '../../../scripts/check-runtime-crate.mjs'

/**
 * 通用 runtime crate（`wasmnest-desktop-runtime`）的打包门禁契约
 *
 * 背景：L2 把 `src-tauri` 的 lib 角色做成唯一可发布 crate，壳前端随包分发
 * （`shell-dist/`）。`cargo package` 的 include 清单一旦漏掉壳或能力声明，
 * 发布出去的 crate 会在 `cargo install` 后启动即失败——这条锁把「包内必须
 * 有什么」和「crate 身份」钉在门禁脚本的纯函数上。
 */

const here = dirname(fileURLToPath(import.meta.url))
const srcTauri = join(here, '..', '..', '..', 'src-tauri')

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(srcTauri, rel), 'utf-8'))
}

/** 真实 `cargo package --list` 的形态（含 Cargo 自动追加的 Cargo.toml / 换行差异） */
const PACKAGE_LIST = [
  'Cargo.toml',
  'Cargo.toml.orig',
  'build.rs',
  'capabilities/default.json',
  'icons/32x32.png',
  'icons/icon.png',
  'resources/config.properties',
  'shell-dist/assets/index.js',
  'shell-dist/index.html',
  'src/lib.rs',
  'src/main.rs',
  'tauri.conf.json',
].join('\n')

describe('parseCargoPackageList（cargo package --list 输出归一化）', () => {
  it('去掉空行 / 回车 / 首尾空白，保留相对路径', () => {
    const raw = 'Cargo.toml\r\n\r\n  src/lib.rs  \r\nshell-dist/index.html\r\n'
    expect(parseCargoPackageList(raw)).toEqual(['Cargo.toml', 'src/lib.rs', 'shell-dist/index.html'])
  })
})

describe('missingRequiredEntries（包内必备清单）', () => {
  it('完整清单不缺任何必备项', () => {
    expect(missingRequiredEntries(parseCargoPackageList(PACKAGE_LIST))).toEqual([])
  })

  it('壳前端缺失时点名 shell-dist（包内没有壳 = 宿主进去白屏）', () => {
    const files = parseCargoPackageList(PACKAGE_LIST).filter((f) => !f.startsWith('shell-dist/'))
    expect(missingRequiredEntries(files)).toContain(REQUIRED_PACKAGE_ENTRIES.find((e) => e.id === 'shell-dist'))
  })

  it('能力声明 / 内置配置 / 图标缺失时逐项点名', () => {
    const files = parseCargoPackageList(PACKAGE_LIST).filter(
      (f) => !f.startsWith('capabilities/') && f !== 'resources/config.properties' && !f.startsWith('icons/'),
    )
    const missing = missingRequiredEntries(files).map((e: { id: string }) => e.id)
    expect(missing).toEqual(expect.arrayContaining(['capabilities', 'config-properties', 'icons']))
  })

  it('必须有 src 与 tauri.conf.json', () => {
    expect(missingRequiredEntries(['Cargo.toml']).map((e: { id: string }) => e.id)).toEqual(
      expect.arrayContaining(['src', 'tauri-conf', 'capabilities', 'icons', 'config-properties', 'shell-dist']),
    )
  })
})

describe('crate 身份（发布名与二进制名解耦）', () => {
  const manifest = readFileSync(join(srcTauri, 'Cargo.toml'), 'utf-8')

  it('包名 = wasmnest-desktop-runtime，二进制仍叫 wasmnest-desktop', () => {
    const identity = parseCrateIdentity(manifest)
    expect(identity.packageName).toBe('wasmnest-desktop-runtime')
    expect(identity.binNames).toContain('wasmnest-desktop')
    expect(identity.libName).toBe('wasmnest_desktop_lib')
  })

  it('能力仓依赖全部是 git tag（可发布），SDK 是 crates.io 精确版本', () => {
    expect(manifest).not.toMatch(/path\s*=\s*"[^"]*wasmnest-lib/)
    expect(manifest).toMatch(/git\s*=\s*"https:\/\/github\.com\/7ZAI\/wasmnest-lib"/)
    expect(manifest).toMatch(/tag\s*=\s*"lib-v0\.0\.2"/)
    expect(manifest).toMatch(/wasmnest-plugin-api\s*=\s*\{\s*version\s*=\s*"=0\.0\.1"\s*\}/)
    expect(manifest).not.toMatch(/wasmnest-plugin-api\s*=\s*\{\s*path/)
  })
})

describe('tauri.conf.json（壳随包分发的落点）', () => {
  const conf = readJson('tauri.conf.json') as { build: { frontendDist: string; beforeBuildCommand: string } }

  it('frontendDist 指向随包的 shell-dist，构建不再回写 ../dist', () => {
    expect(conf.build.frontendDist).toBe('shell-dist')
    expect(conf.build.beforeBuildCommand).toBe('')
  })
})
