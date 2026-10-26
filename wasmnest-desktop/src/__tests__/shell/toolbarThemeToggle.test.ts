import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import hostZhCN from '@/i18n/host-zh-CN'
import hostEn from '@/i18n/host-en'
import ShellIcon from '@/shell/components/ShellIcon.vue'

/**
 * 标题栏主题切换按钮的状态反馈锁（挂载行为断言）
 *
 * 问题（2026-10 裁决的回归锁）：按钮图标恒为月亮（`theme`），深浅色切换后视觉上
 * 没有任何变化 —— 用户无法判断当前是深色还是浅色，只能靠点击后自己看界面。
 *
 * 口径：
 * - 图标画**当前**状态：深色 = 月亮 `theme`，浅色 = 太阳 `sun`；
 * - 文案（title / aria-label）说**点一下会变成什么**：深色时「切换到浅色」，反之亦然；
 * - 两者都由 `isDark` 派生，`system` 主题下跟随系统偏好（isSystemDark）。
 *
 * 改造说明（issue #23 / codemap §8.1 首批，#12 样板）：原锁是 4 条源码文本断言
 * （逐属性字符串 `:name="isDark ? 'theme' : 'sun'"` / 精确 SVG path 源码），
 * 对模板重排与格式化误红；现在挂载 ShellToolbar 直接断言渲染结果——图标几何走
 * 真实 DOM path、文案走 aria-label、尺寸走 svg 属性。豁免保留：sun 光线内缩的
 * 几何口径（内边距防裁切）以 DOM path 断言（渲染资产事实），i18n 双语文案以
 * 消息对象断言（跨两套消息集契约）。
 */

const mocks = vi.hoisted(() => ({
  /** 设置仓桩：settings.ui.theme 可写（点击切换写回这里）+ saveSettings 记账 */
  settings: null as unknown as { ui: { theme: string } },
  saveSettings: vi.fn(),
  isSystemDark: null as unknown as Ref<boolean>,
  shellState: null as unknown as Record<string, unknown>,
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ settings: mocks.settings, saveSettings: mocks.saveSettings }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isSystemDark: mocks.isSystemDark }),
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => mocks.shellState,
}))

// 窗口控制：无 Tauri 环境，appWindow 走组件内的空操作兜底
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => null }))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import ShellToolbar from '@/shell/components/ShellToolbar.vue'

/** ShellIcon 的月亮 / 太阳 path d（渲染几何真源，本套件以其出现位置断言） */
const MOON_D = 'M12 3a6.4 6.4 0 0 0 9 9 9 9 0 1 1-9-9Z'
const SUN_DISC_D_PREFIX = 'M15.75 12a3.75'

beforeEach(() => {
  mocks.settings = reactive({ ui: { theme: 'dark' } })
  mocks.saveSettings = vi.fn()
  mocks.isSystemDark = ref(false)
  const box = <T,>(v: T) => ({ value: v })
  mocks.shellState = {
    screen: box('home'),
    activeCard: box(null),
    cards: box<string[]>([]),
    recentsOpen: box(false),
    panelOpen: box(false),
    quickSettingsOpen: box(false),
    dialog: box(null),
    ctxMenu: box(null),
    homeQ: box(''),
    notifCountTotal: box(0),
    notifPulse: box(0),
    cardTitleOf: vi.fn(() => ''),
    goBack: vi.fn(),
    goHome: vi.fn(),
    toggleRecents: vi.fn(),
    toggleQuickSettings: vi.fn(),
    openApp: vi.fn(),
    openSys: vi.fn(),
  }
})

function mountToolbar() {
  return mount(ShellToolbar, { attachTo: document.body })
}

