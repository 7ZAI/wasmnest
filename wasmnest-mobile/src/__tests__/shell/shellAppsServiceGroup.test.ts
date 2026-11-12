/**
 * 移动壳「应用管理」系统服务区（manifest kind 分组）行为锁
 *
 * 需求（spec `.scratch/2026-10-22-monitor-system-service` §3 + 2026-10-23 排序裁决）：
 * 系统服务区由 **manifest kind** 判定（L1 basic-service / L2 internal-business），
 * 不硬编码 id；业务应用在前、服务在后（服务内部按 L1 → L2 → 名称）；
 * 没有服务 / 没有应用时不渲染空分区；点行仍进详情页（详情页负责隐藏卸载入口）。
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
    stats: ref({ installed: 0, running: 0, totalBytes: undefined }),
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

/** 分组标题（testid 由分组 id 拼出；空分区不渲染） */
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

describe('移动壳应用管理的系统服务区', () => {
  it('应用区在前；服务区在后、按 L1 → L2 → 名称（不依赖数据源顺序）', () => {
    mocks.apps.value = [
      app({ id: 'com.wasmnest.bedcode', name: 'Zed App' }),
      app({ id: 'com.wasmnest.monitor', name: 'Monitor', kind: 'internal-business' }),
      app({ id: 'com.wasmnest.auth-center', name: 'Auth Center', kind: 'basic-service' }),
    ]

    const wrapper = mountScreen()
    expect(groupTitles(wrapper)).toEqual([
      'shell.apps.businessApps',
      'shell.apps.systemServices',
    ])

    const text = wrapper.text()
    expect(text.indexOf('Zed App')).toBeLessThan(text.indexOf('Auth Center'))
    expect(text.indexOf('Auth Center')).toBeLessThan(text.indexOf('Monitor'))
  })

  it('没有系统服务时不渲染服务分区（不留空标题）', () => {
    mocks.apps.value = [app({ id: 'com.wasmnest.app-a', name: 'App A' })]

    const wrapper = mountScreen()
    expect(groupTitles(wrapper)).toEqual(['shell.apps.businessApps'])
  })

  it('全部是系统服务时不渲染业务应用分区', () => {
    mocks.apps.value = [
      app({ id: 'com.wasmnest.auth-center', name: 'Auth Center', kind: 'basic-service' }),
    ]

    const wrapper = mountScreen()
    expect(groupTitles(wrapper)).toEqual(['shell.apps.systemServices'])
  })

  it('空清单 → 只有空态，不渲染任何分区', () => {
    const wrapper = mountScreen()
    expect(groupTitles(wrapper)).toEqual([])
    expect(wrapper.text()).toContain('shell.apps.empty')
  })

  it('点服务行仍进详情页（卸载入口由详情页按 kind 隐藏）', async () => {
    mocks.apps.value = [
      app({ id: 'com.wasmnest.monitor', name: 'Monitor', kind: 'internal-business' }),
    ]

    const wrapper = mountScreen()
    const row = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Monitor'))

    expect(row).toBeTruthy()
    await row!.trigger('click')
    expect(mocks.openDetail).toHaveBeenCalledWith('com.wasmnest.monitor')
  })
})
