/**
 * 宿主版本事实工具行为契约测试（node --test，零依赖）
 *
 * 覆盖只在「发布时」使用的脚本：
 *  - `scripts/set-host-version.mjs`：同步 manifest hostRuntime.version / tauri.conf version /
 *    src-tauri/Cargo.toml [package].version（只改版本，不动其他字节）。
 *
 * 旧的 `update-host-runtime-artifacts.mjs`（发布后回写 tar.gz sha256）已随「不再发布 tar.gz」
 * 退役（2026-10-28），对应契约 C-005…C-008 同批删除。
 *
 * 行为契约：
 * | 契约ID | 来源 | 规则 |
 * | C-001 | set-host-version | 三处版本同时更新；manifest.product 不动 |
 * | C-002 | set-host-version | Cargo.toml 只改 [package] 段，[dependencies] 的 version 原样 |
 * | C-003 | set-host-version | 非 semver（含 v 前缀 / 空）→ 抛错，不写文件 |
 * | C-004 | set-host-version | 缺 hostRuntime 段 → 抛错（版本真源不可猜） |
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { applyHostVersion } from './set-host-version.mjs'

const MANIFEST_TEXT = `{
  "$comment": "跨仓版本唯一表达",
  "product": "0.0.1",
  "repos": {
    "lib": { "tag": "lib-v0.0.1" },
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
    "libTag": "lib-v0.0.1",
    "witVersion": "0.0.1",
    "sdkVersion": "0.0.1",
    "mountContract": "1"
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
    assert.equal(manifest.repos.lib.tag, 'lib-v0.0.1')

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
