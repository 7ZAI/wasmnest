import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 表面透明度阶梯锁（2026-10-20 用户裁决）
 *
 * 背景：壁纸挂在壳根后，用户提出「主要页面是否都该半透明 / 玻璃」。
 * 裁决不是全页玻璃，而是按「背后有什么」分档：
 * 1. 内容面（设置卡片 / 工具栏）：背后只有壁纸 → 92% 轻透，不加 blur；
 * 2. 浮层（通知 / 快捷设置 / 右键菜单）：背后是任意应用内容 → 96% + blur；
 * 3. 决策面（授权弹窗）与密集数据面（授权列表）：保持实心，优先逐字可读；
 * 4. 应用挂载面：应用自绘，不参与宿主透明度。
 *
 * 本锁钉住 ①②③ 的落点，防止后续「顺手把卡片也做成玻璃」或
 * 「把授权弹窗改成半透」时没有红。
 */

const read = (path: string): string => readFileSync(path, 'utf-8')

/** 取 CSS 规则块（选择器后紧跟 `{`，避免匹配到 `X Y {` 的派生规则） */
function rule(src: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = src.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `找不到规则块 ${selector}`).toBeTruthy()
  return match![1]
}

const STYLE = 'src/style.css'
const SHELL_CSS = 'src/shell/styles/shell.css'
const CARD = 'src/shell/components/ShellCard.vue'
const TOOLBAR = 'src/shell/components/ShellToolbar.vue'
const NOTIF = 'src/shell/components/ShellNotificationPanel.vue'
const QUICK = 'src/shell/components/ShellQuickSettings.vue'
const CTX = 'src/shell/components/ShellContextMenu.vue'
const AUTH_VIEW = 'src/shell/auth/AuthorizationView.vue'
const FS_AUTH = 'src/shell/auth/FsAuthDialog.vue'
const NET_AUTH = 'src/shell/auth/NetworkAuthDialog.vue'
const MODAL = 'src/components/Modal.vue'
const DIALOG_LAYER = 'src/shell/components/ShellDialogLayer.vue'

describe('透明度阶梯 token（单表真源 = style.css）', () => {
  it('内容面 / 浮层表面 token 在位，且不透明度下限符合裁决', () => {
    const css = read(STYLE)
    expect(css, '内容卡片 / 工具栏表面 = 92%').toMatch(
      /--bg-veil:\s*color-mix\(in srgb, var\(--bg-card\) 92%, transparent\)/,
    )
    expect(css, '浮层表面 = 96%（92% 时 11px tertiary 文字会掉出 AA）').toMatch(
      /--bg-glass:\s*color-mix\(in srgb, var\(--bg-card\) 96%, transparent\)/,
    )
    expect(css).toMatch(/--ui-glass-blur:\s*18px/)
    expect(css).toMatch(/--ui-glass-saturate:\s*115%/)
  })
})

describe('内容面：壁纸开启时轻透，不叠背景模糊', () => {
  it('设置卡片由 .shell-wall 门控，使用 --bg-veil', () => {
    const block = rule(read(CARD), '.shell-wall .shell-card')
    expect(block).toContain('var(--bg-veil)')
    expect(block, '卡片背后只有柔和壁纸，blur 看不出差异，不要加').not.toContain(
      'backdrop-filter',
    )
  })

  it('工具栏同样只轻透、不叠模糊', () => {
    const block = rule(read(TOOLBAR), '.shell-wall .shell-toolbar')
    expect(block).toContain('var(--bg-veil)')
    expect(block).not.toContain('backdrop-filter')
  })

  it('设置页分组仍走 ShellCard（否则轻透不会生效）', () => {
    expect(read('src/shell/sys/SysSettingsView.vue')).toContain('<ShellCard')
  })
})

describe('浮层：共享玻璃类 + 双写背景模糊', () => {
  it('.shell-glass 同时提供表面色与 -webkit- / 标准 backdrop-filter', () => {
    const block = rule(read(SHELL_CSS), '.shell-glass')
    expect(block).toContain('var(--bg-glass)')
    expect(block).toContain('-webkit-backdrop-filter')
    expect(block).toContain('backdrop-filter')
    expect(block).toContain('blur(var(--ui-glass-blur))')
  })

  it('通知 / 快捷设置 / 右键菜单接入 .shell-glass，且不再各自铺实心卡面', () => {
    expect(read(NOTIF)).toContain('shell-glass')
    expect(read(QUICK)).toContain('shell-glass')
    expect(read(CTX)).toContain('shell-glass')

    expect(rule(read(NOTIF), '.panel')).not.toContain('background: var(--bg-card)')
    expect(rule(read(QUICK), '.qs-panel')).not.toContain('background: var(--bg-card)')
  })
})

describe('决策面 / 密集数据面：保持实心，不接玻璃 token', () => {
  it.each([
    ['授权列表', AUTH_VIEW],
    ['文件授权弹窗', FS_AUTH],
    ['网络授权弹窗', NET_AUTH],
    ['通用弹窗', MODAL],
    ['壳弹窗层', DIALOG_LAYER],
  ])('%s 不得使用玻璃表面', (_name, file) => {
    const src = read(file)
    expect(src).not.toContain('shell-glass')
    expect(src).not.toContain('--bg-glass')
    expect(src).not.toContain('--bg-veil')
  })
})
