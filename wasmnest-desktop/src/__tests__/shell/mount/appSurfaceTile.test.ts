/**
 * AppSurfaceTile 行为单测（2026-10-30 多任务卡改真实实例）
 *
 * 卡片缩略区不再由应用自绘：宿主把保活实例搬进卡片容器（等比缩放），卡片卸载时
 * 再摘回后台。本组件只负责容器 / 搬运请求 / 卸载收尾；实例缺失（装载失败 / 已停用）
 * 必须停在品牌卡 fallback，不空白、不报错。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'

const api = vi.hoisted(() => ({
  present: vi.fn((_appId: string, _el: HTMLElement, _box?: { width: number; height: number }) => true),
  fit: vi.fn((_appId: string, _box?: { width: number; height: number }) => true),
  leave: vi.fn((_appId: string) => true),
}))

vi.mock('@/shell/mount/useAppMount', () => ({
  presentAppSurfaceInPreview: api.present,
  fitAppSurfacePreview: api.fit,
  leaveAppSurfacePreview: api.leave,
}))

import AppSurfaceTile from '@/shell/mount/AppSurfaceTile.vue'

const TILE_STUB = {
  props: ['icon', 'pluginId', 'iconFile', 'tone', 'size'],
  template: '<span class="tile-stub" />',
}

function mountTile(
  props: Partial<{
    appId: string
    icon: string
    tone: 'info'
    thumbWidth: number
    thumbHeight: number
  }> = {},
) {
  return mount(AppSurfaceTile, {
    props: { appId: 'com.wasmnest.test.app', icon: 'grid', tone: 'info', ...props },
    global: { stubs: { ShellAppTile: TILE_STUB } },
    attachTo: document.body,
  })
}

beforeEach(() => {
  api.present.mockReset().mockImplementation(() => true)
  api.fit.mockClear()
  api.leave.mockClear()
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('AppSurfaceTile：卡内真实实例容器', () => {
  it('挂载即请求把实例搬进缩略区容器，并淡入真实画面', async () => {
    const wrapper = mountTile()
    await nextTick()

    expect(api.present).toHaveBeenCalledTimes(1)
    const [appId, box] = api.present.mock.calls[0]!
    expect(appId).toBe('com.wasmnest.test.app')
    expect((box as HTMLElement).classList.contains('app-live-surface')).toBe(true)
    expect(wrapper.find('.app-live-surface').classes()).toContain('app-live-surface')
    expect(wrapper.find('.app-live').attributes('data-live-state')).toBe('live')
    expect(wrapper.find('.app-live-fallback').classes()).toContain('is-hidden')

    wrapper.unmount()
  })

  it('实例缺失（装载失败 / 已停用）：停在品牌卡，不空白', async () => {
    api.present.mockReturnValueOnce(false)
    const wrapper = mountTile()
    await nextTick()

    expect(wrapper.find('.app-live').attributes('data-live-state')).toBe('fallback')
    expect(wrapper.find('.app-live-fallback').classes()).not.toContain('is-hidden')
    expect(wrapper.find('.tile-stub').exists()).toBe(true)

    wrapper.unmount()
  })

  it('卸载卡片把实例摘下（回后台保留，不销毁）', async () => {
    const wrapper = mountTile()
    await nextTick()
    wrapper.unmount()

    expect(api.leave).toHaveBeenCalledWith('com.wasmnest.test.app')
  })
})

/**
 * ResizeObserver 桩：容器尺寸变化时的**实测校正**路径。
 *
 * 回归背景（2026-11-07）：上一版为了让首帧就用解算尺寸，在“有解算值”时直接
 * 不装 ResizeObserver。结果解算值一旦偏了（卡片带首帧测量 / 应用区尺寸陈旧），
 * 画面会永久按错误比例缩放：缩略区像空白卡、或页面被裁掉下半截。现在解算值只
 * 负责首帧，观察器必须常驻并以 DOM 实测值重算。
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  observed: Element[] = []
  disconnected = false
  constructor(private readonly cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.observed.push(el)
  }
  disconnect(): void {
    this.disconnected = true
  }
  /** 模拟容器尺寸变化：回调里不传 entries（组件不消费） */
  trigger(): void {
    this.cb([], this as unknown as ResizeObserver)
  }
}

describe('AppSurfaceTile：解算尺寸只负责首帧，容器变化仍按 DOM 实测校正', () => {
  beforeEach(() => {
    FakeResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  it('有解算尺寸也安装观察器：首帧用解算值，变化时按实测值重算', async () => {
    const wrapper = mountTile({ thumbWidth: 640, thumbHeight: 400 })
    await nextTick()

    // 首帧：解算尺寸交给挂载层（不靠 DOM 量，避免先按兜底三等分缩一次再跳）
    expect(api.present).toHaveBeenCalledWith('com.wasmnest.test.app', expect.anything(), {
      width: 640,
      height: 400,
    })
    const [ro] = FakeResizeObserver.instances
    expect(ro, '有解算值也必须观察容器尺寸').toBeTruthy()
    expect(ro!.observed).toHaveLength(1)
    expect(ro!.observed[0]).toBe(wrapper.find('.app-live-surface').element)

    // 尺寸变化：只传 appId，让挂载层按容器 DOM 实测重新 contain（不再信任旧解算值）
    ro!.trigger()
    expect(api.fit).toHaveBeenLastCalledWith('com.wasmnest.test.app')

    wrapper.unmount()
    expect(ro!.disconnected).toBe(true)
  })

  it('解算尺寸变化（卡片数 / 窗口）时仍用新解算值重算；无 ResizeObserver 不报错', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const wrapper = mountTile({ thumbWidth: 640, thumbHeight: 400 })
    await nextTick()
    expect(api.present).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ thumbWidth: 320, thumbHeight: 200 })
    await nextTick()
    expect(api.fit).toHaveBeenLastCalledWith('com.wasmnest.test.app', { width: 320, height: 200 })

    wrapper.unmount()
  })
})
