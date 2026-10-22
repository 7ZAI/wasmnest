/**
 * 移动壳「应用详情」系统服务守卫（manifest kind）
 *
 * 需求（spec `.scratch/2026-10-22-monitor-system-service` §3.2 / §3.3）：
 * - 系统服务（L1/L2）不渲染卸载入口，即便数据源声明支持卸载；
 * - 系统服务显示自启开关（默认开由宿主 `isAutostart` 给出，UI 不伪造）；
 * - 切换自启写偏好：成功后更新本地态，失败不改（不制造「看起来开了」的假成功）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { ref } from 'vue'
import type { ShellApp } from '@/shell/types'

const mocks = vi.hoisted(() => ({
  params: null as unknown as Ref<Record<string, unknown>>,
  app: null as unknown as ShellApp | null,
  supportsRemove: true,
  supportsAutostart: true,
  autostartValue: true,
  autostartSetOk: true,
  setAutostart: vi.fn(async () => true),
  back: vi.fn(),
  openApp: vi.fn(),
}))

vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    getApp: () => mocks.app,
    supportsPermissionControl: () => false,
    setPermissionGrant: vi.fn(async () => true),
    supportsRemove: () => mocks.supportsRemove,
    removeApp: vi.fn(async () => true),
    supportsAutostart: () => mocks.supportsAutostart,
    isAutostart: async () => mocks.autostartValue,
    setAutostart: (...args: unknown[]) => mocks.setAutostart(...args as []),
    stop: vi.fn(async () => {}),
    approveApp: vi.fn(async () => {}),
    launch: vi.fn(async () => {}),
  }),
}))

vi.mock('@/shell/composables/useShellNavigation', () => ({
  useShellNavigation: () => ({
    params: mocks.params,
    back: mocks.back,
    openApp: mocks.openApp,
  }),
}))

vi.mock('@/shell/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import ShellAppDetailScreen from '@/shell/components/screens/ShellAppDetailScreen.vue'

function serviceApp(kind = 'internal-business'): ShellApp {
  return {
    id: 'com.wasmnest.monitor',
    name: 'Monitor',
    version: '0.1.0',
    state: 'disabled',
    kind,
    permissions: [],
    contributions: {},
  }
}

function businessApp(): ShellApp {
  return {
    id: 'com.wasmnest.file-transfer',
    name: 'File Transfer',
    version: '0.1.0',
    state: 'disabled',
    kind: 'business-app',
    permissions: [],
    contributions: {},
  }
}

async function mountDetail() {
  const wrapper = mount(ShellAppDetailScreen, {
    global: { stubs: { ShellAppIcon: true, ConfirmDialog: true } },
  })
  await flushPromises()
  return wrapper
}

/** 自启开关（Toggle 渲染为 checkbox；按文案定位所属分组） */
function autostartCheckbox(wrapper: Awaited<ReturnType<typeof mountDetail>>) {
  const headings = wrapper.findAll('h2')
  const section = headings.find((h) => h.text() === 'shell.apps.autostart')
  if (!section) return null
  // ShellSection 是标题行；开关在紧随其后的分组卡里
  const group = section.element.parentElement?.parentElement?.nextElementSibling
  return group ? wrapper.findAll('input[type="checkbox"]').find((el) => group.contains(el.element)) ?? null : null
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.params = ref({ appId: 'com.wasmnest.monitor' })
  mocks.app = serviceApp()
  mocks.supportsRemove = true
  mocks.supportsAutostart = true
  mocks.autostartValue = true
  mocks.autostartSetOk = true
  mocks.setAutostart.mockImplementation(async () => mocks.autostartSetOk)
})

describe('系统服务详情：不可卸载 + 自启可关', () => {
  it('服务不渲染卸载入口（即便数据源声明可卸载）', async () => {
    const wrapper = await mountDetail()
    expect(wrapper.text()).not.toContain('shell.detail.uninstall')
    expect(wrapper.text()).toContain('shell.detail.disable')
  })

  it('业务应用仍渲染卸载入口', async () => {
    mocks.params.value = { appId: 'com.wasmnest.file-transfer' }
    mocks.app = businessApp()

    const wrapper = await mountDetail()
    expect(wrapper.text()).toContain('shell.detail.uninstall')
  })

  it('服务显示自启开关并反映宿主偏好（默认开）', async () => {
    const wrapper = await mountDetail()
    const checkbox = autostartCheckbox(wrapper)
    expect(checkbox, '服务详情必须显示自启开关').not.toBeNull()
    expect((checkbox!.element as HTMLInputElement).checked).toBe(true)
  })

  it('关闭自启 → 写偏好 (id, false)，成功后开关变关', async () => {
    const wrapper = await mountDetail()
    const checkbox = autostartCheckbox(wrapper)
    expect(checkbox).not.toBeNull()

    await checkbox!.trigger('change')
    await flushPromises()

    expect(mocks.setAutostart).toHaveBeenCalledWith('com.wasmnest.monitor', false)
    expect((autostartCheckbox(wrapper)!.element as HTMLInputElement).checked).toBe(false)
  })

  it('写偏好失败 → 开关回到真实偏好，不伪造成功', async () => {
    mocks.autostartSetOk = false
    const wrapper = await mountDetail()
    const checkbox = autostartCheckbox(wrapper)

    await checkbox!.trigger('change')
    await flushPromises()

    expect(mocks.setAutostart).toHaveBeenCalledWith('com.wasmnest.monitor', false)
    expect((autostartCheckbox(wrapper)!.element as HTMLInputElement).checked).toBe(true)
  })

  it('数据源不支持自启 → 不渲染自启分区（不显示点了没反应的开关）', async () => {
    mocks.supportsAutostart = false

    const wrapper = await mountDetail()
    expect(wrapper.text()).not.toContain('shell.apps.autostart')
  })
})
