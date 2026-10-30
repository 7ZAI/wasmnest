import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createAppSurfaceRegistry,
  type AppSurfaceHandle,
  type AppSurfaceRegistry,
} from '@/shell/mount/appSurfaceRegistry'

/**
 * 应用表面实例记账（机制 B 的「保活半边」）契约
 *
 * 语义（`.scratch/2026-10-23-app-surface-keepalive/spec.md` §2.1；2026-10-30 追加预览态）：
 *   首次打开 → register + attach；切走 → detach（容器脱文档，实例保留）；
 *   切回 → attach（同一容器节点放回槽，状态不重建）；停用 / 卸载 → dispose（才 unmount）；
 *   多任务卡 → attachPreview（同一实例搬进卡片，等比缩放、不谎报前台）/ detachPreview。
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

/** jsdom 不做布局：给元素伪造布局尺寸（只读 getter，模拟真实实测值） */
function fakeSize(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => width })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => height })
}

describe('多任务卡预览态：真实实例搬运（2026-10-30）', () => {
  let slot: HTMLElement
  let box: HTMLElement
  let registry: AppSurfaceRegistry
  let host: HTMLElement
  let handle: ReturnType<typeof makeHandle>

  beforeEach(() => {
    document.body.innerHTML = ''
    slot = document.createElement('div')
    document.body.appendChild(slot)
    box = document.createElement('div')
    box.className = 'app-live-surface'
    document.body.appendChild(box)
    registry = createAppSurfaceRegistry()
    host = document.createElement('div')
    host.className = 'app-instance-host'
    handle = makeHandle()
    // 整幅（全屏应用区）1280×800；卡片缩略区 640×400（正好 0.5）
    fakeSize(host, 1280, 800)
    fakeSize(box, 640, 400)
    registry.register(APP, host, handle)
    registry.attach(APP, slot)
    handle.setActive.mockClear()
  })

  it('搬进卡片：同一节点、不销毁、不谎报前台、固定整幅尺寸并等比缩小', () => {
    expect(registry.attachPreview(APP, box)).toBe(true)

    expect(host.parentElement, '必须是同一个容器节点（实例状态原样）').toBe(box)
    expect(registry.get(APP)?.location).toBe('preview')
    expect(handle.unmount).not.toHaveBeenCalled()
    expect(handle.setActive, '卡片不是可交互前台，不得通知 setActive(true)').toHaveBeenCalledWith(
      false,
    )
    // 布局尺寸保持整幅：终端不 resize / 不重排，只是视觉缩小
    expect(host.style.width).toBe('1280px')
    expect(host.style.height).toBe('800px')
    expect(host.style.transform).toBe('translate(0px, 0px) scale(0.5)')
    expect(host.inert, '卡片里的实例不可交互 / 不可聚焦').toBe(true)
  })

  it('卡片尺寸变化：fitPreview 重算缩放并居中留边', () => {
    registry.attachPreview(APP, box)
    fakeSize(box, 640, 200)

    expect(registry.fitPreview(APP)).toBe(true)
    // 等比取小（0.25），宽度方向居中：(640 - 320) / 2 = 160
    expect(host.style.transform).toBe('translate(160px, 0px) scale(0.25)')
  })

  it('detachPreview 摘回后台：清掉缩放内联样式，实例与记账保留', () => {
    registry.attachPreview(APP, box)

    expect(registry.detachPreview(APP)).toBe(true)

    expect(host.parentElement, '卡片收起后必须脱离文档（后台不渲染）').toBeNull()
    expect(registry.get(APP)?.location).toBe('detached')
    expect(registry.has(APP), '摘卡片不得销毁实例').toBe(true)
    expect(handle.unmount).not.toHaveBeenCalled()
    expect(host.style.width).toBe('')
    expect(host.style.transform).toBe('')
    expect(host.inert).toBe(false)
  })

  it('卡片直接放回挂载槽：清缩放态并恢复前台通知', () => {
    registry.attachPreview(APP, box)

    expect(registry.attach(APP, slot)).toBe(true)

    expect(host.parentElement).toBe(slot)
    expect(host.style.width).toBe('')
    expect(host.style.transform).toBe('')
    expect(host.inert).toBe(false)
    expect(handle.setActive).toHaveBeenLastCalledWith(true)
  })

  it('非预览态调 detachPreview / fitPreview 返回 false（幂等，不误伤槽内实例）', () => {
    expect(registry.detachPreview(APP)).toBe(false)
    expect(registry.fitPreview(APP)).toBe(false)
    expect(host.parentElement).toBe(slot)
  })

  it('未知实例 attachPreview 返回 false（卡片回退品牌卡）', () => {
    expect(registry.attachPreview('ghost', box)).toBe(false)
  })

  it('卡片里被停用：dispose 仍只 unmount 一次并移除容器', async () => {
    registry.attachPreview(APP, box)

    await expect(registry.dispose(APP)).resolves.toBe(true)

    expect(handle.unmount).toHaveBeenCalledTimes(1)
    expect(host.parentElement).toBeNull()
    expect(registry.has(APP)).toBe(false)
  })
})
