import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 壳扩展点接线锁
 *
 * 注册表与组件本身有行为测试，但「ShellHost 是否真的挂上」没有运行时覆盖：
 * 忘记挂状态栏 / 忘记装配主题时，所有组件测试仍全绿而界面完全没变化。
 * 这里直接锁 ShellHost 的装配点与顺序。
 */

const HOST = readFileSync('src/shell/ShellHost.vue', 'utf-8')
const MAIN = readFileSync('src/main.ts', 'utf-8')

describe('壳扩展点接线锁', () => {
  it('主题在壳内装配（token 挂 <html>，不再挂壳根内联样式）', () => {
    expect(HOST).toContain('useShellTheme()')
    // 主题挂在文档根：壳根只留壁纸内联变量，避免主题被限制在壳子树里
    expect(HOST).not.toContain('skinStyle')
    expect(HOST).toContain(':style="wallStyle"')
  })

  it('主题 CSS 与首帧预应用都在入口接线', () => {
    expect(MAIN).toContain("import './styles/theme-presets.css'")
    const presetAt = MAIN.indexOf('presetThemeBeforeMount()')
    expect(presetAt, 'main.ts 必须调用 presetThemeBeforeMount（首帧零闪变）').toBeGreaterThan(0)
    expect(presetAt, '主题必须在 app.mount 之前应用').toBeLessThan(MAIN.indexOf("app.mount('#app')"))
    expect(MAIN.indexOf("import './styles/theme-presets.css'"), '主题 CSS 排在 token 之后').toBeGreaterThan(
      MAIN.indexOf("import './style.css'"),
    )
  })

  it('状态栏在路由内容之后、全局覆层之前挂载；独立窗口与应用态不渲染', () => {
    expect(HOST).toContain('<ShellStatusBar v-if="!isBareWindow && !isAppRoute" />')

    const statusAt = HOST.indexOf('<ShellStatusBar')
    expect(statusAt).toBeGreaterThan(HOST.indexOf('<AppMountSlot'))
    expect(statusAt).toBeGreaterThan(HOST.indexOf('<ShellCardScreen'))
    expect(statusAt).toBeLessThan(HOST.indexOf('<ShellTaskSwitcher'))
  })
})
