/**
 * 平台主屏（Android 平台化）行为契约测试（2026-10-14）
 *
 * 被测：`src/shell/components/screens/ShellHomeScreen.vue`
 *
 * | 契约 | 来源 | 规则 | 预期 |
 * |---|---|---|---|
 * | C-H2 | 头部快捷入口 | 铃铛左侧是多任务图标，不是运行中应用图标；入口不随运行态变化 | 多任务紧邻铃铛左侧；无 switchTo 图标 |
 * | C-H3 | 应用宫格 | 全部应用在场；待审批有「!」角标与可访问状态 | 未运行也在格内；approval 角标可见 |
 * | C-H4 | 系统宫格 | 三个平台自有面进栈（可返回） | navigate('apps') / openPermissions / navigate('settings') |
 * | C-H5 | 铃铛 | 角标 = 通知 + 待审批；点击开通知栏 | 计数与 toggleShade |
 * | C-H6 | 空态 | 无应用时给出下一步说明 | 渲染 emptyAppsHint |
 * | C-H7 | 快捷卡片轨道 | 横向 scroll-snap 轨道（原型形态），不定宽竖排 | 轨道内 listitem 数 = 卡片数 |
 * | C-H8 | 应用分组头 | 只留标题：计数与管理图标均已退役（管理入口在系统宫格） | 无 manageApps 按钮、无计数文案 |
 * | C-H9 | 文案纪律 | 不渲染方案期解释（由应用提供 / 平台自带 / 最近使用在前） | 三个退役 key 缺席 |
 * | C-H11 | 多任务入口 | 主屏头部图标与铃铛同档，点击进多任务 | openSwitcher 被调用 |
 * | C-H12 | 系统宫格图标 | 与桌面 ShellIcon 同口径：.shell-sys-tile + data-tile=entry.id，SVG 为 24 画框 stroke 线稿（fill=none / 1.55），路径逐字对齐桌面 | 类名 / data-tile / stroke 属性；双端路径一致性锁 |
 * | C-H13 | 运行带退役 | 主屏不再渲染运行卡片与停止按钮 | 无 article / 无 stopInstance / 无 runningTitle |
 * | C-H14 | 壁纸上的浮空文字 | 壁纸上的标题挂 .shell-text-over-wall（底色描边护对比度）；shell.css 里该类的描边色由 token 派生 | 头部标题与应用分组头均带类；CSS 含 text-shadow + color-mix |
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computed, ref } from 'vue'
import { resetShellNotifications, useShellNotifications } from '@/shell/composables/useShellNotifications'
import { clearRecent } from '@/shell/composables/useShellRecent'
import type { ShellApp } from '@/shell/types'

// ==================== 替身 ====================

const apps = ref<ShellApp[]>([])
const mockOpen = vi.fn(async () => true)
const mockToggleShade = vi.fn()
const mockNavigate = vi.fn()
const mockOpenPermissions = vi.fn()
const mockOpenSwitcher = vi.fn()

vi.mock('vue-i18n', () => ({
  // 回显 key + 参数：角标计数与可访问名称里的参数才可断言
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))
vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    apps: computed(() => apps.value),
    // 与生产实现同语义：按名称排序（中文 localeCompare）
    sortedApps: computed(() =>
      [...apps.value].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
    ),
    stats: computed(() => ({ installed: apps.value.length, running: 0, totalBytes: 0 })),
  }),
}))
vi.mock('@/shell/composables/useShellOpen', () => ({
  useShellOpen: () => ({ open: mockOpen }),
}))
vi.mock('@/shell/composables/useShellOverlays', () => ({
  useShellOverlays: () => ({ toggleShade: mockToggleShade }),
}))
vi.mock('@/shell/composables/useShellNavigation', () => ({
  useShellNavigation: () => ({
    navigate: mockNavigate,
    openPermissions: mockOpenPermissions,
    openSwitcher: mockOpenSwitcher,
  }),
}))
vi.mock('@/plugin/assets', () => ({
  toFileAssetUrl: (path: string) => `asset://${path}`,
}))

import ShellHomeScreen from '@/shell/components/screens/ShellHomeScreen.vue'
import ShellAppIcon from '@/shell/components/ShellAppIcon.vue'

function app(id: string, state: ShellApp['state'], name = id): ShellApp {
  return {
    id,
    name,
    version: '1.0.0',
    state,
    permissions: [{ key: 'fs:read', granted: state !== 'approval' }],
    contributions: {},
  }
}

beforeEach(() => {
  resetShellNotifications()
  clearRecent()
  localStorage.clear()
  apps.value = []
  mockOpen.mockClear()
  mockToggleShade.mockClear()
  mockNavigate.mockClear()
  mockOpenPermissions.mockClear()
  mockOpenSwitcher.mockClear()
})

describe('C-H2 头部快捷入口（多任务，不是运行应用）', () => {
  it('should_showMultitaskLeftOfBell_when_appsRunning', () => {
    apps.value = [app('a', 'running', 'AppA'), app('b', 'running', 'AppB')]
    const wrapper = mount(ShellHomeScreen)

    const labels = wrapper.findAll('header button').map((b) => b.attributes('aria-label') ?? '')
    const bellIndex = labels.findIndex((l) => l.startsWith('shell.notify.open'))

    expect(labels[bellIndex - 1], '铃铛左侧紧邻多任务入口').toBe('shell.switcher.title')
    // 运行中的应用不再占据头部：入口固定为多任务，不随运行态变化
    expect(wrapper.findAll('header button[aria-label^="shell.home.switchTo"]')).toHaveLength(0)
  })

  it('should_renderIconOnlyLikeBell_when_entryShown', () => {
    const wrapper = mount(ShellHomeScreen)
    const entry = wrapper.find('header button[aria-label="shell.switcher.title"]')

    // 与铃铛同档：44px 触达区、无卡面、无文字
    expect(entry.classes()).toContain('rounded-[10px]')
    expect(entry.classes()).toContain('min-w-[var(--mobile-touch-target-min)]')
    expect(entry.text()).toBe('')
  })
})

describe('C-H15 应用图标外框（满幅作品不得叠框）', () => {
  /** 移动端插件图标（plugin.json.icon）都是满幅圆角方作品 */
  const imageApp = () => ({
    ...app('a', 'stopped', 'AppA'),
    icon: 'icon.svg',
    iconUrl: 'asset://localhost/icon.svg',
  })

  it('should_notFrameArtwork_when_imageIconRendered', () => {
    const wrapper = mount(ShellAppIcon, { props: { app: imageApp() } })
    const box = wrapper.find('span')

    // 作品自带底色与圆角：盒子再描边 + 铺底就只在作品四周添一圈白框（实测反馈）
    expect(box.classes().some((c) => c.startsWith('border')), '作品外围不得有描边').toBe(false)
    expect(box.classes()).toContain('bg-transparent')
  })

  it('should_keepSurface_when_iconFallsBackToLetter', () => {
    // 没有作品可依托（无图标 / 图片失败）时盒子才是承载面，仍不着描边
    const wrapper = mount(ShellAppIcon, { props: { app: app('a', 'stopped', 'AppA') } })
    const box = wrapper.find('span')

    expect(box.classes()).toContain('bg-[var(--mobile-bg-elevated)]')
    expect(box.classes().some((c) => c.startsWith('border')), '回退态同样不得有描边').toBe(false)
  })

  it('should_keepDashedFrame_when_toneGhost', () => {
    // ghost 的全部视觉身份就是虚线框（「更多」占位），描边只留给它
    const wrapper = mount(ShellAppIcon, { props: { app: app('a', 'stopped', 'AppA'), tone: 'ghost' } })

    expect(wrapper.find('span').classes()).toContain('border-dashed')
  })
})

