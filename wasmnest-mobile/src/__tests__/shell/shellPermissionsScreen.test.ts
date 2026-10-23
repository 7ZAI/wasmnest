/**
 * 权限总览：系统服务不参与授权（manifest kind L1/L2）
 *
 * 需求（2026-10-23 用户裁决）：系统服务 wasm 不需要授权，权限页的
 * 「按应用 / 按权限」两个视图、待审批分区与空态都不得出现系统服务；
 * 业务应用照常展示。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { ShellApp, ShellPermissionGrant } from '@/shell/types'

const mocks = vi.hoisted(() => ({
  apps: null as unknown as Ref<ShellApp[]>,
  openDetail: vi.fn(),
}))

vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    apps: mocks.apps,
    approveApp: vi.fn(async () => true),
    launch: vi.fn(async () => true),
  }),
}))

vi.mock('@/shell/composables/useShellNavigation', () => ({
  useShellNavigation: () => ({
    params: ref({}),
    back: vi.fn(),
    openDetail: mocks.openDetail,
    openApp: vi.fn(),
  }),
}))

vi.mock('@/shell/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import ShellPermissionsScreen from '@/shell/components/screens/ShellPermissionsScreen.vue'

function grant(key: string, granted = true): ShellPermissionGrant {
  return { key, granted }
}

function app(
  id: string,
  name: string,
  overrides: Partial<ShellApp> & { permissions?: ShellPermissionGrant[] } = {},
): ShellApp {
  return {
    id,
    name,
    version: '1.0.0',
    state: 'disabled',
    permissions: [],
    contributions: {},
    ...overrides,
  }
}

function mountScreen() {
  return mount(ShellPermissionsScreen, {
    global: { stubs: { ShellAppIcon: true } },
  })
}

function clickViewToggle(wrapper: ReturnType<typeof mountScreen>, key: string): Promise<void> {
  const button = wrapper.findAll('button').find((b) => b.text().includes(key))
  if (!button) throw new Error(`missing view toggle ${key}`)
  return button.trigger('click')
}

beforeEach(() => {
  mocks.apps = ref([])
  vi.clearAllMocks()
})

describe('权限总览：系统服务不参与授权', () => {
  it('按应用视图：系统服务不渲染，业务应用照常渲染', () => {
    mocks.apps.value = [
      app('com.wasmnest.monitor', 'Monitor', {
        kind: 'internal-business',
        permissions: [grant('metrics:read')],
      }),
      app('com.wasmnest.auth-center', 'Auth Center', {
        kind: 'basic-service',
        permissions: [grant('network:http')],
      }),
      app('com.wasmnest.bedcode', 'BedCode', {
        kind: 'business-app',
        permissions: [grant('fs:read')],
      }),
    ]

    const wrapper = mountScreen()
    const text = wrapper.text()

    expect(text).toContain('BedCode')
    expect(text).not.toContain('Monitor')
    expect(text).not.toContain('Auth Center')
  })

  it('按权限视图：系统服务持有的权限词不出现，业务应用照常反查', async () => {
    mocks.apps.value = [
      app('com.wasmnest.monitor', 'Monitor', {
        kind: 'internal-business',
        permissions: [grant('svc:only')],
      }),
      app('com.wasmnest.bedcode', 'BedCode', {
        kind: 'business-app',
        permissions: [grant('fs:read')],
      }),
    ]

    const wrapper = mountScreen()
    await clickViewToggle(wrapper, 'shell.permissions.viewGroups')

    expect(wrapper.text()).toContain('fs:read')
    expect(wrapper.text()).not.toContain('svc:only')
    expect(wrapper.text()).not.toContain('Monitor')
  })

  it('待审批分区：系统服务不进审批列表，业务应用照常', () => {
    mocks.apps.value = [
      app('com.wasmnest.monitor', 'Monitor', {
        kind: 'internal-business',
        state: 'approval',
        permissions: [grant('metrics:read')],
      }),
      app('com.wasmnest.bedcode', 'BedCode', {
        kind: 'business-app',
        state: 'approval',
        permissions: [grant('fs:read')],
      }),
    ]

    const wrapper = mountScreen()
    const text = wrapper.text()

    expect(text).toContain('shell.permissions.pending')
    expect(text).toContain('BedCode')
    expect(text).not.toContain('Monitor')
  })

  it('只有系统服务：两个视图都落空态，不误报有可管理应用', async () => {
    mocks.apps.value = [
      app('com.wasmnest.monitor', 'Monitor', {
        kind: 'internal-business',
        permissions: [grant('metrics:read')],
      }),
    ]

    const wrapper = mountScreen()
    expect(wrapper.text()).toContain('mobile.plugin.noPermissions')
    expect(wrapper.text()).not.toContain('Monitor')

    await clickViewToggle(wrapper, 'shell.permissions.viewGroups')
    expect(wrapper.text()).toContain('mobile.plugin.noPermissions')
    expect(wrapper.text()).not.toContain('metrics:read')
  })
})
