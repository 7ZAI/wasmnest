import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'

/**
 * 设置页「恢复初始设置」：弹窗确认 + 破坏性动作
 *
 * 锁三条行为：
 *   1. 点击入口先弹确认（提示语含「清除所有授权记录，还原默认配置」），取消不动作；
 *   2. 确认后清空授权记录（allow 走撤销 / deny 走移除）并还原默认配置；
 *   3. 撤销 allow 后**新落的 deny** 也要移除——否则「恢复初始设置」会把应用永久
 *      挡在门外（deny 是判定链第 0 层，2026-10-20 ai-chatbox 实机故障）。
 */

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

const authMocks = vi.hoisted(() => ({
  overview: vi.fn(),
  revoke: vi.fn(),
  removeRecord: vi.fn(),
}))

vi.mock('@/utils/appCommands', () => ({
  authOverview: (...args: unknown[]) => authMocks.overview(...args),
  authRevoke: (...args: unknown[]) => authMocks.revoke(...args),
  authRemoveRecord: (...args: unknown[]) => authMocks.removeRecord(...args),
}))

const storeMocks = vi.hoisted(() => ({ resetSettings: vi.fn() }))
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => storeMocks }))

const prefsMocks = vi.hoisted(() => ({
  prefs: {
    value: {
      wallpaper: 'dune',
      wallDim: 60,
      wallpaperImage: 'custom-1.png',
      theme: 'dusk',
    },
  },
}))
vi.mock('@/shell/composables/useShellSettings', () => ({
  useShellSettings: () => prefsMocks,
}))

const wallpaperMocks = vi.hoisted(() => ({ clear: vi.fn() }))
vi.mock('@/shell/composables/customWallpaper', () => ({
  clearCustomWallpaper: wallpaperMocks.clear,
}))

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toastMocks }))

import SettingsResetSection from '@/shell/settings/SettingsResetSection.vue'

