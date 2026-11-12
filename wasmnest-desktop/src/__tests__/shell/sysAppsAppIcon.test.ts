/**
 * 应用管理页「卡头图标 + 应用 id 隐藏」行为锁（2026-11-11 用户裁决）
 *
 * 需求：
 * - 应用管理页每张卡片必须显示**该应用自带的那张图标**（manifest.icon 经 asset
 *   协议解析，与主屏 / 多任务图块同一组件 ShellAppTile），不得退化成壳内通用
 *   glyph 导致「主屏有图标、管理页没有」两套观感；
 * - 应用 id（`com.wasmnest.bedcode` 这类装配标识）是给排障看的内部键，不是用户
 *   语汇：卡面不得再原样显示（卡头有名称、副行有来源与版本已足够）。
 *
 * 只锁这两点：卡片其余动作面（启停 / 卸载 / 更新）由 sysAppsServiceGroup /
 * sysAppsInstall / sysAppsUpdateVersion 各自承载，不在此重复。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { ref } from 'vue'

const mocks = vi.hoisted(() => ({
  plugins: null as unknown as Ref<unknown[]>,
  busyId: null as unknown as Ref<string | null>,
  installing: null as unknown as Ref<boolean>,
  dialog: null as unknown as Ref<string | null>,
  dialogAppId: null as unknown as Ref<string | null>,
  appIconUrl: vi.fn(),
}))

vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    plugins: mocks.plugins as never,
    busyId: mocks.busyId as never,
    installing: mocks.installing as never,
    setEnabled: vi.fn(),
    setAutostart: vi.fn(),
  }),
  isServiceKind: (kind?: string) => kind === 'basic-service' || kind === 'internal-business',
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({
    dialog: mocks.dialog,
    dialogAppId: mocks.dialogAppId,
    openSys: vi.fn(),
    openApp: vi.fn(),
    stopApp: vi.fn(),
    approveAndStart: vi.fn(),
  }),
}))

// 真实图标链是 asset 协议（Tauri 运行时才有），这里只替 URL 解析这一跳：
// 断言点在下游「卡头真的挂了应用自带图标」。
vi.mock('@/shell/composables/appIcons', () => ({
  appIconUrl: (appId: string, iconFile?: string) => {
    mocks.appIconUrl(appId, iconFile)
    return Promise.resolve(`asset://localhost/plugins/${appId}/${iconFile ?? 'icon.svg'}`)
  },
  clearAppIconCache: vi.fn(),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import SysAppsView from '@/shell/sys/SysAppsView.vue'
import type { ShellAppEntry } from '@/shell/composables/useShellApps'

function entry(overrides: Partial<ShellAppEntry>): ShellAppEntry {
  return {
    id: 'com.wasmnest.bedcode',
    pluginId: 'com.wasmnest.bedcode',
    name: 'BedCode',
    version: '1.0.0',
    icon: 'terminal',
    iconFile: 'icon.svg',
    tone: 'system',
    state: 'dormant',
    pluginState: 'loaded',
    kind: 'business-app',
    source: 'builtin',
    permissions: [],
    enabled: true,
    autostart: false,
    ...overrides,
  } as ShellAppEntry
}

beforeEach(() => {
  mocks.plugins = ref([])
  mocks.busyId = ref(null)
  mocks.installing = ref(false)
  mocks.dialog = ref(null)
  mocks.dialogAppId = ref(null)
  vi.clearAllMocks()
})

describe('应用管理页卡头图标', () => {
  it('每个应用卡片显示自己那张图标（manifest.icon → asset URL），不是通用 glyph', async () => {
    mocks.plugins.value = [
      entry({ id: 'com.wasmnest.bedcode', pluginId: 'com.wasmnest.bedcode', name: 'BedCode' }),
      entry({
        id: 'com.wasmnest.monitor',
        pluginId: 'com.wasmnest.monitor',
        name: 'Monitor',
        iconFile: 'logo.svg',
        kind: 'internal-business',
      }),
    ]

    const wrapper = mount(SysAppsView)
    await flushPromises()

    const headers = wrapper.findAll('.shell-card-title img.logo')
    expect(headers).toHaveLength(2)
    const srcs = headers.map((img) => img.attributes('src'))
    expect(srcs).toContain('asset://localhost/plugins/com.wasmnest.bedcode/icon.svg')
    expect(srcs).toContain('asset://localhost/plugins/com.wasmnest.monitor/logo.svg')
    // 图标落在卡头标题里（不是正文里另起一块）
    expect(wrapper.find('.shell-card-title .glyph-box.has-logo').exists()).toBe(true)
  })

  it('解析出图标时不再叠回退 glyph（同一位置只留一枚图标）', async () => {
    mocks.plugins.value = [entry({})]

    const wrapper = mount(SysAppsView)
    await flushPromises()

    const title = wrapper
      .findAll('.shell-card-title')
      .find((node) => node.text().includes('BedCode'))
    expect(title, '应用卡片必须有卡头标题').toBeDefined()
    expect(title!.find('img.logo').exists()).toBe(true)
    expect(title!.find('svg').exists()).toBe(false)
  })
})

describe('应用管理页不显示应用 id', () => {
  it('卡面文本不出现原样 pluginId（名称 / 来源 / 版本仍在）', async () => {
    mocks.plugins.value = [
      entry({ id: 'com.wasmnest.bedcode', pluginId: 'com.wasmnest.bedcode', name: 'BedCode' }),
      entry({
        id: 'com.wasmnest.monitor',
        pluginId: 'com.wasmnest.monitor',
        name: 'Monitor',
        kind: 'internal-business',
      }),
    ]

    const wrapper = mount(SysAppsView)
    await flushPromises()

    const text = wrapper.text()
    expect(text).not.toContain('com.wasmnest.bedcode')
    expect(text).not.toContain('com.wasmnest.monitor')
    // 去掉的只是装配 id，副行的可读信息不能被一起带走
    expect(text).toContain('BedCode')
    expect(text).toContain('shell.apps.source.builtin')
    expect(text).toContain('v1.0.0')
  })
})
