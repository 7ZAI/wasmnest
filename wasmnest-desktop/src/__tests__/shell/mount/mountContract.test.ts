/**
 * 挂载契约版本（mountContract）单测
 *
 * 分发化之后宿主与 app 整包不再天然同版本：`AppMountEnv` 形状的破坏性变更
 * 由 `mountContract` 编号表达。装载时必须**显性比对**——不匹配 / 缺失 = 点名
 * appId、期望值、实际值与修复指引，而不是 mount 失败的白屏。
 *
 * 两档断言：
 * - 纯函数档：`assertMountContract` 的三态（一致 / 缺失 / 不符）；
 * - 装载档：`mountAppBundle` 经真实动态 import 装载临时 bundle，证明校验发生在
 *   创建 app 之前（bundles 里的 `mountApp` 被调用与否可直接观察）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppMountEnv } from '@/shell/mount/useAppMount'

/**
 * 宿主 asset 目录桩：path → 模块源码。
 *
 * happy-dom 下 `import(file://...)` 会被 Vite 的模块解析接管（外部路径不可用），
 * 故 `convertFileSrc` 返回 data: URL——仍是**真实动态 import**（走 loadAppModule /
 * importWithTimeout 的同一路径），只是绕开 asset protocol。
 */
const asset = vi.hoisted(() => ({ root: '', sources: new Map<string, string>() }))

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) =>
    `data:text/javascript,${encodeURIComponent(asset.sources.get(path) ?? '')}`,
}))
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => parts.join('/'),
}))
vi.mock('@/utils/invoke', () => ({ invoke: vi.fn(async () => asset.root) }))

import {
  MOUNT_CONTRACT,
  assertMountContract,
  mountAppBundle,
} from '@/shell/mount/useAppMount'

/** 装载过的 appId（bundle 内 mountApp 被调用时写入；用于断言「校验先于创建」） */
declare global {
  // eslint-disable-next-line no-var
  var __mountContractMounted: string[]
}

function writeBundle(appId: string, source: string): void {
  asset.sources.set(join(asset.root, appId, 'index.js'), source)
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

/** 挂载包桩：可选导出 mountContract；mountApp 记录自身被调用 */
function bundleSource(mountContract?: string): string {
  return [
    mountContract === undefined ? '' : `export const mountContract = '${mountContract}'`,
    `export async function mountApp() {`,
    `  globalThis.__mountContractMounted.push(${JSON.stringify('mounted')})`,
    `  return { async unmount() {} }`,
    `}`,
  ].join('\n')
}

beforeAll(() => {
  asset.root = mkdtempSync(join(tmpdir(), 'wasmnest-mount-contract-'))
  globalThis.__mountContractMounted = []
})

afterAll(() => {
  asset.sources.clear()
})

beforeEach(() => {
  globalThis.__mountContractMounted.length = 0
})

describe('mountContract 契约版本', () => {
  it('宿主声明的契约版本是 "1"（编号只随 AppMountEnv 破坏性变更 bump）', () => {
    expect(MOUNT_CONTRACT).toBe('1')
  })

  it('一致时放行', () => {
    expect(() => assertMountContract('com.wasmnest.demo', '1')).not.toThrow()
  })

  it('bundle 缺失 mountContract：点名 appId / 期望 / 实际 / 修复指引', () => {
    expect(() => assertMountContract('com.wasmnest.demo', undefined)).toThrowError(
      /com\.wasmnest\.demo.*mountContract.*期望.*1.*缺失.*重编 app.*宿主版本/s,
    )
  })

  it('bundle 版本不符：点名实际值', () => {
    expect(() => assertMountContract('com.wasmnest.demo', '0')).toThrowError(
      /com\.wasmnest\.demo.*mountContract.*期望.*1.*实际.*"0"/s,
    )
  })
})

describe('mountAppBundle 装载时校验 mountContract', () => {
  it('bundle 未导出 mountContract → 显性报错，且不创建 app', async () => {
    const appId = 'com.wasmnest.bundle.missing'
    writeBundle(appId, bundleSource())

    await expect(mountAppBundle(document.createElement('div'), mountEnv(appId))).rejects.toThrow(
      /mountContract.*缺失/s,
    )
    expect(globalThis.__mountContractMounted).toEqual([])
  })

  it('bundle mountContract 与宿主不符 → 显性报错，且不创建 app', async () => {
    const appId = 'com.wasmnest.bundle.stale'
    writeBundle(appId, bundleSource('0'))

    await expect(mountAppBundle(document.createElement('div'), mountEnv(appId))).rejects.toThrow(
      /实际.*"0"/s,
    )
    expect(globalThis.__mountContractMounted).toEqual([])
  })

  it('bundle mountContract 一致 → 正常挂载并返回句柄', async () => {
    const appId = 'com.wasmnest.bundle.match'
    writeBundle(appId, bundleSource('1'))

    const handle = await mountAppBundle(document.createElement('div'), mountEnv(appId))
    expect(typeof handle.unmount).toBe('function')
    expect(globalThis.__mountContractMounted).toHaveLength(1)
  })
})
