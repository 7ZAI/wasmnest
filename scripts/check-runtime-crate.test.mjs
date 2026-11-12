/**
 * check-runtime-crate · 依赖可发布性判据（node --test，零依赖）
 *
 * 契约来源：`wasmnest-desktop/scripts/check-runtime-crate.mjs` 判据 4 + 发布形态
 * `wasmnest-desktop/src-tauri/Cargo.toml` 头注（L2：能力仓依赖 = git tag，桌面 SDK
 * 已不是宿主直接依赖，批 2 / issue #36）。
 *
 * 行为契约：
 * | 契约ID | 判据 |
 * | C-001 | 真实 manifest × release-manifest 的 repos.lib.tag → 0 问题（漂移锁） |
 * | C-002 | tag 与 release-manifest 不一致 → 点名报错（悬空 tag 不再静默通过） |
 * | C-003 | 缺任一登记的能力仓 crate → 点名报错 |
 * | C-004 | 出现 path 依赖（本地路径形态回归）→ 报错 |
 * | C-005 | 清单外的能力仓 git 依赖（拆分/合并遗留）→ 报错 |
 * | C-006 | 依赖 version 与 tag 不对齐 → 报错 |
 * | C-007 | `[patch]` 写回 manifest → 报错 |
 *
 * 为什么由根测试守：`check-runtime-crate.mjs` 是人工门禁（不在 CI job 里），判据 4 的
 * 硬编码（12 条 / `lib-v0.0.1` / SDK 精确版本）曾在 `peer-net-dissolve` 与 SDK 摘除后
 * 静默过期。这里把「真实 manifest 必须与版本真源一致」接进 node-root 测试，漂移即红。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EXPECTED_LIB_CRATES,
  manifestPublishabilityIssues,
} from '../wasmnest-desktop/scripts/check-runtime-crate.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_TEXT = readFileSync(resolve(ROOT, 'wasmnest-desktop/src-tauri/Cargo.toml'), 'utf-8')
const RELEASE_MANIFEST = JSON.parse(readFileSync(resolve(ROOT, 'release-manifest.json'), 'utf-8'))
const LIB_TAG = RELEASE_MANIFEST.repos.lib.tag
const LIB_GIT_URL = 'https://github.com/7ZAI/wasmnest-lib'

describe('manifestPublishabilityIssues', () => {
  it('C-001 真实 manifest 与 release-manifest 的 lib tag 一致 → 0 问题', () => {
    assert.deepEqual(manifestPublishabilityIssues(MANIFEST_TEXT, { tag: LIB_TAG }), [])
  })

  it('C-002 tag 与 release-manifest 不一致 → 点名报错', () => {
    const issues = manifestPublishabilityIssues(MANIFEST_TEXT, { tag: 'lib-v9.9.9' })
    assert.ok(issues.length > 0, 'tag 漂移必须转红')
    assert.ok(issues.some((i) => i.includes('tag')), `报错应点名 tag：${issues.join(' | ')}`)
  })

  it('C-003 缺登记的能力仓 crate → 点名报错', () => {
    const missing = EXPECTED_LIB_CRATES[0]
    const text = MANIFEST_TEXT.replace(new RegExp(`^${missing}\\s*=.*$`, 'm'), '')
    const issues = manifestPublishabilityIssues(text, { tag: LIB_TAG })
    assert.ok(issues.some((i) => i.includes(missing)), `报错应点名 ${missing}：${issues.join(' | ')}`)
  })

  it('C-004 path 依赖回归 → 报错', () => {
    const text = MANIFEST_TEXT.replace(
      /^wasmnest-link-crypto\s*=.*$/m,
      'wasmnest-link-crypto = { path = "../../../wasmnest-lib/link-crypto" }',
    )
    const issues = manifestPublishabilityIssues(text, { tag: LIB_TAG })
    assert.ok(issues.some((i) => i.includes('path')), `报错应点名 path：${issues.join(' | ')}`)
  })

  it('C-005 清单外的能力仓 git 依赖 → 报错', () => {
    const extra = `wasmnest-server-peer-net-base = { version = "${LIB_TAG.replace(/^lib-v/, '')}", git = "${LIB_GIT_URL}", tag = "${LIB_TAG}" }`
    const text = MANIFEST_TEXT.replace(/^wasmnest-server-peer-net\s*=.*$/m, (line) => `${line}\n${extra}`)
    const issues = manifestPublishabilityIssues(text, { tag: LIB_TAG })
    assert.ok(
      issues.some((i) => i.includes('wasmnest-server-peer-net-base')),
      `报错应点名清单外依赖：${issues.join(' | ')}`,
    )
  })

  it('C-006 version 与 tag 不对齐 → 报错', () => {
    const text = MANIFEST_TEXT.replace(
      /^(wasmnest-host-kit = \{ version = )"[^"]+"/m,
      '$1"9.9.9"',
    )
    const issues = manifestPublishabilityIssues(text, { tag: LIB_TAG })
    assert.ok(issues.some((i) => i.includes('wasmnest-host-kit')), `报错应点名 version：${issues.join(' | ')}`)
  })

  it('C-007 [patch] 写回 manifest → 报错', () => {
    const issues = manifestPublishabilityIssues(`${MANIFEST_TEXT}\n[patch.crates-io]\nfoo = { path = "../foo" }\n`, {
      tag: LIB_TAG,
    })
    assert.ok(issues.some((i) => i.includes('[patch]')), `报错应点名 [patch]：${issues.join(' | ')}`)
  })
})
