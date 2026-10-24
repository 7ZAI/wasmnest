/**
 * 移动壳「应用详情」系统服务守卫（manifest kind）
 *
 * 需求（spec `.scratch/2026-10-22-monitor-system-service` §3.2 / §3.3 + 2026-10-23 裁决）：
 * - 系统服务（L1/L2）不渲染卸载入口，即便数据源声明支持卸载；
 * - 系统服务显示自启开关（默认开由宿主 `isAutostart` 给出，UI 不伪造）；
 * - 切换自启写偏好：成功后更新本地态，失败不改（不制造「看起来开了」的假成功）；
 * - 系统服务的权限随包固定：权限清单只读呈现，**不渲染任何逐项开关**；
 * - 停止动作按 kind 分词语：服务说「停止服务」（`shell.detail.stopService`）。
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
  stopSpy: vi.fn(async () => {}),
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
    stop: (...args: unknown[]) => mocks.stopSpy(...args as []),
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
    // 带一条真实声明：服务仍展示权限清单，但不得渲染任何开关
    permissions: [{ key: 'metrics:read', granted: true }],
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

/** 找「停止」按钮（按 kind 文案定位；业务应用与服务的标签不同） */
function stopButton(wrapper: Awaited<ReturnType<typeof mountDetail>>) {
  return wrapper
    .findAll('button')
    .find((b) => b.text().includes('shell.detail.stopService') || b.text().includes('shell.detail.disable'))
}

/**
 * 挂载一个能记录 confirm 流的替换版 ConfirmDialog 桩：
 * 服务停止确认弹窗是否被打开（modelValue 变 true），以及确认后 emit confirm。
 */
async function mountDetailWithDialogStub() {
  const confirmModel = { value: false }
  const wrapper = mount(ShellAppDetailScreen, {
    global: {
      stubs: {
        ShellAppIcon: true,
        ConfirmDialog: {
          props: ['modelValue'],
          emits: ['update:modelValue', 'confirm'],
          template: `
            <div v-if="modelValue" class="dialog-stub">
              <button class="dialog-confirm" @click="$emit('confirm')">confirm</button>
              <button class="dialog-cancel" @click="$emit('update:modelValue', false)">cancel</button>
            </div>`,
        },
      },
    },
  })
  await flushPromises()
  return { wrapper, confirmModel }
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

/** 详情页全部开关（Toggle 一律渲染为 checkbox：自启 + 权限逐项） */
function allToggles(wrapper: Awaited<ReturnType<typeof mountDetail>>) {
  return wrapper.findAll('input[type="checkbox"]')
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
    expect(wrapper.text()).toContain('shell.detail.stopService')
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

  it('服务详情不渲染任何权限开关：清单只读 + 说明权限随包固定', async () => {
    const wrapper = await mountDetail()
    // 只剩自启一个开关；声明的 metrics:read 仍以只读行呈现（信息不隐藏）
    expect(allToggles(wrapper)).toHaveLength(1)
    expect(wrapper.text()).toContain('metrics:read')
    expect(wrapper.text()).toContain('shell.detail.permissionServiceFixed')
    expect(wrapper.text()).not.toContain('shell.detail.permissionUnsupported')
  })

  it('业务应用仍按权限逐项渲染开关（服务守卫不外溢）', async () => {
    mocks.params.value = { appId: 'com.wasmnest.file-transfer' }
    mocks.app = { ...businessApp(), permissions: [{ key: 'fs:write', granted: true }] }

    const wrapper = await mountDetail()
    expect(allToggles(wrapper)).toHaveLength(2)
    expect(wrapper.text()).toContain('shell.detail.permissionsNote')
    expect(wrapper.text()).not.toContain('shell.detail.permissionServiceFixed')
  })

  it('业务应用的停止按钮仍为「停用应用」', async () => {
    mocks.params.value = { appId: 'com.wasmnest.file-transfer' }
    mocks.app = businessApp()

    const wrapper = await mountDetail()
    expect(wrapper.text()).toContain('shell.detail.disable')
    expect(wrapper.text()).not.toContain('shell.detail.stopService')
  })
})

describe('系统服务停止：先弹确认，确认后才停（业务应用直停）', () => {
  it('服务点「停止服务」→ 弹确认，不直接停止', async () => {
    const { wrapper } = await mountDetailWithDialogStub()
    const btn = stopButton(wrapper)
    expect(btn).toBeDefined()
    await btn!.trigger('click')
    await flushPromises()

    expect(mocks.stopSpy).not.toHaveBeenCalled()
    expect(wrapper.find('.dialog-stub').exists(), '服务停止必须先弹确认弹窗').toBe(true)
  })

  it('确认 → 才执行 stop(appId)', async () => {
    const { wrapper } = await mountDetailWithDialogStub()
    await stopButton(wrapper)!.trigger('click')
    await flushPromises()

    await wrapper.find('.dialog-confirm').trigger('click')
    await flushPromises()

    expect(mocks.stopSpy).toHaveBeenCalledTimes(1)
    expect(mocks.stopSpy).toHaveBeenCalledWith('com.wasmnest.monitor')
  })

  it('取消 → 不执行 stop', async () => {
    const { wrapper } = await mountDetailWithDialogStub()
    await stopButton(wrapper)!.trigger('click')
    await flushPromises()

    await wrapper.find('.dialog-cancel').trigger('click')
    await flushPromises()

    expect(mocks.stopSpy).not.toHaveBeenCalled()
    expect(wrapper.find('.dialog-stub').exists()).toBe(false)
  })

  it('业务应用点「停用应用」→ 直接停止，不弹确认', async () => {
    mocks.params.value = { appId: 'com.wasmnest.file-transfer' }
    mocks.app = businessApp()

    const { wrapper } = await mountDetailWithDialogStub()
    await stopButton(wrapper)!.trigger('click')
    await flushPromises()

    expect(mocks.stopSpy).toHaveBeenCalledTimes(1)
    expect(mocks.stopSpy).toHaveBeenCalledWith('com.wasmnest.file-transfer')
    expect(wrapper.find('.dialog-stub').exists()).toBe(false)
  })
})
