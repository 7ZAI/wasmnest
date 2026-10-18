import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import hostZhCN from '@/i18n/host-zh-CN'
import hostEn from '@/i18n/host-en'

/**
 * 标题栏主题切换按钮的状态反馈锁
 *
 * 问题：按钮图标恒为月亮（`theme`），深浅色切换后视觉上没有任何变化 —— 用户无法
 * 判断当前是深色还是浅色，只能靠点击后自己看界面。
 *
 * 现在的口径：
 * - 图标画**当前**状态：深色 = 月亮 `theme`，浅色 = 太阳 `sun`；
 * - 文案（title / aria-label）说**点一下会变成什么**：深色时「切换到浅色」，反之亦然；
 * - 两者都由 `isDark` 派生，`system` 主题下同样跟随系统偏好（isSystemDark）。
 */

const TOOLBAR = 'src/shell/components/ShellToolbar.vue'
const ICONS = 'src/shell/components/ShellIcon.vue'

const read = (path: string): string => readFileSync(path, 'utf-8')

/** 取值：`a.b.c` → 对象字段（不存在返回 undefined） */
function pick(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

describe('主题切换按钮：图标与文案随当前主题变化', () => {
  it('图标按 isDark 二选一（月亮 / 太阳），不再恒为月亮', () => {
    const toolbar = read(TOOLBAR)
    expect(toolbar, '图标必须跟 isDark 走').toMatch(
      /:name="isDark \? 'theme' : 'sun'"/,
    )
    // 反例：写死 name="theme" 就是本次要修的「图标没变化」
    expect(toolbar).not.toMatch(/<ShellIcon name="theme" :size="14" \/>/)
  })

  it('标题与 aria-label 用同一个「动作」文案（点击后会变成什么）', () => {
    const toolbar = read(TOOLBAR)
    expect(toolbar).toContain(':title="themeActionLabel"')
    expect(toolbar).toContain(':aria-label="themeActionLabel"')
    expect(toolbar, '文案由 isDark 派生').toContain("isDark.value ? t('shell.toolbar.themeToLight')")
    expect(toolbar).toContain(": t('shell.toolbar.themeToDark')")
  })

  it('ShellIcon 图标表定义了 sun（否则浅色态画不出太阳）', () => {
    const icons = read(ICONS)
    expect(icons).toMatch(/sun:\s*\[/)
    // 太阳光线必须留边（从 3 起，不是贴 viewBox 的 2）：加到 stroke-width 的一半后
    // 贴边的那几道光会被裁掉，14/15px 下看起来像"没画全"
    const sunBlock = icons.match(/sun:\s*\[([\s\S]*?)\]/)?.[1] ?? ''
    expect(sunBlock, '顶部光线应内缩到 y=3').toContain('M12 3v2.25')
    expect(sunBlock, '底部光线应内缩到 y=21').toContain('M12 18.75V21')
    expect(sunBlock).not.toContain('M12 2v')
    expect(sunBlock).not.toContain('M12 20v')
  })

  it('铃铛与主题图标同档尺寸（15），别比导航图标小一号', () => {
    const toolbar = read(TOOLBAR)
    expect(toolbar, '铃铛图标应为 15').toContain('<ShellIcon name="bell" :size="15" />')
    expect(toolbar, '主题图标应为 15').toContain(
      `<ShellIcon :name="isDark ? 'theme' : 'sun'" :size="15" />`,
    )
    // 反例：回到 14 就会与「返回 / 多任务 / 主屏」的 15 不齐（视觉上偏小）
    expect(toolbar).not.toContain('<ShellIcon name="bell" :size="14" />')
  })

  it('双语都提供了动作文案，旧的恒态文案已退役（半迁移会回显 key 原文）', () => {
    for (const [name, messages] of [
      ['zh-CN', hostZhCN],
      ['en', hostEn],
    ] as const) {
      const toLight = pick(messages, 'shell.toolbar.themeToLight')
      const toDark = pick(messages, 'shell.toolbar.themeToDark')
      expect(typeof toLight, `${name} 缺 shell.toolbar.themeToLight`).toBe('string')
      expect(typeof toDark, `${name} 缺 shell.toolbar.themeToDark`).toBe('string')
      expect(String(toLight).length).toBeGreaterThan(0)
      expect(String(toDark).length).toBeGreaterThan(0)
      expect(pick(messages, 'shell.toolbar.theme'), `${name} 旧 key 应已删除`).toBeUndefined()
      expect(pick(messages, 'shell.toolbar.themeTitle'), `${name} 旧 key 应已删除`).toBeUndefined()
    }
  })
})
