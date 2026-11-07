/**
 * 桌面壳「卸载确认」弹窗行为锁（2026-11-06）
 *
 * 契约（真源 = ShellDialogLayer uninstall 分支 + useShellState.uninstallApp）：
 * - 应用数据缺省删除（checkbox 未勾选）；勾选 = 保留私有库 / KV；
 * - 确认一律把选择传给状态层（uninstallApp(id, keepData)），不做第二套卸载逻辑。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  dialog: { value: null as string | null },
  dialogAppId: { value: null as string | null },
  installTarget: { value: null as { path: string; pluginId: string } | null },
  quitting: { value: false },
  uninstallApp: vi.fn(() => Promise.resolve()),
  appOf: vi.fn((id: string) => ({
    id,
    pluginId: id,
    name: 'Demo App',
    permissions: [] as string[],
  })),
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({
    dialog: mocks.dialog,
    dialogAppId: mocks.dialogAppId,
    installTarget: mocks.installTarget,
    quitInProgress: mocks.quitting,
    uninstallApp: mocks.uninstallApp,
  }),
}))

vi.mock('@/shell/composables/useShellApps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shell/composables/useShellApps')>()
  return {
    ...actual,
    useShellApps: () => ({
      busyId: { value: null },
      installing: { value: false },
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

const APP_ID = 'com.wasmnest.demo'

function mountLayer() {
  mocks.dialog.value = 'uninstall'
  mocks.dialogAppId.value = APP_ID
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
  mocks.installTarget.value = null
  mocks.uninstallApp.mockReset()
  mocks.uninstallApp.mockResolvedValue(undefined)
})

describe('ShellDialogLayer：卸载确认', () => {
  it('缺省删除应用数据；确认传 keepData=false', async () => {
    const wrapper = mountLayer()
    const checkbox = wrapper.find('input[type="checkbox"]')
    expect(checkbox.exists(), '保留数据勾选项必须在位').toBe(true)
    expect((checkbox.element as HTMLInputElement).checked).toBe(false)

    await buttonByText(wrapper, 'shell.dialog.uninstall.confirm')!.trigger('click')
    await flushPromises()

    expect(mocks.uninstallApp).toHaveBeenCalledWith(APP_ID, false)
  })

  it('勾选保留 → 确认传 keepData=true（保留应用数据）', async () => {
    const wrapper = mountLayer()
    const checkbox = wrapper.find('input[type="checkbox"]')
    await checkbox.setValue(true)

    await buttonByText(wrapper, 'shell.dialog.uninstall.confirm')!.trigger('click')
    await flushPromises()

    expect(mocks.uninstallApp).toHaveBeenCalledWith(APP_ID, true)
  })
})
