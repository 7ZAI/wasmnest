/**
 * 胶囊菜单停止项按 kind 分词语（manifest 装配角色）
 *
 * 需求（2026-10-23 用户裁决）：停止动作按 wasm 类型分词语——系统服务
 * （L1 `basic-service` / L2 `internal-business`）说「停止服务」，业务应用仍是
 * 「停用此应用」。判据只看 kind，不硬编码插件 id。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { ref } from 'vue'
import type { ShellApp } from '@/shell/types'

const mocks = vi.hoisted(() => ({
  capsuleAppId: null as unknown as Ref<string | null>,
  app: null as unknown as ShellApp | null,
  closeCapsule: vi.fn(),
  openDetail: vi.fn(),
  stop: vi.fn(async () => true),
}))

vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({ getApp: () => mocks.app, stop: mocks.stop }),
}))

vi.mock('@/shell/composables/useShellNavigation', () => ({
  useShellNavigation: () => ({ openDetail: mocks.openDetail }),
}))

vi.mock('@/shell/composables/useShellOverlays', () => ({
  useShellOverlays: () => ({
    capsuleAppId: mocks.capsuleAppId,
    closeCapsule: mocks.closeCapsule,
  }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import ShellCapsuleMenu from '@/shell/components/ShellCapsuleMenu.vue'

function appOf(kind: string): ShellApp {
  return {
    id: 'com.wasmnest.monitor',
    name: 'Monitor',
    version: '0.1.0',
    state: 'running',
    kind,
    permissions: [],
    contributions: {},
  }
}

/** 菜单里的平台停止项文案（Teleport 到 body，故查 document） */
function stopLabel(): string {
  const btn = [...document.body.querySelectorAll('button')].find((el) =>
    el.textContent?.trim().startsWith('shell.capsule.disable'),
  )
  return btn?.textContent?.trim() ?? ''
}

async function mountMenu(kind: string) {
  mocks.capsuleAppId = ref('com.wasmnest.monitor')
  mocks.app = appOf(kind)
  const wrapper = mount(ShellCapsuleMenu, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('胶囊菜单：停止项按 wasm 类型分词语', () => {
  it('L1 系统服务说「停止服务」', async () => {
    const wrapper = await mountMenu('basic-service')
    expect(stopLabel()).toBe('shell.capsule.disableService')
    wrapper.unmount()
  })

  it('L2 内部业务说「停止服务」', async () => {
    const wrapper = await mountMenu('internal-business')
    expect(stopLabel()).toBe('shell.capsule.disableService')
    wrapper.unmount()
  })

  it('业务应用仍说「停用此应用」', async () => {
    const wrapper = await mountMenu('business-app')
    expect(stopLabel()).toBe('shell.capsule.disable')
    wrapper.unmount()
  })
})
