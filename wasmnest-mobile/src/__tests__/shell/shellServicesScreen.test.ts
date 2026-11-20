/**
 * 服务管理屏（移动壳）行为锁
 *
 * 2026-11-20：服务型 wasm（basic-service / internal-business）迁入独立服务管理屏。
 * 契约：只列服务（L1 → L2 → 名称）；点服务卡 = 进入对应运行入口（经 useShellOpen，
 * 待审批转详情由 open 内部处理）；右侧另有管理入口进详情页；空清单出空态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'

const mocks = vi.hoisted(() => ({
  apps: null as unknown as ReturnType<typeof ref>,
  open: vi.fn(async () => true),
  openDetail: vi.fn(),
  back: vi.fn(),
}))

vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({ sortedApps: computed(() => mocks.apps.value) }),
}))
vi.mock('@/shell/composables/useShellOpen', () => ({ useShellOpen: () => ({ open: mocks.open }) }))
vi.mock('@/shell/composables/useShellNavigation', () => ({
  useShellNavigation: () => ({ openDetail: mocks.openDetail, back: mocks.back }),
}))
vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import ShellServicesScreen from '@/shell/components/screens/ShellServicesScreen.vue'
import type { ShellApp } from '@/shell/types'

function app(id: string, kind: string, state: ShellApp['state'] = 'dormant'): ShellApp {
  return {
    id,
    name: id,
    version: '1.0.0',
    state,
    kind,
    permissions: [],
    contributions: {},
  }
}

function mountScreen() {
  return mount(ShellServicesScreen, { global: { stubs: { ShellAppIcon: true } } })
}

beforeEach(() => {
  mocks.apps = ref([])
  mocks.open.mockClear()
  mocks.openDetail.mockClear()
  mocks.back.mockClear()
})

describe('移动壳服务管理', () => {
  it('只列服务：L1 basic-service → L2 internal-business → 名称', () => {
    mocks.apps.value = [
      app('com.wasmnest.bedcode', 'business-app'),
      app('com.wasmnest.monitor', 'internal-business'),
      app('com.wasmnest.auth-center', 'basic-service'),
      app('com.wasmnest.speech', 'internal-business'),
    ]

    const wrapper = mountScreen()
    const text = wrapper.text()
    expect(text).not.toContain('com.wasmnest.bedcode')
    expect(text.indexOf('com.wasmnest.auth-center')).toBeLessThan(text.indexOf('com.wasmnest.monitor'))
    expect(text.indexOf('com.wasmnest.monitor')).toBeLessThan(text.indexOf('com.wasmnest.speech'))
    expect(wrapper.findAll('[data-testid^="mobile-shell-services-card-"]')).toHaveLength(3)
  })

  it('点服务卡 = 打开对应服务（open(appId)）', async () => {
    mocks.apps.value = [app('com.wasmnest.monitor', 'internal-business')]

    const wrapper = mountScreen()
    const card = wrapper.find('[data-testid="mobile-shell-services-card-com.wasmnest.monitor"]')
    await card.find('button[aria-label^="shell.services.open"]').trigger('click')
    expect(mocks.open).toHaveBeenCalledWith('com.wasmnest.monitor')
  })

  it('右侧管理入口进详情页（停止 / 权限沿用详情页）', async () => {
    mocks.apps.value = [app('com.wasmnest.monitor', 'internal-business')]

    const wrapper = mountScreen()
    const card = wrapper.find('[data-testid="mobile-shell-services-card-com.wasmnest.monitor"]')
    await card.find('button[aria-label^="shell.services.detail"]').trigger('click')
    expect(mocks.openDetail).toHaveBeenCalledWith('com.wasmnest.monitor')
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('运行中计数只数 running 服务', () => {
    mocks.apps.value = [
      app('com.wasmnest.monitor', 'internal-business', 'running'),
      app('com.wasmnest.speech', 'internal-business', 'dormant'),
    ]

    const wrapper = mountScreen()
    expect(wrapper.text()).toContain('shell.apps.statRunning')
    const nums = wrapper.findAll('b.tabular-nums').map((n) => n.text())
    expect(nums).toEqual(['2', '1'])
  })

  it('空清单 → 空态，不渲染服务卡', () => {
    const wrapper = mountScreen()
    expect(wrapper.text()).toContain('shell.services.empty')
    expect(wrapper.findAll('[data-testid^="mobile-shell-services-card-"]')).toHaveLength(0)
  })
})
