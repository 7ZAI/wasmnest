/**
 * 宿主前端边界：多任务面板同时展示 N 个应用时的预览挂载上限。
 *
 * 产品侧没有「最多打开 N 个应用」的硬编码：卡片清单是运行中应用的投影，
 * 每张 app 卡各自挂载一份 `mountPreview`（后台应用离开运行面即卸载，没有
 * DOM 可截图）。因此真正的上限是「同时挂 N 份预览还能不能全部挂上 / 全部
 * 卸载」，而不是某个常量。
 *
 * 本测试锁定三条边界行为（N = 32，当前随包 4 个应用的 8 倍）：
 * 1. 全部 N 张卡各自发起挂载，且全部到达 ready（不丢卡、不串行吞掉）；
 * 2. 任一预览 3s 超时只影响自己，N 张卡全部回退品牌卡，不阻塞其他卡；
 * 3. 关闭多任务 / 卸载卡片时 N 个句柄逐一 unmount（不留后台预览实例）。
 *
 * 真实 WebView 的渲染帧率、内存与 3s 超时的真实耗时由平台 e2e 覆盖；
 * 这里只锁组件契约与并发数量边界，不做机器相关的计时断言。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const mountAppPreview = vi.hoisted(() => vi.fn())
const appInvoke = vi.hoisted(() => vi.fn(async () => null))
const appStorageGet = vi.hoisted(() => vi.fn(async () => undefined))
const refreshChannelToken = vi.hoisted(() => vi.fn(async () => 'token'))
const appStorageSet = vi.hoisted(() => vi.fn(async () => {}))
const appStorageDelete = vi.hoisted(() => vi.fn(async () => {}))
const loggerWarn = vi.hoisted(() => vi.fn())
const loggerError = vi.hoisted(() => vi.fn())

vi.mock('@/shell/mount/useAppMount', () => ({
  mountAppPreview,
  PREVIEW_MOUNT_TIMEOUT_MS: 3000,
}))
vi.mock('@/utils/appCommands', () => ({
  appInvoke,
  appStorageGet,
  refreshChannelToken,
  appStorageSet,
  appStorageDelete,
}))
vi.mock('@/utils/frontendLogger', () => ({
  logger: { log: vi.fn(), warn: loggerWarn, error: loggerError },
}))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ settings: { ui: { language: 'zh-CN', theme: 'dark' } } }),
}))
vi.mock('@/composables/usePlatform', () => ({
  usePlatform: () => ({ platformInfo: { value: { isDesktop: true, isMobile: false } } }),
}))
vi.mock('@/utils/invoke', () => ({ invoke: vi.fn(async () => null) }))

import AppPreviewTile from '@/shell/mount/AppPreviewTile.vue'
import type { AppPreviewHandle } from '@/shell/mount/useAppMount'

/** 同时展示的应用数：随包 4 个的 8 倍，足以暴露「只挂第一个 / 串行超时」类回归 */
const N = 32
const APP_IDS = Array.from({ length: N }, (_, i) => `com.wasmnest.scale.app${String(i).padStart(2, '0')}`)

type TrackedHandle = AppPreviewHandle & { unmount: ReturnType<typeof vi.fn> }

function makeHandle(): TrackedHandle {
  return { unmount: vi.fn(async () => {}) }
}

/** 一个宿主容器：按真实多任务面板的形态渲染 N 张应用卡（每张卡一个预览容器） */
function mountTiles(): VueWrapper {
  const Host = defineComponent({
    render() {
      return h(
        'div',
        APP_IDS.map((id) =>
          h(AppPreviewTile, {
            key: id,
            appId: id,
            icon: 'grid',
            tone: 'info',
          }),
        ),
      )
    },
  })
  return mount(Host, { attachTo: document.body })
}

function readyCount(): number {
  return document.querySelectorAll('.app-preview[data-preview-state="ready"]').length
}

describe('宿主前端边界：N 个应用预览同时挂载', () => {
  let wrapper: VueWrapper | null = null
  let handles: TrackedHandle[] = []

  beforeEach(() => {
    mountAppPreview.mockReset()
    loggerWarn.mockClear()
    loggerError.mockClear()
    appInvoke.mockClear()
    appStorageGet.mockClear()
    refreshChannelToken.mockClear()
    appStorageSet.mockClear()
    appStorageDelete.mockClear()
    document.body.innerHTML = ''
    handles = []
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('32 张卡全部发起挂载并到达 ready（不设人为上限、不丢卡）', async () => {
    mountAppPreview.mockImplementation(async (root: HTMLElement) => {
      root.innerHTML = '<div data-preview-drawn>app preview</div>'
      const handle = makeHandle()
      handles.push(handle)
      return handle
    })

    wrapper = mountTiles()
    await flushPromises()

    expect(mountAppPreview).toHaveBeenCalledTimes(N)
    expect(readyCount()).toBe(N)
    expect(handles).toHaveLength(N)
    expect(loggerWarn).not.toHaveBeenCalled()
  })

  it('任一预览超时只回退自己：32 张卡全部回退，不阻塞其他卡', async () => {
    vi.useFakeTimers()
    mountAppPreview.mockReturnValue(new Promise<AppPreviewHandle>(() => {}))

    wrapper = mountTiles()
    await nextTick()
    expect(document.querySelectorAll('.app-preview[data-preview-state="loading"]')).toHaveLength(N)

    await vi.advanceTimersByTimeAsync(3000)
    await nextTick()

    expect(document.querySelectorAll('.app-preview[data-preview-state="fallback"]')).toHaveLength(N)
    expect(loggerWarn).toHaveBeenCalledTimes(N)
    // 每张卡的告警都带自己的 appId，避免「只报第一个」的静默丢失
    const warned = loggerWarn.mock.calls.map((c) => String(c[0]))
    for (const id of APP_IDS) {
      expect(warned.some((line) => line.includes(`appId=${id}`))).toBe(true)
    }
  })

  it('关闭多任务时 32 个预览句柄逐一 unmount（不留后台预览实例）', async () => {
    mountAppPreview.mockImplementation(async () => {
      const handle = makeHandle()
      handles.push(handle)
      return handle
    })

    wrapper = mountTiles()
    await flushPromises()
    expect(handles).toHaveLength(N)

    wrapper.unmount()
    wrapper = null
    await flushPromises()

    for (const handle of handles) {
      expect(handle.unmount).toHaveBeenCalledTimes(1)
    }
  })
})
