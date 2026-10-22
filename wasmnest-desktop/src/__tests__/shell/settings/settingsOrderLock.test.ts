import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 设置页分组顺序锁（用户 2026-10-20 裁决）
 *
 * 「关于」只承载版本 / 更新等只读信息，必须排在所有可操作分组之后；皮肤跟在
 * 背景之后、系统与日志之后，破坏性复位与关于收尾。
 * （应用贡献的动态扩展设置项渲染在「系统设置」卡内，无独立分组。）
 *
 * 顺序是产品裁决，组件静态拼接在主视图里——直接锁源码顺序，防止后续插入
 * 新分组时把「关于」又挤回中间。
 */

const SOURCE = readFileSync('src/shell/sys/SysSettingsView.vue', 'utf-8')

const ORDER = [
  "t('shell.settings.ui.title')",
  "t('shell.settings.background.title')",
  '<SettingsThemeSkinSection />',
  '<SettingsSystemSection />',
  '<SettingsLoggingSection />',
  "t('shell.settings.permsEntry.title')",
  '<SettingsResetSection />',
  '<SettingsAboutSection />',
]

describe('设置页分组顺序锁', () => {
  it('按「界面 → 背景 → 皮肤 → 系统 → 日志 → 授权入口 → 复位 → 关于」排列', () => {
    let previous = -1
    for (const marker of ORDER) {
      const index = SOURCE.indexOf(marker)
      expect(index, `设置页缺少分组：${marker}`).toBeGreaterThanOrEqual(0)
      expect(index, `${marker} 的顺序不符合预期`).toBeGreaterThan(previous)
      previous = index
    }
  })

  it('关于是模板中最后一个分组（其后不再有任何设置分组）', () => {
    const template = SOURCE.slice(0, SOURCE.indexOf('</template>')).trimEnd()
    expect(template.endsWith('<SettingsAboutSection />')).toBe(true)
  })
})
