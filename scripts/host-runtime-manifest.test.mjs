/**
 * release-manifest.json · hostRuntime 段校验行为契约测试（node --test，零依赖）
 *
 * 契约来源：`.scratch/2026-10-21-host-runtime-distribution/CONTRACT.md` §2.3（manifest 形状）
 * 与 §1.2（资产命名）/ §1.4（sha256），P2 票据「必做 2」。
 *
 * 行为契约：
 * | 契约ID | 判据 |
 * | C-001 | 完整 artifacts 正例 → 无错 |
 * | C-002 | 空 artifacts 正例 → 无错，且给出「宿主未发布」提示（不红） |
 * | C-003 | 缺 hostRuntime 段 / 缺必填字段 → 逐项报错并点名字段 |
 * | C-004 | version 必须 semver；sourceCommit 必须 40 位 hex |
 * | C-005 | libTag == repos.lib.tag、witVersion == contract.version |
 * | C-006 | sdkVersion / mountContract 与各自真源（SDK 版本 / 宿主常量）一致 |
 * | C-007 | artifacts 的 key 必须是 6 个平台-架构 token 之一 |
 * | C-008 | file == host-desktop-<version>-<platform>-<arch>.tar.gz；sha256 必须 64 位 hex |
 * | C-009 | artifacts 必须是对象（数组 / 字符串 → 红） |
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  HOST_RUNTIME_REQUIRED_FIELDS,
  HOST_ARTIFACT_KEY_RE,
  validateHostRuntime,
} from './check-release-manifest.mjs'

const SOURCE_COMMIT = 'ca295a802edcc53ea9d938bad186e6d17b670e48'
const SHA_A = 'a'.repeat(64)

function makeManifest(overrides = {}) {
  return {
    product: '0.0.1',
    repos: { lib: { tag: 'lib-v0.0.1' }, apps: { tag: 'apps-v0.0.1' } },
    contract: { package: 'wasmnest:plugin', version: '0.0.1', witSha256: 'b'.repeat(64) },
    hostRuntime: {
      version: '0.0.1',
      sourceCommit: SOURCE_COMMIT,
      libTag: 'lib-v0.0.1',
      witVersion: '0.0.1',
      sdkVersion: '0.0.1',
      mountContract: '1',
      artifacts: {},
      $comment: 'artifacts 由 host-release workflow 发布时填充；未发布时为空',
    },
    apps: {},
    ...overrides,
  }
}

const TRUTH = { sdkVersion: '0.0.1', mountContract: '1' }

describe('validateHostRuntime', () => {
  it('C-001 正例：三平台 artifacts 齐全 → 无错', () => {
    const manifest = makeManifest()
    manifest.hostRuntime.artifacts = {
      'linux-x86_64': { file: 'host-desktop-0.0.1-linux-x86_64.tar.gz', sha256: SHA_A },
      'macos-arm64': { file: 'host-desktop-0.0.1-macos-arm64.tar.gz', sha256: 'c'.repeat(64) },
      'windows-x86_64': { file: 'host-desktop-0.0.1-windows-x86_64.tar.gz', sha256: 'd'.repeat(64) },
    }
    const { errors, notices } = validateHostRuntime(manifest, TRUTH)
    assert.deepEqual(errors, [])
    assert.deepEqual(notices, [])
  })

  it('C-002 正例：artifacts 为空（未发布态）→ 无错，但提示宿主未发布', () => {
    const { errors, notices } = validateHostRuntime(makeManifest(), TRUTH)
    assert.deepEqual(errors, [])
    assert.ok(notices.some((n) => n.includes('宿主未发布')), '空 artifacts 必须显式提示未发布')
  })

  it('C-003 反例：缺 hostRuntime 段 → 点名', () => {
    const { errors } = validateHostRuntime(makeManifest({ hostRuntime: undefined }), TRUTH)
    assert.ok(errors.some((e) => e.includes('hostRuntime')))
  })

  it('C-003 反例：逐个缺必填字段 → 每个都报', () => {
    for (const field of HOST_RUNTIME_REQUIRED_FIELDS) {
      const manifest = makeManifest()
      delete manifest.hostRuntime[field]
      const { errors } = validateHostRuntime(manifest, TRUTH)
      assert.ok(
        errors.some((e) => e.includes(`hostRuntime.${field}`)),
        `缺 ${field} 必须点名 hostRuntime.${field}`,
      )
    }
  })

  it('C-004 反例：version 非 semver / sourceCommit 非 40 位 hex → 红', () => {
    const m1 = makeManifest()
    m1.hostRuntime.version = 'v0.0.1'
    assert.ok(validateHostRuntime(m1, TRUTH).errors.some((e) => e.includes('semver')))
    const m2 = makeManifest()
    m2.hostRuntime.sourceCommit = 'ca295a8'
    assert.ok(validateHostRuntime(m2, TRUTH).errors.some((e) => e.includes('sourceCommit')))
  })

  it('C-005 反例：libTag / witVersion 与真源不一致 → 红', () => {
    const m1 = makeManifest()
    m1.hostRuntime.libTag = 'lib-v0.9.9'
    assert.ok(validateHostRuntime(m1, TRUTH).errors.some((e) => e.includes('libTag')))
    const m2 = makeManifest()
    m2.hostRuntime.witVersion = '0.0.2'
    assert.ok(validateHostRuntime(m2, TRUTH).errors.some((e) => e.includes('witVersion')))
  })

  it('C-006 反例：sdkVersion / mountContract 与宿主 / SDK 真源不一致 → 红', () => {
    const { errors } = validateHostRuntime(makeManifest(), { sdkVersion: '0.0.2', mountContract: '2' })
    assert.ok(errors.some((e) => e.includes('sdkVersion')))
    assert.ok(errors.some((e) => e.includes('mountContract')))
  })

  it('C-009 反例：artifacts 是数组 → 红', () => {
    const manifest = makeManifest()
    manifest.hostRuntime.artifacts = []
    assert.ok(validateHostRuntime(manifest, TRUTH).errors.some((e) => e.includes('artifacts')))
  })

  it('C-007 反例：未知平台 token / 未归一化的架构 token → 红', () => {
    for (const key of ['freebsd-x86_64', 'linux-amd64', 'linux-x64']) {
      const manifest = makeManifest()
      manifest.hostRuntime.artifacts = { [key]: { file: `host-desktop-0.0.1-${key}.tar.gz`, sha256: SHA_A } }
      const { errors } = validateHostRuntime(manifest, TRUTH)
      assert.ok(errors.some((e) => e.includes(key)), `${key} 必须被拒绝`)
      assert.equal(HOST_ARTIFACT_KEY_RE.test(key), false)
    }
    for (const key of ['linux-x86_64', 'linux-arm64', 'macos-x86_64', 'macos-arm64', 'windows-x86_64', 'windows-arm64']) {
      assert.equal(HOST_ARTIFACT_KEY_RE.test(key), true, `${key} 是契约内 token`)
    }
  })

  it('C-008 反例：file 命名不符 / sha256 非 64 位 hex → 红', () => {
    const m1 = makeManifest()
    m1.hostRuntime.artifacts = {
      'linux-x86_64': { file: 'host-desktop-0.0.1-linux-amd64.tar.gz', sha256: SHA_A },
    }
    assert.ok(validateHostRuntime(m1, TRUTH).errors.some((e) => e.includes('file')))

    const m2 = makeManifest()
    m2.hostRuntime.artifacts = {
      'linux-x86_64': { file: 'host-desktop-0.0.1-linux-x86_64.tar.gz', sha256: 'not-hex' },
    }
    assert.ok(validateHostRuntime(m2, TRUTH).errors.some((e) => e.includes('sha256')))

    const m3 = makeManifest()
    m3.hostRuntime.artifacts = { 'linux-x86_64': { file: 'x', sha256: SHA_A } }
    assert.ok(validateHostRuntime(m3, TRUTH).errors.some((e) => e.includes('linux-x86_64')))
  })
})
