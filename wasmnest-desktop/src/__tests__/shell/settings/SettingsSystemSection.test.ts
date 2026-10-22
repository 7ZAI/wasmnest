import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

/**
 * 设置页「系统设置」分组（SettingsSystemSection）
 *
 * 该卡承载两类行：
 *   - 宿主机制行：防止休眠开关（写 settings store，由父组件防抖持久化）；
 *   - 应用贡献的动态扩展设置项：别的应用对系统设置的动态扩展（用户 2026-10-22
 *     裁决——无固定「扩展设置」分组），有注册才渲染，按 order 排序，有动作为
 *     按钮 / 无动作为静态行，动作失败只进日志。
 */

const storeMocks = vi.hoisted(() => ({
  settings: { network: { prevent_sleep: true } },
}))

vi.mock('@/stores/settings', async () => {
  const { reactive } = await import('vue')
  // Pinia store 是响应式的：计算属性才随写重算，测试 mock 也要响应式
  return { useSettingsStore: () => ({ settings: reactive(storeMocks.settings) }) }
})

const loggerMocks = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('@/utils/frontendLogger', () => ({ logger: { error: loggerMocks.error } }))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import SettingsSystemSection from '@/shell/settings/SettingsSystemSection.vue'
import { clearShellExtensions, registerSettingsEntry } from '@/shell/extensions'

beforeEach(() => {
  vi.clearAllMocks()
  clearShellExtensions()
  storeMocks.settings.network.prevent_sleep = true
})

describe('设置页 — 系统设置', () => {
  it('防止休眠开关写 settings store', async () => {
    const wrapper = mount(SettingsSystemSection)
    expect(wrapper.find('[role="switch"]').attributes('aria-checked')).toBe('true')

    await wrapper.find('[role="switch"]').trigger('click')

    expect(storeMocks.settings.network.prevent_sleep).toBe(false)
    expect(wrapper.find('[role="switch"]').attributes('aria-checked')).toBe('false')
  })

  it('无注册时不渲染扩展行（无固定「扩展设置」占位）', () => {
    const wrapper = mount(SettingsSystemSection)
    expect(wrapper.findAll('[data-entry-id]')).toHaveLength(0)
  })

  it('注册项按 order 渲染；有动作是按钮，无动作是静态行', async () => {
    const select = vi.fn()
    registerSettingsEntry({ id: 'later', label: 'Later', order: 20 })
    registerSettingsEntry({
      id: 'first',
      label: 'First',
      hint: 'hint',
      order: 10,
      onSelect: select,
    })

    const wrapper = mount(SettingsSystemSection)
    const rows = wrapper.findAll('[data-entry-id]')
    expect(rows.map((row) => row.attributes('data-entry-id'))).toEqual(['first', 'later'])
    expect(rows[0].element.tagName).toBe('BUTTON')
    expect(rows[1].element.tagName).toBe('DIV')

    await rows[0].trigger('click')
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('扩展动作失败只进日志，不冒泡到界面', async () => {
    registerSettingsEntry({
      id: 'broken',
      label: 'Broken',
      onSelect: () => Promise.reject(new Error('boom')),
    })

    const wrapper = mount(SettingsSystemSection)
    await wrapper.find('[data-entry-id="broken"]').trigger('click')
    await vi.waitFor(() => expect(loggerMocks.error).toHaveBeenCalled())
    expect(loggerMocks.error.mock.calls[0][0]).toContain('broken')
  })
})
