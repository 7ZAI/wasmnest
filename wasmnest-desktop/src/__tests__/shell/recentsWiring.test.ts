import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { existsSync, readFileSync } from 'node:fs'

/**
 * 多任务接线锁（2026-10-17 用户裁决的回归锁）——挂载行为断言
 *
 * 需求演进：
 * - 主屏**不再**展示「正在运行」区域；
 * - 打开过 / 后台运行的应用由**标题栏导航区的「多任务」入口**承载（紧贴「返回」右侧），
 *   形态是**全屏切换层**（安卓 recents：虚化背景 + 运行中应用的大卡片），不是小浮层面板。
 *
 * 这类改动的典型失败形态是「三处只改了两处」：组件写了但工具栏没入口 / 入口点了没层
 * 可开 / 主屏卡片带忘了删 / 全屏层被壳根的 overflow 裁成小窗——界面看起来正常，功能
 * 其实半截。
 *
 * 改造说明（issue #23 / codemap §8.1 首批，#12 样板）：原锁 81 处 `toContain` 逐调用点
 * 逐函数名点名（`:style="bandStyle"`、`state.toggleRecents()`、SVG path 源码……），
 * 合法重排装配顺序 / 重命名局部变量 / 改文案即红。现收敛为：
 * - 装配语义全部改挂载行为断言：主屏无运行区（ShellHome）、工具栏入口与导航顺序
 *   （ShellToolbar）、全屏层开合与动作转发（ShellTaskSwitcher）、图标接线
 *   （ShellIcon / ShellAppTile，经 appIcons 真实解析链）；
 * - **多任务开关状态收敛**以联合挂载证明：工具栏入口与全屏层共享 useShellState 的
 *   同一 `recentsOpen`，点入口 → 层开、关层 → 入口态跟随（不再逐函数名点名）；
 * - 装配点只留 **1 条轻量接线锁**（ShellHost 模板真的挂 `<ShellTaskSwitcher />`，
 *   同 shellExtensionWiring 口径：组件测试全绿而装配缺失的场景无运行时覆盖）；
 * - 退役面（ShellRecentsPanel 小浮层 / ShellCommandPalette 命令面板）保留 fail-visible
 *   存在性扫描（退役面纪律：回接即违规）；
 * - 卡片尺寸 / 几何的纯函数面由 recentsLayout.test.ts 承载（方向 / 常量 / 轨道），
 *   组件侧只断言解算结果真的注入 DOM（末行居中、溢出滚动）。
 */

const mocks = vi.hoisted(() => ({
  /** 壳状态共享桩：工具栏 / 全屏层 / 主屏挂同一份（状态收敛的载体） */
  state: null as unknown as Record<string, unknown>,
  appsStore: null as unknown as Record<string, unknown>,
  /** 挂载层 API 桩：多任务收起时把前台实例送回挂载槽 */
  returnAppSurfaceToSlot: vi.fn(() => true),
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => mocks.state,
}))

vi.mock('@/shell/mount/useAppMount', () => ({
  returnAppSurfaceToSlot: mocks.returnAppSurfaceToSlot,
  presentAppSurfaceInPreview: vi.fn(() => false),
  fitAppSurfacePreview: vi.fn(() => false),
  leaveAppSurfacePreview: vi.fn(() => false),
}))

vi.mock('@/shell/composables/useShellApps', async () => {
  // isServiceKind 用真实口径（AGENTS §2：basic-service / internal-business 不产多任务卡）
  const isServiceKind = (kind?: string) => kind === 'basic-service' || kind === 'internal-business'
  return { useShellApps: () => mocks.appsStore, isServiceKind }
})

vi.mock('@/shell/composables/appIcons', () => ({
  appIconUrl: vi.fn(),
  clearAppIconCache: vi.fn(),
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ settings: { ui: { theme: 'dark' } }, saveSettings: vi.fn() }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isSystemDark: ref(false) }),
}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => null }))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import ShellHome from '@/shell/components/ShellHome.vue'
import ShellToolbar from '@/shell/components/ShellToolbar.vue'
import ShellTaskSwitcher from '@/shell/components/ShellTaskSwitcher.vue'
import ShellIcon from '@/shell/components/ShellIcon.vue'
import ShellAppTile from '@/shell/components/ShellAppTile.vue'
import { appIconUrl } from '@/shell/composables/appIcons'
import type { ShellAppEntry } from '@/shell/composables/useShellApps'

