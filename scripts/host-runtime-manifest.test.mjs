/**
 * release-manifest.json · hostRuntime 段校验行为契约测试（node --test，零依赖）
 *
 * 契约来源：`.scratch/2026-10-21-host-runtime-distribution/CONTRACT.md` §2.3（manifest 形状）。
 *
 * `hostRuntime.artifacts` 已**退役**（2026-10-28 用户裁决：平台仓不再构建 / 发布任何 tar.gz）。
 * 旧的资产命名 / sha256 / 平台 token 三类断言（原 C-001 / C-002 / C-007 / C-008 / C-009）
 * 随真源一起删除；改为一条退役面锁（C-007）：字段残留即红，防止机器工件线静默回接。
 *
 * 行为契约：
 * | 契约ID | 判据 |
 * | C-001 | 缺 hostRuntime 段 / 缺必填字段 → 逐项报错并点名字段 |
 * | C-002 | version 必须 semver；sourceCommit 必须 40 位 hex |
 * | C-003 | libTag == repos.lib.tag、witVersion == contract.version |
 * | C-004 | sdkVersion / mountContract 与各自真源（SDK 版本 / 宿主常量）一致 |
 * | C-005 | 正例：hostRuntime 段齐全 → 无错、无提示 |
 * | C-006 | artifacts 已退役：出现即红（含空对象 {}） |
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  HOST_RUNTIME_REQUIRED_FIELDS,
  validateHostRuntime,
} from './check-release-manifest.mjs'

const SOURCE_COMMIT = 'ca295a802edcc53ea9d938bad186e6d17b670e48'

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
    },
    apps: {},
    ...overrides,
  }
}

const TRUTH = { sdkVersion: '0.0.1', mountContract: '1' }

describe('validateHostRuntime', () => {
  it('C-005 正例：hostRuntime 段齐全 → 无错、无提示', () => {
    const { errors, notices } = validateHostRuntime(makeManifest(), TRUTH)
    assert.deepEqual(errors, [])
    assert.deepEqual(notices, [])
  })

  it('C-001 反例：缺 hostRuntime 段 → 点名', () => {
    const { errors } = validateHostRuntime(makeManifest({ hostRuntime: undefined }), TRUTH)
    assert.ok(errors.some((e) => e.includes('hostRuntime')))
  })

  it('C-001 反例：逐个缺必填字段 → 每个都报', () => {
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

  it('C-002 反例：version 非 semver / sourceCommit 非 40 位 hex → 红', () => {
    const m1 = makeManifest()
    m1.hostRuntime.version = 'v0.0.1'
    assert.ok(validateHostRuntime(m1, TRUTH).errors.some((e) => e.includes('semver')))
    const m2 = makeManifest()
    m2.hostRuntime.sourceCommit = 'ca295a8'
    assert.ok(validateHostRuntime(m2, TRUTH).errors.some((e) => e.includes('sourceCommit')))
  })

  it('C-003 反例：libTag / witVersion 与真源不一致 → 红', () => {
    const m1 = makeManifest()
    m1.hostRuntime.libTag = 'lib-v0.9.9'
    assert.ok(validateHostRuntime(m1, TRUTH).errors.some((e) => e.includes('libTag')))
    const m2 = makeManifest()
    m2.hostRuntime.witVersion = '0.0.2'
    assert.ok(validateHostRuntime(m2, TRUTH).errors.some((e) => e.includes('witVersion')))
  })

  it('C-004 反例：sdkVersion / mountContract 与宿主 / SDK 真源不一致 → 红', () => {
    const { errors } = validateHostRuntime(makeManifest(), { sdkVersion: '0.0.2', mountContract: '2' })
    assert.ok(errors.some((e) => e.includes('sdkVersion')))
    assert.ok(errors.some((e) => e.includes('mountContract')))
  })

  it('C-006 退役面：artifacts 出现即红（空对象也算）', () => {
    const empty = makeManifest()
    empty.hostRuntime.artifacts = {}
    assert.ok(
      validateHostRuntime(empty, TRUTH).errors.some((e) => e.includes('artifacts') && e.includes('退役')),
      '空 artifacts 残留也必须红（未发布的「空对象」不再合法）',
    )

    const filled = makeManifest()
    filled.hostRuntime.artifacts = {
      'linux-x86_64': { file: 'host-desktop-0.0.1-linux-x86_64.tar.gz', sha256: 'a'.repeat(64) },
    }
    assert.ok(
      validateHostRuntime(filled, TRUTH).errors.some((e) => e.includes('artifacts')),
      '带内容 artifacts 必须红',
    )
  })
})
