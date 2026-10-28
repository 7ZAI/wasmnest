import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { BUILTIN_THEMES, SHELL_THEME_DEFAULT } from '@/shell/composables/themePresets'

/**
 * 主题预设覆盖锁（2026-10-27 主题机制建立时立）
 *
 * 主题目录（TS）与主题样式表（CSS）是两份真源，任何一边漏项都表现为
 * 「切过去没反应」——而这种失效没有任何异常可捕获：点了、属性也写了、
 * 只是选择器不存在。四条断言：
 *
 *   1. 每个内置主题 id 在 theme-presets.css 有对应 token 块；
 *   2. 除默认主题外，每个主题都有深色档（浅色值直接套深底会掉对比度）；
 *   3. 决策面不变量：授权 / 弹窗组件不得被主题选择器命中（任何主题都必须实心）；
 *   4. 内容面 token `--bg-card` 不得被主题改成半透明（它是决策面的实心底）；
 *   5. 动效主题必须真的有 keyframes 引用，且 reduced-motion 守卫在位。
 */

const CSS = readFileSync('src/styles/theme-presets.css', 'utf-8')

/** 取某个主题的浅色 token 块（`[data-theme='x'] {` 开头的那一段） */
function tokenBlock(themeId: string): string {
  const match = CSS.match(new RegExp(`\\[data-theme='${themeId}'\\]\\s*\\{([^}]*)\\}`))
  expect(match, `${themeId} 缺少 token 块`).toBeTruthy()
  return match![1]
}

/** 取某个主题的深色 token 块（两条选择器并写，取到第一段即可） */
function darkTokenBlock(themeId: string): string {
  const match = CSS.match(new RegExp(`:root\\.dark\\[data-theme='${themeId}'\\][^{]*\\{([^}]*)\\}`))
  expect(match, `${themeId} 缺少深色 token 块`).toBeTruthy()
  return match![1]
}

const NON_DEFAULT = BUILTIN_THEMES.map((theme) => theme.id).filter((id) => id !== SHELL_THEME_DEFAULT)

describe('主题预设覆盖', () => {
  it('每个非默认内置主题都有浅色 / 深色 token 块', () => {
    for (const id of NON_DEFAULT) {
      expect(tokenBlock(id).trim().length, `${id} 浅色块为空`).toBeGreaterThan(0)
      expect(darkTokenBlock(id).trim().length, `${id} 深色块为空`).toBeGreaterThan(0)
    }
  })

  it('主题 token 覆盖的是表面 / 圆角 / 阴影，不是随便几个无关变量', () => {
    for (const id of NON_DEFAULT) {
      const block = tokenBlock(id)
      for (const required of ['--bg-page', '--bg-veil', '--bg-glass', '--radius-card']) {
        expect(block, `${id} 缺少 ${required}（主题语汇不完整）`).toContain(`${required}:`)
      }
    }
  })

  it('决策面不变量：主题选择器不得命中授权 / 弹窗组件', () => {
    // 这些组件的可读性优先于氛围：任何主题都不许给它们加玻璃或改底色
    for (const forbidden of [
      'AuthorizationView',
      'FsAuthDialog',
      'NetworkAuthDialog',
      'ShellDialogLayer',
      'auth-',
    ]) {
      expect(CSS, `主题样式表命中决策面（${forbidden}）——违反跨主题不变量`).not.toContain(
        forbidden,
      )
    }
  })

  it('--bg-card 不得被主题改成半透明（它是决策面的实心底）', () => {
    for (const id of NON_DEFAULT) {
      for (const block of [tokenBlock(id), darkTokenBlock(id)]) {
        const match = block.match(/--bg-card:\s*([^;]+);/)
        if (!match) continue
        expect(match[1], `${id} 把 --bg-card 改成半透明，决策面会跟着透`).not.toContain(
          'transparent',
        )
      }
    }
  })

  it('带漂移动效的主题引用了 keyframes，且 reduced-motion 守卫在位', () => {
    const dynamicThemes = BUILTIN_THEMES.filter((theme) => theme.dynamic).map((theme) => theme.id)
    // 目录里声明 dynamic 的必须真的挂了动画（否则设置页的「动态」标记是假的）
    for (const id of dynamicThemes) {
      expect(CSS, `${id} 声明了 dynamic 但没有挂 animation`).toContain(
        `[data-theme='${id}'] .shell-root:not(.wall-custom)`,
      )
    }
    expect(CSS).toContain('@keyframes theme-drift')
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('默认主题的预览块挂 theme-base，隔离当前主题的 token', () => {
    const style = readFileSync('src/style.css', 'utf-8')
    // 深浅两档基础档都要与 .theme-base 共用（默认预览跟壳的明暗走）
    expect(style, '浅色基础档未与 .theme-base 共用').toMatch(/^:root,\s*\n\.theme-base\s*\{/m)
    expect(style, '深色基础档未与 .theme-base 共用').toMatch(
      /^:root\.dark,\s*\n:root\.dark \.theme-base\s*\{/m,
    )
    // 主题专属的三枚 token 必须显式归零，否则默认预览继承当前主题的语汇
    // （基础档是 `:root,` + `.theme-base {` 两行合写的，中性化块另起一块）
    const baseBlocks = [...style.matchAll(/^\.theme-base \{([^}]*)\}/gm)].map((m) => m[1])
    const base = baseBlocks.find((block) => block.includes('--theme-ambient'))
    expect(base, 'style.css 缺少 .theme-base 中性化块').toBeTruthy()
    for (const token of ['--theme-ambient', '--theme-icon-shadow', '--theme-icon-radius']) {
      expect(base!, `.theme-base 未归零 ${token}`).toContain(`${token}:`)
    }
    // 预览块要真的挂上这个类
    const section = readFileSync('src/shell/settings/SettingsThemeSection.vue', 'utf-8')
    expect(section, '默认主题预览未挂 theme-base').toMatch(
      /class="theme-preview"[\s\S]{0,200}'theme-base'/,
    )
  })

  it('主题的结构规则只作用于代表自己的那张预览（不靠 <html> 祖先命中）', () => {
    // [data-theme='x'] .pv-card 会顺着 <html data-theme> 漏进「默认」预览——默认档
    // 不挂 data-theme，主题规则必须锚在预览块自身（判据只看规则，注释不算）
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rules, '预览卡规则未锚在 .theme-preview 上').not.toMatch(
      /(?<!\.theme-preview)\[data-theme='\w+'\] \.pv-card/,
    )
    expect(rules).toMatch(/\.theme-preview\[data-theme='\w+'\] \.pv-card/)
  })
})
