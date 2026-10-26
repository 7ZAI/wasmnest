/**
 * 发布物自足锁（P1：SDK / dev 工具可分发）
 *
 * 背景：应用仓只拿到本 SDK（npm 渠道）就必须能构建 app——构建链不再 import 平台仓
 * 源码。`plugin-watch.js`（前端 watch 闭环）与 `tools/componentize`（file-transfer /
 * 移动端组件化）此前住平台仓 `wasmnest-desktop/scripts` 与仓库级 `tools/`，应用必须
 * 跨仓引用；收进 SDK 后，**发布内容本身**成为契约：漏一个 `files` 条目或一个
 * `exports` 条目，应用侧 `ERR_PACKAGE_PATH_NOT_EXPORTED` / 找不到 Cargo.toml。
 *
 * 判据（任一失败即红）：
 *  1. 应用需要的导出入口全部在册：`./bin/wasm-hash.js`、`./bin/plugin-watch.js`、
 *     `./tools/componentize/Cargo.toml`；
 *  2. `exports` 的每个目标都真实存在——`./dist/**` 是 `build` 产物，由 `files` 的
 *     `dist` 条目保证入库（本测试在未 build 的干净工作区也必须绿，故不查磁盘）；
 *  3. `files` 白名单覆盖 `bin` / `tools` / `dist`（npm 只发白名单内的文件）；
 *  4. 收进 `bin/` 的插件工具**自包含**：只引同目录 `./wasm-hash.js`，不得反向引
 *     平台仓路径（`../packages/**` 之类），否则发布包里必然断链；
 *  5. 两个 Rust crate 的 `repository` 指向平台仓（7ZAI/wasmnest），且 description 非空
 *     （crates.io 发布元数据门禁）。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface PackageJson {
  files: string[]
  exports: Record<string, string | Record<string, string>>
}

const pkg = JSON.parse(readFileSync(join(SDK_ROOT, 'package.json'), 'utf-8')) as PackageJson

/** 展开 exports（字符串或条件对象）里的全部目标路径 */
function exportTargets(): string[] {
  const out: string[] = []
  for (const value of Object.values(pkg.exports)) {
    if (typeof value === 'string') out.push(value)
    else out.push(...Object.values(value))
  }
  return out
}

/** 把 `./bin/plugin-watch.js` 这类导出目标落到磁盘路径 */
function diskPath(target: string): string {
  return resolve(SDK_ROOT, target)
}

describe('SDK 发布物内容（应用构建链的自足面）', () => {
  it('应用需要的导出入口全部在册', () => {
    expect(Object.keys(pkg.exports)).toEqual(
      expect.arrayContaining([
        './bin/wasm-hash.js',
        './bin/plugin-watch.js',
        './tools/componentize/Cargo.toml',
      ]),
    )
  })

  it('exports 的每个目标都存在（dist 由 build 产出，按 files 白名单保证）', () => {
    const missing = exportTargets().filter(
      (target) => !target.startsWith('./dist/') && !existsSync(diskPath(target)),
    )
    expect(missing, `exports 指向了不存在的文件: ${missing.join(', ')}`).toEqual([])
  })

  it('files 白名单覆盖 bin / tools / dist（npm 只发白名单内的文件）', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['bin', 'tools', 'dist']))
  })

  it('收进 bin/ 的 plugin-watch 自包含（只引同目录 wasm-hash，不反向引平台仓）', () => {
    const source = readFileSync(join(SDK_ROOT, 'bin', 'plugin-watch.js'), 'utf-8')
    expect(source).toContain("from './wasm-hash.js'")
    expect(source).not.toMatch(/from\s+'\.\.\/packages\//)
  })
})

describe('Rust SDK crate 发布元数据', () => {
  const crates = ['rust/Cargo.toml', 'rust-macros/Cargo.toml']

  for (const manifest of crates) {
    it(`${manifest} 指向平台仓（7ZAI/wasmnest）且 description 非空`, () => {
      const text = readFileSync(join(SDK_ROOT, manifest), 'utf-8')
      const repository = text.match(/^repository\s*=\s*"([^"]+)"/m)?.[1]
      const description = text.match(/^description\s*=\s*"([^"]+)"/m)?.[1]

      expect(repository).toBe('https://github.com/7ZAI/wasmnest')
      expect(description?.trim()).toBeTruthy()
    })
  }
})
