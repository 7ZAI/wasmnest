import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { BUILTIN_THEMES, SHELL_THEME_DEFAULT } from '@/shell/composables/themePresets'

/**
 * 主题预设覆盖锁（移动端，与桌面同名锁同口径）
 *
 * 主题目录（TS）与主题样式表（CSS）是两份真源，任何一边漏项都表现为
 * 「切过去没反应」——点了、属性也写了、只是选择器不存在，没有任何异常可捕获。
 *
 * 移动端多一条：浅色 token 整块挂在 `html:not(.dark)` 上（mobile.css 头注），
 * 所以每个主题必须有**深色 + 浅色两个落点**，只写一个会让另一档完全没有主题。
 */

const CSS = readFileSync('src/styles/theme-presets.css', 'utf-8')

const NON_DEFAULT = BUILTIN_THEMES.map((theme) => theme.id).filter((id) => id !== SHELL_THEME_DEFAULT)

/** 深色档：`[data-theme='x'] {`（移动端 :root 默认深色） */
function darkBlock(themeId: string): string {
  const match = CSS.match(new RegExp(`(?:^|\\n)\\[data-theme='${themeId}'\\]\\s*\\{([^}]*)\\}`))
  expect(match, `${themeId} 缺少深色 token 块`).toBeTruthy()
  return match![1]
}

/** 浅色档：`html:not(.dark)[data-theme='x']` 那一段 */
function lightBlock(themeId: string): string {
  const match = CSS.match(
    new RegExp(`html:not\\(\\.dark\\)\\[data-theme='${themeId}'\\][^{]*\\{([^}]*)\\}`),
  )
  expect(match, `${themeId} 缺少浅色 token 块（移动端浅色挂 html:not(.dark)）`).toBeTruthy()
  return match![1]
}

