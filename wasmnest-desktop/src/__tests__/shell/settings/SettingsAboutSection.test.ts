/**
 * 设置页「关于」— 检查更新入口（组件行为）
 *
 * 锁四件事：
 *   1. 卡片里真的有一个可点的「检查更新」按钮（此前只有状态展示，触发入口已丢失）；
 *   2. 点击 → invoke 宿主命令 `check_for_update`；有新版 → 渲染版本号 + 「立即更新」；
 *   3. 「立即更新」→ invoke `install_update`；
 *   4. 检查中按钮禁用 + aria-busy（标签不变，行宽不跳），失败后回到可重试态。
 *
 * 传输面契约由 useUpdateChecker / 集成测试覆盖（前端零资源访问红线，只走宿主命令），
 * 这里只断言组件接线与渲染，不重复测错误信封细节。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import i18n from '@/i18n'
import { useUpdateChecker } from '@/shell/settings/useUpdateChecker'

// ==================== mock Tauri 边界 ====================

const mockInvoke = vi.fn()
// 按命令名路由；未登记的命令直接抛错——避免用例没跟上迁移却静默变绿
const invokeHandlers = new Map<string, (args: unknown) => Promise<unknown>>()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(async () => {}),
}))

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn(() => 'mock-id'),
    error: vi.fn(() => 'mock-id-error'),
    warning: vi.fn(() => 'mock-id'),
    info: vi.fn(() => 'mock-id-info'),
  },
}))

import { toast } from 'vue-sonner'
import SettingsAboutSection from '@/shell/settings/SettingsAboutSection.vue'

const mockedToast = vi.mocked(toast)

async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockReset()
  invokeHandlers.clear()
  mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const handler = invokeHandlers.get(cmd)
    if (!handler) throw new Error(`unmocked invoke command: ${cmd}`)
    return handler(args)
  })
  invokeHandlers.set('get_app_version', async () => '0.0.1')
  setActivePinia(createPinia())
  // 模块级单例跨用例共享：复位状态与上一轮版本号
  const { status, availableVersion, downloadProgress } = useUpdateChecker()
  status.value = 'idle'
  availableVersion.value = null
  downloadProgress.value = { downloaded: 0, contentLength: 0 }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

/** 挂载并等 onMounted 的版本号读取完成 */
async function mountSection() {
  wrapper = mount(SettingsAboutSection, {
    global: { plugins: [createPinia(), i18n] },
  })
  await flushAsync()
  return wrapper
}

describe('设置页「关于」— 检查更新', () => {
  it('默认渲染「检查更新」按钮，点击经宿主命令检查', async () => {
    invokeHandlers.set('check_for_update', async () => ({
      available: false,
      version: null,
      date: null,
    }))
    const w = await mountSection()

    const button = w.find('[data-testid="settings-check-update"]')
    expect(button.exists()).toBe(true)
    expect(button.text()).toContain('检查更新')

    await button.trigger('click')
    await flushAsync()

    expect(mockInvoke).toHaveBeenCalledWith('check_for_update')
  })

  it('有新版 → 渲染版本号与「立即更新」，检查按钮让位', async () => {
    invokeHandlers.set('check_for_update', async () => ({
      available: true,
      version: '0.0.2',
      date: '2026-11-02',
    }))
    const w = await mountSection()

    await w.find('[data-testid="settings-check-update"]').trigger('click')
    await flushAsync()

    const text = w.text()
    expect(text).toContain('发现新版本')
    expect(text).toContain('v0.0.2')
    expect(w.find('[data-testid="settings-install-update"]').text()).toContain('立即更新')
    // 同一行只留一个可点的动作：检查按钮不再渲染
    expect(w.find('[data-testid="settings-check-update"]').exists()).toBe(false)
  })

  it('「立即更新」→ invoke install_update', async () => {
    invokeHandlers.set('check_for_update', async () => ({
      available: true,
      version: '0.0.2',
      date: null,
    }))
    // false = 当前无可用更新（不是失败）：避免测试进入 relaunch
    invokeHandlers.set('install_update', async () => false)
    const w = await mountSection()

    await w.find('[data-testid="settings-check-update"]').trigger('click')
    await flushAsync()
    await w.find('[data-testid="settings-install-update"]').trigger('click')
    await flushAsync()

    expect(mockInvoke).toHaveBeenCalledWith('install_update')
  })

  it('已是最新 → 弹 info toast，检查按钮保留可重试', async () => {
    invokeHandlers.set('check_for_update', async () => ({
      available: false,
      version: null,
      date: null,
    }))
    const w = await mountSection()

    await w.find('[data-testid="settings-check-update"]').trigger('click')
    await flushAsync()

    expect(mockedToast.info).toHaveBeenCalledWith(
      '已是最新版本',
      expect.objectContaining({ duration: 3000 }),
    )
    expect(w.find('[data-testid="settings-check-update"]').exists()).toBe(true)
  })

  it('检查中 → 按钮禁用 + aria-busy，标签保持「检查更新」避免行宽跳动', async () => {
    let resolveCheck: (value: unknown) => void = () => {}
    invokeHandlers.set(
      'check_for_update',
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve
        }),
    )
    const w = await mountSection()

    await w.find('[data-testid="settings-check-update"]').trigger('click')
    await flushAsync()

    const button = w.find('[data-testid="settings-check-update"]')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('aria-busy')).toBe('true')
    expect(button.attributes('aria-label')).toBe('正在检查更新...')
    expect(button.text()).toContain('检查更新')
    expect(button.find('.update-spinner').exists()).toBe(true)

    resolveCheck({ available: false, version: null, date: null })
    await flushAsync()
  })

  it('检查失败 → 通用文案可重试，不渲染原始错误', async () => {
    invokeHandlers.set('check_for_update', async () => {
      throw new Error('GET https://github.com/7ZAI/wasmnest/releases/latest -> 404')
    })
    const w = await mountSection()

    await w.find('[data-testid="settings-check-update"]').trigger('click')
    await flushAsync()

    const text = w.text()
    expect(text).toContain('检查更新失败，请稍后重试')
    expect(text).not.toContain('404')
    expect(text).not.toContain('github.com')
    expect(w.find('[data-testid="settings-check-update"]').exists()).toBe(true)
  })

  it('GitHub 仓库入口指向发布 latest.json 的平台仓', async () => {
    invokeHandlers.set('open_external_url', async () => undefined)
    const w = await mountSection()

    await w.find('[data-testid="settings-github"]').trigger('click')
    await flushAsync()

    expect(mockInvoke).toHaveBeenCalledWith('open_external_url', {
      url: 'https://github.com/7ZAI/wasmnest',
    })
  })
})