describe('C-H14 壁纸上的浮空文字', () => {
  it('should_markWallFloatingText_when_homeRendered', () => {
    apps.value = [app('a', 'running', 'AppA')]
    const wrapper = mount(ShellHomeScreen)

    // 壁纸亮度/色相不可控（含用户自选图片）：直接压在壁纸上的文字必须有底色描边。
    const headerText = wrapper.find('header .shell-text-over-wall')
    expect(headerText.exists(), '头部标题框挂描边类').toBe(true)
    expect(headerText.text()).toContain('WasmNest')
    expect(headerText.text(), '头部副标题「本机 · N 个应用」已退役').not.toContain(
      'shell.home.appCount',
    )

    const appsHeader = wrapper
      .findAll('.shell-text-over-wall')
      .find((s) => s.text().includes('shell.home.appsTitle'))
    expect(appsHeader?.exists(), '应用宫格分组头在描边容器内').toBe(true)
    expect(wrapper.text(), '分组头「N 个已安装」已退役').not.toContain('shell.home.appsNote')
  })
})

describe('C-H3 应用宫格', () => {
  it('should_listEveryAppIncludingDormant_when_gridRendered', () => {
    apps.value = [app('a', 'running', 'AppA'), app('b', 'stopped', 'AppB')]

    const text = mount(ShellHomeScreen).text()

    expect(text).toContain('AppA')
    expect(text, '未运行应用同样在主屏宫格').toContain('AppB')
  })

  it('should_markApprovalApp_when_pending', () => {
    apps.value = [app('p', 'approval', 'PendingApp')]

    const wrapper = mount(ShellHomeScreen)
    // 可访问名称带应用名与状态（读屏用户看不到角标颜色）
    const cell = wrapper
      .findAll('button')
      .find((b) => (b.attributes('aria-label') ?? '').includes('PendingApp'))

    expect(cell, '待审批应用的宫格单元应在场').toBeTruthy()
    expect(cell!.attributes('aria-label')).toContain('shell.common.approval')
    expect(cell!.text()).toContain('PendingApp')
  })
})

