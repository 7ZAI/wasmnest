/**
 * 表面保活装载层行为（`.scratch/2026-10-23-app-surface-keepalive/spec.md` §2.1 / §2.2）
 *
 * 与 `appSurfaceRegistry.test.ts`（纯记账）互补：这里经**真实动态 import** 装载
 * 临时 bundle，验证 `useAppMount` 的对外行为——
 *   - 首次 mount 建实例；再次 mount 同一 app 只 attach（不重建、不换令牌）；
 *   - detach 不销毁；dispose 才 unmount 并释放界面租约；
 *   - 并发首次 mount 合并为一次（不许出现两个实例争同一 appId，造成孤儿实例与
 *     重复 acquire）。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppMountEnv } from '@/shell/mount/useAppMount'

/** 宿主 asset 目录 + bundle 源码 + 装载观测（在途跟踪用的同一份真源） */
const asset = vi.hoisted(() => ({
  root: '',
  sources: new Map<string, string>(),
  invoke: vi.fn(async (_command: string, _args?: unknown) => asset.root),
}))

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) =>
    `data:text/javascript,${encodeURIComponent(asset.sources.get(path) ?? '')}`,
}))
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => parts.join('/'),
}))
vi.mock('@/utils/invoke', () => ({
  invoke: (command: string, args?: Record<string, unknown>) => asset.invoke(command, args),
}))

import {
  MOUNT_CONTRACT,
  detachAppBundle,
  disposeAppBundle,
  listAppSurfaces,
  mountAppBundle,
} from '@/shell/mount/useAppMount'

declare global {
  // eslint-disable-next-line no-var
  var __surfaceLifecycle: { mounts: string[]; unmounts: string[]; active: string[] }
}

function writeBundle(appId: string): void {
  asset.sources.set(
    join(asset.root, appId, 'index.js'),
    [
      `export const mountContract = '${MOUNT_CONTRACT}'`,
      `export async function mountApp(root) {`,
      `  globalThis.__surfaceLifecycle.mounts.push(${JSON.stringify(appId)})`,
      `  root.innerHTML = '<div data-app="' + ${JSON.stringify(appId)} + '"></div>'`,
      `  return {`,
      `    async unmount() { globalThis.__surfaceLifecycle.unmounts.push(${JSON.stringify(appId)}) },`,
      `    setActive(active) {`,
      `      globalThis.__surfaceLifecycle.active.push(`,
      `        ${JSON.stringify(appId)} + ':' + String(active),`,
      `      )`,
      `    },`,
      `  }`,
      `}`,
    ].join('\n'),
  )
}

function mountEnv(appId: string): AppMountEnv {
  return {
    appId,
    mountContract: MOUNT_CONTRACT,
    invoke: async () => null,
    appInvoke: async () => null,
    appStorageGet: async () => undefined,
    appStorageSet: async () => {},
    appStorageDelete: async () => {},
    locale: 'zh-CN',
    theme: 'dark',
    initialRoute: '/',
  }
}

/** 某个命令被调用了几次（invoke 的 mock 参数是 [command, args]） */
function invokeCount(command: string): number {
  return asset.invoke.mock.calls.filter((call) => call[0] === command).length
}

/** 已入文档的挂载槽（`app-instance-host` 的归属断言需要真实父链） */
function createSlot(): HTMLElement {
  const slot = document.createElement('div')
  document.body.appendChild(slot)
  return slot
}

beforeAll(() => {
  asset.root = mkdtempSync(join(tmpdir(), 'wasmnest-surface-lifecycle-'))
  globalThis.__surfaceLifecycle = { mounts: [], unmounts: [], active: [] }
})

afterAll(() => {
  asset.sources.clear()
})

beforeEach(() => {
  globalThis.__surfaceLifecycle.mounts.length = 0
  globalThis.__surfaceLifecycle.unmounts.length = 0
  globalThis.__surfaceLifecycle.active.length = 0
  asset.invoke.mockClear()
})

afterEach(async () => {
  // 模块级注册表：逐例回收，避免测试之间互相污染
  for (const appId of listAppSurfaces()) await disposeAppBundle(appId)
  document.body.innerHTML = ''
})

describe('表面保活：首次建实例、切走保留、停用销毁', () => {
  it('再次 mount 同一 app 只 attach 复用实例（不重建、不闪新实例）', async () => {
    const appId = 'com.wasmnest.lifecycle.reuse'
    writeBundle(appId)
    const slotA = createSlot()
    const slotB = createSlot()

    const first = await mountAppBundle(slotA, mountEnv(appId))
    const host = slotA.querySelector('.app-instance-host')
    const second = await mountAppBundle(slotB, mountEnv(appId))

    expect(second, '同一 app 必须返回同一句柄').toBe(first)
    expect(globalThis.__surfaceLifecycle.mounts, '不得重复创建实例').toEqual([appId])
    expect(slotA.children.length, '实例容器已移动到新槽').toBe(0)
    expect(slotB.querySelector('.app-instance-host')).toBe(host)
  })

  it('detach 只脱离文档；dispose 才 unmount 并释放界面租约', async () => {
    const appId = 'com.wasmnest.lifecycle.lease'
    writeBundle(appId)
    const slot = createSlot()
    await mountAppBundle(slot, mountEnv(appId))

    expect(invokeCount('plugin_surface_open'), '首次创建 acquire 一次').toBe(1)

    detachAppBundle(appId)
    expect(slot.querySelector('.app-instance-host'), '切走必须脱文档（后台不渲染）').toBeNull()
    expect(globalThis.__surfaceLifecycle.unmounts, '切走不得销毁实例').toEqual([])
    expect(invokeCount('plugin_surface_close'), '切走不释放界面租约').toBe(0)
    expect(globalThis.__surfaceLifecycle.active).toEqual([`${appId}:true`, `${appId}:false`])

    await disposeAppBundle(appId)
    expect(globalThis.__surfaceLifecycle.unmounts, 'dispose 才销毁').toEqual([appId])
    expect(invokeCount('plugin_surface_close'), 'dispose 释放界面租约').toBe(1)
    expect(listAppSurfaces()).toEqual([])
  })

  it('dispose 后重新打开是全新实例（旧 DOM / 状态不复活）', async () => {
    const appId = 'com.wasmnest.lifecycle.fresh'
    writeBundle(appId)
    const slot = createSlot()

    await mountAppBundle(slot, mountEnv(appId))
    await disposeAppBundle(appId)
    await mountAppBundle(slot, mountEnv(appId))

    expect(globalThis.__surfaceLifecycle.mounts).toEqual([appId, appId])
    expect(globalThis.__surfaceLifecycle.unmounts).toEqual([appId])
    expect(slot.querySelectorAll('.app-instance-host')).toHaveLength(1)
  })

  it('并发首次 mount 合并为一次：不产生孤儿实例 / 不重复 acquire 租约', async () => {
    const appId = 'com.wasmnest.lifecycle.concurrent'
    writeBundle(appId)
    const slotA = createSlot()
    const slotB = createSlot()

    const [handleA, handleB] = await Promise.all([
      mountAppBundle(slotA, mountEnv(appId)),
      mountAppBundle(slotB, mountEnv(appId)),
    ])

    expect(globalThis.__surfaceLifecycle.mounts, '并发首次打开只许建一个实例').toEqual([appId])
    expect(handleB).toBe(handleA)
    expect(invokeCount('plugin_surface_open'), '界面租约只 acquire 一次').toBe(1)
    expect(document.querySelectorAll('.app-instance-host'), '不得留下孤儿容器').toHaveLength(1)
  })
})
