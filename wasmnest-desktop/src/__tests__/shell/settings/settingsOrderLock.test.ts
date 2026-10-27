import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import type { Ref } from 'vue'

/**
 * 设置页分组顺序锁（用户 2026-10-20 裁决）——挂载行为断言
 *
 * 口径：「关于」只承载版本 / 更新等只读信息，必须排在所有可操作分组之后；
 * 主题跟在背景之后、系统与日志之后，破坏性复位与关于收尾。
 * （应用贡献的动态扩展设置项渲染在「系统设置」卡内，无独立分组。）
 *
 * 改造说明（issue #23 / codemap §8.1 首批，#12 样板）：原锁是源码顺序正则
 * （indexOf 模板字符串 + `</template>` 尾缀判断），对模板重构 / 注释挪动 /
 * 组件名重命名误红；顺序本来就在渲染结果里，现在挂载 SysSettingsView 直接断言
 * 分组标题的 DOM 顺序——合法重排源码不红，真把「关于」挪进中间才红。
 * 五个分组组件以带 data-group 标记的桩替身渲染（它们的内部顺序属于各自组件
 * 自己的测试面）；壳内两组与授权入口用真实 ShellCard 渲染标题。
 */

const mocks = vi.hoisted(() => ({
  settingsStore: null as unknown as Record<string, unknown>,
  prefs: null as unknown as Ref<{ wallpaper: string; wallDim: number; wallpaperImage: string; theme: string }>,
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key, locale: ref('zh-CN') }) }
})

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => mocks.settingsStore,
}))

vi.mock('@/stores/i18n', () => ({
  useI18nStore: () => ({ setLanguage: vi.fn() }),
}))

vi.mock('@/composables/useFontSize', () => ({
  useFontSize: () => ({ setupFontSize: vi.fn() }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({ openSys: vi.fn() }),
}))

vi.mock('@/shell/composables/useShellSettings', async () => {
  const { ref } = await import('vue')
  return { useShellSettings: () => ({ prefs: mocks.prefs }) }
})

vi.mock('@/shell/composables/customWallpaper', async () => {
  const { ref } = await import('vue')
  return {
    useCustomWallpaper: () => ({
      imageUrl: ref(''),
      pick: vi.fn(async () => null),
      clear: vi.fn(async () => {}),
    }),
  }
})

import SysSettingsView from '@/shell/sys/SysSettingsView.vue'

/** 分组组件桩：只渲染一个带 data-group 标记的标题（顺序断言的锚点） */
const sectionStub = (label: string) => ({
  template: `<section class="group-stub" data-group="${label}">${label}</section>`,
})

/** 分组标题的期望 DOM 顺序（t 返回 key 原文，锚点与语言无关） */
const EXPECTED_ORDER = [
  'shell.settings.ui.title', // 界面（壳内实现）
  'shell.settings.background.title', // 背景（壳专属）
  'THEME', // SettingsThemeSection（主题）
  'SYSTEM', // SettingsSystemSection（系统设置，动态扩展项也渲染在此卡内）
  'LOGGING', // SettingsLoggingSection（日志）
  'shell.settings.permsEntry.title', // 授权管理入口
  'RESET', // SettingsResetSection（破坏性复位）
  'ABOUT', // SettingsAboutSection（关于，固定收尾）
]

beforeEach(() => {
  mocks.settingsStore = {
    settings: { ui: { theme: 'system', font_size: 13, animations_enabled: true } },
    saveSettings: vi.fn(),
  }
  mocks.prefs = ref({ wallpaper: 'aurora', wallDim: 30, wallpaperImage: '', theme: 'default' })
})

function mountSettings() {
  return mount(SysSettingsView, {
    global: {
      stubs: {
        SettingsThemeSection: sectionStub('THEME'),
        SettingsSystemSection: sectionStub('SYSTEM'),
        SettingsLoggingSection: sectionStub('LOGGING'),
        SettingsResetSection: sectionStub('RESET'),
        SettingsAboutSection: sectionStub('ABOUT'),
      },
    },
  })
}

/**
 * 分组标题按**文档序**读取。
 *
 * 不能用逗号并列选择器一次取（happy-dom 的 querySelectorAll 对选择器列表按
 * 选择器分段返回、不保文档序）：两类锚点各查一次，再按 compareDocumentPosition
 * 归并成文档序。
 */
function groupTitles(wrapper: VueWrapper): string[] {
  const anchors = [
    ...wrapper.findAll('.shell-card-title').map((h) => h.element),
    ...wrapper.findAll('[data-group]').map((h) => h.element),
  ].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  )
  return anchors.map((el) => el.textContent?.trim() ?? '')
}

describe('设置页分组顺序（DOM 顺序断言）', () => {
  it('按「界面 → 背景 → 主题 → 系统 → 日志 → 授权入口 → 复位 → 关于」排列', () => {
    const wrapper = mountSettings()

    expect(groupTitles(wrapper), '分组缺项或顺序不符').toEqual(EXPECTED_ORDER)
  })

  it('「关于」固定最后：其后不再有任何设置分组', () => {
    const wrapper = mountSettings()

    const titles = groupTitles(wrapper)
    expect(titles.at(-1), '关于必须是最后一个分组').toBe('ABOUT')
    // 破坏性复位必须紧贴在「关于」之前（复位不得把关于夹在中间或挤到它后面）
    expect(titles.at(-2)).toBe('RESET')
  })
})
