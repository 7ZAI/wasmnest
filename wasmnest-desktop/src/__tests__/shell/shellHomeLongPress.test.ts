/**
 * 主屏应用图标长按手势行为锁（2026-10-28）
 *
 * 契约（真源 = ShellHome.vue 长按接线 + useLongPress）：
 * - 长按图标（500ms）→ 打开操作菜单（state.ctxMenu 置位，与右键同一覆层；
 *   用户安装应用的「卸载」随之在主屏可达）；
 * - 长按触发后的那次 click 不打开应用（长按不是打开）；
 * - 普通点击照常 openApp；右键菜单路径不受影响。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { ref } from 'vue'

const mocks = vi.hoisted(() => ({
  homeQ: null as unknown as Ref<string>,
  plugins: null as unknown as Ref<unknown[]>,
  ctxMenu: null as unknown as Ref<{ appId: string; x: number; y: number } | null>,
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

import ShellHome from '@/shell/components/ShellHome.vue'
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
    source: 'user-installed',
    permissions: [],
    enabled: true,
    autostart: false,
    ...overrides,
  } as ShellAppEntry
}

/** happy-dom 无 PointerEvent：Event + 显式字段合成（与 useLongPress 单测同口径） */
function pointer(type: string, opts: { clientX?: number; clientY?: number } = {}): Event {
  return Object.assign(new Event(type), { pointerId: 1, clientX: 0, clientY: 0, button: 0, ...opts })
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.homeQ = ref('')
  mocks.plugins = ref([entry({})])
  mocks.ctxMenu = ref(null)
  vi.clearAllMocks()
})
afterEach(() => vi.useRealTimers())

function mountHome() {
  return mount(ShellHome)
}

function firstTile(wrapper: ReturnType<typeof mountHome>) {
  return wrapper.find('.appicon')
}

describe('主屏应用图标长按', () => {
  it('长按图标 → 打开操作菜单（ctxMenu 置位，坐标取自指针）', async () => {
    const wrapper = mountHome()
    const tile = firstTile(wrapper)
    await tile.trigger('pointerdown', { pointerId: 1, clientX: 55, clientY: 66, button: 0 })
    vi.advanceTimersByTime(500)

    expect(mocks.ctxMenu.value).toEqual({ appId: 'com.wasmnest.test.app', x: 55, y: 66 })
  })

  it('长按触发后的那次 click 不打开应用；其后普通点击照常打开', async () => {
    const wrapper = mountHome()
    const tile = firstTile(wrapper)
    await tile.trigger('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, button: 0 })
    vi.advanceTimersByTime(500)
    await tile.trigger('click')
    expect(mocks.openApp).not.toHaveBeenCalled()

    await tile.trigger('click')
    expect(mocks.openApp).toHaveBeenCalledTimes(1)
    expect(mocks.openApp).toHaveBeenCalledWith('com.wasmnest.test.app')
  })

  it('普通点击（未长按）照常打开应用', async () => {
    const wrapper = mountHome()
    await firstTile(wrapper).trigger('click')
    expect(mocks.openApp).toHaveBeenCalledTimes(1)
  })

  it('按住后右键先行 → 长按计时撤销，不再重复触发', async () => {
    const wrapper = mountHome()
    const tile = firstTile(wrapper)
    await tile.trigger('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, button: 0 })
    // 右键：onCtx 先 cancel 计时再置菜单
    await tile.trigger('contextmenu', { clientX: 5, clientY: 5 })
    vi.advanceTimersByTime(1000)

    expect(mocks.openApp).not.toHaveBeenCalled()
    expect(mocks.ctxMenu.value).toEqual({ appId: 'com.wasmnest.test.app', x: 5, y: 5 })
  })
})
