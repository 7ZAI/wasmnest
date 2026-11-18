/**
 * useEdgeToEdge 初始化行为锁（2026-11-08 性能审查 F3）
 *
 * 被测行为：
 * - 初始化只发两条**并发**查询（safe area insets + keyboard info），不入串行链；
 * - **不挂 Tauri `listen('safeAreaChanged')`**：插件真源
 *   `tauri-plugin-edge-to-edge@0.3.3`（`android/.../EdgeToEdgePlugin.kt`）只
 *   `window.dispatchEvent(new CustomEvent(...))`，从无 Tauri emit——那条监听永不触发，
 *   早先版本在初始化链上白付一次往返；
 * - 唯一事件面是 DOM `window` 的 `safeAreaChanged`，随组件卸载解绑；
 * - 两条查询都回来后 isReady 放开（ShellView 的 `v-if="safeAreaReady"` 闸门）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const mockInvoke = vi.fn()
const mockListen = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// 动态 import 的 Tauri 事件模块：若实现退回「挂 Tauri 监听」，这里的调用会被记录
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/composables/usePlatform', () => ({
  usePlatform: () => ({ platformInfo: { value: { isMobile: true } } }),
}))

import { useEdgeToEdge } from '@/composables/useEdgeToEdge'

const INSETS = {
  top: 24,
  right: 0,
  bottom: 16,
  left: 0,
  statusBar: 24,
  navigationBar: 16,
}
const KEYBOARD = { keyboardHeight: 0, isVisible: false }

function invocationsOf(cmd: string): unknown[][] {
  return mockInvoke.mock.calls.filter(([c]) => c === cmd).map((call) => call.slice(1))
}

/** 把 composable 挂进真实组件生命周期（onMounted / onUnmounted 生效） */
function mountConsumer() {
  let api: ReturnType<typeof useEdgeToEdge> | undefined
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useEdgeToEdge()
        return () => h('div')
      },
    }),
  )
  return { wrapper, api: api! }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'plugin:edge-to-edge|get_safe_area_insets') return INSETS
    if (cmd === 'plugin:edge-to-edge|get_keyboard_info') return KEYBOARD
    return undefined
  })
})

describe('useEdgeToEdge 初始化', () => {
  it('两条查询并发发出、不挂 Tauri listen，insets 落地后 isReady', async () => {
    const inFlight: string[] = []
    let releaseInsets!: () => void
    mockInvoke.mockImplementation((cmd: string) => {
      inFlight.push(cmd)
      if (cmd === 'plugin:edge-to-edge|get_safe_area_insets') {
        return new Promise((resolve) => {
          releaseInsets = () => resolve(INSETS)
        })
      }
      if (cmd === 'plugin:edge-to-edge|get_keyboard_info') return Promise.resolve(KEYBOARD)
      return Promise.resolve(undefined)
    })

    const { api } = mountConsumer()
    await flushPromises()

    // 并发：键盘查询在 insets 未 resolve 前就已发出（不是 await 串行）
    expect(inFlight).toEqual([
      'plugin:edge-to-edge|get_safe_area_insets',
      'plugin:edge-to-edge|get_keyboard_info',
    ])
    // 死监听不再存在（Tauri 事件面零调用）
    expect(mockListen).not.toHaveBeenCalled()
    expect(api.isReady.value).toBe(false)

    releaseInsets()
    await flushPromises()
    expect(api.isReady.value).toBe(true)
    expect(api.safeArea.value).toEqual(INSETS)
    expect(api.keyboardInfo.value).toEqual(KEYBOARD)
  })

  it('DOM safeAreaChanged 驱动 insets/键盘投影，卸载后解绑', async () => {
    const { wrapper, api } = mountConsumer()
    await flushPromises()

    window.dispatchEvent(
      new CustomEvent('safeAreaChanged', {
        detail: { top: 30, right: 1, bottom: 20, left: 2, keyboardHeight: 300, keyboardVisible: true },
      }),
    )
    expect(api.safeArea.value).toEqual({
      top: 30,
      right: 1,
      bottom: 20,
      left: 2,
      statusBar: 30,
      navigationBar: 20,
    })
    expect(api.keyboardInfo.value).toEqual({ keyboardHeight: 300, isVisible: true })
    expect(api.totalBottomInset.value).toBe(320)

    wrapper.unmount()
    window.dispatchEvent(
      new CustomEvent('safeAreaChanged', {
        detail: { top: 0, right: 0, bottom: 0, left: 0, keyboardHeight: 0, keyboardVisible: false },
      }),
    )
    // 解绑后不再改投影
    expect(api.safeArea.value.top).toBe(30)
  })

  it('桌面端同步就绪且不发查询', async () => {
    vi.resetModules()
    vi.doMock('@/composables/usePlatform', () => ({
      usePlatform: () => ({ platformInfo: { value: { isMobile: false } } }),
    }))
    const mod = await import('@/composables/useEdgeToEdge')
    let api: ReturnType<typeof mod.useEdgeToEdge> | undefined
    mount(
      defineComponent({
        setup() {
          api = mod.useEdgeToEdge()
          return () => h('div')
        },
      }),
    )
    await flushPromises()
    expect(api!.isReady.value).toBe(true)
    expect(mockInvoke).not.toHaveBeenCalled()
    vi.doUnmock('@/composables/usePlatform')
  })
})