describe('C-H4 系统宫格', () => {
  it('should_enterSystemPagesInStackOrder_when_entriesTapped', async () => {
    const wrapper = mount(ShellHomeScreen)

    await wrapper.find('button[aria-label="shell.home.sysApps"]').trigger('click')
    await wrapper.find('button[aria-label="shell.home.sysPermissions"]').trigger('click')
    await wrapper.find('button[aria-label="shell.home.sysSettings"]').trigger('click')

    // 平台面进栈而不是重置栈：系统屏要有可返回的上一级
    expect(mockNavigate.mock.calls.map((c) => c[0])).toEqual(['apps', 'settings'])
    expect(mockOpenPermissions).toHaveBeenCalledTimes(1)
  })
})

describe('C-H12 系统宫格图标（与桌面 ShellIcon 一致）', () => {
  /** 系统宫格按钮（可访问名即入口文案，三个入口三种 key） */
  const SYS_KEYS = ['shell.home.sysApps', 'shell.home.sysPermissions', 'shell.home.sysSettings']
  /** entry.id → data-tile（测试锚点；样式不再按 id 上色） */
  const EXPECTED_TILES = ['apps', 'permissions', 'settings']

  const css = () => readFileSync(join(process.cwd(), 'src/shell/styles/shell.css'), 'utf8')

  it('should_markEachEntryWithTileId_when_sysGridRendered', () => {
    const buttons = SYS_KEYS.map((key) =>
      mount(ShellHomeScreen).find(`button[aria-label="${key}"]`),
    )

    buttons.forEach((button, i) => {
      const tile = button.find('.shell-sys-tile')
      expect(tile.exists(), `${SYS_KEYS[i]} 应渲染系统瓦片`).toBe(true)
      expect(tile.attributes('data-tile'), `${SYS_KEYS[i]} 的 data-tile`).toBe(EXPECTED_TILES[i])
    })
  })

  it('should_useStrokeGlyphsOnTwentyFourCanvas_when_sysTileRendered', () => {
    const tile = mount(ShellHomeScreen).find('.shell-sys-tile')
    const svg = tile.find('svg')

    // 与桌面 ShellIcon 同一套 stroke 线稿（不是启动器实心块面）
    expect(svg.attributes('fill')).toBe('none')
    expect(svg.attributes('stroke')).toBe('currentColor')
    expect(svg.attributes('stroke-width')).toBe('1.55')
    expect(svg.attributes('stroke-linecap')).toBe('round')
    expect(svg.attributes('stroke-linejoin')).toBe('round')
    expect(svg.attributes('width')).toBe('24')
    expect(svg.attributes('height')).toBe('24')
    // 首个入口 = 应用管理（grid，四条独立方框路径）
    expect(svg.findAll('path')).toHaveLength(4)
  })

  it('should_matchDesktopShellIconPaths_when_systemGlyphsChanged', () => {
    const mobile = readFileSync(
      join(process.cwd(), 'src/shell/components/screens/ShellHomeScreen.vue'),
      'utf8',
    )
    const desktop = readFileSync(
      join(process.cwd(), '../wasmnest-desktop/src/shell/components/ShellIcon.vue'),
      'utf8',
    )
    // 移动端图标表里所有 SVG path 字符串都必须逐字存在于桌面 ShellIcon
    const paths = [...mobile.matchAll(/'([Mm][^']*)'/g)]
      .map((m) => m[1])
      .filter((d) => /\d/.test(d))

    expect(
      paths.length,
      '至少覆盖 grid / shield / gear / lock / pulse / layers',
    ).toBeGreaterThanOrEqual(6)
    for (const d of paths) {
      expect(desktop.includes(d), `系统图标路径未在桌面 ShellIcon 中找到：${d}`).toBe(true)
    }
  })

  it('should_useNeutralTileSurface_when_sysTileRendered', () => {
    const sheet = css()
    const block = sheet.match(/\.shell-sys-tile\s*\{[^}]*\}/)?.[0] ?? ''

    expect(block, '中性 card 表面（桌面 .tone-system 同口径）').toContain(
      'background: var(--mobile-bg-card)',
    )
    expect(block).toContain('border: 1px solid var(--mobile-border)')
    expect(block).toContain('color: var(--mobile-text-primary)')
    expect(sheet, '不再保留按入口上色的启动器渐变 token').not.toContain('--shell-tile-')
  })
})

