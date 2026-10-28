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
  'resources/plugins/.gitkeep',
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

  it('随包产物目录占位缺失时点名（缺目录 = tauri_build 直接失败）', () => {
    const files = parseCargoPackageList(PACKAGE_LIST).filter(
      (f) => f !== 'resources/plugins/.gitkeep',
    )
    expect(missingRequiredEntries(files)).toContain(
      REQUIRED_PACKAGE_ENTRIES.find((e: { id: string }) => e.id === 'plugins-placeholder'),
    )
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

  it('能力仓依赖全部是 git tag（可发布）；宿主不直接依赖 SDK', () => {
    expect(manifest).not.toMatch(/path\s*=\s*"[^"]*wasmnest-lib/)
    expect(manifest).toMatch(/git\s*=\s*"https:\/\/github\.com\/7ZAI\/wasmnest-lib"/)
    expect(manifest).toMatch(/tag\s*=\s*"lib-v0\.0\.2"/)
    // 2026-10-25 契约依赖收口（db81007）：宿主不再直接依赖 SDK（发布不再前置 SDK 上
    // crates.io），权限 / FORM_COMPONENT / 事件 topic 词汇改读 wasm-core 真源。锁随该
    // 决策改口径——断言「桌面宿主 manifest 里没有 SDK 直接依赖」，而不是断言它以
    // crates.io 精确版本存在（旧断言在依赖摘除当天就红了，与发布形态无关）。
    expect(manifest).not.toMatch(/^\s*wasmnest-plugin-api\s*=/m)
    expect(manifest).not.toMatch(/wasmnest-plugin-api\s*=\s*\{\s*path/)
  })
})

describe('tauri.conf.json（壳随包分发的落点）', () => {
  const conf = readJson('tauri.conf.json') as { build: { frontendDist: string; beforeBuildCommand: string } }

  it('frontendDist 指向随包 shell-dist；构建前只允许刷新它，不得回退到 ../dist', () => {
    expect(conf.build.frontendDist).toBe('shell-dist')
    // L2 后壳的落点是签入的 shell-dist：构建前命令必须是「dist → shell-dist 的同步」，
    // 否则改了宿主前端却仍嵌入旧壳（静默陈旧）。空串也放行给显式 --skip 的场景，但
    // 仓内基线必须走 shell:sync。
    expect(conf.build.beforeBuildCommand).toBe('pnpm run shell:sync')
    expect(conf.build.frontendDist).not.toContain('../dist')
  })
})
