/**
 * scripts/vendor-apps.mjs 行为契约测试（node --test，零依赖）
 *
 * 契约来源：`release-manifest.json` 的 `apps` 段（version / ends.<end>.package / sha256）
 * + 应用仓 `app-release.yml` 的产物命名与元数据形态。
 *
 * 行为契约：
 * | 契约ID | 来源 | 规则 |
 * | C-001 | planVendorApps | 只收本端有条目的应用；slug 取自 path 末段；releaseTag/packageName 按应用仓命名推导 |
 * | C-002 | planVendorApps | 缺 version / package / sha256 / artifact，或 package 命名不符 → 抛错（不猜） |
 * | C-003 | planVendorApps | --only 过滤后为空 / apps 段为空 → 抛错 |
 * | C-004 | vendorUrl | `<base>/<tag>/<encodeURIComponent(file)>`；非 http(s) base → 抛错 |
 * | C-005 | verifyMeta | id / version / artifact.file / wasm.file / sha256 任一不符即抛错 |
 * | C-006 | verifyMeta | source.libRef 缺失或不等于清单 repos.lib.tag → 抛错（WIT 契约不匹配） |
 * | C-007 | verifyPluginJson | id / version / platform / rustLibrary+'.wasm' / main 任一不符即抛错 |
 *
 * 副作用：import 本模块不得触发 CLI main（有 import.meta.url 守卫）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  planVendorApps,
  vendorUrl,
  verifyMeta,
  verifyPluginJson,
} from './vendor-apps.mjs'

const SHA = 'a'.repeat(64)

function makeManifest(apps = {}) {
  return {
    repos: { lib: { tag: 'lib-v0.0.1' }, apps: { tag: 'apps-v0.0.1' } },
    apps,
  }
}

function makeApp(path, overrides = {}) {
  return {
    path,
    version: '0.0.1',
    ends: {
      desktop: {
        artifact: 'wasmnest_plugin_demo.wasm',
        package: `${path.split('/').pop()}-desktop-v0.0.1.zip`,
        sha256: SHA,
      },
    },
    ...overrides,
  }
}

describe('planVendorApps（C-001 / C-002 / C-003）', () => {
  it('C-001 正例：按清单推导 releaseTag / 包名 / 元数据名', () => {
    const plan = planVendorApps(
      makeManifest({
        'com.wasmnest.bedcode': makeApp('apps/bedcode', {
          ends: { desktop: { artifact: 'bedcode_plugin_terminal_session.wasm', package: 'bedcode-desktop-v0.0.1.zip', sha256: SHA } },
        }),
        'com.wasmnest.monitor': makeApp('servers/monitor', {
          ends: { desktop: { artifact: 'wasmnest_plugin_monitor.wasm', package: 'monitor-desktop-v0.0.1.zip', sha256: SHA } },
        }),
      }),
    )
    assert.deepEqual(plan.map((p) => [p.id, p.slug, p.releaseTag, p.packageName]), [
      ['com.wasmnest.bedcode', 'bedcode', 'bedcode-v0.0.1', 'bedcode-desktop-v0.0.1.zip'],
      ['com.wasmnest.monitor', 'monitor', 'monitor-v0.0.1', 'monitor-desktop-v0.0.1.zip'],
    ])
    assert.equal(plan[0].metaName, 'bedcode-desktop-v0.0.1.json')
    assert.equal(plan[0].artifact, 'bedcode_plugin_terminal_session.wasm')
  })

  it('C-001 边界：只有对端条目的应用被跳过（不算错误）', () => {
    const plan = planVendorApps(
      makeManifest({
        'com.wasmnest.desk': makeApp('apps/desk'),
        'com.wasmnest.mob': { path: 'apps/mob', version: '0.0.1', ends: { mobile: { artifact: 'x.wasm' } } },
      }),
    )
    assert.deepEqual(plan.map((p) => p.id), ['com.wasmnest.desk'])
  })

  it('C-002 反例：缺 version / package / sha256 / artifact 一律抛错', () => {
    const cases = [
      [{ path: 'apps/x', ends: { desktop: { artifact: 'x.wasm', package: 'x-desktop-v0.0.1.zip', sha256: SHA } } }, /缺 version/],
      [{ path: 'apps/x', version: '0.0.1', ends: { desktop: { artifact: 'x.wasm', sha256: SHA } } }, /缺 package/],
      [{ path: 'apps/x', version: '0.0.1', ends: { desktop: { artifact: 'x.wasm', package: 'x-desktop-v0.0.1.zip' } } }, /sha256/],
      [{ path: 'apps/x', version: '0.0.1', ends: { desktop: { package: 'x-desktop-v0.0.1.zip', sha256: SHA } } }, /artifact/],
    ]
    for (const [entry, re] of cases) {
      assert.throws(() => planVendorApps(makeManifest({ 'com.wasmnest.x': entry })), re)
    }
  })

  it('C-002 反例：sha256 非 64 位 hex / package 命名不符 → 抛错', () => {
    assert.throws(
      () =>
        planVendorApps(
          makeManifest({
            'com.wasmnest.x': { path: 'apps/x', version: '0.0.1', ends: { desktop: { artifact: 'x.wasm', package: 'x-desktop-v0.0.1.zip', sha256: 'abc' } } },
          }),
        ),
      /64 位/,
    )
    assert.throws(
      () =>
        planVendorApps(
          makeManifest({
            'com.wasmnest.x': { path: 'apps/x', version: '0.0.1', ends: { desktop: { artifact: 'x.wasm', package: 'wrong.zip', sha256: SHA } } },
          }),
        ),
      /命名规则/,
    )
  })

  it('C-003 反例：--only 过滤后为空 / apps 段缺失 → 抛错', () => {
    const manifest = makeManifest({ 'com.wasmnest.x': makeApp('apps/x') })
    assert.throws(() => planVendorApps(manifest, { only: ['com.wasmnest.nope'] }), /--only/)
    assert.throws(() => planVendorApps({ repos: {} }), /apps 段/)
  })
})

describe('vendorUrl（C-004）', () => {
  it('正例：拼出 releases/download/<tag>/<file>', () => {
    assert.equal(
      vendorUrl('https://github.com/7ZAI/wasmnest-apps/releases/download', 'bedcode-v0.0.1', 'bedcode-desktop-v0.0.1.zip'),
      'https://github.com/7ZAI/wasmnest-apps/releases/download/bedcode-v0.0.1/bedcode-desktop-v0.0.1.zip',
    )
  })

  it('边界：base 末尾斜杠被归一；非 http(s) 抛错', () => {
    assert.equal(vendorUrl('https://x.test/dl//', 't', 'f.zip'), 'https://x.test/dl/t/f.zip')
    assert.throws(() => vendorUrl('ftp://x', 't', 'f.zip'), /base-url/)
  })
})

describe('verifyMeta（C-005 / C-006）', () => {
  const plan = { id: 'com.wasmnest.demo', version: '0.0.1', sha256: SHA, packageName: 'demo-desktop-v0.0.1.zip', artifact: 'demo.wasm' }
  const ctx = { libTag: 'lib-v0.0.1' }
  const good = () => ({
    plugin: { id: 'com.wasmnest.demo', version: '0.0.1' },
    artifact: { file: 'demo-desktop-v0.0.1.zip', sha256: SHA },
    wasm: { file: 'demo.wasm' },
    source: { libRef: 'lib-v0.0.1' },
  })

  it('正例：完全一致不抛错', () => {
    assert.doesNotThrow(() => verifyMeta(good(), plan, ctx))
  })

  it('C-005 反例：id / version / file / wasm / sha256 任一不符即抛错', () => {
    const mut = (fn) => {
      const m = good()
      fn(m)
      return m
    }
    assert.throws(() => verifyMeta(mut((m) => (m.plugin.id = 'other')), plan, ctx), /plugin\.id/)
    assert.throws(() => verifyMeta(mut((m) => (m.plugin.version = '0.0.2')), plan, ctx), /plugin\.version/)
    assert.throws(() => verifyMeta(mut((m) => (m.artifact.file = 'x.zip')), plan, ctx), /artifact\.file/)
    assert.throws(() => verifyMeta(mut((m) => (m.artifact.sha256 = 'b'.repeat(64))), plan, ctx), /sha256/)
    assert.throws(() => verifyMeta(mut((m) => (m.wasm.file = 'other.wasm')), plan, ctx), /wasm\.file/)
  })

  it('C-006 反例：libRef 缺失 / 与清单 lib tag 不一致 → 抛错（WIT 契约不匹配）', () => {
    const missing = good()
    delete missing.source
    assert.throws(() => verifyMeta(missing, plan, ctx), /libRef/)
    const mismatch = good()
    mismatch.source.libRef = 'lib-v0.0.2'
    assert.throws(() => verifyMeta(mismatch, plan, ctx), /实例化失败/)
  })
})

describe('verifyPluginJson（C-007）', () => {
  const plan = { id: 'com.wasmnest.demo', version: '0.0.1', artifact: 'demo.wasm' }
  const good = () => ({
    id: 'com.wasmnest.demo',
    version: '0.0.1',
    platform: 'desktop',
    rustLibrary: 'demo',
    main: 'index.js',
  })

  it('正例：desktop 与 both 都接受', () => {
    assert.doesNotThrow(() => verifyPluginJson(good(), plan, 'desktop'))
    assert.doesNotThrow(() => verifyPluginJson({ ...good(), platform: 'both' }, plan, 'desktop'))
  })

  it('C-007 反例：错端 / id / version / wasm / main 任一不符即抛错', () => {
    assert.throws(() => verifyPluginJson({ ...good(), platform: 'mobile' }, plan, 'desktop'), /错端/)
    assert.throws(() => verifyPluginJson({ ...good(), id: 'x' }, plan, 'desktop'), /id=/)
    assert.throws(() => verifyPluginJson({ ...good(), version: '0.9.9' }, plan, 'desktop'), /version=/)
    assert.throws(() => verifyPluginJson({ ...good(), rustLibrary: 'other' }, plan, 'desktop'), /rustLibrary/)
    assert.throws(() => verifyPluginJson({ ...good(), main: '' }, plan, 'desktop'), /main/)
  })
})
