/**
 * 宿主壁纸作用域锁（2026-10-23）
 *
 * 需求：移动端与桌面壳同口径——背景（壁纸 + 遮罩）挂在宿主根，主屏 / 应用管理 /
 * 权限 / 设置 / 应用运行面共用同一背景，不再只有主屏生效。
 *
 * 本锁钉住：① 壁纸类、遮罩变量与壁纸层由 ShellHost 壳根承载；② ShellHomeScreen
 * 不再自持壁纸；③ 层序（壁纸在壳根底色之上、内容之下）；④ 各宿主屏不自铺不透明
 * 页面底色（否则又把根背景盖住）；⑤ 外观设置文案不再写「仅主屏」。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(p, 'utf-8')

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? ''
}

describe('移动宿主壁纸作用域：所有宿主屏共用壳根背景', () => {
  it('ShellHost 壳根承载壁纸类、遮罩强度与壁纸层', () => {
    const src = read('src/shell/components/ShellHost.vue')
    expect(src, '壳根必须始终带 .shell-wall').toContain("'shell-wall'")
    expect(src, '壁纸档位类必须由偏好派生').toContain('wall-${wallpaper.value}')
    expect(src, '遮罩强度必须写在壳根（--wall-dim）').toContain("'--wall-dim'")
    expect(src, '壁纸层必须是壳根的子元素').toContain('class="shell-wallpaper"')
    expect(src, '壁纸偏好必须来自 useShellPreferences').toContain('useShellPreferences')
    expect(src, '自定义壁纸必须经宿主 asset 工具取 URL').toContain('toFileAssetUrl')
    expect(src, '壳根必须建立层叠上下文（负层序壁纸才有落点）').toContain('isolate')
  })

  it('ShellHomeScreen 不再自持壁纸（否则只有主屏生效）', () => {
    const src = read('src/shell/components/screens/ShellHomeScreen.vue')
    expect(src).not.toContain('shell-wall')
    expect(src).not.toContain('shell-wallpaper')
    expect(src).not.toContain('useShellPreferences')
    expect(src).not.toContain("'--wall-dim'")
  })

  it('层序：氛围底在壁纸之下，壁纸在内容之下', () => {
    const wallpaper = read('src/styles/wallpaper.css')
    expect(cssBlock(wallpaper, '.shell-wallpaper'), '壁纸层必须落到负层序').toContain(
      'z-index: -1',
    )
    const shell = read('src/shell/styles/shell.css')
    expect(cssBlock(shell, '.shell-ui::before'), '氛围底必须在壁纸之下').toContain(
      'z-index: -2',
    )
  })

  it('宿主页面保持透明，不自铺不透明页面底色', () => {
    const screens = [
      'src/shell/components/screens/ShellHomeScreen.vue',
      'src/shell/components/screens/ShellAppsScreen.vue',
      'src/shell/components/screens/ShellPermissionsScreen.vue',
      'src/shell/components/screens/ShellSettingsScreen.vue',
      'src/shell/components/screens/ShellSwitcherScreen.vue',
      'src/shell/components/screens/ShellAppRunScreen.vue',
      'src/shell/components/screens/ShellAppDetailScreen.vue',
    ]
    for (const screen of screens) {
      expect(read(screen), `${screen} 不得自铺 bg-[var(--mobile-bg-primary)]`).not.toContain(
        'bg-[var(--mobile-bg-primary)]',
      )
    }
  })

  it('外观设置不再写「仅主屏」', () => {
    expect(read('src/locales/zh-CN/settings.ts')).not.toContain("backgroundNote: '仅主屏'")
    expect(read('src/locales/en/settings.ts')).not.toContain(
      "backgroundNote: 'Home screen only'",
    )
  })
})
