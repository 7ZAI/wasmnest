/**
 * 桌面壳「服务停止确认」弹窗行为锁
 *
 * 需求（2026-10-25 用户缺陷报告）：应用管理页系统服务「停止服务」确认弹窗，
 * 点击停止且停用**成功**后必须自动收起——此前只调 stopApp，弹窗永久停在
 * 屏上（服务已停却仍显示运行态确认面）；停用失败时保留确认面供重试 / 取消
 * （失败提示由 showUserError 统一发出，ADR 0030）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  dialog: { value: null as string | null },
  dialogAppId: { value: null as string | null },
  busyId: { value: null as string | null },
  stopApp: vi.fn(() => Promise.resolve(true)),
  appOf: vi.fn((id: string) => ({
    id,
    pluginId: id,
    name: 'Monitor',
    permissions: [] as string[],
  })),
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({
    dialog: mocks.dialog,
    dialogAppId: mocks.dialogAppId,
    stopApp: mocks.stopApp,
  }),
}))

vi.mock('@/shell/composables/useShellApps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shell/composables/useShellApps')>()
  return {
    ...actual,
    useShellApps: () => ({
      busyId: mocks.busyId,
      appOf: mocks.appOf,
      plugins: { value: [] },
    }),
  }
})

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => null }))

import ShellDialogLayer from '@/shell/components/ShellDialogLayer.vue'

const MONITOR_ID = 'com.wasmnest.monitor'

/** 打开服务停止确认弹窗（关联系统服务；dialogAppId 是真实生命周期的目标） */
function openStopServiceDialog(appId: string | null = MONITOR_ID): void {
  mocks.dialog.value = 'stop-service'
  mocks.dialogAppId.value = appId
}

function mountLayer() {
  return mount(ShellDialogLayer, {
    global: { stubs: { teleport: true, ShellIcon: true } },
  })
}

function buttonByText(wrapper: ReturnType<typeof mountLayer>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(text))
}

beforeEach(() => {
  mocks.dialog.value = null
  mocks.dialogAppId.value = null
  mocks.busyId.value = null
  mocks.stopApp.mockReset()
  mocks.stopApp.mockResolvedValue(true)
})

describe('ShellDialogLayer：服务停止确认', () => {
  it('确认停止且停用成功 → 收起弹窗并清掉关联应用', async () => {
    openStopServiceDialog()
    const wrapper = mountLayer()

    const confirm = buttonByText(wrapper, 'shell.dialog.stopService.confirm')
    expect(confirm, '确认按钮必须在位').toBeDefined()
    await confirm!.trigger('click')
    await flushPromises()

    expect(mocks.stopApp).toHaveBeenCalledTimes(1)
    expect(mocks.stopApp).toHaveBeenCalledWith(MONITOR_ID)
    expect(mocks.dialog.value, '停止成功后弹窗必须自动收起').toBeNull()
    expect(mocks.dialogAppId.value).toBeNull()
  })

  it('停用失败 → 弹窗保留（服务仍在运行，用户可重试 / 取消）', async () => {
    mocks.stopApp.mockResolvedValueOnce(false)
    openStopServiceDialog()
    const wrapper = mountLayer()

    await buttonByText(wrapper, 'shell.dialog.stopService.confirm')!.trigger('click')
    await flushPromises()

    expect(mocks.stopApp).toHaveBeenCalledWith(MONITOR_ID)
    expect(mocks.dialog.value).toBe('stop-service')
    expect(mocks.dialogAppId.value).toBe(MONITOR_ID)
  })

  it('取消 → 只收起弹窗，不触发停止', async () => {
    openStopServiceDialog()
    const wrapper = mountLayer()

    await buttonByText(wrapper, 'shell.dialog.cancel')!.trigger('click')
    await flushPromises()

    expect(mocks.stopApp).not.toHaveBeenCalled()
    expect(mocks.dialog.value).toBeNull()
  })

  it('无关联应用（dialogAppId 为空）→ 确认不发命令（防无目标停用）', async () => {
    openStopServiceDialog(null)
    const wrapper = mountLayer()

    await buttonByText(wrapper, 'shell.dialog.stopService.confirm')!.trigger('click')
    await flushPromises()

    expect(mocks.stopApp).not.toHaveBeenCalled()
    expect(mocks.dialog.value).toBe('stop-service')
  })
})