describe('宿主系统级服务（L1/L2 = 服务宫格，不进应用 / 系统宫格）', () => {
  function service(id: string, kind: string, name = id): ShellApp {
    const s = app(id, 'running', name)
    return { ...s, kind }
  }

  it('系统服务不出现在应用宫格，住在独立的服务宫格（本地化名 + 专属瓦片）', () => {
    apps.value = [
      service('com.wasmnest.auth-center', 'internal-business', 'Auth Center'),
      service('com.wasmnest.monitor', 'internal-business', 'MonitoringService'),
      app('com.wasmnest.ai-chatbox', 'running', 'AI Chatbox'),
    ]
    const wrapper = mount(ShellHomeScreen)

    // 业务应用在应用宫格；两个系统服务不在（也不以插件名出现）
    expect(wrapper.text()).toContain('AI Chatbox')
    expect(wrapper.text()).not.toContain('Auth Center')
    expect(wrapper.text()).not.toContain('MonitoringService')

    // 服务宫格：标题 + 两个服务瓦片（本地化 key 回显 + data-tile 锚点）
    expect(wrapper.text()).toContain('shell.home.servicesTitle')
    const auth = wrapper.find('button[aria-label="shell.home.serviceAuthCenter"]')
    const monitor = wrapper.find('button[aria-label="shell.home.serviceMonitor"]')
    expect(auth.exists()).toBe(true)
    expect(monitor.exists()).toBe(true)
    expect(auth.find('.shell-sys-tile').attributes('data-tile')).toBe('auth-center')
    expect(monitor.find('.shell-sys-tile').attributes('data-tile')).toBe('monitor')
  })

  it('分区顺序固定为 应用 → 服务 → 系统', () => {
    apps.value = [
      service('com.wasmnest.auth-center', 'internal-business', 'Auth Center'),
      app('com.wasmnest.ai-chatbox', 'running', 'AI Chatbox'),
    ]
    const wrapper = mount(ShellHomeScreen)

    const titles = wrapper
      .findAll('h2.shell-type-section')
      .map((h) => h.text())
      .filter((text) =>
        ['shell.home.appsTitle', 'shell.home.servicesTitle', 'shell.home.sysTitle'].includes(text),
      )
    expect(titles).toEqual([
      'shell.home.appsTitle',
      'shell.home.servicesTitle',
      'shell.home.sysTitle',
    ])
  })

  it('点击服务瓦片打开应用面（open），不是系统页导航', async () => {
    apps.value = [
      service('com.wasmnest.auth-center', 'internal-business', 'Auth Center'),
    ]
    const wrapper = mount(ShellHomeScreen)

    await wrapper.find('button[aria-label="shell.home.serviceAuthCenter"]').trigger('click')
    expect(mockOpen).toHaveBeenCalledWith('com.wasmnest.auth-center')
    expect(mockNavigate).not.toHaveBeenCalledWith('apps')
  })

  it('未知系统服务回退插件名 + 通用瓦片（不硬编码新 id）', () => {
    apps.value = [service('com.wasmnest.unknown-svc', 'basic-service', 'UnknownSvc')]
    const wrapper = mount(ShellHomeScreen)

    expect(wrapper.text()).toContain('UnknownSvc')
    const tile = wrapper.find('button[aria-label="UnknownSvc"] .shell-sys-tile')
    expect(tile.attributes('data-tile')).toBe('com.wasmnest.unknown-svc')
  })

  it('只有系统服务、没有业务应用 → 应用宫格空态（不误报“全部停用”）', () => {
    apps.value = [service('com.wasmnest.monitor', 'internal-business', 'MonitoringService')]
    const wrapper = mount(ShellHomeScreen)

    expect(wrapper.text()).toContain('shell.home.emptyAppsHint')
    // 服务仍在服务宫格
    expect(wrapper.find('button[aria-label="shell.home.serviceMonitor"]').exists()).toBe(true)
  })
})

