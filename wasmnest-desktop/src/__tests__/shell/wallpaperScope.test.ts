import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 壳壁纸作用域锁（2026-10-20）
 *
 * 背景：壁纸偏好存在 useShellSettings，渲染却只落在 ShellHome——
 * 切到系统页（ShellCardScreen 自铺 `--bg-page`）壁纸整面消失，
 * 用户预期「设置了背景，宿主所有页面都生效」。
 *
 * 本锁钉住：① 壁纸类与遮罩强度挂在 ShellHost 壳根（所有面共用）；
 * ② 宿主页面不再自铺不透明页面底色（否则又把根背景盖住）；
 * ③ 壁纸类已从主屏私有样式改名 `.shell-wall`，不留 `.home-wall` 旧名。
 */
const read = (p: string) => readFileSync(p, 'utf-8')

describe('壳壁纸作用域：宿主所有面共用壳根背景', () => {
  it('ShellHost 壳根承载壁纸类 + 遮罩强度', () => {
    const src = read('src/shell/ShellHost.vue')
    expect(src, '壳根必须绑定 .shell-wall 壁纸类').toContain('shell-wall')
    expect(src, '壁纸档位类必须由 wallClass 派生').toContain('wall-${wallClass}')
    expect(src, '遮罩强度必须写在壳根（CSS 变量 --wall-dim）').toContain("'--wall-dim'")
    expect(src, '壁纸偏好必须来自 useShellSettings').toContain('useShellSettings')
  })

  it('宿主页面保持透明，不自铺不透明页面底色', () => {
    expect(read('src/shell/views/ShellView.vue'), '主屏容器不得自铺 bg-page').not.toContain(
      'bg-page',
    )
    expect(
      read('src/shell/components/ShellCardScreen.vue'),
      '系统页不得自铺 background: var(--bg-page)',
    ).not.toContain('background: var(--bg-page)')
    expect(
      read('src/shell/views/NotFoundView.vue'),
      '宿主兜底面不得自铺 bg-[var(--bg-page)]',
    ).not.toContain('bg-[var(--bg-page)]')
  })

  it('ShellHome 不再单独持有壁纸（否则只有主屏生效）', () => {
    const src = read('src/shell/components/ShellHome.vue')
    expect(src).not.toContain('shell-wall')
    expect(src).not.toContain("'--wall-dim'")
  })

  it('样式真源只有 .shell-wall（不留 .home-wall 旧名）', () => {
    const css = read('src/shell/styles/shell.css')
    expect(css).toContain('.shell-wall')
    expect(css).not.toContain('.home-wall')
  })
})
