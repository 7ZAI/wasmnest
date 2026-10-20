import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 壳扩展点接线锁
 *
 * 注册表与组件本身有行为测试，但「ShellHost 是否真的挂上」没有运行时覆盖：
 * 忘记挂状态栏 / 忘记把皮肤 token 接到壳根时，所有组件测试仍全绿而界面完全没变化。
 * 这里直接锁 ShellHost 的装配点与顺序。
 */

const HOST = readFileSync('src/shell/ShellHost.vue', 'utf-8')

describe('壳扩展点接线锁', () => {
  it('皮肤 token 与壁纸样式一起挂到壳根', () => {
    expect(HOST).toContain('const { skinStyle } = useShellThemeSkin()')
    expect(HOST).toContain(':style="[wallStyle, skinStyle]"')
  })

  it('状态栏在路由内容之后、全局覆层之前挂载，独立窗口不渲染', () => {
    expect(HOST).toContain('<ShellStatusBar v-if="!isBareWindow" />')

    const statusAt = HOST.indexOf('<ShellStatusBar')
    expect(statusAt).toBeGreaterThan(HOST.indexOf('<AppMountSlot'))
    expect(statusAt).toBeGreaterThan(HOST.indexOf('<ShellCardScreen'))
    expect(statusAt).toBeLessThan(HOST.indexOf('<ShellTaskSwitcher'))
  })
})