function mountSection() {
  return mount(SettingsResetSection, {
    global: {
      stubs: {
        Modal: {
          props: ['modelValue'],
          template: '<div v-if="modelValue"><slot /><slot name="footer" /></div>',
        },
        Button: { template: '<button v-bind="$attrs"><slot /></button>' },
      },
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  prefsMocks.prefs.value.wallpaper = 'dune'
  prefsMocks.prefs.value.wallDim = 60
  prefsMocks.prefs.value.wallpaperImage = 'custom-1.png'
  prefsMocks.prefs.value.theme = 'dusk'
  authMocks.overview.mockResolvedValue([
    {
      pluginId: 'com.wasmnest.bedcode',
      name: 'BedCode',
      strategies: [],
      firstPartyDirs: [],
      records: [
        {
          id: 1,
          pluginId: 'com.wasmnest.bedcode',
          resource: 'fs',
          target: '/repo',
          effect: 'allow',
          ops: ['read'],
          prefixMatch: false,
          source: 'user',
          createdAt: 0,
        },
        {
          id: 2,
          pluginId: 'com.wasmnest.bedcode',
          resource: 'network',
          target: 'http://127.0.0.1:8765',
          effect: 'deny',
          ops: [],
          prefixMatch: false,
          source: 'user_deny',
          createdAt: 0,
        },
      ],
    },
  ])
})

describe('设置页「恢复初始设置」', () => {
  it('入口点击先弹确认，提示清除授权记录 + 还原默认配置', async () => {
    const wrapper = mountSection()
    expect(wrapper.find('[data-testid="settings-reset-confirm-body"]').exists()).toBe(false)

    await wrapper.find('[data-testid="settings-reset-open"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="settings-reset-confirm-body"]').text()).toBe(
      'settings.reset.confirmBody',
    )
    // 弹窗期间不执行任何破坏性动作
    expect(authMocks.overview).not.toHaveBeenCalled()
    expect(storeMocks.resetSettings).not.toHaveBeenCalled()
  })

  it('确认后清空授权记录并还原默认配置', async () => {
    const wrapper = mountSection()
    await wrapper.find('[data-testid="settings-reset-open"]').trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-testid="settings-reset-confirm"]').trigger('click')
    await wrapper.vm.$nextTick()
    await vi.waitFor(() => expect(toastMocks.success).toHaveBeenCalled())

    // allow → 撤销；deny → 移除
    expect(authMocks.revoke).toHaveBeenCalledWith('com.wasmnest.bedcode', 'fs', '/repo')
    expect(authMocks.removeRecord).toHaveBeenCalledWith(
      'com.wasmnest.bedcode',
      'network',
      'http://127.0.0.1:8765',
    )
    expect(storeMocks.resetSettings).toHaveBeenCalledTimes(1)
    // 复制到应用数据目录的自定义壁纸文件必须一并删除
    expect(wallpaperMocks.clear).toHaveBeenCalledTimes(1)
    // 壳偏好一并回落默认
    expect(prefsMocks.prefs.value.wallpaper).toBe('aurora')
    expect(prefsMocks.prefs.value.wallDim).toBe(30)
    expect(prefsMocks.prefs.value.wallpaperImage).toBe('')
    // 主题也属于壳偏好：复位必须回到内置 default，而不是留着已注册/已卸载的主题 id
    expect(prefsMocks.prefs.value.theme).toBe('default')
  })

  it('撤销 allow 后新落的 deny 一并移除（否则恢复初始设置会把应用永久挡在门外）', async () => {
    // 第一次读模型只有 allow；revoke 的语义是「删 allow + 落 deny」，因此第二次
    // 读模型出现同名目标的 deny——它必须被移除，否则 deny 作为判定链第 0 层会
    // 让该应用此后一律无法激活（2026-10-20 ai-chatbox 实机故障）。
    authMocks.overview
      .mockResolvedValueOnce([
        {
          pluginId: 'com.wasmnest.ai-chatbox',
          name: 'AI Chatbox',
          strategies: [],
          firstPartyDirs: [],
          records: [
            {
              id: 10,
              pluginId: 'com.wasmnest.ai-chatbox',
              resource: 'fs',
              target: '/home/me/.wasmnest/ai-chatbox',
              effect: 'allow',
              ops: ['read', 'write'],
              prefixMatch: false,
              source: 'user',
              createdAt: 0,
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          pluginId: 'com.wasmnest.ai-chatbox',
          name: 'AI Chatbox',
          strategies: [],
          firstPartyDirs: [],
          records: [
            {
              id: 11,
              pluginId: 'com.wasmnest.ai-chatbox',
              resource: 'fs',
              target: '/home/me/.wasmnest/ai-chatbox',
              effect: 'deny',
              ops: [],
              prefixMatch: false,
              source: 'user_deny',
              createdAt: 1,
            },
          ],
        },
      ])

    const wrapper = mountSection()
    await wrapper.find('[data-testid="settings-reset-open"]').trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-testid="settings-reset-confirm"]').trigger('click')
    await vi.waitFor(() => expect(toastMocks.success).toHaveBeenCalled())

    expect(authMocks.revoke).toHaveBeenCalledWith(
      'com.wasmnest.ai-chatbox',
      'fs',
      '/home/me/.wasmnest/ai-chatbox',
    )
    expect(authMocks.removeRecord).toHaveBeenCalledWith(
      'com.wasmnest.ai-chatbox',
      'fs',
      '/home/me/.wasmnest/ai-chatbox',
    )
  })

  it('取消不执行任何动作', async () => {
    const wrapper = mountSection()
    await wrapper.find('[data-testid="settings-reset-open"]').trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-testid="settings-reset-cancel"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(authMocks.overview).not.toHaveBeenCalled()
    expect(storeMocks.resetSettings).not.toHaveBeenCalled()
    expect(wallpaperMocks.clear).not.toHaveBeenCalled()
    expect(toastMocks.success).not.toHaveBeenCalled()
  })
})