describe('主题预设覆盖（移动端）', () => {
  it('每个非默认内置主题都有深色 / 浅色两个 token 落点', () => {
    for (const id of NON_DEFAULT) {
      expect(darkBlock(id).trim().length, `${id} 深色块为空`).toBeGreaterThan(0)
      expect(lightBlock(id).trim().length, `${id} 浅色块为空`).toBeGreaterThan(0)
    }
  })

  it('主题覆盖的是表面 token，不是几个无关变量', () => {
    for (const id of NON_DEFAULT) {
      for (const block of [darkBlock(id), lightBlock(id)]) {
        for (const required of ['--mobile-bg-primary', '--mobile-group-bg']) {
          expect(block, `${id} 缺少 ${required}（主题语汇不完整）`).toContain(`${required}:`)
        }
      }
    }
  })

  it('决策面不变量：--mobile-bg-card 不得被主题改成半透明', () => {
    // 授权 / 确认弹窗与列表用 --mobile-bg-card 做实心底，透一点就连带变透
    for (const id of NON_DEFAULT) {
      for (const block of [darkBlock(id), lightBlock(id)]) {
        const match = block.match(/--mobile-bg-card:\s*([^;]+);/)
        if (!match) continue
        expect(match[1], `${id} 把 --mobile-bg-card 改成半透明，决策面会跟着透`).not.toContain(
          'transparent',
        )
      }
    }
  })

  it('玻璃主题重绘核心表面，而不是只换边框 / 圆角 / 阴影', () => {
    // 与桌面同口径：主题要换整套材质。移动端最少覆盖设置分组、列表卡、
    // 通知、多任务、应用胶囊、图标井与悬浮导航。
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rules, '玻璃主题缺少结构规则').toContain(":root[data-theme='glass']")
    for (const surface of [
      '.settings-group',
      '.shell-group-card',
      '.group-card',
      '.notify-card',
      '.shell-sys-tile',
      '.shell-capsule',
      '.shell-recents-card',
      '.settings-segment',
      '.shell-segmented',
      '.shell-icon-action',
      '.shell-shade-panel',
      '.shell-floatnav',
    ]) {
      expect(rules, `玻璃主题未覆盖 ${surface}`).toContain(surface)
    }
    expect(rules).toContain('backdrop-filter')
    expect(rules).toContain('mask-composite')
    expect(rules).toContain('feTurbulence')
  })

  it('大表面列表不得抬高特异性：控件的材质覆盖必须能生效', () => {
    // `:is()` 取列表里最高特异性。`.shell-host .shell-group-card`（0,2,0）会把
    // 整条卡片规则抬到 0,4,0，令后面给分段凹槽 / 图标按钮 / 图标井 / 胶囊写的
    // 0,3,0 规则全部失效（表现为「所有控件都长成小卡片」）。必须用 `:where()`
    // 把宿主作用域计为 0 特异性，保留作用域但不再抬高整条规则。
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rules, '大表面列表又用复合选择器抬高了特异性').not.toMatch(
      /(?<!:where\()\.shell-host\s+\.shell-group-card/,
    )
    expect(rules, '宿主作用域未用 :where() 降特异性').toContain(
      ':where(.shell-host) .shell-group-card',
    )
  })

  it('主题样式表不挂常驻动画：壳根背景漂移已按性能裁决移除（与桌面同锁）', () => {
    // 2026-11-02 桌面性能裁决：玻璃主题的 44s `theme-drift`（动 background-position）
    // 在 WebKitGTK 上把 62fps 拖到 11fps——每帧整屏重绘 + 屏上每个 backdrop-filter 面
    // 重新采样重算模糊。移动端 2026-11-04 对齐删除；这条锁防止它被无声加回来。
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rules, 'theme-drift 又被加回来了').not.toMatch(/@keyframes\s+theme-drift/)
    const shellRootAnimated = /\[data-theme[^\]]*\][^{]*\.shell-host[^{]*\{[^}]*animation:/.test(
      rules,
    )
    // 目录里的 dynamic 标记与 CSS 必须双向一致：声明 dynamic 就必须有壳根 animation 规则
    // （只看选择器会被环境光的 `.shell-host` 规则误命中，必须断言规则体里真有 animation）
    const dynamicThemes = BUILTIN_THEMES.filter((theme) => theme.dynamic).map((theme) => theme.id)
    for (const id of dynamicThemes) {
      const animated = new RegExp(
        `\\[data-theme='${id}'\\][^{]*\\.shell-host[^{]*\\{[^}]*animation:`,
      ).test(rules)
      expect(animated, `${id} 声明了 dynamic 但没有挂 animation`).toBe(true)
    }
    if (dynamicThemes.length === 0) {
      expect(shellRootAnimated, '没有主题声明 dynamic，壳根却挂了动画').toBe(false)
    }
  })

  it('默认主题的预览块挂 theme-base，隔离当前主题的 token', () => {
    const mobileCss = readFileSync('src/styles/mobile.css', 'utf-8')
    // 深浅两档基础档都要与 .theme-base 共用（默认预览跟壳的明暗走）
    expect(mobileCss, '深色基础档未与 .theme-base 共用').toMatch(/^:root,\s*\n\.theme-base\s*\{/m)
    expect(mobileCss, '浅色基础档未与 .theme-base 共用').toMatch(
      /^html:not\(\.dark\),\s*\nhtml:not\(\.dark\) \.theme-base\s*\{/m,
    )
    // 主题专属的三枚 token 必须显式归零，否则默认预览继承当前主题的语汇
    // （基础档是 `:root,` + `.theme-base {` 两行合写的，中性化块另起一块）
    const baseBlocks = [...mobileCss.matchAll(/^\.theme-base \{([^}]*)\}/gm)].map((m) => m[1])
    const base = baseBlocks.find((block) => block.includes('--theme-ambient'))
    expect(base, 'mobile.css 缺少 .theme-base 中性化块').toBeTruthy()
    for (const token of ['--theme-ambient', '--theme-icon-shadow', '--theme-icon-radius']) {
      expect(base!, `.theme-base 未归零 ${token}`).toContain(`${token}:`)
    }
    // 预览块要真的挂上这个类
    const view = readFileSync('src/views/settings/AppearanceSettingsView.vue', 'utf-8')
    expect(view, '默认主题预览未挂 theme-base').toMatch(
      /class="theme-swatch"[\s\S]{0,200}'theme-base'/,
    )
  })
})
