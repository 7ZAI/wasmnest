/**
 * 「应用管理」更新行版本号显示锁（2026-11-05）
 *
 * 契约（真源 = SysAppsView.vue 更新面）：
 * - 「检查更新」按钮右侧**常显**应用当前版本号，不依赖检查结果（idle 也显示）；
 * - 状态行「已是最新」不再内嵌版本号——版本号已常显，同一行不重复。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { ref } from 'vue'

const mocks = vi.hoisted(() => ({
  plugins: null as unknown as Ref<unknown[]>,
  busyId: null as unknown as Ref<string | null>,
  installing: null as unknown as Ref<boolean>,
  updateStates: null as unknown as Ref<Record<string, { status: string; [k: string]: unknown }>>,
  check: vi.fn(),
  applyUpdate: vi.fn(),
}))

vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    plugins: mocks.plugins as never,
    busyId: mocks.busyId as never,
    installing: mocks.installing as never,
  }),
  isServiceKind: (kind?: string) => kind === 'basic-service' || kind === 'internal-business',
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({
    openSys: vi.fn(),
    openApp: vi.fn(),
    stopApp: vi.fn(),
    approveAndStart: vi.fn(),
  }),
}))

vi.mock('@/shell/composables/useAppUpdates', () => ({
  useAppUpdates: () => ({
    states: mocks.updateStates as never,
    check: mocks.check,
    applyUpdate: mocks.applyUpdate,
  }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import SysAppsView from '@/shell/sys/SysAppsView.vue'
import hostZhCN from '@/i18n/host-zh-CN'
import type { ShellAppEntry } from '@/shell/composables/useShellApps'

const PLUGIN_ID = 'com.wasmnest.test.app'

/** 可更新条目：manifest 声明 update + 非静态注册来源（SysAppsView.isUpdatable 判据） */
function updatableEntry(overrides: Partial<ShellAppEntry> = {}): ShellAppEntry {
  return {
    id: PLUGIN_ID,
    pluginId: PLUGIN_ID,
    name: 'App',
    version: '0.0.3',
    icon: 'grid',
    tone: 'system',
    state: 'dormant',
    pluginState: 'loaded',
    kind: 'business-app',
    source: 'user-installed',
    update: { provider: 'github-release', repo: 'wasmnest/apps' },
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
  mocks.updateStates = ref({})
  vi.clearAllMocks()
})

describe('应用管理：更新行版本号', () => {
  it('idle 时「检查更新」右侧也常显当前版本号（DOM 紧邻按钮之后）', () => {
    mocks.plugins.value = [updatableEntry()]
    const wrapper = mount(SysAppsView)

    const checkBtn = wrapper.get(`[data-testid="sys-apps-update-check-${PLUGIN_ID}"]`)
    const version = wrapper.get(`[data-testid="sys-apps-update-version-${PLUGIN_ID}"]`)
    expect(version.text()).toBe('v0.0.3')
    // 「右边」= 检查按钮的直接后继节点，而不是散落在卡片别处
    expect(checkBtn.element.nextElementSibling).toBe(version.element)
  })

  it('检查完成后版本号仍常显；「已是最新」文案不内嵌版本号（避免重复）', () => {
    mocks.plugins.value = [updatableEntry()]
    mocks.updateStates.value = { [PLUGIN_ID]: { status: 'up-to-date', currentVersion: '0.0.3' } }
    const wrapper = mount(SysAppsView)

    expect(wrapper.get(`[data-testid="sys-apps-update-version-${PLUGIN_ID}"]`).text()).toBe(
      'v0.0.3',
    )
    expect(wrapper.get(`[data-testid="sys-apps-update-status-${PLUGIN_ID}"]`).text()).toBe(
      'shell.apps.update.upToDate',
    )

    // 双语文案契约：版本号已由相邻节点承载，状态行不再要求 version 参数
    const zh = (hostZhCN as { shell: { apps: { update: { upToDate: string } } } }).shell.apps.update
      .upToDate
    expect(zh).not.toContain('{version}')
  })
})
