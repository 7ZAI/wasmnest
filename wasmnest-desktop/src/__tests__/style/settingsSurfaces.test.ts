import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 设置页表面 / 控件语言锁（2026-11-02 立）
 *
 * 事故背景：设置页四个功能分组（系统 / 日志 / 复位 / 关于）用裸 Tailwind
 * `bg-[var(--bg-card)] border rounded-[10px]` 自建卡面，控件也自己画（方角开关、
 * 土制分段控件、legacy `.wb-btn-*`）。主题的结构规则只认壳共享类（`.shell-card` /
 * `.shell-sw` / `.shell-seg` / `.shell-btn`），所以切到玻璃主题时
 * **同一页一半是玻璃材质、一半是实心平面**——用户反馈的「关于等选项没适配玻璃主题」。
 *
 * 2026-11-09 用户裁决（卡头统一）：设置页分组卡一律走 `ShellCard`（图标 + 标题在卡内），
 * 不再用「卡外平铺标题（`.wb-section-title`）+ `.shell-panel`」这套与入口卡并存的第二种头型。
 * 授权 / 弹窗等决策面**不在**本锁范围（它们按跨主题不变量必须保持实心，见
 * themePresetCoverage.test.ts 的决策面断言）。
 */

const SETTINGS_FILES = [
  'src/shell/sys/SysSettingsView.vue',
  'src/shell/sys/SysAppearanceView.vue',
  'src/shell/settings/SettingsSystemSection.vue',
  'src/shell/settings/SettingsLinkCryptoSection.vue',
  'src/shell/settings/SettingsLoggingSection.vue',
  'src/shell/settings/SettingsThemeSection.vue',
  'src/shell/settings/SettingsResetSection.vue',
  'src/shell/settings/SettingsAboutSection.vue',
]

const read = (file: string): string => readFileSync(file, 'utf-8')

/** 去掉 HTML / 块 / 行注释：锁判的是代码，不是注释里提到的历史写法 */
const code = (file: string): string =>
  read(file)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('设置页表面 / 控件语言', () => {
  it('分组卡面走壳共享 ShellCard：图标 + 标题都在卡内（不是卡外平铺标题）', () => {
    for (const file of SETTINGS_FILES) {
      const src = read(file)
      expect(src, `${file} 的分组卡面没走 ShellCard`).toContain('<ShellCard')
      // 头型只有一种：标题（+ 图标）在卡内，不许回到卡外 `.wb-section-title` 平铺标题
      expect(code(file), `${file} 的标题又平铺到卡外（.wb-section-title）`).not.toContain(
        'wb-section-title',
      )
      // 图标是卡头的一部分，不是可选装饰
      expect(src, `${file} 的 ShellCard 缺图标`).toMatch(/<ShellCard[\s\S]{0,240}?icon="/)
      expect(code(file), `${file} 又在自建卡面（bg-[var(--bg-card)]）`).not.toContain(
        'bg-[var(--bg-card)]',
      )
    }
  })

  it('控件只用壳共享类：开关 .shell-sw / 分段 .shell-seg / 按钮 .shell-btn', () => {
    const system = read('src/shell/settings/SettingsSystemSection.vue')
    expect(system, '防止休眠开关回到自绘方块').toContain('class="shell-sw"')
    // 自绘开关的特征：rounded-[4px] 轨道 + bg-[var(--color-primary)] 直接拼
    expect(system, '防止休眠开关又自绘轨道').not.toContain('rounded-[4px]')

    // 分段控件由 ShellSeg 渲染（.shell-seg），不许土制 border + overflow-hidden 按钮条
    const logging = read('src/shell/settings/SettingsLoggingSection.vue')
    expect(logging, '日志分组未使用 ShellSeg').toContain('ShellSeg')

    // 按钮：legacy .wb-btn-* 不被任何主题结构规则命中
    for (const file of SETTINGS_FILES) {
      expect(code(file), `${file} 仍在使用 legacy .wb-btn-*`).not.toContain('wb-btn-')
    }
  })

  it('数字输入不用原生 type=number（步进器不可 token 化，属禁止的原生 UI）', () => {
    for (const file of SETTINGS_FILES) {
      expect(code(file), `${file} 使用了原生 number 输入`).not.toContain('type="number"')
    }
    // 数字输入改走 .shell-input + inputmode=numeric（窄屏出数字键盘）
    const logging = read('src/shell/settings/SettingsLoggingSection.vue')
    expect(logging).toContain('shell-input')
    expect(logging).toContain('inputmode="numeric"')
  })
})
