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
// 挂载换发令牌（不信任页面内存缓存）：AppMountSlot 挂载前必经
const refreshChannelToken = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/shell/mount/useAppMount', () => ({
  useAppMount: () => ({ mountAppBundle, unmountAppBundle, notifyAppRoute }),
  MOUNT_CONTRACT: '1',
}))
vi.mock('@/shell/mount/appSession', () => ({ rememberAppRoute }))
vi.mock('@/utils/appCommands', () => ({
  refreshChannelToken,
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
    refreshChannelToken.mockClear()
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
    // 挂载 = 身份重绑：必须强制换发令牌，不能复用页面内存里的旧缓存
    expect(refreshChannelToken).toHaveBeenCalledWith(APP_A)
    const env = mountAppBundle.mock.calls[0][1] as {
      appId: string
      initialRoute: string
      mountContract: string
    }
    expect(env.appId).toBe(APP_A)
    expect(env.initialRoute).toBe('/sessions')
    // 契约版本必须由宿主注入（与 useAppMount 的 MOUNT_CONTRACT 同一值）
    expect(env.mountContract).toBe('1')
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
    refreshChannelToken.mockImplementation(async (appId: string) => {
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

/**
 * DOM 所有权锁：宿主状态层与应用的挂载容器必须分离
 *
 * 应用前端是**另一个 Vue 实例**：`app.mount(container)` 会先 `container.innerHTML = ''`。
 * 若宿主的状态层（加载 / 失败面）与挂载容器同层，挂载瞬间宿主自己的 DOM 被清空
 * （vdom 仍引用着它们）→ 宿主随后 patch 该容器拿到失效容器 →
 * `TypeError: null is not an object (evaluating 't.insertBefore')` → 壳弹
 * 「发生了未知错误，详见日志」（2026-10-21 dev:host 实测）。
 */
describe('AppMountSlot DOM 所有权（状态层不得与应用挂载容器同层）', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('加载态的状态层在挂载容器之外，且挂载容器里没有宿主自己的 DOM', async () => {
    // 装载永不 resolve → 停在加载态（状态层在场）
    mountAppBundle.mockImplementation(() => new Promise(() => {}))
    wrapper = mount(AppMountSlot, {
      props: { appId: APP_A, route: '/sessions' },
      attachTo: document.body,
    })
    await flushPromises()

    const slot = wrapper.find('.app-mount-slot')
    const status = wrapper.find('.app-mount-status')
    expect(slot.exists(), '必须有专用的应用挂载容器').toBe(true)
    expect(status.exists(), '装载未完成时应有加载面').toBe(true)
    expect(
      slot.element.contains(status.element),
      '状态层不得与应用挂载容器同层（Vue app.mount 会清空容器 innerHTML）',
    ).toBe(false)
    expect(
      slot.element.children.length,
      '挂载容器里不放宿主自己的 DOM（否则应用 mount 瞬间被清空）',
    ).toBe(0)
  })

  it('应用挂载（复刻 Vue 的 container.innerHTML = ""）后，宿主状态层仍在', async () => {
    // 复刻真实挂载行为：Vue 的 app.mount(container) 先清空容器
    mountAppBundle.mockImplementation(async (slot: HTMLElement) => {
      slot.innerHTML = ''
      return makeHandle()
    })
    wrapper = mount(AppMountSlot, {
      props: { appId: APP_A, route: '/sessions' },
      attachTo: document.body,
    })
    await flushPromises()

    // 挂载完成后状态层退场，但**宿主自己的 DOM 不得被应用清空带走**
    const slot = wrapper.find('.app-mount-slot')
    expect(slot.exists()).toBe(true)
    expect(
      wrapper.find('.app-mount-status').exists(),
      '挂载完成后加载面应退场',
    ).toBe(false)
  })
})
