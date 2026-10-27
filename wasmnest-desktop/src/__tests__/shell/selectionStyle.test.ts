import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 选中态样式锁（2026-10-20 用户裁决）
 *
 * 两套选中语言，都不用黑色描边：
 * 1. 背景壁纸选择（预览类，唯一保留勾章）：表面抬一档选中色阶 + 勾章
 *    （固定黑底 + 固定白勾，不随明暗反转）。
 * 2. 其余选择（主题/语言分段、快捷磁贴、多任务信息条、授权档位）：
 *    固定黑底 + 固定白字（不随明暗反转），不压勾章。
 *
 * 选中填充是固定近黑，不取 --color-primary：后者在深色主题下会翻成浅色，
 * 用户明确要求「选中背景为黑色，不是白色」。边框同样不许用黑色描边。
 * 深色档例外（2026-10-26 用户裁决，仅快捷磁贴）：黑底在近黑暗带上与未选块贴色，
 * 改用信息蓝淡染底 + 蓝图标表达「开」，不用边框 / 描边当线索，且不反转成白底。
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
const SWITCHER = 'src/shell/components/ShellTaskSwitcher.vue'
const SETTINGS = 'src/shell/sys/SysSettingsView.vue'
const QUICK = 'src/shell/components/ShellQuickSettings.vue'
const SEG = 'src/shell/components/ShellSeg.vue'
const SHELL_CSS = 'src/shell/styles/shell.css'
const AUTH = 'src/shell/auth/AuthorizationView.vue'

describe('选中态 token 已登记（单表真源 = style.css）', () => {
  it('--selection-solid / -ink / -halo / --selection-tint 四个 token 在位', () => {
    const css = read(STYLE)
    expect(css).toMatch(/--selection-solid:\s*#1d1a14/)
    expect(css).toMatch(/--selection-solid-ink:\s*#fdfcfa/)
    expect(css).toMatch(/--selection-halo:\s*color-mix\(/)
    expect(css).toMatch(/--selection-tint:\s*color-mix\(/)
  })

  it('选中黑底不随明暗反转：两个实底 token 只定义一次（dark 不覆盖）', () => {
    const css = read(STYLE)
    expect(css.match(/--selection-solid:/g)?.length ?? 0).toBe(1)
    expect(css.match(/--selection-solid-ink:/g)?.length ?? 0).toBe(1)
  })
})

describe('背景壁纸选择：唯一保留勾章的选择', () => {
  it('壁纸卡用 --selection-tint + 勾章 + aria-pressed', () => {
    const src = read(SETTINGS)
    expect(rule(src, '.pal-card.on')).toContain('var(--selection-tint)')
    expect(src, '选中壁纸必须有勾章').toContain('class="pal-check"')
    expect(src, '选中壁纸必须向读屏宣布按下态').toContain(':aria-pressed=')
  })

  it('勾章是固定黑底 + 固定白勾（不随明暗反转）', () => {
    const block = rule(read(SETTINGS), '.pal-check')
    expect(block, '勾面必须是固定黑底').toContain('background: var(--selection-solid)')
    expect(block, '勾线必须是固定白勾').toContain('color: var(--selection-solid-ink)')
  })
})

describe('其余选择：固定黑底 + 固定白字，不用勾章', () => {
  it('主题 / 语言分段：黑底白字，没有勾章、没有白色药丸', () => {
    const on = rule(read(SHELL_CSS), '.shell-seg button.on')
    expect(on, '选中背景必须是固定黑底').toContain('background: var(--selection-solid)')
    expect(on, '选中文字必须是固定白字').toContain('color: var(--selection-solid-ink)')
    expect(on, '不能再回到白色药丸').not.toContain('var(--bg-card)')

    const seg = read(SEG)
    expect(seg, '分段控件不许再渲染勾章').not.toContain('seg-check')
    expect(seg, '分段控件不需要勾章图标').not.toContain('ShellIcon')
  })

  it('多任务当前卡：信息条黑底 + 白应用名，不压勾章', () => {
    const src = read(SWITCHER)
    expect(rule(src, '.ts-card.active .ts-meta')).toContain('background: var(--selection-solid)')
    expect(rule(src, '.ts-card.active .ts-nm')).toContain('color: var(--selection-solid-ink)')
    expect(src, '当前卡不再使用勾章').not.toContain('ts-now')
    expect(src, '状态仍由 aria-current 宣布').toContain('aria-current')
  })

  it('快捷磁贴：选中黑底 + 白图文，aria-pressed 跟随开关态', () => {
    const src = read(QUICK)
    expect(rule(src, '.tile.on')).toContain('background: var(--selection-solid)')
    // 图标 / 标题 / 副标题三处一起反白（同一条分组规则）
    expect(src).toMatch(
      /\.tile\.on svg,\s*\.tile\.on \.tt b,\s*\.tile\.on \.tt span\s*\{[^}]*var\(--selection-solid-ink\)/,
    )
    expect(src.match(/:aria-pressed=/g)?.length ?? 0).toBe(3)
  })

  it('快捷磁贴深色档：不用边框，信息蓝淡染底 + 蓝图标表达「开」（2026-10-26 用户裁决）', () => {
    const src = read(QUICK)
    // 深色覆盖块位于基线 `.tile.on` 之后，rule(src, '.tile.on') 仍命中基线黑底块
    // （黑底白字基线不受影响，见上一条）
    expect(src).toMatch(
      /:root\.dark \.tile\.on\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--color-info\)\s*16%,\s*var\(--bg-card\)\)/,
    )
    expect(src).toMatch(/:root\.dark \.tile\.on svg\s*\{[^}]*color:\s*var\(--color-info\)/)
    // 深色档不得再用边框 / 描边作选中线索
    const darkBlock = src.match(/:root\.dark \.tile\.on\s*\{[^}]*\}/)?.[0] ?? ''
    expect(darkBlock).not.toContain('border-color: color-mix')
    expect(darkBlock).not.toContain('box-shadow')
  })

  it('授权档位：选中黑底 + 白字，aria-pressed 宣布当前档', () => {
    const src = read(AUTH)
    expect(src, '选中档位必须是固定黑底').toContain('bg-[var(--selection-solid)]')
    expect(src, '选中档位文字必须是固定白字').toContain('text-[var(--selection-solid-ink)]')
    expect(src, '选中档位必须向读屏宣布按下态').toContain(':aria-pressed=')
  })
})

describe('选中态不许用黑色描边', () => {
  it('卡片悬停 / 壁纸选中都不把边框染成 --color-primary', () => {
    expect(read(SWITCHER)).not.toMatch(
      /\.ts-card:hover\s*\{[^}]*border-color:\s*var\(--color-primary\)/,
    )
    expect(read(SETTINGS)).not.toMatch(
      /\.pal-card:hover\s*\{[^}]*border-color:\s*var\(--color-primary\)/,
    )
    expect(rule(read(SETTINGS), '.pal-card.on')).not.toMatch(
      /border-color:\s*var\(--color-primary\)/,
    )
  })
})
