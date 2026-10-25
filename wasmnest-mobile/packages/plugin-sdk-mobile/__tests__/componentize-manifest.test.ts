/**
 * 组件化工具落点锁（P1：SDK / dev 工具可分发）
 *
 * 背景：组件化工具（`wasmnest-componentize`，core module → Component）原住平台仓级
 * `tools/componentize`，应用 / 移动构建必须引用平台仓源码。P1 把它收进**桌面 SDK** 的
 * `tools/`（随 npm 包发布），移动 SDK 的 CLI 搜索链以新落点优先、旧落点仅作兼容兜底。
 *
 * 判据（任一失败即红）：
 *  1. 仓内新落点真实存在，且桌面 SDK 的 `files` / `exports` 都登记了它（发布包内可见）；
 *  2. `cli.js` 的候选链里新落点排在旧平台仓落点之前——顺序反了会让旧树永远遮住新发布物。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(SDK_ROOT, '../../..')

const DESKTOP_SDK_ROOT = join(REPO_ROOT, 'wasmnest-desktop/packages/plugin-sdk-desktop')
const NEW_MANIFEST = join(DESKTOP_SDK_ROOT, 'tools/componentize/Cargo.toml')

interface PackageJson {
  files: string[]
  exports: Record<string, string>
}

describe('组件化工具随桌面 SDK 发布', () => {
  it('仓内新落点存在，且 files / exports 都登记了 tools 与 Cargo.toml', () => {
    const pkg = JSON.parse(
      readFileSync(join(DESKTOP_SDK_ROOT, 'package.json'), 'utf-8'),
    ) as PackageJson

    expect(existsSync(NEW_MANIFEST)).toBe(true)
    expect(pkg.files).toContain('tools')
    expect(pkg.exports['./tools/componentize/Cargo.toml']).toBe('./tools/componentize/Cargo.toml')
  })

  it('CLI 候选链优先桌面 SDK 落点，旧平台仓落点只作兜底', () => {
    const source = readFileSync(join(SDK_ROOT, 'bin/lib.js'), 'utf-8')
    const newAt = source.indexOf("'wasmnest-desktop', 'packages', 'plugin-sdk-desktop', 'tools'")
    const legacyAt = source.indexOf("join('tools', 'componentize', 'Cargo.toml')")

    expect(newAt, 'CLI 未登记桌面 SDK 新落点').toBeGreaterThan(-1)
    expect(legacyAt, 'CLI 应保留旧落点作为兼容兜底').toBeGreaterThan(-1)
    expect(newAt, '旧落点排在新落点之前：发布物会被平台仓旧树遮住').toBeLessThan(legacyAt)
  })
})
