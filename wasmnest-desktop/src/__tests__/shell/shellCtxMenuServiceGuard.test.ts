/**
 * 桌面壳「右键菜单」系统服务守卫（manifest kind）
 *
 * 需求（keepalive spec `.scratch/2026-10-23-app-surface-keepalive` §3.3 + 2026-10-23 裁决）：
 * - 服务型应用（L1/L2）右键菜单不渲染「停用」项——关闭唯一入口 = 应用管理页；
 * - 运行中的服务应用也不得渲染「启动」（v-else 链同判据：不能对着运行中的服务
 *   应用显示启动）；
 * - 业务应用行为不变：运行中显「停用」、未运行显「启动」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  ctxMenu: { value: null as { appId: string; x: number; y: number } | null },
  dialog: { value: null as string | null },
  dialogAppId: { value: null as string | null },
  openApp: vi.fn(),
  stopApp: vi.fn(),
  openSys: vi.fn(),
}))

const appsState = vi.hoisted(() => ({
  plugins: {
    value: [] as Array<{ id: string; name: string; kind?: string; state?: string; source?: string }>,
  },
}))

vi.mock('@/shell/composables/useShellState', () => ({
  useShellState: () => ({
    ctxMenu: mocks.ctxMenu,
    dialog: mocks.dialog,
    dialogAppId: mocks.dialogAppId,
    openApp: mocks.openApp,
    stopApp: mocks.stopApp,
    openSys: mocks.openSys,
  }),
}))

vi.mock('@/shell/composables/useShellApps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shell/composables/useShellApps')>()
  return {
    ...actual,
    useShellApps: () => ({
      appOf: (id: string) => appsState.plugins.value.find((p) => p.id === id),
    }),
  }
})

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import ShellContextMenu from '@/shell/components/ShellContextMenu.vue'

/** 种子：菜单目标应用（kind = 装配角色；state 决定运行中分支）+ 打开的菜单态 */
function seedMenuTarget(kind: string | undefined, state: string) {
  appsState.plugins.value = [
    { id: 'com.wasmnest.monitor', name: 'Monitor', kind, state, source: 'bundled' },
  ]
  mocks.ctxMenu.value = { appId: 'com.wasmnest.monitor', x: 10, y: 10 }
}

function mountMenu() {
  return mount(ShellContextMenu, {
    global: { stubs: { ShellIcon: true, teleport: true } },
  })
}

beforeEach(() => {
  mocks.ctxMenu.value = null
  mocks.dialog.value = null
  mocks.dialogAppId.value = null
  appsState.plugins.value = []
  vi.clearAllMocks()
})

describe('桌面右键菜单：服务型应用守卫（keepalive spec §3.3）', () => {
  it('运行中的服务应用不渲染「停用」与「启动」，仍保留管理 / 权限', () => {
    seedMenuTarget('internal-business', 'running')
    const wrapper = mountMenu()

    expect(wrapper.text(), '关闭唯一入口 = 应用管理页，右键不给停用').not.toContain('shell.ctx.stop')
    expect(wrapper.text(), '运行中的服务应用不得显示启动').not.toContain('shell.ctx.startOpen')
    expect(wrapper.text()).toContain('shell.ctx.manage')
    expect(wrapper.text()).toContain('shell.ctx.perms')
  })

  it('运行中的业务应用仍渲染「停用」（守卫不外溢）', () => {
    seedMenuTarget('business-app', 'running')
    const wrapper = mountMenu()

    expect(wrapper.text()).toContain('shell.ctx.stop')
  })

  it('未运行的服务应用仍可「启动」（只限制关闭入口，不限制打开）', () => {
    seedMenuTarget('internal-business', 'disabled')
    const wrapper = mountMenu()

    expect(wrapper.text()).toContain('shell.ctx.startOpen')
    expect(wrapper.text()).not.toContain('shell.ctx.stop')
  })
})
