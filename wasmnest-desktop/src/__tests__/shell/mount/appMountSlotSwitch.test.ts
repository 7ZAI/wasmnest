import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

/**
 * 挂载槽换应用契约（多任务卡片切换的回归锁）
 *
 * 现象：多任务面板里点 ai-chatbox 卡片，界面仍是 bedcode。
 * 根因：`ShellHost` 的应用分支只渲染**一个** `<AppMountSlot>`，bedcode → ai-chatbox 时
 * Vue 复用同一实例、只改 props——`onMounted` 不会再跑，旧组件只 watcher 了 `route`
 *（把换应用寄望于「组件重建」）。于是旧 app 的 DOM 留在槽里，新 app 从未 mount。
 *
 * 本测试直接驱动 props：
 *   - 挂载时按 A 装载；
 *   - 换 appId 为 B → 必须 unmount(A) + mount(B)（反例：只改 props 也能"看起来正常"）；
 *   - 同一 appId 内换 route → 只通知应用，不重建实例；
 *   - 卸载组件 → 卸载实例。
 */

// ==================== 模块桩（挂载槽依赖宿主面 env 的全部取数口） ====================
const unmountAppBundle = vi.hoisted(() => vi.fn(async () => {}))
const mountAppBundle = vi.hoisted(() => vi.fn())
const notifyAppRoute = vi.hoisted(() => vi.fn(async () => {}))
const rememberAppRoute = vi.hoisted(() => vi.fn())
const ensureChannelToken = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/shell/mount/useAppMount', () => ({
  useAppMount: () => ({ mountAppBundle, unmountAppBundle, notifyAppRoute }),
}))
vi.mock('@/shell/mount/appSession', () => ({ rememberAppRoute }))
vi.mock('@/utils/appCommands', () => ({
  ensureChannelToken,
  appInvoke: vi.fn(async () => null),
  appStorageGet: vi.fn(async () => undefined),
  appStorageSet: vi.fn(async () => {}),
  appStorageDelete: vi.fn(async () => {}),
}))
vi.mock('@/utils/invoke', () => ({ invoke: vi.fn(async () => null) }))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ settings: { ui: { language: 'zh-CN', theme: 'dark' } } }),
}))
vi.mock('@/composables/usePlatform', () => ({
  usePlatform: () => ({ platformInfo: { value: { isDesktop: true, isMobile: false } } }),
}))
// 只替换 useRouter（组件用 push 处理 app 的 navigate 事件），保留真实实现供其它模块用
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return { ...actual, useRouter: () => ({ push: vi.fn() }) }
})
// 同上：useI18n 返回 key 原文，createI18n 保留（src/i18n 仍在导入图里）
vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import AppMountSlot from '@/shell/mount/AppMountSlot.vue'

const APP_A = 'com.wasmnest.terminal-session'
const APP_B = 'com.wasmnest.ai-chatbox'

/** 每次挂载返回一个可断言卸载的句柄 */
function makeHandle() {
  return { unmount: vi.fn(async () => {}) }
}

describe('AppMountSlot 换应用（多任务切换）', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    unmountAppBundle.mockClear()
    mountAppBundle.mockReset()
    notifyAppRoute.mockClear()
    rememberAppRoute.mockClear()
    ensureChannelToken.mockClear()
    mountAppBundle.mockImplementation(async () => makeHandle())
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  /** 以 appId A / route /a 挂载并等装载完成 */
  async function mountWith(appId: string, route: string): Promise<void> {
    wrapper = mount(AppMountSlot, { props: { appId, route }, attachTo: document.body })
    await flushPromises()
  }

  it('挂载时按 appId 装载（env.appId 不得串用别的应用）', async () => {
    await mountWith(APP_A, '/sessions')
    expect(mountAppBundle).toHaveBeenCalledTimes(1)
    const env = mountAppBundle.mock.calls[0][1] as { appId: string; initialRoute: string }
    expect(env.appId).toBe(APP_A)
    expect(env.initialRoute).toBe('/sessions')
  })

  it('换 appId（复用同一实例）→ 先卸载旧实例再装载新实例', async () => {
    await mountWith(APP_A, '/sessions')

    await wrapper!.setProps({ appId: APP_B, route: '/chat' })
    await flushPromises()

    expect(unmountAppBundle, '旧应用必须卸载（否则旧 DOM 留在槽里）').toHaveBeenCalledWith(APP_A)
    expect(mountAppBundle, '新应用必须重新装载').toHaveBeenCalledTimes(2)
    const env = mountAppBundle.mock.calls[1][1] as { appId: string; initialRoute: string }
    expect(env.appId).toBe(APP_B)
    expect(env.initialRoute).toBe('/chat')
  })

  it('同一 appId 内换 route → 只通知应用消化，不重建实例（反例）', async () => {
    await mountWith(APP_A, '/sessions')
    mountAppBundle.mockClear()

    await wrapper!.setProps({ route: '/tasks' })
    await flushPromises()

    expect(notifyAppRoute).toHaveBeenCalledWith(APP_A, '/tasks')
    expect(mountAppBundle, '同应用换页不该重新 mount').not.toHaveBeenCalled()
    expect(unmountAppBundle).not.toHaveBeenCalled()
  })

  it('卸载组件 → 卸载当前实例', async () => {
    await mountWith(APP_A, '/sessions')
    wrapper!.unmount()
    wrapper = null
    await flushPromises()
    expect(unmountAppBundle).toHaveBeenCalledWith(APP_A)
  })

  it('连续切换：过期代次的装载不得挂到界面上', async () => {
    await mountWith(APP_A, '/sessions')

    // B 的令牌获取挂起不返回 —— 模拟"装载慢"，期间再切到 C
    let releaseSecond: (() => void) | null = null
    ensureChannelToken.mockImplementation(async (appId: string) => {
      if (appId === APP_B) {
        await new Promise<void>((resolve) => {
          releaseSecond = resolve
        })
      }
    })

    const APP_C = 'com.wasmnest.file-transfer'
    await wrapper!.setProps({ appId: APP_B, route: '/chat' })
    await flushPromises() // 让 B 的 watcher 走到「等令牌」
    await wrapper!.setProps({ appId: APP_C, route: '/transfer' })
    await flushPromises()

    // 放行 B：它会完成 env 构建，但代次已过期 → 不得 mount 到槽上
    releaseSecond?.()
    await flushPromises()

    const mountedAppIds = mountAppBundle.mock.calls.map(
      (call) => (call[1] as { appId: string }).appId,
    )
    expect(mountedAppIds, '过期代次的实例不许挂到界面上').not.toContain(APP_B)
    expect(mountedAppIds.at(-1), '最终界面必须属于最后选中的应用').toBe(APP_C)
  })
})