describe('C-H5 通知入口', () => {
  it('should_countNotificationsPlusPending_when_badgeRendered', () => {
    useShellNotifications().pushNotification({ kind: 'info', icon: 'i', source: 's', title: 'n1' })
    useShellNotifications().pushNotification({ kind: 'info', icon: 'i', source: 's', title: 'n2' })
    apps.value = [app('p', 'approval', 'PendingApp')]

    const bell = mount(ShellHomeScreen).find('button[aria-label^="shell.notify.open"]')

    // 计数 = 2 条通知 + 1 个待审批
    expect(bell.attributes('aria-label')).toContain('3')
    expect(bell.text()).toContain('3')
  })

  it('should_toggleShade_when_bellTapped', async () => {
    const wrapper = mount(ShellHomeScreen)

    await wrapper.find('button[aria-label^="shell.notify.open"]').trigger('click')

    expect(mockToggleShade).toHaveBeenCalledTimes(1)
  })
})

describe('C-H6 空态', () => {
  it('should_explainNextStep_when_noAppsInstalled', () => {
    const wrapper = mount(ShellHomeScreen)

    expect(wrapper.text()).toContain('shell.home.emptyAppsHint')
    // 多任务是平台入口，空态也在场；头部不出现运行应用图标
    expect(wrapper.find('button[aria-label="shell.switcher.title"]').exists()).toBe(true)
    expect(wrapper.findAll('header button[aria-label^="shell.home.switchTo"]')).toHaveLength(0)
  })
})

