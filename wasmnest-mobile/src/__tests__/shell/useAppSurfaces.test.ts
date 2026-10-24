import { describe, it, expect, beforeEach } from 'vitest'
import { effect } from 'vue'
import {
  SURFACE_ACTIVE_KEY,
  dropSurface,
  isSurfaceOpened,
  markSurfaceOpened,
  releaseSurfaceOutlet,
  setActiveSurface,
  setSurfaceOutlet,
  useAppSurfaces,
} from '@/shell/composables/useAppSurfaces'

/**
 * 移动端运行面保活池记账（`.scratch/2026-10-23-app-surface-keepalive/spec.md` §3.2）
 *
 * 本模块只做记账，不渲染：壳（ShellHost）按 `opened ∩ 运行中` 决定池内条目，
 * 运行屏（ShellAppRunScreen）登记 `outletEl`。这些断言锁住「打开过的才保活」
 * 与「停用即出池」两条判据——写错任一方向都会变成「切回来被重置」或「停了还在内存里」。
 */

const APP = 'com.wasmnest.ai-chatbox'
const OTHER = 'com.wasmnest.file-transfer'

const api = useAppSurfaces()

beforeEach(() => {
  // 模块级单例：逐例清理，避免测试之间互相污染
  for (const appId of [...api.opened.value]) dropSurface(appId)
  setSurfaceOutlet(null)
  setActiveSurface('')
})

describe('打开过的应用集合（opened）', () => {
  it('markSurfaceOpened 记录打开过的应用；重复登记幂等', () => {
    markSurfaceOpened(APP)
    expect(isSurfaceOpened(APP)).toBe(true)

    // 重复登记不得把集合换掉（会让保活池里的条目重建）
    const before = api.opened.value
    markSurfaceOpened(APP)
    expect(api.opened.value).toBe(before)
  })

  it('空 appId 不登记（避免保活一条没有身份的条目）', () => {
    markSurfaceOpened('')
    expect(api.opened.value.size).toBe(0)
  })

  it('dropSurface 移出保活池（停用 / 卸载 / 错误终态）', () => {
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

  it('dropSurface 清掉该应用的前台标记（不留悬空的 active）', () => {
    markSurfaceOpened(APP)
    setActiveSurface(APP)

    dropSurface(APP)

    expect(api.activeSurfaceId.value).toBe('')
  })
})

describe('运行屏插槽（outlet）', () => {
  it('登记 / 注销插槽', () => {
    const el = document.createElement('div')

    setSurfaceOutlet(el)
    expect(api.outletEl.value).toBe(el)

    releaseSurfaceOutlet(el)
    expect(api.outletEl.value, '离开运行屏必须注销，否则插槽指向已卸载的 DOM').toBeNull()
  })

  it('注销只清自己的插槽：过渡期新旧运行屏共存不得互相抹掉', () => {
    const oldEl = document.createElement('div')
    const newEl = document.createElement('div')

    setSurfaceOutlet(oldEl)
    // 新屏先挂载并登记，旧屏离场动画结束后才 onBeforeUnmount
    setSurfaceOutlet(newEl)
    releaseSurfaceOutlet(oldEl)

    expect(api.outletEl.value, '旧屏注销不得清掉新屏刚登记的插槽').toBe(newEl)

    releaseSurfaceOutlet(newEl)
    expect(api.outletEl.value).toBeNull()
  })

  it('releaseSurfaceOutlet(null) 不清空（没有自己的插槽可注销）', () => {
    const el = document.createElement('div')
    setSurfaceOutlet(el)

    releaseSurfaceOutlet(null)

    expect(api.outletEl.value).toBe(el)
  })
})

describe('前后台判据（active）', () => {
  it('isSurfaceActive 只认当前前台应用', () => {
    markSurfaceOpened(APP)
    markSurfaceOpened(OTHER)

    setActiveSurface(APP)

    expect(api.isSurfaceActive(APP)).toBe(true)
    expect(api.isSurfaceActive(OTHER), '后台应用不算前台').toBe(false)
  })

  it('不在应用面（空串）时所有应用都是后台', () => {
    markSurfaceOpened(APP)
    setActiveSurface('')

    expect(api.isSurfaceActive(APP)).toBe(false)
  })

  it('activeSignal 是响应式的（应用可在后台暂停轮询）', () => {
    markSurfaceOpened(APP)
    // 与 ShellAppSurface 的用法一致：setup 期创建一次 computed，之后只读它
    const signal = api.activeSignal(APP)
    // 用 effect 收集「依赖变化能推动重新求值」；不断言精确推送次数（调度批次是实现细节）
    let latest = signal.value
    const stop = effect(
      () => {
        latest = signal.value
      },
      { flush: 'sync' },
    )

    setActiveSurface(APP)
    expect(signal.value, '切到前台 → true').toBe(true)
    setActiveSurface('')
    expect(signal.value, '切到后台 → false').toBe(false)

    stop()
    expect(latest, 'effect 侧同样看得到最终值').toBe(false)
  })

  it('SURFACE_ACTIVE_KEY 用 Symbol.for（跨 bundle 副本可对齐）', () => {
    // 移动端应用代码与壳是两份构建：Symbol() 对不上，必须用注册表形式
    expect(SURFACE_ACTIVE_KEY).toBe(Symbol.for('wasmnest.shell.surface-active'))
  })
})
