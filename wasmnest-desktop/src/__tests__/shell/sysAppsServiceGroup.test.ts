/**
 * 应用管理「服务迁移」锁（桌面）
 *
 * 2026-11-20 用户裁决：服务型 wasm（basic-service / internal-business）从应用管理
 * 全量迁往「服务管理」系统页，主屏「服务」宫格同步撤除。本锁守住迁移后的边界：
 * 应用管理只投影业务应用——不出现服务、不出现服务分组标题、不再有「停止服务」措辞
 * 与服务专属的卸载豁免；服务本身的行为由 sysServicesView.test.ts 覆盖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { ref } from 'vue'

const mocks = vi.hoisted(() => ({
  plugins: null as unknown as Ref<unknown[]>,
  busyId: null as unknown as Ref<string | null>,
  installing: null as unknown as Ref<boolean>,
  dialog: null as unknown as Ref<string | null>,
  dialogAppId: null as unknown as Ref<string | null>,
  setEnabled: vi.fn(),
  setAutostart: vi.fn(),
  openSys: vi.fn(),
  openApp: vi.fn(),
  stopApp: vi.fn(),
  approveAndStart: vi.fn(),
}))

vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    plugins: mocks.plugins as never,
    busyId: mocks.busyId as never,
    installing: mocks.installing as never,
    setEnabled: mocks.setEnabled,
    setAutostart: mocks.setAutostart,
  }),
  // 与真源同判据（UI 不硬编码 id 清单，只认 kind）
  isServiceKind: (kind?: string) => kind === 'basic-service' || kind === 'internal-business',
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({
    dialog: mocks.dialog,
    dialogAppId: mocks.dialogAppId,
    openSys: mocks.openSys,
    openApp: mocks.openApp,
    stopApp: mocks.stopApp,
    approveAndStart: mocks.approveAndStart,
  }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import SysAppsView from '@/shell/sys/SysAppsView.vue'
import type { ShellAppEntry } from '@/shell/composables/useShellApps'

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
    kind: 'business-app',
    source: 'builtin',
    permissions: [],
    enabled: true,
    autostart: false,
    ...overrides,
  } as ShellAppEntry
}

function mountView() {
  return mount(SysAppsView, { global: { stubs: { ShellAppTile: true, ShellIcon: true } } })
}

/** 残留的分组标题（服务迁出后应为 0 个：分组壳的标题恒空） */
function groupTitles(wrapper: ReturnType<typeof mountView>): string[] {
  return wrapper.findAll('[data-testid^="sys-apps-group-"]').map((n) => n.text())
}

beforeEach(() => {
  mocks.plugins = ref([])
  mocks.busyId = ref(null)
  mocks.installing = ref(false)
  mocks.dialog = ref(null)
  mocks.dialogAppId = ref(null)
  vi.clearAllMocks()
})

describe('应用管理只列业务应用（服务已迁入服务管理）', () => {
  it('服务不出现在应用管理（判据是 kind，不硬编码 id）', () => {
    mocks.plugins.value = [
      entry({ id: 'com.wasmnest.bedcode', pluginId: 'com.wasmnest.bedcode', name: 'BedCode' }),
      entry({
        id: 'com.wasmnest.monitor',
        pluginId: 'com.wasmnest.monitor',
        name: 'Monitor',
        kind: 'internal-business',
      }),
      entry({
        id: 'com.wasmnest.auth-center',
        pluginId: 'com.wasmnest.auth-center',
        name: 'Auth Center',
        kind: 'basic-service',
      }),
    ]

    const wrapper = mountView()
    const text = wrapper.text()
    expect(text).toContain('BedCode')
    expect(text).not.toContain('Monitor')
    expect(text).not.toContain('Auth Center')
    expect(groupTitles(wrapper)).toEqual([])
  })

  it('只有服务时应用管理为空清单（不渲染服务卡，也不误报有业务应用）', () => {
    mocks.plugins.value = [
      entry({
        id: 'com.wasmnest.auth-center',
        pluginId: 'com.wasmnest.auth-center',
        name: 'Auth Center',
        kind: 'basic-service',
      }),
    ]

    const wrapper = mountView()
    expect(wrapper.text()).not.toContain('Auth Center')
    expect(groupTitles(wrapper)).toEqual([])
  })

  it('停用措辞不再分服务/应用：应用管理只有「停用」，没有「停止服务」', () => {
    mocks.plugins.value = [
      entry({
        id: 'com.wasmnest.bedcode',
        pluginId: 'com.wasmnest.bedcode',
        name: 'BedCode',
        state: 'running',
      }),
    ]

    const wrapper = mountView()
    const labels = wrapper.findAll('button').map((b) => b.text())
    expect(labels.some((tx) => tx.includes('shell.apps.stop'))).toBe(true)
    expect(labels.some((tx) => tx.includes('shell.apps.stopService'))).toBe(false)
  })

  it('业务应用停用即时生效（服务停止确认属于服务管理页）', async () => {
    mocks.plugins.value = [
      entry({
        id: 'com.wasmnest.bedcode',
        pluginId: 'com.wasmnest.bedcode',
        name: 'BedCode',
        state: 'running',
      }),
    ]

    const wrapper = mountView()
    const stopBtn = wrapper.findAll('button').find((b) => b.text().includes('shell.apps.stop'))
    expect(stopBtn).toBeDefined()
    await stopBtn!.trigger('click')
    expect(mocks.stopApp).toHaveBeenCalledWith('com.wasmnest.bedcode')
    expect(mocks.dialog!.value).toBeNull()
  })

  it('卸载入口对业务应用常驻（不再按 kind 隐藏）', () => {
    mocks.plugins.value = [
      entry({
        id: 'com.wasmnest.third-party',
        pluginId: 'com.wasmnest.third-party',
        name: 'Third Party',
        source: 'user-installed',
      }),
    ]

    const wrapper = mountView()
    expect(
      wrapper.findAll('button').filter((b) => b.text().includes('shell.apps.uninstall')),
    ).toHaveLength(1)
  })
})
