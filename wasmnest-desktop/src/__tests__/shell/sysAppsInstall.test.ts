/**
 * 「应用管理」外部应用包安装入口行为锁（2026-10-28）
 *
 * 契约（真源 = SysAppsView.vue 安装卡 + useShellState.installApp）：
 * - 安装卡常驻首卡，按钮触发 state.installApp()（选包 → 新装 / 升级裁决在状态层）；
 * - 安装进行中（installing）按钮禁用（防重复选包）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { ref } from 'vue'

const mocks = vi.hoisted(() => ({
  plugins: null as unknown as Ref<unknown[]>,
  busyId: null as unknown as Ref<string | null>,
  installing: null as unknown as Ref<boolean>,
  installApp: vi.fn(),
  openSys: vi.fn(),
}))

vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    plugins: mocks.plugins as never,
    busyId: mocks.busyId as never,
    installing: mocks.installing as never,
  }),
  isServiceKind: (kind?: string) => kind === 'basic-service' || kind === 'internal-business',
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({
    openSys: mocks.openSys,
    installApp: mocks.installApp,
  }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import SysAppsView from '@/shell/sys/SysAppsView.vue'
import type { ShellAppEntry } from '@/shell/composables/useShellApps'

function entry(overrides: Partial<ShellAppEntry>): ShellAppEntry {
  return {
    id: 'com.wasmnest.test.app',
    pluginId: 'com.wasmnest.test.app',
    name: 'App',
    version: '1.0.0',
    icon: 'grid',
    tone: 'system',
    state: 'dormant',
    pluginState: 'loaded',
    kind: 'business-app',
    source: 'builtin',
    permissions: [],
    enabled: true,
    autostart: false,
    ...overrides,
  } as ShellAppEntry
}

beforeEach(() => {
  mocks.plugins = ref([])
  mocks.busyId = ref(null)
  mocks.installing = ref(false)
  vi.clearAllMocks()
})

describe('应用管理：安装外部应用入口', () => {
  it('安装卡常驻（无应用时也在），按钮点击走 installApp 编排', async () => {
    const wrapper = mount(SysAppsView)
    const installBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('shell.apps.install'))
    expect(installBtn, '安装卡按钮必须在位').toBeDefined()

    await installBtn!.trigger('click')
    expect(mocks.installApp).toHaveBeenCalledTimes(1)
  })

  it('安装进行中按钮禁用（不占 busyId，走 installing）', () => {
    mocks.installing.value = true
    mocks.plugins.value = [entry({})]
    const wrapper = mount(SysAppsView)

    const installBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('shell.apps.install'))
    expect(installBtn!.attributes('disabled')).toBeDefined()
  })
})
