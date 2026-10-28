/**
 * scripts/build-latest-json.mjs 行为契约测试（node --test，零依赖）
 *
 * 契约来源：Tauri updater 静态 JSON（`latest.json`）+ 本仓版本线
 * （`release-manifest.json` 的 `product`）。
 *
 * 行为契约：
 * | 契约ID | 来源 | 规则 |
 * | C-001 | classifyAsset | `-setup.exe` / `.AppImage[.tar.gz]` 归到对应 target key；同时兼容 `_x64-setup.exe` 与 `-release-x64-setup.exe`；deb / latest.json / .sig / .sha256 不算载体；未知返回 null |
 * | C-002 | classifyAsset | `.AppImage.tar.gz` 必须先于裸 `.AppImage` 命中（更新包不能被当成安装包） |
 * | C-003 | collectArtifacts | 缺 `<artifact>.sig` 直接抛错并点名；目录无载体抛错；签名内容 trim |
 * | C-004 | buildLatestJson | `<baseUrl>/<encodeURIComponent(name)>`；platforms 键稳定排序；signature 原样 |
 * | C-005 | buildLatestJson | 同一 target 命中多个产物即抛错（不静默取其一）；version / baseUrl / 空 artifacts 非法即抛错 |
 * | C-006 | parseArgs | `--k v` 与 `--k=v` 等价；`--k` 缺值抛错（不静默取空串） |
 *
 * 副作用：import 本模块不得触发 CLI main（有 import.meta.url 守卫）。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyAsset,
  collectArtifacts,
  buildLatestJson,
  parseArgs,
} from './build-latest-json.mjs'

const tmpDirs = []
function makeTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

describe('classifyAsset（C-001 / C-002）', () => {
  it('Windows NSIS 按架构归类', () => {
    assert.equal(classifyAsset('WasmNest_0.0.1_x64-setup.exe'), 'windows-x86_64')
    assert.equal(classifyAsset('WasmNest_0.0.1_arm64-setup.exe'), 'windows-aarch64')
  })

  it('Linux AppImage 更新包（.tar.gz）与裸 AppImage 都归 linux', () => {
    assert.equal(classifyAsset('WasmNest_0.0.1_amd64.AppImage.tar.gz'), 'linux-x86_64')
    assert.equal(classifyAsset('WasmNest_0.0.1_aarch64.AppImage.tar.gz'), 'linux-aarch64')
    assert.equal(classifyAsset('WasmNest_0.0.1_amd64.AppImage'), 'linux-x86_64')
  })

  it('兼容 tauri-build.js 重命名后的 -release- 形态（C-001 / 本地与 CI 同名）', () => {
    assert.equal(classifyAsset('WasmNest-0.0.1-release-x64-setup.exe'), 'windows-x86_64')
    assert.equal(classifyAsset('WasmNest-0.0.1-release-arm64-setup.exe'), 'windows-aarch64')
    assert.equal(classifyAsset('WasmNest-0.0.1-release-amd64.AppImage'), 'linux-x86_64')
  })

  it('.AppImage.tar.gz 先于裸 .AppImage 命中（C-002，不重复归类）', () => {
    const name = 'WasmNest_0.0.1_amd64.AppImage.tar.gz'
    // 只返回一个 target；裸 AppImage 规则不得抢先
    assert.equal(classifyAsset(name), 'linux-x86_64')
    assert.notEqual(classifyAsset(`${name}.sig`), 'linux-x86_64')
  })

  it('deb / latest.json / .sig / .sha256 不是更新载体', () => {
    assert.equal(classifyAsset('WasmNest_0.0.1_amd64.deb'), null)
    assert.equal(classifyAsset('latest.json'), null)
    assert.equal(classifyAsset('WasmNest_0.0.1_x64-setup.exe.sig'), null)
    assert.equal(classifyAsset('WasmNest_0.0.1_x64-setup.exe.sha256'), null)
  })

  it('未知文件与空输入返回 null', () => {
    assert.equal(classifyAsset('README.md'), null)
    assert.equal(classifyAsset(''), null)
    assert.equal(classifyAsset(undefined), null)
  })
})

describe('collectArtifacts（C-003）', () => {
  it('收集产物并读取签名（trim 尾部换行，按 target 排序）', () => {
    const dir = makeTmp('latest-json-')
    writeFileSync(join(dir, 'WasmNest_0.0.1_x64-setup.exe'), 'x')
    writeFileSync(join(dir, 'WasmNest_0.0.1_x64-setup.exe.sig'), 'SIGWIN\n')
    writeFileSync(join(dir, 'WasmNest_0.0.1_amd64.AppImage.tar.gz'), 'x')
    writeFileSync(join(dir, 'WasmNest_0.0.1_amd64.AppImage.tar.gz.sig'), ' SIGLN \n')
    writeFileSync(join(dir, 'WasmNest_0.0.1_amd64.deb'), 'x')

    const artifacts = collectArtifacts(dir)
    assert.deepEqual(
      artifacts.map((a) => [a.target, a.name, a.signature]),
      [
        ['linux-x86_64', 'WasmNest_0.0.1_amd64.AppImage.tar.gz', 'SIGLN'],
        ['windows-x86_64', 'WasmNest_0.0.1_x64-setup.exe', 'SIGWIN'],
      ],
    )
  })

  it('缺 .sig 直接抛错并点名文件', () => {
    const dir = makeTmp('latest-json-')
    writeFileSync(join(dir, 'WasmNest_0.0.1_x64-setup.exe'), 'x')
    assert.throws(
      () => collectArtifacts(dir),
      /缺少签名边车 WasmNest_0\.0\.1_x64-setup\.exe\.sig/,
    )
  })

  it('空签名内容视为错误（不能产出空 signature）', () => {
    const dir = makeTmp('latest-json-')
    writeFileSync(join(dir, 'WasmNest_0.0.1_x64-setup.exe'), 'x')
    writeFileSync(join(dir, 'WasmNest_0.0.1_x64-setup.exe.sig'), '  \n')
    assert.throws(() => collectArtifacts(dir), /为空/)
  })

  it('目录里没有更新载体时抛错并列出实际内容', () => {
    const dir = makeTmp('latest-json-')
    writeFileSync(join(dir, 'WasmNest_0.0.1_amd64.deb'), 'x')
    assert.throws(() => collectArtifacts(dir), /没有任何更新载体[\s\S]*\.deb/)
  })

  it('目录不存在时抛错（不返回空结果）', () => {
    assert.throws(() => collectArtifacts(join(tmpdir(), 'definitely-missing-dir-xyz')), /不可读/)
  })
})

describe('buildLatestJson（C-004 / C-005）', () => {
  const base = {
    version: '0.0.1',
    baseUrl: 'https://github.com/7ZAI/wasmnest/releases/download/v0.0.1',
    pubDate: '2026-10-28T00:00:00.000Z',
    notes: 'note',
  }

  it('url = baseUrl/文件名，platforms 键稳定排序', () => {
    const doc = buildLatestJson({
      ...base,
      artifacts: [
        { target: 'windows-x86_64', name: 'WasmNest_0.0.1_x64-setup.exe', signature: 'S1' },
        { target: 'linux-x86_64', name: 'WasmNest_0.0.1_amd64.AppImage.tar.gz', signature: 'S2' },
      ],
    })
    assert.equal(doc.version, '0.0.1')
    assert.equal(doc.notes, 'note')
    assert.equal(doc.pub_date, '2026-10-28T00:00:00.000Z')
    assert.deepEqual(Object.keys(doc.platforms), ['linux-x86_64', 'windows-x86_64'])
    assert.deepEqual(doc.platforms['windows-x86_64'], {
      signature: 'S1',
      url: 'https://github.com/7ZAI/wasmnest/releases/download/v0.0.1/WasmNest_0.0.1_x64-setup.exe',
    })
    assert.equal(
      doc.platforms['linux-x86_64'].url,
      'https://github.com/7ZAI/wasmnest/releases/download/v0.0.1/WasmNest_0.0.1_amd64.AppImage.tar.gz',
    )
  })

  it('baseUrl 末尾斜杠被归一（不产生 //）', () => {
    const doc = buildLatestJson({
      ...base,
      baseUrl: 'https://example.com/dl//',
      artifacts: [{ target: 'windows-x86_64', name: 'a_x64-setup.exe', signature: 'S' }],
    })
    assert.equal(doc.platforms['windows-x86_64'].url, 'https://example.com/dl/a_x64-setup.exe')
  })

  it('同一 target 命中多个产物即抛错（C-005）', () => {
    assert.throws(
      () =>
        buildLatestJson({
          ...base,
          artifacts: [
            { target: 'linux-x86_64', name: 'a_amd64.AppImage', signature: 'S' },
            { target: 'linux-x86_64', name: 'a_amd64.AppImage.tar.gz', signature: 'S' },
          ],
        }),
      /命中多个产物/,
    )
  })

  it('version / baseUrl / artifacts 非法即抛错', () => {
    const artifacts = [{ target: 'windows-x86_64', name: 'a_x64-setup.exe', signature: 'S' }]
    assert.throws(() => buildLatestJson({ ...base, version: 'v0.0.1', artifacts }), /version/)
    assert.throws(() => buildLatestJson({ ...base, version: '0.0', artifacts }), /version/)
    assert.throws(() => buildLatestJson({ ...base, baseUrl: 'github.com/x', artifacts }), /base-url/)
    assert.throws(() => buildLatestJson({ ...base, artifacts: [] }), /artifacts 为空/)
  })

  it('默认 pub_date 为 ISO 8601', () => {
    const doc = buildLatestJson({
      ...base,
      pubDate: undefined,
      artifacts: [{ target: 'windows-x86_64', name: 'a_x64-setup.exe', signature: 'S' }],
    })
    assert.match(doc.pub_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('parseArgs（C-006）', () => {
  it('--k v 与 --k=v 等价', () => {
    assert.deepEqual(parseArgs(['--version', '0.0.1', '--out=latest.json']), {
      version: '0.0.1',
      out: 'latest.json',
    })
  })

  it('缺值 / 非法 token 抛错', () => {
    assert.throws(() => parseArgs(['--version']), /缺值/)
    assert.throws(() => parseArgs(['--version', '--out', 'x']), /缺值/)
    assert.throws(() => parseArgs(['pos']), /无法识别的参数/)
  })
})
