/**
 * wasmnest-desktop/scripts/package-host.mjs 行为契约测试（node --test，零依赖）
 *
 * 契约来源：宿主运行时产物契约（应用仓 `.scratch/2026-10-21-host-runtime-distribution/CONTRACT.md`）
 * §1.1 产物内容 / §1.3 host-version.json 必填字段。
 * 宿主**不再打包 tar.gz**（2026-10-28 用户裁决）：§1.2 资产命名与 §1.4 sha256 边车已退役，
 * 对应的契约测试（旧 C-003 / C-005 / C-008）同批删除，不保留空存的断言。
 *
 * 行为契约：
 * | 契约ID | 来源 | 规则 |
 * | C-001 | normalizePlatform | linux→linux、win32→windows、darwin→macos；其余原样 |
 * | C-002 | normalizeArch | x64→x86_64、arm64→arm64；其余原样 |
 * | C-004 | buildHostVersionJson | 含 CONTRACT §1.3 全部必填字段；不写 L3 取消的 profile；dirty 仅在有未提交改动时出现 |
 * | C-006 | resolveHostBinaryName | 优先 [[bin]].name，缺失才退回 [package].name（P3 改名不影响产物名） |
 * | C-007 | parseHostRuntimeManifest | 从 manifest 取 hostRuntime 版本事实；缺段 / 缺字段 / 非法 semver 一律抛错 |
 *
 * 副作用：import 本模块不得触发 CLI main（有 import.meta.url 守卫）。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HOST_VERSION_FIELDS,
  normalizePlatform,
  normalizeArch,
  buildHostVersionJson,
  resolveHostBinaryName,
  parseHostRuntimeManifest,
} from '../wasmnest-desktop/scripts/package-host.mjs'

const tmpDirs = []
function makeTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ==================== C-001 / C-002 平台与架构归一化 ====================
describe('normalizePlatform', () => {
  it('正例：linux 原样', () => {
    assert.equal(normalizePlatform('linux'), 'linux')
  })
  it('正例：Node win32 → windows（CONTRACT §1.3）', () => {
    assert.equal(normalizePlatform('win32'), 'windows')
  })
  it('正例：Node darwin → macos（CONTRACT §1.3）', () => {
    assert.equal(normalizePlatform('darwin'), 'macos')
  })
})

describe('normalizeArch', () => {
  it('正例：x64 → x86_64', () => {
    assert.equal(normalizeArch('x64'), 'x86_64')
  })
  it('正例：arm64 原样', () => {
    assert.equal(normalizeArch('arm64'), 'arm64')
  })
  it('边界：未知架构原样返回（是否可发布由目标矩阵另行拒绝）', () => {
    assert.equal(normalizeArch('ia32'), 'ia32')
  })
})

// ==================== C-004 host-version.json ====================
describe('buildHostVersionJson', () => {
  const input = {
    hostVersion: '0.0.1',
    platform: 'linux',
    arch: 'x86_64',
    sourceCommit: 'ca295a802edcc53ea9d938bad186e6d17b670e48',
    libTag: 'lib-v0.0.1',
    witVersion: '0.0.1',
    sdkVersion: '0.0.1',
    mountContract: '1',
    binary: 'wasmnest-desktop',
    builtBy: 'tauri-cli(--no-bundle)',
    builtAt: '2026-10-21T02:48:29.058Z',
  }

  it('正例：CONTRACT §1.3 必填字段齐全且取值来自入参', () => {
    const meta = buildHostVersionJson(input)
    for (const field of HOST_VERSION_FIELDS) {
      assert.ok(field in meta, `缺必填字段 ${field}`)
    }
    assert.equal(meta.hostVersion, '0.0.1')
    assert.equal(meta.platform, 'linux')
    assert.equal(meta.arch, 'x86_64')
    assert.equal(meta.sourceCommit, input.sourceCommit)
    assert.equal(meta.libTag, 'lib-v0.0.1')
    assert.equal(meta.witVersion, '0.0.1')
    assert.equal(meta.sdkVersion, '0.0.1')
    assert.equal(meta.mountContract, '1')
    assert.equal(meta.binary, 'wasmnest-desktop')
    assert.equal(meta.builtBy, 'tauri-cli(--no-bundle)')
    assert.equal(meta.builtAt, '2026-10-21T02:48:29.058Z')
    assert.equal(meta.pluginsEnv, 'WASMNEST_PLUGINS_DIR')
    assert.ok(meta.note.length > 0)
  })
  it('反例：L3 瘦身取消 → 不再写 profile 字段', () => {
    const meta = buildHostVersionJson(input)
    assert.equal('profile' in meta, false)
  })
  it('边界：无未提交改动时不写 dirty', () => {
    const meta = buildHostVersionJson(input)
    assert.equal('dirty' in meta, false)
  })
  it('边界：工作树有未提交改动 → dirty=true（可选字段，读取方忽略未知字段）', () => {
    const meta = buildHostVersionJson({ ...input, dirty: true })
    assert.equal(meta.dirty, true)
  })
})

// ==================== C-006 二进制名 ====================
describe('resolveHostBinaryName', () => {
  it('正例：无 [[bin]] 时退回 [package].name', () => {
    const toml = ['[package]', 'name = "wasmnest-desktop"', 'version = "0.0.1"', '', '[dependencies]', 'tauri = "2"'].join('\n')
    assert.equal(resolveHostBinaryName(toml), 'wasmnest-desktop')
  })
  it('正例：有 [[bin]].name 时优先（P3 把 package 改名 wasmnest-desktop-runtime）', () => {
    const toml = [
      '[package]',
      'name = "wasmnest-desktop-runtime"',
      'version = "0.0.1"',
      '',
      '[lib]',
      'name = "wasmnest_desktop_lib"',
      '',
      '[[bin]]',
      'name = "wasmnest-desktop"',
      'path = "src/main.rs"',
    ].join('\n')
    assert.equal(resolveHostBinaryName(toml), 'wasmnest-desktop')
  })
  it('反例：都没有 → 抛错（不猜产物名）', () => {
    assert.throws(() => resolveHostBinaryName('[dependencies]\ntauri = "2"'))
  })
})

// ==================== C-007 manifest 版本事实 ====================
describe('parseHostRuntimeManifest', () => {
  const valid = {
    repos: { lib: { tag: 'lib-v0.0.1' } },
    contract: { version: '0.0.1' },
    hostRuntime: {
      version: '0.0.1',
      sourceCommit: 'ca295a802edcc53ea9d938bad186e6d17b670e48',
      libTag: 'lib-v0.0.1',
      witVersion: '0.0.1',
      sdkVersion: '0.0.1',
      mountContract: '1',
      artifacts: {},
    },
  }
  it('正例：取出版本事实', () => {
    assert.deepEqual(parseHostRuntimeManifest(valid), {
      version: '0.0.1',
      sdkVersion: '0.0.1',
      mountContract: '1',
      libTag: 'lib-v0.0.1',
      witVersion: '0.0.1',
    })
  })
  it('反例：缺 hostRuntime 段 → 抛错并点名 CONTRACT §2.3', () => {
    assert.throws(() => parseHostRuntimeManifest({ ...valid, hostRuntime: undefined }), /hostRuntime/)
  })
  it('反例：缺 version → 抛错', () => {
    assert.throws(
      () => parseHostRuntimeManifest({ ...valid, hostRuntime: { ...valid.hostRuntime, version: undefined } }),
      /version/,
    )
  })
  it('反例：version 非 semver → 抛错', () => {
    assert.throws(
      () => parseHostRuntimeManifest({ ...valid, hostRuntime: { ...valid.hostRuntime, version: 'v0.0.1' } }),
      /semver/,
    )
  })
  it('反例：libTag 与 repos.lib.tag 不一致 → 抛错', () => {
    assert.throws(
      () => parseHostRuntimeManifest({ ...valid, hostRuntime: { ...valid.hostRuntime, libTag: 'lib-v0.9.9' } }),
      /libTag/,
    )
  })
  it('反例：witVersion 与 contract.version 不一致 → 抛错', () => {
    assert.throws(
      () => parseHostRuntimeManifest({ ...valid, hostRuntime: { ...valid.hostRuntime, witVersion: '0.0.2' } }),
      /witVersion/,
    )
  })
})
