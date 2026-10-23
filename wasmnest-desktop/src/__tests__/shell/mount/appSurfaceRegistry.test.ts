import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createAppSurfaceRegistry,
  type AppSurfaceHandle,
  type AppSurfaceRegistry,
} from '@/shell/mount/appSurfaceRegistry'

/**
 * 应用表面实例记账（机制 B 的「保活半边」）契约
 *
 * 语义（`.scratch/2026-10-23-app-surface-keepalive/spec.md` §2.1）：
 *   首次打开 → register + attach；切走 → detach（容器脱文档，实例保留）；
 *   切回 → attach（同一容器节点放回槽，状态不重建）；停用 / 卸载 → dispose（才 unmount）。
 *
 * 这些断言锁住的核心不变量是「detach 不销毁、dispose 才销毁」——写反了就是
 * 「切回来应用被重置」（用户可感知）或「停用了实例还赖在内存里」（泄漏）。
 */

const APP = 'com.wasmnest.ai-chatbox'

function makeHandle(): AppSurfaceHandle & {
  unmount: ReturnType<typeof vi.fn>
  setActive: ReturnType<typeof vi.fn>
} {
  return { unmount: vi.fn(async () => {}), setActive: vi.fn() }
}

describe('应用表面实例注册表', () => {
  let slot: HTMLElement
  let registry: AppSurfaceRegistry
  let host: HTMLElement
  let handle: ReturnType<typeof makeHandle>

  beforeEach(() => {
    document.body.innerHTML = ''
    slot = document.createElement('div')
    slot.className = 'app-mount-slot'
    document.body.appendChild(slot)
    registry = createAppSurfaceRegistry()
    host = document.createElement('div')
    host.className = 'app-instance-host'
    handle = makeHandle()
  })

  it('register 后可按 appId 查到，且默认视为不在前台', () => {
    registry.register(APP, host, handle)

    expect(registry.has(APP)).toBe(true)
    expect(registry.get(APP)?.host).toBe(host)
    expect(registry.get(APP)?.active, '刚登记还没挂到槽上，不得算前台').toBe(false)
    expect(registry.list()).toEqual([APP])
  })

  it('attach 把容器放进槽并通知前台一次；重复 attach 幂等', () => {
    registry.register(APP, host, handle)

    expect(registry.attach(APP, slot)).toBe(true)
    expect(host.parentElement).toBe(slot)
    expect(handle.setActive).toHaveBeenCalledTimes(1)
    expect(handle.setActive).toHaveBeenCalledWith(true)

    // 幂等：同一个槽再 attach 不重复 append / 不重复通知（避免应用反复恢复轮询）
    expect(registry.attach(APP, slot)).toBe(true)
    expect(slot.children).toHaveLength(1)
    expect(handle.setActive).toHaveBeenCalledTimes(1)
  })

  it('attach 未知实例返回 false（调用方应改走首次装载）', () => {
    expect(registry.attach('ghost', slot)).toBe(false)
  })

  it('detach 只摘槽不销毁：容器脱文档、实例仍在、通知后台', () => {
    registry.register(APP, host, handle)
    registry.attach(APP, slot)

    expect(registry.detach(APP)).toBe(true)
    expect(host.parentElement, '容器必须脱离文档（后台不渲染）').toBeNull()
    expect(registry.has(APP), 'detach 不得销毁实例').toBe(true)
    expect(handle.unmount).not.toHaveBeenCalled()
    expect(handle.setActive).toHaveBeenLastCalledWith(false)
  })

  it('detach 后 attach 放回的是同一个容器节点（DOM / 组件状态原样）', () => {
    registry.register(APP, host, handle)
    registry.attach(APP, slot)
    host.appendChild(document.createElement('input'))

    registry.detach(APP)
    expect(registry.attach(APP, slot)).toBe(true)

    expect(slot.firstElementChild, '必须是同一节点，不能重建').toBe(host)
    expect(host.querySelector('input'), 'DOM 子树保留').not.toBeNull()
    expect(handle.setActive.mock.calls).toEqual([[true], [false], [true]])
  })

  it('detach 未知实例返回 false（幂等调用不抛）', () => {
    expect(registry.detach('ghost')).toBe(false)
  })

  it('dispose 才 unmount，并清掉记账与容器', async () => {
    registry.register(APP, host, handle)
    registry.attach(APP, slot)

    await expect(registry.dispose(APP)).resolves.toBe(true)

    expect(handle.unmount).toHaveBeenCalledTimes(1)
    expect(host.parentElement).toBeNull()
    expect(registry.has(APP)).toBe(false)
    expect(registry.list()).toEqual([])
  })

  it('dispose 幂等：重复调用不重复 unmount', async () => {
    registry.register(APP, host, handle)
    expect(await registry.dispose(APP)).toBe(true)
    expect(await registry.dispose(APP)).toBe(false)
    expect(handle.unmount).toHaveBeenCalledTimes(1)
  })

  it('dispose 期间记账已摘除：并发 attach 不得复用半销毁实例', async () => {
    let release: (() => void) | null = null
    const slowHandle: AppSurfaceHandle = {
      unmount: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      ),
    }
    registry.register(APP, host, slowHandle)

    const disposing = registry.dispose(APP)
    expect(registry.has(APP), 'dispose 一开始就摘记账（用户连点也不会复用）').toBe(false)
    expect(registry.attach(APP, slot)).toBe(false)

    release!()
    await disposing
    expect(slowHandle.unmount).toHaveBeenCalledTimes(1)
  })

  it('unmount 抛错也要清掉容器（不留孤儿 DOM）', async () => {
    handle.unmount.mockRejectedValueOnce(new Error('app unmount failed'))
    registry.register(APP, host, handle)
    registry.attach(APP, slot)

    await expect(registry.dispose(APP)).rejects.toThrow(/unmount failed/)
    expect(host.parentElement).toBeNull()
    expect(registry.has(APP)).toBe(false)
  })

  it('应用未实现 setActive 时零影响（旧应用照常保活）', () => {
    const legacy: AppSurfaceHandle = { unmount: vi.fn(async () => {}) }
    registry.register(APP, host, legacy)

    expect(() => registry.attach(APP, slot)).not.toThrow()
    expect(() => registry.detach(APP)).not.toThrow()
    expect(host.parentElement).toBeNull()
  })

  it('setActive 抛错不得阻断壳的切换', () => {
    handle.setActive.mockImplementation(() => {
      throw new Error('app setActive blew up')
    })
    registry.register(APP, host, handle)

    expect(() => registry.attach(APP, slot)).not.toThrow()
    expect(host.parentElement).toBe(slot)
    expect(() => registry.detach(APP)).not.toThrow()
    expect(host.parentElement).toBeNull()
  })
})
