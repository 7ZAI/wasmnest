/**
 * 服务管理页（桌面）行为锁
 *
 * 迁移自原「应用管理系统服务区」测试：服务型 wasm（basic-service / internal-business）
 * 现在只住在服务管理页，按 L1 → L2 → 名称排序；不渲染卸载；自启开关可用；停止先弹
 * 确认；点服务卡片（非卡内控件）进入对应运行入口。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { ref } from 'vue'

const mocks = vi.hoisted(() => ({
  plugins: null as unknown as Ref<unknown[]>,
  busyId: null as unknown as Ref<string | null>,
  dialog: null as unknown as Ref<string | null>,
  dialogAppId: null as unknown as Ref<string | null>,
  setEnabled: vi.fn(),
  setAutostart: vi.fn(),
  activate: vi.fn(async () => true),
  openApp: vi.fn(),
  approveAndStart: vi.fn(),
  stopApp: vi.fn(),
}))

vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    plugins: mocks.plugins as never,
    busyId: mocks.busyId as never,
    setEnabled: mocks.setEnabled,
    setAutostart: mocks.setAutostart,
    activate: mocks.activate,
  }),
  isServiceKind: (kind?: string) => kind === 'basic-service' || kind === 'internal-business',
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({
    dialog: mocks.dialog,
    dialogAppId: mocks.dialogAppId,
    openApp: mocks.openApp,
    approveAndStart: mocks.approveAndStart,
    stopApp: mocks.stopApp,
  }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import SysServicesView from '@/shell/sys/SysServicesView.vue'
import type { ShellAppEntry } from '@/shell/composables/useShellApps'

function entry(overrides: Partial<ShellAppEntry> & { id: string }): ShellAppEntry {
  return {
    pluginId: overrides.id,
    name: overrides.id,
    version: '1.0.0',
    icon: 'layers',
    tone: 'system',
    state: 'dormant',
    pluginState: 'loaded',
    kind: 'internal-business',
    source: 'builtin',
    route: '/service',
    permissions: [],
    enabled: true,
    autostart: false,
    ...overrides,
  } as ShellAppEntry
}

function mountView() {
  return mount(SysServicesView, {
    global: { stubs: { ShellAppTile: true, ShellIcon: true } },
  })
}

beforeEach(() => {
  mocks.plugins = ref([])
  mocks.busyId = ref(null)
  mocks.dialog = ref(null)
  mocks.dialogAppId = ref(null)
  vi.clearAllMocks()
})

describe('服务管理（manifest kind 分组）', () => {
  it('只列服务：L1 basic-service → L2 internal-business → 名称', () => {
    mocks.plugins.value = [
      entry({ id: 'com.wasmnest.bedcode', name: 'BedCode', kind: 'business-app' }),
      entry({ id: 'com.wasmnest.monitor', name: 'Monitor', kind: 'internal-business' }),
      entry({ id: 'com.wasmnest.auth-center', name: 'Auth Center', kind: 'basic-service' }),
      entry({ id: 'com.wasmnest.speech', name: 'Speech', kind: 'internal-business' }),
    ]

    const wrapper = mountView()
    const text = wrapper.text()
    expect(text).not.toContain('BedCode')
    expect(text.indexOf('Auth Center')).toBeLessThan(text.indexOf('Monitor'))
    expect(text.indexOf('Monitor')).toBeLessThan(text.indexOf('Speech'))
    expect(wrapper.findAll('[data-testid^="sys-services-card-"]')).toHaveLength(3)
  })

  it('服务没有卸载入口（即便来源是 user-installed）', () => {
    mocks.plugins.value = [
      entry({ id: 'com.wasmnest.monitor', name: 'Monitor', source: 'user-installed' }),
    ]

    const wrapper = mountView()
    expect(
      wrapper.findAll('button').filter((b) => b.text().includes('shell.apps.uninstall')),
    ).toHaveLength(0)
  })

  it('自启开关可点：按当前值取反写偏好', async () => {
    mocks.plugins.value = [entry({ id: 'com.wasmnest.monitor', name: 'Monitor', autostart: true })]

    const wrapper = mountView()
    const toggle = wrapper.find('label[title="shell.apps.autostartHint"] button[role="switch"]')
    expect(toggle.exists()).toBe(true)
    expect(toggle.attributes('aria-checked')).toBe('true')
    await toggle.trigger('click')
    expect(mocks.setAutostart).toHaveBeenCalledWith('com.wasmnest.monitor', false)
    expect(mocks.setEnabled).not.toHaveBeenCalled()
  })

  it('停止按钮说「停止服务」，点击先弹确认不直停', async () => {
    mocks.plugins.value = [
      entry({ id: 'com.wasmnest.monitor', name: 'Monitor', state: 'running' }),
    ]

    const wrapper = mountView()
    const stopBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('shell.apps.stopService'))
    expect(stopBtn).toBeDefined()
    await stopBtn!.trigger('click')
    expect(mocks.stopApp).not.toHaveBeenCalled()
    expect(mocks.dialog!.value).toBe('stop-service')
    expect(mocks.dialogAppId!.value).toBe('com.wasmnest.monitor')
  })

  it('运行态是同一个按钮：运行中 = 停止服务，其余 = 运行服务（不会消失）', async () => {
    mocks.plugins.value = [entry({ id: 'com.wasmnest.monitor', name: 'Monitor', state: 'running' })]
    const running = mountView()
    expect(running.text()).toContain('shell.apps.stopService')
    expect(running.text()).not.toContain('shell.services.start')

    mocks.plugins.value = [entry({ id: 'com.wasmnest.monitor', name: 'Monitor', state: 'dormant' })]
    const stopped = mountView()
    expect(stopped.text()).toContain('shell.services.start')
    expect(stopped.text()).not.toContain('shell.apps.stopService')
  })

  it('停止后同一位置出现「运行服务」：点击只启动（activate），不离开本页', async () => {
    mocks.plugins.value = [entry({ id: 'com.wasmnest.monitor', name: 'Monitor', state: 'dormant' })]

    const wrapper = mountView()
    const startBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('shell.services.start'))
    expect(startBtn).toBeDefined()
    await startBtn!.trigger('click')
    expect(mocks.activate).toHaveBeenCalledWith('com.wasmnest.monitor')
    expect(mocks.openApp).not.toHaveBeenCalled()
  })

  it('「服务详情」按钮进入服务页面（与整卡点击同义）', async () => {
    mocks.plugins.value = [entry({ id: 'com.wasmnest.monitor', name: 'Monitor' })]

    const wrapper = mountView()
    const detailBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('shell.services.detail'))
    expect(detailBtn).toBeDefined()
    await detailBtn!.trigger('click')
    expect(mocks.openApp).toHaveBeenCalledWith('com.wasmnest.monitor')
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('点服务卡片（非卡内控件）= 进入该服务运行入口', async () => {
    mocks.plugins.value = [entry({ id: 'com.wasmnest.monitor', name: 'Monitor' })]

    const wrapper = mountView()
    const card = wrapper.find('[data-testid="sys-services-card-com.wasmnest.monitor"]')
    await card.trigger('click')
    expect(mocks.openApp).toHaveBeenCalledWith('com.wasmnest.monitor')
  })

  it('卡内开关点击不冒泡成「服务详情」', async () => {
    mocks.plugins.value = [entry({ id: 'com.wasmnest.monitor', name: 'Monitor' })]

    const wrapper = mountView()
    const toggle = wrapper.find('label[title="shell.apps.autostartHint"] button[role="switch"]')
    await toggle.trigger('click')
    expect(mocks.openApp).not.toHaveBeenCalled()
  })

  it('没有服务时只给空态，不渲染服务卡', () => {
    const wrapper = mountView()
    expect(wrapper.text()).toContain('shell.services.empty')
    expect(wrapper.findAll('[data-testid^="sys-services-card-"]')).toHaveLength(0)
  })
})
