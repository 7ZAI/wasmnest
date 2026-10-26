import { describe, it, expect, beforeEach } from 'vitest'
import {
  SURFACE_ACTIVE_KEY,
  dropSurface,
  isSurfaceOpened,
  markSurfaceOpened,
  useAppSurfaces,
} from '@/shell/composables/useAppSurfaces'

/**
 * 移动端运行面保活记账
 *
 * 本模块只记「打开过运行面」的应用集合；实例承载、容器位置与前后台信号在
 * `surfaceRuntime` / `surfaceAppRegistry`（注册表按 attach / detach 推动）。
 * 这些断言锁住「打开过的才保活」与「停用即出池」两条判据——写错任一方向
 * 都会变成「切回来被重置」或「停了还在内存里」。
 */

const APP = 'com.wasmnest.ai-chatbox'
const OTHER = 'com.wasmnest.file-transfer'

const api = useAppSurfaces()

beforeEach(() => {
  // 模块级单例：逐例清理，避免测试之间互相污染
  for (const appId of [...api.opened.value]) dropSurface(appId)
})

describe('打开过的应用集合（opened）', () => {
  it('markSurfaceOpened 记录打开过的应用；重复登记幂等', () => {
    markSurfaceOpened(APP)
    expect(isSurfaceOpened(APP)).toBe(true)

    // 重复登记不得把集合换掉（会让保活側的条目重建）
    const before = api.opened.value
    markSurfaceOpened(APP)
    expect(api.opened.value).toBe(before)
  })

  it('空 appId 不登记（避免保活一条没有身份的条目）', () => {
    markSurfaceOpened('')
    expect(api.opened.value.size).toBe(0)
  })

  it('dropSurface 移出保活集合（停用 / 卸载 / 错误终态）', () => {
    markSurfaceOpened(APP)
    markSurfaceOpened(OTHER)

    dropSurface(APP)

    expect(isSurfaceOpened(APP)).toBe(false)
    expect(isSurfaceOpened(OTHER), '只摘目标应用').toBe(true)
  })

  it('dropSurface 未知应用不抛、不改集合', () => {
    markSurfaceOpened(APP)
    const before = api.opened.value
    expect(() => dropSurface('ghost')).not.toThrow()
    expect(api.opened.value).toBe(before)
  })
})

describe('前后台信号键', () => {
  it('SURFACE_ACTIVE_KEY 用 Symbol.for（跨 bundle 副本可对齐）', () => {
    // 移动端应用代码与壳是两份构建：Symbol() 对不上，必须用注册表形式
    expect(SURFACE_ACTIVE_KEY).toBe(Symbol.for('wasmnest.shell.surface-active'))
  })
})
