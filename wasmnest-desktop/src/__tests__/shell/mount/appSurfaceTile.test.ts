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
  present: vi.fn((_appId: string, _el: HTMLElement) => true),
  fit: vi.fn((_appId: string) => true),
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

function mountTile() {
  return mount(AppSurfaceTile, {
    props: { appId: 'com.wasmnest.test.app', icon: 'grid', tone: 'info' },
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