describe('主题切换按钮：图标画当前态、文案说目标态（挂载行为）', () => {
  it('深色 → 月亮 + 「切换到浅色」；点击切浅色后 → 太阳 + 「切换到深色」', async () => {
    mocks.settings.ui.theme = 'dark'
    const wrapper = mountToolbar()

    const darkBtn = wrapper.find('button[aria-label="shell.toolbar.themeToLight"]')
    expect(darkBtn.exists(), '深色态文案 = 切换到浅色（动作方向）').toBe(true)
    expect(darkBtn.attributes('title')).toBe('shell.toolbar.themeToLight')
    expect(darkBtn.find(`path[d="${MOON_D}"]`).exists(), '深色态图标 = 月亮（当前态）').toBe(true)

    await darkBtn.trigger('click')
    expect(mocks.settings.ui.theme).toBe('light')
    expect(mocks.saveSettings).toHaveBeenCalledWith({ ui: mocks.settings.ui })
    await nextTick()

    const lightBtn = wrapper.find('button[aria-label="shell.toolbar.themeToDark"]')
    expect(lightBtn.exists(), '浅色态文案 = 切换到深色').toBe(true)
    expect(
      lightBtn.find(`path[d^="${SUN_DISC_D_PREFIX}"]`).exists(),
      '浅色态图标 = 太阳（不再恒为月亮）',
    ).toBe(true)
    // 同一时刻只有一个主题按钮语义在场（旧态文案随状态消失）
    expect(wrapper.find('button[aria-label="shell.toolbar.themeToLight"]').exists()).toBe(false)
  })

  it('system 主题跟随系统偏好（isSystemDark 派生，不写死深浅）', async () => {
    mocks.settings.ui.theme = 'system'
    const wrapper = mountToolbar()

    mocks.isSystemDark.value = true
    await nextTick()
    expect(wrapper.find('button[aria-label="shell.toolbar.themeToLight"]').exists()).toBe(true)
    expect(wrapper.find(`path[d="${MOON_D}"]`).exists()).toBe(true)

    mocks.isSystemDark.value = false
    await nextTick()
    expect(wrapper.find('button[aria-label="shell.toolbar.themeToDark"]').exists()).toBe(true)
    expect(wrapper.find(`path[d^="${SUN_DISC_D_PREFIX}"]`).exists()).toBe(true)
  })

  it('主题图标与铃铛同档尺寸（svg width/height = 15，别比导航图标小一号）', () => {
    mocks.settings.ui.theme = 'dark'
    const wrapper = mountToolbar()

    const bellSvg = wrapper.find('button[data-shell-panel-trigger] svg')
    expect(bellSvg.exists()).toBe(true)
    expect(bellSvg.attributes('width')).toBe('15')
    expect(bellSvg.attributes('height')).toBe('15')

    const themeSvg = wrapper.find('button[aria-label="shell.toolbar.themeToLight"] svg')
    expect(themeSvg.exists()).toBe(true)
    expect(themeSvg.attributes('width')).toBe('15')
    expect(themeSvg.attributes('height')).toBe('15')
  })
})

describe('sun 图标几何（渲染资产：光线内缩防裁切）', () => {
  it('太阳光线从 3 / 21 起留边，不贴 viewBox 边（14/15px 下不裁切）', () => {
    const wrapper = mount(ShellIcon, { props: { name: 'sun', size: 15 } })
    const dList = wrapper.findAll('path').map((p) => p.attributes('d'))
    expect(dList, '顶部光线应内缩到 y=3').toContain('M12 3v2.25')
    expect(dList, '底部光线应内缩到 y=21').toContain('M12 18.75V21')
    // 反例：贴边光线（y=2 / y=22 起）是被裁掉一截的旧几何
    expect(dList.some((d) => d.startsWith('M12 2v'))).toBe(false)
    expect(dList.some((d) => d.startsWith('M12 20v'))).toBe(false)
  })
})

describe('双语动作文案在位（消息集契约，半迁移会回显 key 原文）', () => {
  it('zh-CN 与 en 都提供 themeToLight / themeToDark，旧恒态文案已退役', () => {
    for (const [name, messages] of [
      ['zh-CN', hostZhCN],
      ['en', hostEn],
    ] as const) {
      const toolbar = (messages as Record<string, Record<string, unknown>>).shell?.toolbar ?? {}
      const toLight = toolbar.themeToLight
      const toDark = toolbar.themeToDark
      expect(typeof toLight, `${name} 缺 shell.toolbar.themeToLight`).toBe('string')
      expect(typeof toDark, `${name} 缺 shell.toolbar.themeToDark`).toBe('string')
      expect(String(toLight).length).toBeGreaterThan(0)
      expect(String(toDark).length).toBeGreaterThan(0)
      expect(toolbar.theme, `${name} 旧 key 应已删除`).toBeUndefined()
      expect(toolbar.themeTitle, `${name} 旧 key 应已删除`).toBeUndefined()
    }
  })
})
