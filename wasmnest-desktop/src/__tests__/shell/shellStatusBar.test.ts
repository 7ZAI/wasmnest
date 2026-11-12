import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'

/**
 * 平台状态栏
 *
 * 锁四条行为：
 *   1. 常驻宿主机制事实（就绪 / 应用数 / 待审批）可直接读；
 *   2. 扩展项按 align 分左右两区、按 order 排序；
 *   3. 文本项有 onSelect 才是按钮，无 onSelect 是静态文本；
 *   4. 扩展动作失败只进日志，不拖垮状态栏；
 *   5. 扩展自定义组件渲染抛错被边界吞掉，不冒泡到全局 errorHandler。
 */

const mocks = vi.hoisted(() => ({
  listReady: null as unknown as Ref<boolean>,
  plugins: null as unknown as Ref<Array<{ id: string }>>,
  approvalApps: null as unknown as Ref<Array<{ id: string }>>,
  openSys: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('@/shell/composables/useShellApps', async () => {
  const { ref } = await import('vue')
  mocks.listReady = ref(true)
  mocks.plugins = ref([{ id: 'bedcode' }, { id: 'ai-chatbox' }])
  mocks.approvalApps = ref([{ id: 'ai-chatbox' }])
  return {
    useShellApps: () => ({
      listReady: mocks.listReady,
      plugins: mocks.plugins,
      approvalApps: mocks.approvalApps,
    }),
  }
})

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({ openSys: mocks.openSys }),
}))

vi.mock('@/utils/frontendLogger', () => ({ logger: { error: mocks.loggerError } }))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import ShellStatusBar from '@/shell/components/ShellStatusBar.vue'
import { clearShellExtensions, registerStatusBarItem } from '@/shell/extensions'

describe('平台状态栏', () => {
  beforeEach(() => {
    clearShellExtensions()
    vi.clearAllMocks()
    mocks.listReady.value = true
  })

  it('渲染宿主机制事实；待审批入口打开权限页', async () => {
    const wrapper = mount(ShellStatusBar)

    expect(wrapper.text()).toContain('shell.statusBar.ready')
    expect(wrapper.text()).toContain('shell.statusBar.apps')
    expect(wrapper.text()).toContain('shell.statusBar.approvals')

    await wrapper.find('.sb-warn').trigger('click')
    expect(mocks.openSys).toHaveBeenCalledWith('perms')
  })

  it('清单未就绪时显示加载态，且不渲染应用数', () => {
    mocks.listReady.value = false
    const wrapper = mount(ShellStatusBar)

    expect(wrapper.text()).toContain('shell.statusBar.loading')
    expect(wrapper.text()).not.toContain('shell.statusBar.apps')
  })

  it('扩展项按 align 分区、按 order 排序；无动作为静态文本', () => {
    registerStatusBarItem({ id: 'start-late', label: 'Start late', order: 20 })
    registerStatusBarItem({ id: 'start-early', label: 'Start early', order: 10 })
    registerStatusBarItem({ id: 'end-item', label: 'End item', align: 'end', order: 5 })
    registerStatusBarItem({ id: 'static', label: 'Static' })

    const wrapper = mount(ShellStatusBar)
    const startLabels = wrapper
      .find('.sb-side:not(.sb-end)')
      .findAll('[data-ext-id]')
      .map((item) => item.text())
    const endLabels = wrapper
      .find('.sb-side.sb-end')
      .findAll('[data-ext-id]')
      .map((item) => item.text())

    expect(startLabels).toEqual(['Start early', 'Start late', 'Static'])
    expect(endLabels).toEqual(['End item'])

    // 无 onSelect → span（静态文本），不造点了没反应的按钮
    expect(wrapper.find('.sb-side:not(.sb-end) .sb-item:last-child').element.tagName).toBe('SPAN')
  })

  it('有动作的文本项是按钮；点击执行注册动作', async () => {
    const select = vi.fn()
    registerStatusBarItem({ id: 'action', label: 'Action', onSelect: select })

    const wrapper = mount(ShellStatusBar)
    const button = wrapper.find('.sb-side:not(.sb-end) button.sb-item')
    expect(button.text()).toBe('Action')

    await button.trigger('click')
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('自定义 component 项直接渲染扩展内容', () => {
    registerStatusBarItem({
      id: 'custom',
      component: { template: '<i class="custom-ext">custom</i>' },
    })

    const wrapper = mount(ShellStatusBar)
    expect(wrapper.find('.custom-ext').exists()).toBe(true)
  })

  it('扩展动作失败只进日志，状态栏保持可用', async () => {
    registerStatusBarItem({
      id: 'broken',
      label: 'Broken',
      onSelect: () => Promise.reject(new Error('boom')),
    })

    const wrapper = mount(ShellStatusBar)
    await wrapper.find('.sb-side:not(.sb-end) button.sb-item').trigger('click')
    await flushPromises()

    expect(mocks.loggerError).toHaveBeenCalled()
    expect(mocks.loggerError.mock.calls[0][0]).toContain('broken')
    expect(wrapper.find('.shell-statusbar').exists()).toBe(true)
  })

  it('扩展自定义组件渲染抛错被边界吞掉，其余条目不受影响', () => {
    const Boom = {
      render: () => {
        throw new Error('render boom')
      },
    }
    registerStatusBarItem({ id: 'boom', component: Boom })
    registerStatusBarItem({ id: 'ok', label: 'OK ext' })

    const wrapper = mount(ShellStatusBar)

    // 渲染错误只进日志并就地降级，不冒泡成挂载异常
    expect(mocks.loggerError).toHaveBeenCalled()
    const [message, error] = mocks.loggerError.mock.calls[0]
    expect(message).toContain('status bar extension render failed')
    expect((error as Error).message).toContain('boom')
    // 失败的扩展项不再渲染，其余条目照常
    expect(wrapper.text()).toContain('OK ext')
  })
})
