/**
 * 应用详情页状态响应性回归锁（2026-10-27 真机：停止服务后仍显示「运行中」）
 *
 * 被测：`ShellAppDetailScreen.vue` × `ShellRegistry.getApp`
 *
 * | 契约 | 场景 | 预期 |
 * |---|---|---|
 * | C-DR1 | 停止后注册表就地回写（patchApp → stopped） | 详情页状态徽标立即变「未启动」，停止按钮禁用 |
 * | C-DR2 | 清单重拉落地（refresh → disabled） | 详情页状态徽标变「已停用」，停止按钮仍禁用 |
 *
 * 根因锁：getApp 必须从响应式清单读取——读内部 Map 时 computed 不重算，界面停在旧值。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { getShellRegistry } from '@/shell/registry'
import { useShellApps } from '@/shell/composables/useShellApps'
import { resetShellNavigation, useShellNavigation } from '@/shell/composables/useShellNavigation'
import type { ShellApp, ShellAppSource } from '@/shell/types'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
// useShellApps 直接取 i18n.global.t 落通知文案：替换为最小可调用面，避免真实 i18n 初始化
vi.mock('@/locales', () => ({ default: { global: { t: (key: string) => key } } }))
vi.mock('@/shell/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

import ShellAppDetailScreen from '@/shell/components/screens/ShellAppDetailScreen.vue'

const APP_ID = 'com.wasmnest.monitor'
const SOURCE_ID = 'detail-reactivity-source'

function makeApp(state: ShellApp['state']): ShellApp {
  return {
    id: APP_ID,
    name: 'Monitor',
    version: '0.1.0',
    state,
    kind: 'internal-business',
    permissions: [],
    contributions: {},
  }
}

let current = makeApp('running')

const source: ShellAppSource = {
  id: SOURCE_ID,
  list: async () => [current],
  launch: async () => {},
  stop: async () => {},
  isAutostart: async () => false,
  setAutostart: async () => {},
}

const registry = getShellRegistry()
const nav = useShellNavigation()

function mountDetail() {
  return mount(ShellAppDetailScreen, {
    global: {
      stubs: {
        ShellAppIcon: true,
        ConfirmDialog: {
          props: ['modelValue'],
          emits: ['update:modelValue', 'confirm'],
          template: '<div v-if="modelValue" class="dialog-stub" />',
        },
      },
    },
  })
}

function stopButton(wrapper: ReturnType<typeof mountDetail>) {
  return wrapper
    .findAll('button')
    .find((b) => b.text().includes('shell.detail.stopService'))!
}

beforeEach(() => {
  current = makeApp('running')
  resetShellNavigation()
  registry.registerSource(source)
  registry.upsertApps(SOURCE_ID, [current])
  nav.openDetail(APP_ID)
})

afterEach(() => {
  registry.clearSource(SOURCE_ID)
})

describe('停止服务后的详情页状态闭环', () => {
  it('should_refreshStateAndDisableStop_when_patchedToStopped', async () => {
    const wrapper = mountDetail()
    await flushPromises()

    expect(wrapper.text()).toContain('shell.common.running')
    expect((stopButton(wrapper).element as HTMLButtonElement).disabled).toBe(false)

    // 停止动作的第一步：注册表就地回写（useShellApps.stop 的乐观置位）
    registry.patchApp(APP_ID, { state: 'stopped' })
    await nextTick()

    expect(wrapper.text(), '状态徽标必须随注册表更新').toContain('shell.common.stopped')
    expect(wrapper.text()).not.toContain('shell.common.running')
    expect(
      (stopButton(wrapper).element as HTMLButtonElement).disabled,
      '已停止后停止按钮必须禁用',
    ).toBe(true)

    wrapper.unmount()
  })

  it('should_renderDisabledState_when_manifestRefetchLands', async () => {
    const wrapper = mountDetail()
    await flushPromises()

    // 停止动作的第二步：后端清单重拉（deactivated → 已停用）
    current = makeApp('disabled')
    await useShellApps().refresh()
    await flushPromises()

    expect(wrapper.text()).toContain('shell.common.disabled')
    expect(wrapper.text()).not.toContain('shell.common.running')
    expect((stopButton(wrapper).element as HTMLButtonElement).disabled).toBe(true)

    wrapper.unmount()
  })
})
