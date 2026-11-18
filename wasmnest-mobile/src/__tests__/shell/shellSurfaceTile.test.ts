/**
 * ShellSurfaceTile 行为单测（移动端多任务卡 = 真实实例，2026-10-30）
 *
 * 运行中的卡片把保活实例搬进缩略区；未运行 / 实例缺失时停在品牌卡（图标 + 真实
 * 元信息）。卡片卸载必须把实例摘下回后台（保留实例，不销毁）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'

const api = vi.hoisted(() => ({
  present: vi.fn((_appId: string, _box: HTMLElement) => true),
  fit: vi.fn((_appId: string) => true),
  leave: vi.fn((_appId: string) => true),
}))

vi.mock('@/shell/surfaceRuntime', () => ({
  presentSurfaceInPreview: api.present,
  fitSurfacePreview: api.fit,
  leaveSurfacePreview: api.leave,
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import ShellSurfaceTile from '@/shell/components/ShellSurfaceTile.vue'
import type { ShellApp } from '@/shell/types'

const APP: ShellApp = {
  id: 'com.wasmnest.demo',
  name: 'Demo',
  version: '1.0.0',
  state: 'running',
  permissions: [{ key: 'fs:read', granted: true }],
  contributions: {},
}

const ICON_STUB = { template: '<span class="app-icon-stub" />' }

function mountTile(live = true) {
  return mount(ShellSurfaceTile, {
    props: { app: APP, live },
    global: { stubs: { ShellAppIcon: ICON_STUB } },
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

describe('ShellSurfaceTile：卡内真实实例容器', () => {
  it('运行中的卡片：把实例搬进缩略区容器并淡入真实画面', async () => {
    const wrapper = mountTile(true)
    await nextTick()

    expect(api.present).toHaveBeenCalledTimes(1)
    const [appId, box] = api.present.mock.calls[0]!
    expect(appId).toBe('com.wasmnest.demo')
    expect((box as HTMLElement).classList.contains('shell-live-surface')).toBe(true)
    expect(wrapper.find('.shell-live').attributes('data-live-state')).toBe('live')
    expect(wrapper.find('.shell-live-fallback').classes()).toContain('is-hidden')

    wrapper.unmount()
  })

  it('未运行的最近使用卡：不尝试搬运，显示图标 + 真实元信息', async () => {
    const wrapper = mountTile(false)
    await nextTick()

    expect(api.present).not.toHaveBeenCalled()
    expect(wrapper.find('.shell-live').attributes('data-live-state')).toBe('fallback')
    expect(wrapper.find('.shell-live-fallback').classes()).not.toContain('is-hidden')
    expect(wrapper.text()).toContain('v1.0.0')
    expect(wrapper.text()).toContain('shell.apps.permissionCount')

    wrapper.unmount()
  })

  it('实例缺失（未打开过 / 装载失败）：停在品牌卡，不空白', async () => {
    api.present.mockReturnValueOnce(false)
    const wrapper = mountTile(true)
    await nextTick()

    expect(wrapper.find('.shell-live').attributes('data-live-state')).toBe('fallback')
    expect(wrapper.find('.app-icon-stub').exists()).toBe(true)

    wrapper.unmount()
  })

  it('卡片卸载：把实例摘下回后台（不销毁）', async () => {
    const wrapper = mountTile(true)
    await nextTick()
    wrapper.unmount()

    expect(api.leave).toHaveBeenCalledWith('com.wasmnest.demo')
  })

  it('应用转为未运行：同一张卡摘回实例并回退品牌卡', async () => {
    const wrapper = mountTile(true)
    await nextTick()

    await wrapper.setProps({ live: false })
    await nextTick()

    expect(api.leave).toHaveBeenCalledWith('com.wasmnest.demo')
    expect(wrapper.find('.shell-live').attributes('data-live-state')).toBe('fallback')

    wrapper.unmount()
  })
})
