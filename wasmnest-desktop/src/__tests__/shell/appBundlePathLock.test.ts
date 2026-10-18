import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 应用挂载包路径单一来源锁（2026-10-17 验证 P0-1 的回归锁）
 *
 * 背景：宿主用 `resource_dir()/resources/plugins/desktop` 扫描插件，前端却用
 * `resourceDir()/plugins/desktop` 拼 asset URL——少一层 `resources`，于是每个挂载面
 * 都 404，界面只显示「加载失败」，而后端一切正常（同一份约定写了两遍）。
 *
 * 锁的内容：
 * - 前端只能经宿主命令 `plugin_get_asset_dir` 取整包根目录，源码里不得再出现
 *   `plugins/desktop` 这类落点字面量（写死就又是两处真源）；
 * - 宿主侧命令必须真实注册且状态已装配（否则命令在运行期是 unknown command）。
 */

const USE_APP_MOUNT = 'src/composables/useAppMount.ts'
const LIB_RS = 'src-tauri/src/lib.rs'
const ASSETS_RS = 'src-tauri/src/plugin/assets.rs'

describe('应用挂载包路径单一来源锁', () => {
  it('前端经宿主命令取目录，不自己拼插件落点', () => {
    const src = readFileSync(USE_APP_MOUNT, 'utf-8')
    expect(src).toContain("invoke<string>('plugin_get_asset_dir')")
    // 落点字面量只允许存在于宿主（资源装配）；前端出现即说明路径又写了两遍
    expect(src).not.toContain('plugins/desktop')
    expect(src).not.toContain("'plugins'")
    expect(src).not.toContain('resourceDir')
  })

  it('宿主注册命令并装配目录状态（缺一即运行期 unknown command / 无状态）', () => {
    const lib = readFileSync(LIB_RS, 'utf-8')
    expect(lib).toContain('plugin::assets::plugin_get_asset_dir')
    expect(lib).toContain('plugin::assets::AppAssetsDir')
    const assets = readFileSync(ASSETS_RS, 'utf-8')
    expect(assets).toContain('pub fn plugin_get_asset_dir')
    expect(assets).toContain('pub struct AppAssetsDir')
  })
})
