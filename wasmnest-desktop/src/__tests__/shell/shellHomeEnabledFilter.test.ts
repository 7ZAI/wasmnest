import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { ref } from 'vue'

/**
 * 主屏「启用 = 主屏入口可见性」行为锁（2026-10-21 用户裁决）
 *
 * 契约（真源 = `useShellApps.ts#ShellAppEntry.enabled` 文档 + 宿主
 * lifecycle.rs `ENABLED_KEY_PREFIX` 文档）：
 * - 停用（enabled=false）的应用不在主屏应用网格与搜索结果中出现；
 * - 启用的应用正常出现（默认与搜索两条路径）；
 * - 无搜索但全部停用 → 空态给「应用入口已全部停用」提示（恢复入口在应用管理）；
 * - 有搜索且无匹配 → 维持原有 noApps 提示；
 * - 停用不影响注册表投影本身（应用管理页仍完整可见，此处投影由
 *   useShellApps.test.ts 覆盖）。
 */

const mocks = vi.hoisted(() => ({
  homeQ: null as unknown as Ref<string>,
  plugins: null as unknown as Ref<unknown[]>,
  openApp: vi.fn(),
  openSys: vi.fn(),
}))

vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    plugins: mocks.plugins as never,
    displayStates: ref({}) as never,
    tones: ref({}) as never,
  }),
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({
    homeQ: mocks.homeQ,
    openApp: mocks.openApp,
    openSys: mocks.openSys,
    ctxMenu: ref(null),
    hasAppSession: () => false,
  }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import ShellHome from '@/shell/components/ShellHome.vue'
import type { ShellAppEntry } from '@/shell/composables/useShellApps'

/** 投影条目夹具（只给主屏消费的字段，其余无关者置缺省） */
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
    source: 'builtin',
    permissions: [],
    enabled: true,
    autostart: false,
    ...overrides,
  } as ShellAppEntry
}

describe('主屏入口可见性（启用偏好）过滤', () => {
  beforeEach(() => {
    mocks.homeQ = ref('')
    mocks.plugins = ref([])
    vi.clearAllMocks()
  })

  it('停用的应用不出现在主屏应用网格，启用的正常出现', () => {
    mocks.plugins.value = [
      entry({ id: 'com.wasmnest.on', pluginId: 'com.wasmnest.on', name: 'VisibleApp', enabled: true }),
      entry({ id: 'com.wasmnest.off', pluginId: 'com.wasmnest.off', name: 'HiddenApp', enabled: false }),
    ]
    const wrapper = mount(ShellHome, { global: { stubs: { ShellAppTile: true, ShellIcon: true } } })

    expect(wrapper.text()).toContain('VisibleApp')
    expect(wrapper.text()).not.toContain('HiddenApp')
  })

  it('搜索命中启用应用正常出现；搜索词只命中停用应用 → 不显示、维持 noApps 空态', () => {
    mocks.plugins.value = [
      entry({ id: 'com.wasmnest.off', pluginId: 'com.wasmnest.off', name: 'HiddenApp', enabled: false }),
      entry({ id: 'com.wasmnest.on', pluginId: 'com.wasmnest.on', name: 'VisibleApp', enabled: true }),
    ]
    mocks.homeQ.value = 'Visible'
    const visible = mount(ShellHome, { global: { stubs: { ShellAppTile: true, ShellIcon: true } } })
    expect(visible.text()).toContain('VisibleApp')
    expect(visible.text()).not.toContain('HiddenApp')

    // 搜索词只命中停用应用：入口不出现（启用的也不匹配），空态仍是 noApps 而非 noneEnabled
    mocks.homeQ.value = 'Hidden'
    const hidden = mount(ShellHome, { global: { stubs: { ShellAppTile: true, ShellIcon: true } } })
    expect(hidden.text()).not.toContain('HiddenApp')
    expect(hidden.text()).toContain('shell.home.noApps')
    expect(hidden.text()).not.toContain('shell.home.noneEnabled')
  })

  it('全部停用且无搜索 → noneEnabled 空态提示（在应用管理可恢复）', () => {
    mocks.plugins.value = [
      entry({ id: 'com.wasmnest.a', pluginId: 'com.wasmnest.a', name: 'AppA', enabled: false }),
      entry({ id: 'com.wasmnest.b', pluginId: 'com.wasmnest.b', name: 'AppB', enabled: false }),
    ]
    const wrapper = mount(ShellHome, { global: { stubs: { ShellAppTile: true, ShellIcon: true } } })

    expect(wrapper.text()).toContain('shell.home.noneEnabled')
  })

  it('搜索无匹配 → 维持 noApps 空态（不误报「全部停用」）', () => {
    mocks.plugins.value = [
      entry({ id: 'com.wasmnest.on', pluginId: 'com.wasmnest.on', name: 'VisibleApp', enabled: true }),
    ]
    mocks.homeQ.value = 'zzz-no-match'
    const wrapper = mount(ShellHome, { global: { stubs: { ShellAppTile: true, ShellIcon: true } } })

    expect(wrapper.text()).toContain('shell.home.noApps')
    expect(wrapper.text()).not.toContain('shell.home.noneEnabled')
  })
})
