/**
 * 桌面壳退出确认弹窗行为锁（2026-11-05 用户缺陷）
 *
 * 缺陷：存活 PTY 时宿主 session-guard 会 `prevent_close()` 并广播
 * `window-close-requested`；旧实现点「仍然退出」调 `getCurrentWindow().close()`，
 * 又被同一守卫拦截 → 反复弹确认面、应用无法退出（runtime 日志里同一秒数条
 * "Window close prevented: live PTYs exist"）。
 *
 * 契约（真源 = ShellDialogLayer + commands::confirm_window_close）：
 * - 主窗口监听 `window-close-requested` 并打开退出确认面；
 * - 确认 = invoke('confirm_window_close')（宿主整进程 exit），不得再走 window.close()；
 * - 独立终端窗口（bareWindow）不消费退出确认事件。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  dialog: { value: null as string | null },
  dialogAppId: { value: null as string | null },
  quitInProgress: { value: false },
  installTarget: { value: null as unknown },
  plugins: { value: [] as Array<{ id: string; name?: string; state: string; kind?: string }> },
  windowLabel: 'main',
  closeHandler: null as ((event: { payload: unknown }) => void) | null,
  unlisten: vi.fn(),
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.closeHandler = handler
    return mocks.unlisten
  }),
  invoke: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: mocks.windowLabel }),
}))
vi.mock('@/utils/frontendLogger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/utils/appCommands', () => ({
  ensureHostCredential: vi.fn(async () => 'test-host-credential'),
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({
    dialog: mocks.dialog,
    dialogAppId: mocks.dialogAppId,
    quitInProgress: mocks.quitInProgress,
    installTarget: mocks.installTarget,
  }),
}))

vi.mock('@/shell/composables/useShellApps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shell/composables/useShellApps')>()
  return {
    ...actual,
    useShellApps: () => ({
      plugins: mocks.plugins,
      appOf: () => undefined,
      busyId: { value: null },
      installing: { value: false },
    }),
  }
})

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import ShellDialogLayer from '@/shell/components/ShellDialogLayer.vue'

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
  mocks.quitInProgress.value = false
  mocks.installTarget.value = null
  mocks.plugins.value = []
  mocks.windowLabel = 'main'
  mocks.closeHandler = null
  mocks.listen.mockClear()
  mocks.unlisten.mockClear()
  mocks.invoke.mockClear()
  mocks.invoke.mockResolvedValue(undefined)
})

describe('退出确认弹窗', () => {
  it('主窗口收到 window-close-requested 时打开退出确认面', async () => {
    mountLayer()
    await flushPromises()

    expect(mocks.listen).toHaveBeenCalledWith('window-close-requested', expect.any(Function))
    mocks.closeHandler?.({ payload: [] })
    await flushPromises()

    expect(mocks.dialog.value).toBe('exit')
  })

  it('点「仍然退出」走宿主 confirm_window_close，进入正在退出态且不再重复触发', async () => {
    mocks.dialog.value = 'exit'
    const wrapper = mountLayer()
    await flushPromises()

    const confirm = buttonByText(wrapper, 'shell.dialog.exit.confirm')
    expect(confirm).toBeTruthy()
    await confirm!.trigger('click')
    await flushPromises()

    expect(mocks.invoke).toHaveBeenCalledWith('confirm_window_close', {
      credential: 'test-host-credential',
    })
    // 命令只启动有界优雅关闭；确认面保持可见并进入 quitting 态
    expect(mocks.dialog.value).toBe('exit')
    expect(wrapper.find('[data-testid="exit-quitting"]').exists()).toBe(true)

    // 重复点击不得再次触发退出命令（hooks 只允许执行一次）
    await confirm!.trigger('click')
    await flushPromises()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it('退出命令失败时恢复确认面，允许重试', async () => {
    mocks.dialog.value = 'exit'
    mocks.invoke.mockRejectedValueOnce(new Error('invoke failed'))
    const wrapper = mountLayer()
    await flushPromises()

    const confirm = buttonByText(wrapper, 'shell.dialog.exit.confirm')
    await confirm!.trigger('click')
    await flushPromises()

    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(mocks.dialog.value).toBe('exit')
    expect(wrapper.find('[data-testid="exit-quitting"]').exists()).toBe(false)
    expect(buttonByText(wrapper, 'shell.dialog.exit.confirm')).toBeTruthy()
  })

  it('退出清单只列运行中的业务应用，系统服务不计入', async () => {
    mocks.dialog.value = 'exit'
    mocks.plugins.value = [
      { id: 'com.wasmnest.auth-center', name: '认证中心', state: 'running', kind: 'internal-business' },
      { id: 'com.wasmnest.net-config', name: '网络配置', state: 'degraded', kind: 'basic-service' },
      { id: 'com.wasmnest.monitor', name: '监控', state: 'running', kind: 'internal-business' },
      { id: 'com.example.tool', name: '业务应用', state: 'running', kind: 'business-app' },
      { id: 'com.example.sleep', name: '休眠应用', state: 'dormant', kind: 'business-app' },
    ]
    const wrapper = mountLayer()
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('业务应用')
    expect(text).not.toContain('认证中心')
    expect(text).not.toContain('网络配置')
    expect(text).not.toContain('监控')
    expect(text).not.toContain('休眠应用')
  })

  it('只有系统服务在运行时不列出任何应用，提示可直接退出', async () => {
    mocks.dialog.value = 'exit'
    mocks.plugins.value = [
      { id: 'com.wasmnest.auth-center', name: '认证中心', state: 'running', kind: 'internal-business' },
      { id: 'com.wasmnest.monitor', name: '监控', state: 'degraded', kind: 'internal-business' },
    ]
    const wrapper = mountLayer()
    await flushPromises()

    expect(wrapper.text()).not.toContain('认证中心')
    expect(wrapper.text()).not.toContain('监控')
    expect(wrapper.text()).toContain('shell.dialog.exit.none')
  })

  it('独立终端窗口不监听退出确认事件', async () => {
    mocks.windowLabel = 'terminal-1'
    mountLayer()
    await flushPromises()

    expect(mocks.listen).not.toHaveBeenCalled()
  })
})
