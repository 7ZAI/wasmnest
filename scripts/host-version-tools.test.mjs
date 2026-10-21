/**
 * 宿主版本事实工具行为契约测试（node --test，零依赖）
 *
 * 覆盖两个只在「发布时 / 发布后」使用的脚本：
 *  - `scripts/set-host-version.mjs`：同步 manifest hostRuntime.version / tauri.conf version /
 *    src-tauri/Cargo.toml [package].version（只改版本，不动其他字节）。
 *  - `scripts/update-host-runtime-artifacts.mjs`：发布后把三平台真实 sha 与 sourceCommit
 *    写回 manifest（只改 hostRuntime 块，其他段 JSON 值不变）。
 *
 * 行为契约：
 * | 契约ID | 来源 | 规则 |
 * | C-001 | set-host-version | 三处版本同时更新；manifest.product 不动 |
 * | C-002 | set-host-version | Cargo.toml 只改 [package] 段，[dependencies] 的 version 原样 |
 * | C-003 | set-host-version | 非 semver（含 v 前缀 / 空）→ 抛错，不写文件 |
 * | C-004 | set-host-version | 缺 hostRuntime 段 → 抛错（版本真源不可猜） |
 * | C-005 | update-host-runtime-artifacts | artifacts 与 sourceCommit 写入；其余 hostRuntime 字段不变 |
 * | C-006 | update-host-runtime-artifacts | 产物目录收集：边车解析 + 未发布态（空目录）报错 |
 * | C-007 | update-host-runtime-artifacts | 缺 hostRuntime 段 → 抛错 |
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyHostVersion } from './set-host-version.mjs'
import {
  applyHostRuntimeArtifacts,
  collectArtifacts,
} from './update-host-runtime-artifacts.mjs'

const MANIFEST_TEXT = `{
  "$comment": "跨仓版本唯一表达",
  "product": "0.0.1",
  "repos": {
    "lib": { "tag": "lib-v0.0.2" },
    "apps": { "tag": "apps-v0.0.1" }
  },
  "contract": {
    "package": "wasmnest:plugin",
    "version": "0.0.1",
    "witSha256": "${'b'.repeat(64)}"
  },
  "hostRuntime": {
    "version": "0.0.1",
    "sourceCommit": "${'c'.repeat(40)}",
    "libTag": "lib-v0.0.2",
    "witVersion": "0.0.1",
    "sdkVersion": "0.0.1",
    "mountContract": "1",
    "artifacts": {},
    "$comment": "artifacts 由 host-release workflow 发布时填充；未发布时为空"
  },
  "apps": {}
}
`

const TAURI_CONF_TEXT = `{
  "productName": "WasmNest",
  "identifier": "com.wasmnest.app",
  "version": "0.0.1",
  "build": {
    "frontendDist": "../dist"
  }
}
`

const CARGO_TEXT = `[package]
name = "wasmnest-desktop-runtime"
version = "0.0.1"
edition = "2021"

[lib]
name = "wasmnest_desktop_lib"

[[bin]]
name = "wasmnest-desktop"
path = "src/main.rs"

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
`

const tmpDirs = []
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

describe('applyHostVersion', () => {
  it('C-001 正例：manifest / tauri.conf / Cargo 三处版本同步，product 与其余字段不动', () => {
    const out = applyHostVersion(
      { manifest: MANIFEST_TEXT, tauriConf: TAURI_CONF_TEXT, cargoToml: CARGO_TEXT },
      '0.0.2',
    )
    const manifest = JSON.parse(out.manifest)
    assert.equal(manifest.hostRuntime.version, '0.0.2')
    assert.equal(manifest.product, '0.0.1', 'product 是平台产品版本，不随宿主运行时版本走')
    assert.equal(manifest.hostRuntime.$comment, JSON.parse(MANIFEST_TEXT).hostRuntime.$comment)
    assert.equal(manifest.repos.lib.tag, 'lib-v0.0.2')

    const conf = JSON.parse(out.tauriConf)
    assert.equal(conf.version, '0.0.2')
    assert.equal(conf.productName, 'WasmNest')
  })

  it('C-002 反例/边界：Cargo.toml 只改 [package].version，依赖版本原样', () => {
    const out = applyHostVersion(
      { manifest: MANIFEST_TEXT, tauriConf: TAURI_CONF_TEXT, cargoToml: CARGO_TEXT },
      '1.2.3',
    )
    assert.match(out.cargoToml, /\[package\][\s\S]*?version = "1\.2\.3"/)
    assert.match(out.cargoToml, /tauri = \{ version = "2"/)
    assert.match(out.cargoToml, /serde = \{ version = "1"/)
    assert.match(out.cargoToml, /name = "wasmnest-desktop-runtime"/)
  })

  it('C-003 反例：非 semver → 抛错且不改任何文本', () => {
    for (const bad of ['v0.0.2', '0.0', '', '0.0.2-beta', '00.0.2']) {
      assert.throws(
        () =>
          applyHostVersion(
            { manifest: MANIFEST_TEXT, tauriConf: TAURI_CONF_TEXT, cargoToml: CARGO_TEXT },
            bad,
          ),
        /semver/,
        `${bad} 必须被拒绝`,
      )
    }
  })

  it('C-004 反例：缺 hostRuntime 段 → 抛错（版本真源不可猜）', () => {
    const noHostRuntime = JSON.stringify({ product: '0.0.1', repos: {}, contract: {} }, null, 2)
    assert.throws(
      () =>
        applyHostVersion(
          { manifest: noHostRuntime, tauriConf: TAURI_CONF_TEXT, cargoToml: CARGO_TEXT },
          '0.0.2',
        ),
      /hostRuntime/,
    )
  })
})

describe('applyHostRuntimeArtifacts', () => {
  const artifacts = {
    'linux-x86_64': { file: 'host-desktop-0.0.1-linux-x86_64.tar.gz', sha256: 'd'.repeat(64) },
    'macos-arm64': { file: 'host-desktop-0.0.1-macos-arm64.tar.gz', sha256: 'e'.repeat(64) },
  }

  it('C-005 正例：写入 artifacts 与 sourceCommit，其余 hostRuntime 字段不变', () => {
    const before = JSON.parse(MANIFEST_TEXT)
    const out = applyHostRuntimeArtifacts(MANIFEST_TEXT, {
      artifacts,
      sourceCommit: 'f'.repeat(40),
    })
    const after = JSON.parse(out)
    assert.deepEqual(after.hostRuntime.artifacts, artifacts)
    assert.equal(after.hostRuntime.sourceCommit, 'f'.repeat(40))
    assert.equal(after.hostRuntime.version, before.hostRuntime.version)
    assert.equal(after.hostRuntime.libTag, before.hostRuntime.libTag)
    assert.equal(after.hostRuntime.mountContract, before.hostRuntime.mountContract)
    assert.deepEqual(after.repos, before.repos)
    assert.deepEqual(after.contract, before.contract)
  })

  it('C-007 反例：缺 hostRuntime 段 → 抛错', () => {
    assert.throws(
      () => applyHostRuntimeArtifacts('{ "product": "0.0.1" }', { artifacts, sourceCommit: 'f'.repeat(40) }),
      /hostRuntime/,
    )
  })
})

describe('collectArtifacts', () => {
  it('C-006 正例：按边车收集三平台产物', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hostartifacts-'))
    tmpDirs.push(dir)
    const entries = {
      'host-desktop-0.0.1-linux-x86_64.tar.gz': '1'.repeat(64),
      'host-desktop-0.0.1-macos-arm64.tar.gz': '2'.repeat(64),
      'host-desktop-0.0.1-windows-x86_64.tar.gz': '3'.repeat(64),
    }
    for (const [file, sha] of Object.entries(entries)) {
      writeFileSync(join(dir, file), 'x')
      writeFileSync(join(dir, `${file}.sha256`), `${sha}  ${file}\n`)
    }
    assert.deepEqual(collectArtifacts(dir), {
      'linux-x86_64': { file: 'host-desktop-0.0.1-linux-x86_64.tar.gz', sha256: '1'.repeat(64) },
      'macos-arm64': { file: 'host-desktop-0.0.1-macos-arm64.tar.gz', sha256: '2'.repeat(64) },
      'windows-x86_64': { file: 'host-desktop-0.0.1-windows-x86_64.tar.gz', sha256: '3'.repeat(64) },
    })
  })

  it('C-006 反例：空目录 / 缺边车 → 抛错（发布态必须可校验）', () => {
    const empty = mkdtempSync(join(tmpdir(), 'hostartifacts-empty-'))
    tmpDirs.push(empty)
    assert.throws(() => collectArtifacts(empty), /未找到/)

    const dir = mkdtempSync(join(tmpdir(), 'hostartifacts-noside-'))
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'host-desktop-0.0.1-linux-x86_64.tar.gz'), 'x')
    assert.throws(() => collectArtifacts(dir), /sha256/)
  })
})