describe('C-H7 快捷卡片轨道（横向轮播）', () => {
  const SlotCard = { template: '<div class="slot-card">slot</div>' }

  function withSlot(): ShellApp {
    return {
      ...app('a', 'running', 'AppA'),
      contributions: { slots: [{ id: 's1', component: SlotCard }] },
    }
  }

  it('should_renderCardsInHorizontalSnapTrack_when_slotsRegistered', () => {
    apps.value = [withSlot()]

    const wrapper = mount(ShellHomeScreen)
    const track = wrapper.find('.shell-slot-track')

    expect(track.exists(), '快捷卡片应有独立轨道').toBe(true)
    expect(track.attributes('role')).toBe('list')
    expect(track.findAll('[role="listitem"]')).toHaveLength(1)
    expect(wrapper.find('.slot-card').exists()).toBe(true)
  })

  it('should_notRenderTrack_when_noSlots', () => {
    apps.value = [app('a', 'running', 'AppA')]

    expect(mount(ShellHomeScreen).find('.shell-slot-track').exists()).toBe(false)
  })
})

describe('C-H8 应用分组头（不挂计数与重复入口）', () => {
  it('should_keepTitleOnly_when_appsSectionRendered', () => {
    apps.value = [app('a', 'stopped', 'AppA')]
    const wrapper = mount(ShellHomeScreen)

    // 管理入口已在系统宫格「应用管理」占同层位置；分组头再放图标是重复入口，
    // 且抢标题行视觉重心（用户 2026-10-20 反馈删除）。
    expect(wrapper.find('button[aria-label="shell.home.manageApps"]').exists()).toBe(false)

    // 计数同为用户 2026-10-20 反馈删除的内容：分组头只剩标题
    const note = wrapper.findAll('span').find((s) => s.text().includes('shell.home.appsNote'))
    expect(note, '「N 个已安装」不得回接').toBeUndefined()
    const title = wrapper.findAll('h2.shell-type-section').find((h) => h.text().includes('shell.home.appsTitle'))
    expect(title?.exists(), '应用分组标题仍在场').toBe(true)
  })
})

describe('C-H9 宿主文案纪律（方案期解释不得回接）', () => {
  it('should_notRenderDesignStageNotes_when_mounted', () => {
    apps.value = [app('a', 'running', 'AppA'), app('b', 'stopped', 'AppB')]
    const text = mount(ShellHomeScreen).text()

    expect(text, '「由应用提供」应删除').not.toContain('shell.home.slotsNote')
    expect(text, '「平台自带」应删除').not.toContain('shell.home.sysNote')
    expect(text, '「最近使用在前」应删除').not.toContain('shell.home.runningNote')
  })
})

describe('C-H11 多任务入口', () => {
  it('should_openSwitcher_when_headerEntryTapped', async () => {
    const wrapper = mount(ShellHomeScreen)

    const entry = wrapper.find('button[aria-label="shell.switcher.title"]')
    expect(entry.exists(), '入口应带可访问名（单图标按钮必须有）').toBe(true)

    await entry.trigger('click')
    expect(mockOpenSwitcher).toHaveBeenCalledTimes(1)
  })
})

describe('C-H13 运行带退役（不留卡片与停止按钮）', () => {
  it('should_notRenderRunningCards_when_appsRunning', () => {
    apps.value = [app('a', 'running', 'AppA')]
    const wrapper = mount(ShellHomeScreen)

    expect(wrapper.findAll('article'), '运行卡片不再是按钮形态').toHaveLength(0)
    expect(wrapper.text()).not.toContain('shell.home.stopInstance')
    expect(wrapper.text()).not.toContain('shell.home.runningTitle')
  })
})