const HOME = 'src/shell/components/ShellHome.vue'
const TOOLBAR = 'src/shell/components/ShellToolbar.vue'
const HOST = 'src/shell/ShellHost.vue'

/** 去注释（注释里提到被删除的类名 / key 不算真实用法）——仅退役面扫描使用 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** 投影条目夹具（只给多任务 / 主屏消费的字段，其余无关者置缺省） */
function entry(overrides: Partial<ShellAppEntry>): ShellAppEntry {
  return {
    id: 'com.wasmnest.test.app',
    pluginId: 'com.wasmnest.test.app',
    name: 'App',
    version: '1.0.0',
    icon: 'grid',
    tone: 'system',
    state: 'dormant',
    pluginState: 'loaded',
    source: 'builtin',
    permissions: [],
    enabled: true,
    autostart: false,
    ...overrides,
  } as ShellAppEntry
}

const box = <T>(v: T) => ({ value: v }) as { value: T }

/** 后台卡 key → 标题（i18n mock 返回 key，标题用假名好断言） */
const cardTitleOf = (key: string) => (key.startsWith('app:') ? '后台应用甲' : '系统设置页')

beforeEach(() => {
  mocks.state = {
    screen: ref('home'),
    activeCard: ref(null as string | null),
    cards: ref([] as string[]),
    recentsOpen: ref(false),
    panelOpen: ref(false),
    quickSettingsOpen: ref(false),
    dialog: ref(null),
    ctxMenu: ref(null),
    homeQ: ref(''),
    notifCountTotal: ref(0),
    notifPulse: ref(0),
    cardTitleOf,
    hasAppSession: () => false,
    openApp: vi.fn(),
    openSys: vi.fn(),
    goBack: vi.fn(),
    goHome: vi.fn(),
    toggleRecents: vi.fn(),
    toggleQuickSettings: vi.fn(),
    activateCard: vi.fn(),
    closeCard: vi.fn(),
    stopAllCards: vi.fn(),
  }
  mocks.appsStore = {
    plugins: ref([] as ShellAppEntry[]),
    displayStates: ref({} as Record<string, string>),
    tones: ref({} as Record<string, string>),
    appOf: () => undefined,
  }
  vi.mocked(appIconUrl).mockReset()
  mocks.returnAppSurfaceToSlot.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

// ==================== 被测组件的挂载器 ====================

const TILE_STUB = {
  props: ['icon', 'pluginId', 'iconFile', 'tone', 'size'],
  template:
    '<span class="tile-stub" :data-plugin-id="pluginId ?? \'\'" :data-icon-file="iconFile ?? \'\'"></span>',
}
const PREVIEW_STUB = {
  props: ['appId', 'icon', 'iconFile', 'tone'],
  template: '<div class="surface-stub" :data-app-id="appId"></div>',
}

function mountHome() {
  return mount(ShellHome, {
    global: { stubs: { ShellAppTile: TILE_STUB, ShellIcon: true } },
    attachTo: document.body,
  })
}

function mountToolbar() {
  return mount(ShellToolbar, { attachTo: document.body })
}

/** 全屏层 Teleport 到 body：统一从 document.body 查（找不到即失败） */
function q(selector: string): HTMLElement {
  const node = document.body.querySelector(selector)
  expect(node, `找不到 ${selector}（全屏层没渲染？）`).toBeTruthy()
  return node as HTMLElement
}

function mountSwitcher() {
  const wrapper = mount(ShellTaskSwitcher, {
    global: { stubs: { ShellAppTile: TILE_STUB, AppSurfaceTile: PREVIEW_STUB } },
    attachTo: document.body,
  })
  return wrapper
}

/** 在真实 DOM 上派发点击（冒泡给根节点的委托处理器） */
async function click(selector: string): Promise<void> {
  q(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await nextTick()
}

// ==================== 主屏 ====================

describe('主屏不再展示运行区（挂载行为）', () => {
  it('后台有卡也不在主屏铺开：运行面只在多任务全屏层，主屏只留应用/服务/系统网格', () => {
    mocks.state.cards.value = ['app:com.wasmnest.test.app', 'sys:settings']
    mocks.appsStore.plugins.value = [
      entry({ id: 'com.wasmnest.test.app', pluginId: 'com.wasmnest.test.app', name: 'DemoApp' }),
    ]

    const wrapper = mountHome()

    // 反例守卫：主屏网格还在（别把主屏删空）
    expect(wrapper.text()).toContain('shell.home.appsTitle')
    expect(wrapper.text()).toContain('DemoApp')
    expect(wrapper.text()).toContain('shell.home.sysTitle')
    // 运行区不在：后台卡的标题与多任务层的标题都不出现在主屏
    expect(wrapper.text()).not.toContain('后台应用甲')
    expect(wrapper.text()).not.toContain('系统设置页')
    expect(wrapper.text()).not.toContain('shell.recents.title')
  })

  it('主屏应用图块拿到应用 id（图标还原为应用自带那张，不是哈希 glyph）', () => {
    mocks.appsStore.plugins.value = [
      entry({ id: 'com.wasmnest.test.app', pluginId: 'com.wasmnest.test.app', name: 'DemoApp' }),
    ]

    const wrapper = mountHome()

    const tile = wrapper.find('.tile-stub')
    expect(tile.exists()).toBe(true)
    expect(tile.attributes('data-plugin-id')).toBe('com.wasmnest.test.app')
  })
})

// ==================== 工具栏多任务入口 ====================

describe('标题栏多任务入口（导航区，紧贴「返回」右侧）', () => {
  it('导航区顺序 = 返回 → 多任务 → 主屏，入口有 recents 图标', () => {
    const wrapper = mountToolbar()

    const nav = wrapper.find('nav[aria-label="导航"]')
    expect(nav.exists()).toBe(true)
    const labels = nav.findAll('button').map((b) => b.attributes('aria-label'))
    expect(labels).toEqual(['shell.nav.back', 'shell.nav.tasksTitle', 'shell.nav.home'])
    // 入口用 recents 图标（移动端多任务同视觉）
    expect(nav.findAll('button')[1]!.find('svg').exists()).toBe(true)
  })

  it('入口是共享状态的开合器：点击走 useShellState.toggleRecents，不持本地开关', async () => {
    const wrapper = mountToolbar()

    await wrapper.findAll('nav button')[1]!.trigger('click')

    expect(mocks.state.toggleRecents).toHaveBeenCalledTimes(1)
  })

  it('有后台应用时入口显示数量徽标，无卡时不显示', async () => {
    mountToolbar()
    expect(q('nav[aria-label="导航"]').querySelector('.tb-n')).toBeNull()

    mocks.state.cards.value = ['app:a', 'app:b']
    await nextTick()

    const badge = q('nav[aria-label="导航"]').querySelector('.tb-n')
    expect(badge?.textContent?.trim()).toBe('2')
  })
})

// ==================== 状态收敛 + 全屏层（联合挂载） ====================

describe('多任务开关状态收敛在 useShellState（工具栏 ↔ 全屏层共享同一 ref）', () => {
  /** toggleRecents 的真实语义（useShellState.test.ts 已单测全量互斥；这里只取翻转） */
  function shareRealToggle(): void {
    mocks.state.toggleRecents = (open?: boolean) => {
      const r = mocks.state.recentsOpen as Ref<boolean>
      r.value = open ?? !r.value
    }
  }

  it('点工具栏入口 → 全屏层以 dialog 形态出现在 body；关层 → 入口态跟随回弹', async () => {
    shareRealToggle()
    const toolbar = mountToolbar()
    mountSwitcher()
    expect(document.body.querySelector('.ts-root')).toBeNull()

    // 入口开层
    await toolbar.findAll('nav button')[1]!.trigger('click')
    await nextTick()
    const layer = q('.ts-root')
    expect(layer.getAttribute('role')).toBe('dialog')
    expect(layer.getAttribute('aria-modal')).toBe('true')
    // 入口 on 态（同一 ref 驱动）
    const tasksBtn = toolbar.findAll('nav button')[1]!
    expect(tasksBtn.classes()).toContain('on')

    // 层内关闭 → 层收 + 入口态回弹（同一 ref，两处消费）
    await click('.ts-close')
    await nextTick()
    expect(document.body.querySelector('.ts-root')).toBeNull()
    expect(tasksBtn.classes()).not.toContain('on')
  })

  it('全屏层动作走唯一实现：单关 / 全关 / 激活分别转发 closeCard / stopAllCards / activateCard', async () => {
    mocks.state.recentsOpen.value = true
    mocks.state.cards.value = ['app:com.wasmnest.test.app']
    mocks.appsStore.appOf = vi.fn(() =>
      entry({ id: 'com.wasmnest.test.app', pluginId: 'com.wasmnest.test.app', name: 'DemoApp' }),
    )
    mountSwitcher()

    // 单关：只移除这一张，全屏层留下
    await click('.ts-card-x')
    expect(mocks.state.closeCard).toHaveBeenCalledWith('app:com.wasmnest.test.app')
    // 全关：头部「全部关闭」一键清场
    await click('.shell-mini.danger')
    expect(mocks.state.stopAllCards).toHaveBeenCalledTimes(1)
    // 激活：点卡片本体切回应用
    await click('.ts-card-main')
    expect(mocks.state.activateCard).toHaveBeenCalledWith('app:com.wasmnest.test.app')
    // 反例守卫：层没有自己拼路由 / 直调生命周期命令（那些是 useShellState 的职责）
    expect(mocks.state.openApp).not.toHaveBeenCalled()
    expect(mocks.state.goHome).not.toHaveBeenCalled()
  })

  it('Esc 收起全屏层（模态层的键盘退出）', async () => {
    mocks.state.recentsOpen.value = true
    mocks.state.cards.value = ['sys:settings']
    mountSwitcher()
    expect(q('.ts-root')).toBeTruthy()

    q('.ts-root').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()

    expect((mocks.state.recentsOpen as Ref<boolean>).value).toBe(false)
    expect(document.body.querySelector('.ts-root')).toBeNull()
  })
})

// ==================== 全屏层卡片形态（信息条 / 预览面 / 末行居中） ====================

describe('全屏层卡片装配（挂载 DOM 断言）', () => {
  it('信息条在缩略区之前且以应用图标打头；app 卡缩略区挂应用预览面、系统页卡保持 glyph', () => {
    mocks.state.recentsOpen.value = true
    mocks.state.cards.value = ['app:com.wasmnest.test.app', 'sys:settings']
    mocks.appsStore.appOf = vi.fn(() =>
      entry({
        id: 'com.wasmnest.test.app',
        pluginId: 'com.wasmnest.test.app',
        name: 'DemoApp',
        iconFile: 'icon.svg',
      }),
    )
    mountSwitcher()

    const cards = Array.from(document.body.querySelectorAll('.ts-card'))
    expect(cards).toHaveLength(2)
    const [appCard, sysCard] = cards

    // 信息条在缩略区之前，且第一个视觉元素是应用图标
    expect(appCard!.children[0]!.classList.contains('ts-meta')).toBe(true)
    expect(appCard!.children[1]!.classList.contains('ts-thumb')).toBe(true)
    expect(appCard!.querySelector('.ts-meta .tile-stub')).toBeTruthy()
    expect(appCard!.querySelector('.ts-meta .tile-stub')!.getAttribute('data-plugin-id')).toBe(
      'com.wasmnest.test.app',
    )
    // app 卡缩略区：真实实例容器（2026-10-30 起不再挂应用自绘预览面）
    const surface = appCard!.querySelector('.surface-stub')
    expect(surface?.getAttribute('data-app-id')).toBe('com.wasmnest.test.app')
    // 系统页卡没有实例：保持 glyph 分支，不塞实例容器
    expect(sysCard!.querySelector('.ts-thumb .glyph-box')).toBeTruthy()
    expect(sysCard!.querySelector('.surface-stub')).toBeNull()
  })

  it('预览容器不在打开按钮内部（单一覆盖层动作，避免嵌套交互元素）', () => {
    mocks.state.recentsOpen.value = true
    mocks.state.cards.value = ['app:com.wasmnest.test.app']
    mocks.appsStore.appOf = vi.fn(() =>
      entry({ id: 'com.wasmnest.test.app', pluginId: 'com.wasmnest.test.app', name: 'DemoApp' }),
    )
    mountSwitcher()

    const card = q('.ts-card')
    const openBtn = card.querySelector<HTMLButtonElement>('button.ts-card-main')
    expect(openBtn, '唯一打开动作按钮在场').toBeTruthy()
    // 打开按钮必须是自闭合空按钮：视觉层（预览面 / 信息条 / 缩略区）都不得嵌进去
    expect(openBtn!.childElementCount).toBe(0)
    expect(openBtn!.querySelector('.surface-stub, .ts-thumb, .ts-meta')).toBeNull()
  })

  it('「运行中」不再用 chip 重复（后台卡默认就是在跑）；异常态仍提示', async () => {
    mocks.state.recentsOpen.value = true
    mocks.state.cards.value = ['app:com.wasmnest.test.app']
    mocks.appsStore.appOf = vi.fn(() =>
      entry({ id: 'com.wasmnest.test.app', pluginId: 'com.wasmnest.test.app', name: 'DemoApp' }),
    )

    // running：无 chip
    mocks.appsStore.displayStates.value = { 'com.wasmnest.test.app': 'running' }
    const running = mountSwitcher()
    expect(document.body.querySelector('.ts-card .shell-chip')).toBeNull()
    running.unmount()
    document.body.innerHTML = ''

    // 降级：chip 在场（需要用户注意的状态才显示）
    mocks.appsStore.displayStates.value = { 'com.wasmnest.test.app': 'degraded' }
    mountSwitcher()
    expect(document.body.querySelector('.ts-card .shell-chip')).toBeTruthy()
  })

  it('卡宽解算真的注入 DOM：末行不满 3 张显式居中（6 半轨），超过 2 行整带滚动', () => {
    mocks.state.recentsOpen.value = true
    // 7 张 = 2 整行 + 末行 1 张（正中，行 3 列 3 起跨 2 轨）+ 超过 2 行 → is-scrolling
    mocks.state.cards.value = Array.from({ length: 7 }, (_, i) => `app:a${i}`)
    mountSwitcher()

    const band = q('.ts-cards')
    expect(band.classList.contains('is-scrolling')).toBe(true)
    const cards = Array.from(document.body.querySelectorAll('.ts-card'))
    // 整行满 3 张交给 CSS 自动排布（不写行列）
    expect(cards[0]!.style.gridColumn).toBe('')
    // 末行单卡由 recentsCardPlacement 注入显式位置（正中）
    expect(cards[6]!.style.gridColumn).toBe('3 / span 2')
    expect(cards[6]!.style.gridRow).toBe('3')
  })
})

// ==================== 收起时的实例去向 ====================

describe('多任务收起：前台实例必须送回挂载槽（2026-10-30 真实实例卡片）', () => {
  /** 前台实例在打开多任务时被搬进卡片：普通收起必须送回，否则应用“消失” */
  function originFixture(cards: string[]): void {
    mocks.state.recentsOpen.value = true
    mocks.state.activeCard.value = 'app:com.wasmnest.test.app'
    mocks.state.cards.value = cards
    mocks.appsStore.appOf = vi.fn((id: string) => entry({ id, pluginId: id, name: id }))
  }

  it('普通收起（Esc / 点空白）：送回挂载槽', async () => {
    originFixture(['app:com.wasmnest.test.app', 'sys:settings'])
    mountSwitcher()
    await nextTick()

    mocks.state.recentsOpen.value = false
    await nextTick()

    expect(mocks.returnAppSurfaceToSlot).toHaveBeenCalledWith('com.wasmnest.test.app')
  })

  it('切到别的应用：不抢挂载槽（实例去向由 AppMountSlot 的 appId watcher 接管）', async () => {
    originFixture(['app:com.wasmnest.test.app', 'app:com.wasmnest.other'])
    mountSwitcher()
    await nextTick()

    const mains = document.body.querySelectorAll<HTMLButtonElement>('.ts-card-main')
    mains[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(mocks.state.activateCard).toHaveBeenCalledWith('app:com.wasmnest.other')

    mocks.state.recentsOpen.value = false
    await nextTick()

    expect(mocks.returnAppSurfaceToSlot).not.toHaveBeenCalled()
  })

  it('切回同一张卡：仍要送回（appId 没变，挂载槽不会自己 re-attach）', async () => {
    originFixture(['app:com.wasmnest.test.app'])
    mountSwitcher()
    await nextTick()

    await click('.ts-card-main')
    mocks.state.recentsOpen.value = false
    await nextTick()

    expect(mocks.returnAppSurfaceToSlot).toHaveBeenCalledWith('com.wasmnest.test.app')
  })
})

// ==================== 图标接线 ====================

describe('图标接线（应用图标经 asset 协议解析，失败回退 glyph）', () => {
  it('ShellIcon 图标表定义了 recents（否则入口按钮空白）', () => {
    const wrapper = mount(ShellIcon, { props: { name: 'recents', size: 15 } })
    const dList = wrapper.findAll('path').map((p) => p.attributes('d'))
    expect(dList.length).toBeGreaterThan(0)
    expect(dList.every((d) => d.length > 0)).toBe(true)
  })

  it('ShellAppTile 应用自带图标（appIconUrl 解析链）→ img；解析失败 → 回退壳 glyph', async () => {
    vi.mocked(appIconUrl).mockResolvedValue('asset://localhost/plugins/desktop/com.x/icon.svg')
    const ok = mount(ShellAppTile, {
      props: { icon: 'grid', pluginId: 'com.x', iconFile: 'icon.svg', size: 52 },
      attachTo: document.body,
    })
    await flushPromises()
    expect(appIconUrl).toHaveBeenCalledWith('com.x', 'icon.svg')
    const img = ok.find('img.logo')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('asset://localhost/plugins/desktop/com.x/icon.svg')
    ok.unmount()
    document.body.innerHTML = ''

    // 解析不出来（未声明 / 文件缺失 / 无 asset 协议）→ 回退壳内通用图标，不是空块
    vi.mocked(appIconUrl).mockResolvedValue(undefined)
    const fallback = mount(ShellAppTile, {
      props: { icon: 'grid', pluginId: 'com.x', iconFile: 'icon.svg', size: 52 },
      attachTo: document.body,
    })
    await flushPromises()
    expect(fallback.find('img.logo').exists()).toBe(false)
    expect(fallback.find('svg').exists()).toBe(true)
    fallback.unmount()
  })
})

// ==================== 装配点（唯一文本接线锁 + 退役面） ====================

describe('装配点', () => {
  it('ShellHost 真的挂了全屏多任务层（入口有对象可开；组件测试测不出装配缺失，唯一接线锁）', () => {
    expect(stripComments(readFileSync(HOST, 'utf-8'))).toContain('<ShellTaskSwitcher />')
  })

  it('旧的小浮层面板保持退役（全屏切换层替代；回接即违规）', () => {
    expect(existsSync('src/shell/components/ShellRecentsPanel.vue')).toBe(false)
    expect(existsSync('src/shell/components/ShellTaskSwitcher.vue')).toBe(true)
  })

  it('命令面板保持退役（工具栏搜索入口按用户裁决移除）', () => {
    expect(existsSync('src/shell/components/ShellCommandPalette.vue')).toBe(false)
    for (const path of [HOST, TOOLBAR, 'src/shell/composables/useShellState.ts']) {
      const code = stripComments(readFileSync(path, 'utf-8'))
      expect(code, `${path} 不得回接命令面板`).not.toContain('ShellCommandPalette')
      expect(code).not.toContain('paletteOpen')
    }
    // 反例守卫（行为面）：多任务入口必须还在（别把导航区删空）
    const toolbar = mountToolbar()
    expect(toolbar.findAll('nav[aria-label="导航"] button')).toHaveLength(3)
    toolbar.unmount()
  })
})
