/**
 * 主屏图块入场频率锁（动效优化 2026-11-12）
 *
 * 契约：错峰入场只在本次应用会话第一次进主屏时播。
 * 主屏随路由重挂（ShellHost 的 `v-if="isHome"`），每次回主屏都重播 320ms 动画 +
 * 最多 210ms 延迟，会让高频「回家」动作带上固定等待；搜索是键盘高频动作，
 * 一开始输入就撤掉入场动画，结果即时落终态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref, type Ref } from 'vue'

const mocks = vi.hoisted(() => ({
  homeQ: null as unknown as Ref<string>,
  plugins: null as unknown as Ref<unknown[]>,
  ctxMenu: null as unknown as Ref<unknown>,
  openApp: vi.fn(),
  openSys: vi.fn(),
}))

vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    plugins: mocks.plugins as never,
    displayStates: ref({}) as never,
    tones: ref({}) as never,
  }),
  isServiceKind: (kind?: string) => kind === 'basic-service' || kind === 'internal-business',
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({
    homeQ: mocks.homeQ,
    openApp: mocks.openApp,
    openSys: mocks.openSys,
    ctxMenu: mocks.ctxMenu,
    hasAppSession: () => false,
  }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

function entry() {
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
    source: 'user-installed',
    permissions: [],
    enabled: true,
    autostart: false,
  }
}

/** 每个用例重新求值 ShellHome 模块：模块级「已播过入场」标记随之复位 */
async function freshShellHome() {
  vi.resetModules()
  const mod = await import('@/shell/components/ShellHome.vue')
  return mod.default
}

beforeEach(() => {
  mocks.homeQ = ref('')
  mocks.plugins = ref([entry()])
  mocks.ctxMenu = ref(null)
  vi.clearAllMocks()
})

describe('主屏图块入场', () => {
  it('首次挂载播错峰入场，同会话再次挂载直接落终态', async () => {
    const ShellHome = await freshShellHome()

    const first = mount(ShellHome)
    expect(first.find('.home-scroll').classes()).toContain('home-entrance')
    first.unmount()

    const second = mount(ShellHome)
    expect(second.find('.home-scroll').classes()).not.toContain('home-entrance')
    second.unmount()
  })

  it('开始搜索即撤掉入场动画（键盘高频动作不播装饰动效）', async () => {
    const ShellHome = await freshShellHome()
    const wrapper = mount(ShellHome)
    expect(wrapper.find('.home-scroll').classes()).toContain('home-entrance')

    mocks.homeQ.value = 'app'
    await nextTick()

    expect(wrapper.find('.home-scroll').classes()).not.toContain('home-entrance')
    wrapper.unmount()
  })
})
