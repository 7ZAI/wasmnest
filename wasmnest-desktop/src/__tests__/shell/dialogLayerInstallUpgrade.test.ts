/**
 * 桌面壳「安装升级确认」弹窗行为锁（2026-10-28）
 *
 * 契约（真源 = ShellDialogLayer install-upgrade 分支 + useShellState.confirmInstallUpgrade）：
 * - 安装外部应用包命中已装同 id（user-installed、未运行）时先进本弹窗，
 *   确认 = confirmInstallUpgrade（就地升级保数据；新装不经弹窗）；
 * - 升级成功收起弹窗并清 installTarget；失败保留确认面供重试 / 取消；
 * - 取消只收弹窗，不触发升级。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  dialog: { value: null as string | null },
  dialogAppId: { value: null as string | null },
  installTarget: { value: null as { path: string; pluginId: string } | null },
  installing: { value: false },
  confirmInstallUpgrade: vi.fn(() => Promise.resolve()),
  appOf: vi.fn((id: string) => ({
    id,
    pluginId: id,
    name: 'Third Party',
    permissions: [] as string[],
  })),
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({
    dialog: mocks.dialog,
    dialogAppId: mocks.dialogAppId,
    installTarget: mocks.installTarget,
    confirmInstallUpgrade: mocks.confirmInstallUpgrade,
  }),
}))

vi.mock('@/shell/composables/useShellApps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shell/composables/useShellApps')>()
  return {
    ...actual,
    useShellApps: () => ({
      busyId: { value: null },
      installing: mocks.installing,
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

const APP_ID = 'com.wasmnest.third-party'

function openUpgradeDialog(): void {
  mocks.dialog.value = 'install-upgrade'
  mocks.dialogAppId.value = APP_ID
  mocks.installTarget.value = { path: '/tmp/pkg.zip', pluginId: APP_ID }
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
  mocks.installTarget.value = null
  mocks.installing.value = false
  mocks.confirmInstallUpgrade.mockReset()
  mocks.confirmInstallUpgrade.mockResolvedValue(undefined)
})

describe('ShellDialogLayer：安装升级确认', () => {
  it('确认升级 → 走 confirmInstallUpgrade 编排（就地升级的裁决在状态层）', async () => {
    openUpgradeDialog()
    const wrapper = mountLayer()

    const confirm = buttonByText(wrapper, 'shell.dialog.installUpgrade.confirm')
    expect(confirm, '升级确认按钮必须在位').toBeDefined()
    await confirm!.trigger('click')
    await flushPromises()

    expect(mocks.confirmInstallUpgrade).toHaveBeenCalledTimes(1)
  })

  it('升级进行中（installing）→ 确认按钮禁用', () => {
    openUpgradeDialog()
    mocks.installing.value = true
    const wrapper = mountLayer()

    const confirm = buttonByText(wrapper, 'shell.dialog.installUpgrade.confirm')
    expect(confirm!.attributes('disabled')).toBeDefined()
  })

  it('取消 → 只收弹窗并作废选包目标，不触发升级', async () => {
    openUpgradeDialog()
    const wrapper = mountLayer()

    await buttonByText(wrapper, 'shell.dialog.cancel')!.trigger('click')
    await flushPromises()

    expect(mocks.confirmInstallUpgrade).not.toHaveBeenCalled()
    expect(mocks.dialog.value).toBeNull()
    expect(mocks.installTarget.value, '选包目标必须随取消作废').toBeNull()
  })

  it('确认动作一律委托状态层（无选包目标的守卫在 confirmInstallUpgrade 内部）', async () => {
    mocks.dialog.value = 'install-upgrade'
    mocks.dialogAppId.value = APP_ID
    const wrapper = mountLayer()

    await buttonByText(wrapper, 'shell.dialog.installUpgrade.confirm')!.trigger('click')
    await flushPromises()

    expect(mocks.confirmInstallUpgrade).toHaveBeenCalledTimes(1)
  })
})
