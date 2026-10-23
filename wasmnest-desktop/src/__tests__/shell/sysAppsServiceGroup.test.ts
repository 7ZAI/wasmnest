/**
 * 系统服务区（桌面「应用管理」）行为锁
 *
 * 需求（spec `.scratch/2026-10-22-monitor-system-service` §3 + 2026-10-23 排序裁决）：
 * 系统服务区由 **manifest kind** 判定（L1 basic-service / L2 internal-business），
 * 不硬编码 id；业务应用在前、服务在后（服务内部按 L1 → L2 → 名称）；服务不渲染
 * 卸载入口（即便 source 是用户安装）；自启开关仍然可用；没有服务时不渲染空分区标题。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { ref } from 'vue'

const mocks = vi.hoisted(() => ({
  plugins: null as unknown as Ref<unknown[]>,
  busyId: null as unknown as Ref<string | null>,
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
    setEnabled: mocks.setEnabled,
    setAutostart: mocks.setAutostart,
  }),
  // 与真源同判据（UI 不硬编码 id 清单，只认 kind）
  isServiceKind: (kind?: string) => kind === 'basic-service' || kind === 'internal-business',
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({
    dialog: ref(null),
    dialogAppId: ref(null),
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
  return mount(SysAppsView)
}

/** 分组标题节点（testid 由分组 id 拼出；不渲染空分区） */
function groupTitles(wrapper: ReturnType<typeof mountView>): string[] {
  return wrapper.findAll('[data-testid^="sys-apps-group-"]').map((n) => n.text())
}

beforeEach(() => {
  mocks.plugins = ref([])
  mocks.busyId = ref(null)
  vi.clearAllMocks()
})

describe('系统服务区（manifest kind 分组）', () => {
  it('应用区在前；服务区在后、按 L1 → L2 → 名称（不依赖注册表顺序）', () => {
    mocks.plugins.value = [
      entry({ id: 'com.wasmnest.bedcode', pluginId: 'com.wasmnest.bedcode', name: 'Zed App' }),
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
    expect(groupTitles(wrapper)).toEqual(['shell.apps.businessApps', 'shell.apps.systemServices'])

    const text = wrapper.text()
    expect(text.indexOf('Zed App')).toBeLessThan(text.indexOf('Auth Center'))
    expect(text.indexOf('Auth Center')).toBeLessThan(text.indexOf('Monitor'))
  })

  it('系统服务不渲染卸载入口——即便来源是 user-installed（判据是 kind，不是来源）', () => {
    mocks.plugins.value = [
      entry({
        id: 'com.wasmnest.monitor',
        pluginId: 'com.wasmnest.monitor',
        name: 'Monitor',
        kind: 'internal-business',
        source: 'user-installed',
      }),
      entry({
        id: 'com.wasmnest.third-party',
        pluginId: 'com.wasmnest.third-party',
        name: 'Third Party',
        source: 'user-installed',
      }),
    ]

    const wrapper = mountView()
    const uninstallButtons = wrapper
      .findAll('button')
      .filter((b) => b.text().includes('shell.apps.uninstall'))

    expect(uninstallButtons).toHaveLength(1)
    // 唯一卸载按钮属于业务应用，不属于服务卡片
    expect(uninstallButtons[0].element.closest('.shell-card')?.textContent).toContain('Third Party')
  })

  it('没有系统服务时不渲染服务分区标题（不留空标题）', () => {
    mocks.plugins.value = [
      entry({ id: 'com.wasmnest.app-a', pluginId: 'com.wasmnest.app-a', name: 'App A' }),
    ]

    const wrapper = mountView()
    expect(groupTitles(wrapper)).toEqual(['shell.apps.businessApps'])
  })

  it('全部是系统服务时不渲染业务应用分区标题', () => {
    mocks.plugins.value = [
      entry({
        id: 'com.wasmnest.auth-center',
        pluginId: 'com.wasmnest.auth-center',
        name: 'Auth Center',
        kind: 'basic-service',
      }),
    ]

    const wrapper = mountView()
    expect(groupTitles(wrapper)).toEqual(['shell.apps.systemServices'])
  })

  it('服务卡片的自启开关可点：按当前值取反写偏好', async () => {
    mocks.plugins.value = [
      entry({
        id: 'com.wasmnest.monitor',
        pluginId: 'com.wasmnest.monitor',
        name: 'Monitor',
        kind: 'internal-business',
        autostart: true,
      }),
    ]

    const wrapper = mountView()
    const autostartLabel = wrapper.find('label[title="shell.apps.autostartHint"]')
    expect(autostartLabel.exists(), '服务卡片必须显示自启开关').toBe(true)
    const toggle = autostartLabel.find('button[role="switch"]')
    expect(toggle.element.getAttribute('aria-checked')).toBe('true')

    await toggle.trigger('click')
    expect(mocks.setAutostart).toHaveBeenCalledWith('com.wasmnest.monitor', false)
    expect(mocks.setEnabled).not.toHaveBeenCalled()
  })
})
