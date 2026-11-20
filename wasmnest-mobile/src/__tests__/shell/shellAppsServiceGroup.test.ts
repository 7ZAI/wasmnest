/**
 * 移动壳「应用管理」服务迁移锁
 *
 * 2026-11-20：服务型 wasm（basic-service / internal-business）从应用管理全量迁往
 * 「服务管理」屏，主屏服务宫格同步撤除。本锁守住应用管理只投影业务应用：
 * 不出现服务、不出现服务分组标题；服务自身行为由 shellServicesScreen.test.ts 覆盖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { ref } from 'vue'

const mocks = vi.hoisted(() => ({
  apps: null as unknown as Ref<unknown[]>,
  openDetail: vi.fn(),
  refresh: vi.fn(async () => {}),
  installFromLocalPackage: vi.fn(async () => null),
  installSupported: false,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    sortedApps: mocks.apps as never,
    supportsInstall: () => mocks.installSupported,
    installFromLocalPackage: mocks.installFromLocalPackage,
    refresh: mocks.refresh,
  }),
}))

vi.mock('@/shell/composables/useShellNavigation', () => ({
  useShellNavigation: () => ({ openDetail: mocks.openDetail }),
}))

vi.mock('@/shell/composables/useToast', () => ({
  useToast: () => ({ success: mocks.toastSuccess, error: mocks.toastError }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import ShellAppsScreen from '@/shell/components/screens/ShellAppsScreen.vue'
import type { ShellApp } from '@/shell/types'

function app(overrides: Partial<ShellApp> & { id: string }): ShellApp {
  return {
    name: overrides.id,
    version: '1.0.0',
    state: 'disabled',
    permissions: [],
    contributions: {},
    ...overrides,
  }
}

function mountScreen() {
  return mount(ShellAppsScreen, { global: { stubs: { ShellAppIcon: true } } })
}

/** 残留的分组标题（服务迁出后应为 0 个） */
function groupTitles(wrapper: ReturnType<typeof mountScreen>): string[] {
  return wrapper.findAll('[data-testid^="mobile-shell-apps-group-"]').map((n) => n.text())
}

beforeEach(() => {
  mocks.apps = ref([])
  mocks.installSupported = false
  vi.clearAllMocks()
})

describe('添加应用', () => {
  it('不显示「需审批」提示，只在安装中给出加载文案', () => {
    mocks.installSupported = true
    const wrapper = mountScreen()

    expect(wrapper.text()).toContain('shell.apps.installLocal')
    expect(wrapper.text(), '空闲态不再显示审批要求').not.toContain('shell.apps.installLocalHint')
    expect(wrapper.text()).not.toContain('需审批')
    expect(wrapper.text(), '非安装中不显示加载文案').not.toContain('shell.common.loading')
  })
})

describe('移动壳应用管理只列业务应用（服务已迁入服务管理）', () => {
  it('服务不出现在应用管理（判据是 kind，不硬编码 id）', () => {
    mocks.apps.value = [
      app({ id: 'com.wasmnest.bedcode', name: 'Zed App' }),
      app({ id: 'com.wasmnest.monitor', name: 'Monitor', kind: 'internal-business' }),
      app({ id: 'com.wasmnest.auth-center', name: 'Auth Center', kind: 'basic-service' }),
    ]

    const wrapper = mountScreen()
    const text = wrapper.text()
    expect(text).toContain('Zed App')
    expect(text).not.toContain('Monitor')
    expect(text).not.toContain('Auth Center')
    expect(groupTitles(wrapper)).toEqual([])
  })

  it('只有服务时应用管理为空态（不渲染服务行）', () => {
    mocks.apps.value = [
      app({ id: 'com.wasmnest.auth-center', name: 'Auth Center', kind: 'basic-service' }),
    ]

    const wrapper = mountScreen()
    expect(wrapper.text()).not.toContain('Auth Center')
    expect(groupTitles(wrapper)).toEqual([])
    expect(wrapper.text()).toContain('shell.apps.empty')
  })

  it('空清单 → 只有空态，不渲染任何分区', () => {
    const wrapper = mountScreen()
    expect(groupTitles(wrapper)).toEqual([])
    expect(wrapper.text()).toContain('shell.apps.empty')
  })

  it('指标只数业务应用：服务的数量与占用不进「已安装 / 运行中 / 占用」', () => {
    mocks.apps.value = [
      app({ id: 'com.wasmnest.bedcode', name: 'BedCode', state: 'running', sizeBytes: 2048 }),
      app({
        id: 'com.wasmnest.monitor',
        name: 'Monitor',
        kind: 'internal-business',
        state: 'running',
        sizeBytes: 4096,
      }),
    ]

    const wrapper = mountScreen()
    const nums = wrapper.findAll('b.tabular-nums').map((n) => n.text())
    // 1 个业务应用 / 1 个运行中 / 2.0 KB（只算 BedCode；服务 Monitor 不计入）
    expect(nums).toEqual(['1', '1', '2.0 KB'])
  })

  it('任一业务应用未统计占用时显示「—」，不把缺失值当 0 累加', () => {
    mocks.apps.value = [
      app({ id: 'com.wasmnest.bedcode', name: 'BedCode', sizeBytes: 2048 }),
      app({ id: 'com.wasmnest.ai-chatbox', name: 'AI Chatbox' }),
    ]

    const wrapper = mountScreen()
    expect(wrapper.findAll('b.tabular-nums').map((n) => n.text())).toEqual(['2', '0', 'shell.common.na'])
  })
})
