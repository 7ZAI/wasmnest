import { describe, it, expect, beforeEach } from 'vitest'
import {
  defineComponent,
  getCurrentInstance,
  h,
  inject,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  type Component,
  type Ref,
} from 'vue'
import {
  createSurfaceAppRegistry,
  type SurfaceAppEnsureInput,
  type SurfaceRegistryLogEvent,
  type SurfaceRegistryLogger,
} from '@/shell/surfaceAppRegistry'
import { SURFACE_ACTIVE_KEY } from '@/shell/composables/useAppSurfaces'

/**
 * 运行面 Vue 实例注册表契约测试（移动端每应用一个独立 Vue 应用）
 *
 * 锁住的生命周期不变量（与桌面 appSurfaceRegistry 同组判据）：
 *   同一 appId 至多一个实例；detach 永远不等于 dispose；dispose 是唯一
 *   unmount 路径且先摘记账；创建在途被 dispose 不得登记半死实例。
 * 写反任一方向都会变成「切回来应用被重置」（用户可感知）或「停用了实例还
 * 赖在内存里」（泄漏）。
 *
 * 断言只走外部可观察行为：组件 onMounted / onUnmounted 计数、appContext
 * 异同、DOM 节点身份、注入值、注册表查询面（list / has / get）——不 spy
 * createApp、不断言内部 Map（那些是实现细节，换了写法行为不该变）。
 *
 * 场景编号 T1–T13 对应 `.scratch/2026-10-24-mobile-app-surface-vue-instances/spec.md`
 * §5.3 覆盖矩阵。
 */

const APP_A = 'com.wasmnest.alpha'
const APP_B = 'com.wasmnest.beta'

/** 探针组件的观察计数：setup / mount / unmount 次数与捕获的 appContext */
interface ProbeCounts {
  mounted: number
  unmounted: number
  setups: number
  /** 每次 setup 捕获的 appContext（证明「是不是同一个 Vue 应用」） */
  contexts: unknown[]
  /** 子组件捕获的 appContext（证明同一应用内父子共享上下文） */
  childContexts: unknown[]
}

/**
 * 造一个可观察的运行面探针组件：记录生命周期计数、捕获 appContext、
 * 注入 pluginContext 与前台信号并渲染出来——注入是否漏、实例是否独立、
 * 是否被销毁，全都能从渲染结果与计数读出。
 */
function makeSurfaceProbe(label: string): { counts: ProbeCounts; component: Component } {
  const counts: ProbeCounts = { mounted: 0, unmounted: 0, setups: 0, contexts: [], childContexts: [] }
  const child = defineComponent({
    name: `SurfaceProbeChild${label}`,
    setup() {
      counts.childContexts.push(getCurrentInstance()!.appContext)
      return () => h('span', { class: 'probe-child' }, `${label}-child`)
    },
  })
  const component = defineComponent({
    name: `SurfaceProbe${label}`,
    setup() {
      counts.setups += 1
      counts.contexts.push(getCurrentInstance()!.appContext)
      onMounted(() => {
        counts.mounted += 1
      })
      onUnmounted(() => {
        counts.unmounted += 1
      })
      const pluginCtx = inject<{ marker?: string } | null>('pluginContext', null)
      const active = inject<Ref<boolean>>(SURFACE_ACTIVE_KEY, ref(false))
      return () =>
        h('div', { class: 'probe-root', 'data-label': label }, [
          h('span', { class: 'probe-ctx' }, pluginCtx?.marker ?? 'none'),
          h('span', { class: 'probe-active' }, active.value ? 'active' : 'inactive'),
          h('input', { class: 'probe-input', type: 'text', value: 'initial' }),
          h(child),
        ])
    },
  })
  return { counts, component }
}

/** ensure 输入工厂：按契约形状注入 pluginContext 与该应用的前台信号 */
function makeInput(component: Component, marker: string): SurfaceAppEnsureInput {
  return {
    component,
    provides: (active) => ({
      pluginContext: { marker },
      [SURFACE_ACTIVE_KEY]: active,
    }),
  }
}

/** 日志收集器：T11「日志可见」等断言用 */
function makeLogCollector(): { events: Array<{ level: string; event: SurfaceRegistryLogEvent }>; logger: SurfaceRegistryLogger } {
  const events: Array<{ level: string; event: SurfaceRegistryLogEvent }> = []
  const push = (level: string) => (event: SurfaceRegistryLogEvent) => events.push({ level, event })
  return { events, logger: { info: push('info'), warn: push('warn'), error: push('error') } }
}

/** 建一个挂在文档里的插槽（模拟运行屏 outlet） */
function makeOutlet(className: string): HTMLElement {
  const outlet = document.createElement('div')
  outlet.className = className
  document.body.appendChild(outlet)
  return outlet
}

describe('运行面实例注册表：创建与查询（ensure 语义）', () => {
  let registry: ReturnType<typeof createSurfaceAppRegistry>
  let logs: ReturnType<typeof makeLogCollector>

  beforeEach(() => {
    document.body.innerHTML = ''
    logs = makeLogCollector()
    registry = createSurfaceAppRegistry({ logger: logs.logger })
  })

  it('T1 首次 ensure：mount 一次、容器里有应用 DOM、注册表可查到', async () => {
    const { counts, component } = makeSurfaceProbe('A')

    const record = await registry.ensure(APP_A, makeInput(component, 'ctx-A'))

    expect(counts.mounted).toBe(1)
    expect(record.container.querySelector('[data-label="A"]'), '容器里有应用 DOM').not.toBeNull()
    expect(record.container.querySelector('.probe-ctx')?.textContent).toBe('ctx-A')
    expect(registry.has(APP_A)).toBe(true)
    expect(registry.list()).toEqual([APP_A])
    expect(record.active.value, '未 attach 不算前台').toBe(false)
  })

  it('T2 重复 ensure 同一应用：同一实例、setup/mount 不重跑、不产生第二个容器', async () => {
    const { counts, component } = makeSurfaceProbe('A')
    const input = makeInput(component, 'ctx-A')

    const first = await registry.ensure(APP_A, input)
    const second = await registry.ensure(APP_A, input)

    expect(second).toBe(first)
    expect(counts.setups).toBe(1)
    expect(counts.mounted).toBe(1)
    expect(registry.get(APP_A)?.container).toBe(first.container)
    expect(registry.list()).toEqual([APP_A])
  })

  it('T3 并发 ensure 同一应用：合并为一次创建、两个调用拿到同一实例', async () => {
    const { counts, component } = makeSurfaceProbe('A')
    const input = makeInput(component, 'ctx-A')

    const [first, second] = await Promise.all([
      registry.ensure(APP_A, input),
      registry.ensure(APP_A, input),
    ])

    expect(first).toBe(second)
    expect(counts.setups).toBe(1)
    expect(counts.mounted).toBe(1)
    expect(registry.list()).toEqual([APP_A])
  })

  it('T4 两个应用 ensure：appContext 互不相同、各自注入自己的 pluginContext、同应用父子共享 appContext', async () => {
    const probeA = makeSurfaceProbe('A')
    const probeB = makeSurfaceProbe('B')

    const recordA = await registry.ensure(APP_A, makeInput(probeA.component, 'ctx-A'))
    const recordB = await registry.ensure(APP_B, makeInput(probeB.component, 'ctx-B'))

    expect(
      probeA.counts.contexts[0] !== probeB.counts.contexts[0],
      '两个运行面是两个独立 Vue 应用',
    ).toBe(true)
    expect(recordA.container.querySelector('.probe-ctx')?.textContent).toBe('ctx-A')
    expect(recordB.container.querySelector('.probe-ctx')?.textContent).toBe('ctx-B')
    expect(
      probeA.counts.childContexts[0] === probeA.counts.contexts[0],
      '同一应用内父子组件共享同一个 appContext',
    ).toBe(true)
    expect(registry.list().sort()).toEqual([APP_A, APP_B].sort())
  })

  it('T12 运行面组件晚到：出现前注册表为空、组件出现后才 mount', async () => {
    // 模拟运行面数据源的晚到解析：注册表不做创建判据（那是壳对账的事），
    // 但必须保证「组件没出现时零实例、出现后一次建好」
    let resolved: Component | undefined
    const resolveFromSource = async (): Promise<Component | undefined> => {
      await Promise.resolve()
      return resolved
    }

    expect(await resolveFromSource()).toBeUndefined()
    expect(registry.list()).toEqual([])
    expect(registry.has(APP_A)).toBe(false)

    const { counts, component } = makeSurfaceProbe('A')
    resolved = component
    const late = await resolveFromSource()
    expect(late).toBeDefined()

    await registry.ensure(APP_A, makeInput(late!, 'ctx-A'))

    expect(counts.mounted).toBe(1)
    expect(registry.list()).toEqual([APP_A])
  })
})

describe('运行面实例注册表：attach / detach（保活语义）', () => {
  let registry: ReturnType<typeof createSurfaceAppRegistry>

  beforeEach(() => {
    document.body.innerHTML = ''
    registry = createSurfaceAppRegistry({ logger: makeLogCollector().logger })
  })

  it('T5 attach：容器进入插槽、DOM 节点引用不变、前台信号变 true、重复 attach 幂等', async () => {
    const { component } = makeSurfaceProbe('A')
    const record = await registry.ensure(APP_A, makeInput(component, 'ctx-A'))
    const outlet = makeOutlet('outlet-a')

    expect(registry.attach(APP_A, outlet)).toBe(true)
    expect(outlet.firstElementChild, '必须是同一节点，不能重建').toBe(record.container)
    expect(record.active.value).toBe(true)
    await nextTick()
    expect(record.container.querySelector('.probe-active')?.textContent).toBe('active')

    // 幂等：同一插槽重复 attach 不重复 append、不重复推前台信号语义
    expect(registry.attach(APP_A, outlet)).toBe(true)
    expect(outlet.children).toHaveLength(1)

    // 换插槽：容器搬过去而不是复制（运行屏过渡期新插槽接管）
    const outletB = makeOutlet('outlet-b')
    expect(registry.attach(APP_A, outletB)).toBe(true)
    expect(outletB.firstElementChild).toBe(record.container)
    expect(outlet.children).toHaveLength(0)
    expect(record.active.value).toBe(true)
  })

  it('T6 detach：容器脱离文档、不 unmount、DOM 子树与输入值保留、前台信号变 false', async () => {
    const { counts, component } = makeSurfaceProbe('A')
    const record = await registry.ensure(APP_A, makeInput(component, 'ctx-A'))
    const outlet = makeOutlet('outlet-a')
    registry.attach(APP_A, outlet)

    const input = record.container.querySelector<HTMLInputElement>('.probe-input')!
    input.value = 'typed-by-user'

    expect(registry.detach(APP_A)).toBe(true)

    expect(record.container.parentElement, '容器必须脱离文档（后台不渲染）').toBeNull()
    expect(record.container.isConnected).toBe(false)
    expect(counts.unmounted, 'detach 不得销毁实例').toBe(0)
    expect(
      record.container.querySelector<HTMLInputElement>('.probe-input')?.value,
      'DOM 子树与用户输入保留',
    ).toBe('typed-by-user')
    expect(record.active.value).toBe(false)
    await nextTick()
    expect(record.container.querySelector('.probe-active')?.textContent).toBe('inactive')

    // 幂等：重复 detach 不抛、不重复推信号
    expect(registry.detach(APP_A)).toBe(true)
    expect(record.container.isConnected).toBe(false)
  })

  it('T7 detach 后再 attach：同一个容器节点、同一个 appContext、状态原样', async () => {
    const { counts, component } = makeSurfaceProbe('A')
    const record = await registry.ensure(APP_A, makeInput(component, 'ctx-A'))
    const outlet = makeOutlet('outlet-a')
    registry.attach(APP_A, outlet)
    const input = record.container.querySelector<HTMLInputElement>('.probe-input')!
    input.value = 'typed-by-user'
    registry.detach(APP_A)

    expect(registry.attach(APP_A, outlet)).toBe(true)

    expect(outlet.firstElementChild, '放回的必须是同一个容器节点').toBe(record.container)
    expect(counts.setups, '不重新 createApp / mount').toBe(1)
    expect(counts.mounted).toBe(1)
    expect(counts.unmounted).toBe(0)
    expect(
      record.container.querySelector<HTMLInputElement>('.probe-input')?.value,
      '切走再切回，状态原样',
    ).toBe('typed-by-user')
    expect(record.active.value).toBe(true)
  })

  it('未知实例 attach / detach / dispose 返回失败，不抛（由调用方决定下一步）', async () => {
    const outlet = makeOutlet('outlet-a')

    expect(registry.attach('ghost', outlet)).toBe(false)
    expect(registry.detach('ghost')).toBe(false)
    await expect(registry.dispose('ghost')).resolves.toBe(false)
    expect(registry.has('ghost')).toBe(false)
    expect(outlet.children).toHaveLength(0)
  })
})

describe('运行面实例注册表：dispose（销毁语义）', () => {
  let registry: ReturnType<typeof createSurfaceAppRegistry>
  let logs: ReturnType<typeof makeLogCollector>

  beforeEach(() => {
    document.body.innerHTML = ''
    logs = makeLogCollector()
    registry = createSurfaceAppRegistry({ logger: logs.logger })
  })

  it('T8 dispose：unmount 一次、容器移除、记账清空、再次 ensure 是全新实例', async () => {
    const { counts, component } = makeSurfaceProbe('A')
    const input = makeInput(component, 'ctx-A')
    const record = await registry.ensure(APP_A, input)
    const outlet = makeOutlet('outlet-a')
    registry.attach(APP_A, outlet)

    await expect(registry.dispose(APP_A)).resolves.toBe(true)

    expect(counts.unmounted).toBe(1)
    expect(record.container.isConnected, '容器不残留').toBe(false)
    expect(outlet.children).toHaveLength(0)
    expect(registry.has(APP_A)).toBe(false)
    expect(registry.list()).toEqual([])

    const reborn = await registry.ensure(APP_A, input)
    expect(counts.setups, '全新实例：setup 重跑').toBe(2)
    expect(counts.mounted).toBe(2)
    expect(counts.contexts[1] !== counts.contexts[0], '全新 Vue 应用：appContext 不同').toBe(true)
    expect(reborn.container).not.toBe(record.container)
  })

  it('T9 重复 dispose：不重复 unmount、不抛', async () => {
    const { counts, component } = makeSurfaceProbe('A')
    await registry.ensure(APP_A, makeInput(component, 'ctx-A'))

    await expect(registry.dispose(APP_A)).resolves.toBe(true)
    await expect(registry.dispose(APP_A)).resolves.toBe(false)

    expect(counts.unmounted).toBe(1)
  })

  it('T10 dispose 期间并发 attach：记账先摘、attach 失败、不复用半销毁实例', async () => {
    const { component } = makeSurfaceProbe('A')
    await registry.ensure(APP_A, makeInput(component, 'ctx-A'))
    const outlet = makeOutlet('outlet-a')
    registry.attach(APP_A, outlet)

    const disposing = registry.dispose(APP_A)
    expect(registry.has(APP_A), 'dispose 一开始就摘记账（用户连点也不会复用）').toBe(false)
    expect(registry.attach(APP_A, outlet), '不得复用半销毁实例').toBe(false)

    await expect(disposing).resolves.toBe(true)
    expect(outlet.children).toHaveLength(0)
  })

  it('T11 创建过程中 dispose：不登记半死实例、已创建实例被清理、容器不残留、日志可见', async () => {
    const { counts, component } = makeSurfaceProbe('A')

    const ensuring = registry.ensure(APP_A, makeInput(component, 'ctx-A'))
    expect(await registry.dispose(APP_A), '创建在途时 dispose 优先').toBe(true)

    const doomed = await ensuring
    expect(registry.has(APP_A), '在途 ensure 完成后不得重新登记').toBe(false)
    expect(registry.list()).toEqual([])
    expect(counts.unmounted, '已创建的实例被卸掉，不是丢着不管').toBe(1)
    expect(doomed.container.isConnected).toBe(false)
    expect(document.body.contains(doomed.container), '容器不残留').toBe(false)
    expect(
      logs.events.some(
        ({ event }) =>
          event.appId === APP_A && event.action === 'dispose' && /在途/.test(event.detail ?? ''),
      ),
      '创建在途的 dispose 必须有日志（排障要能还原这次竞态）',
    ).toBe(true)
  })

  it('卸载钩子抛错：错误进该应用 errorHandler（带 appId 与阶段）、清理照常完成', async () => {
    const grumpy = defineComponent({
      name: 'GrumpyTeardown',
      setup() {
        onUnmounted(() => {
          throw new Error('teardown-boom')
        })
        return () => h('div', 'grumpy')
      },
    })
    const record = await registry.ensure(APP_A, makeInput(grumpy, 'ctx-A'))

    await expect(registry.dispose(APP_A)).resolves.toBe(true)

    expect(record.container.isConnected, '清理必须完成：容器移除').toBe(false)
    expect(registry.has(APP_A), '清理必须完成：记账摘除').toBe(false)
    expect(
      logs.events.some(
        ({ event }) =>
          event.appId === APP_A && event.action === 'error' && event.phase === 'lifecycle',
      ),
      '钩子错误经该应用的 errorHandler 落日志',
    ).toBe(true)
  })
})

describe('运行面实例注册表：组件身份与错误隔离', () => {
  let registry: ReturnType<typeof createSurfaceAppRegistry>
  let logs: ReturnType<typeof makeLogCollector>

  beforeEach(() => {
    document.body.innerHTML = ''
    logs = makeLogCollector()
    registry = createSurfaceAppRegistry({ logger: logs.logger })
  })

  it('T13 运行面组件身份变化：旧实例 unmount、新实例 mount、注册表只保留一个', async () => {
    const oldProbe = makeSurfaceProbe('Old')
    const newProbe = makeSurfaceProbe('New')

    await registry.ensure(APP_A, makeInput(oldProbe.component, 'ctx-A'))
    const reborn = await registry.ensure(APP_A, makeInput(newProbe.component, 'ctx-A'))

    expect(oldProbe.counts.unmounted, '旧实例必须销毁').toBe(1)
    expect(newProbe.counts.mounted, '新实例必须创建').toBe(1)
    expect(registry.list(), '同一 appId 至多一个实例').toEqual([APP_A])
    expect(registry.get(APP_A)?.container).toBe(reborn.container)
    expect(reborn.container.querySelector('[data-label="New"]')).not.toBeNull()
    expect(reborn.container.querySelector('[data-label="Old"]')).toBeNull()
  })

  it('事件 / 渲染错误：各应用的 errorHandler 带 appId 与阶段记录、对方应用不受影响', async () => {
    const explode = ref(false)
    const boomA = defineComponent({
      name: 'BoomA',
      setup() {
        return () => {
          if (explode.value) throw new Error('boom-render')
          return h('div', { class: 'boom-a' }, [
            h(
              'button',
              {
                class: 'boom-event-btn',
                type: 'button',
                onClick: () => {
                  throw new Error('boom-event')
                },
              },
              'event',
            ),
            h('button', { class: 'boom-render-btn', type: 'button', onClick: () => { explode.value = true } }, 'render'),
          ])
        }
      },
    })
    const probeB = makeSurfaceProbe('B')
    const recordA = await registry.ensure(APP_A, makeInput(boomA, 'ctx-A'))
    await registry.ensure(APP_B, makeInput(probeB.component, 'ctx-B'))

    // 事件错误：A 的 errorHandler 收到（appId=A、phase=event），不冒泡到调用方
    expect(() => recordA.container.querySelector<HTMLButtonElement>('.boom-event-btn')!.click()).not.toThrow()

    // 渲染错误：触发重渲染后由调度器送进 A 的 errorHandler（appId=A、phase=render）
    recordA.container.querySelector<HTMLButtonElement>('.boom-render-btn')!.click()
    await nextTick()
    await nextTick()

    const errors = logs.events.filter(({ event }) => event.action === 'error')
    expect(
      errors.some(({ event }) => event.appId === APP_A && event.phase === 'event'),
      '事件错误要带 appId 与 event 阶段',
    ).toBe(true)
    expect(
      errors.some(({ event }) => event.appId === APP_A && event.phase === 'render'),
      '渲染错误要带 appId 与 render 阶段',
    ).toBe(true)

    // 隔离：B 不受 A 的错误牵连，仍在注册表、DOM 仍可交互
    expect(registry.has(APP_B)).toBe(true)
    expect(probeB.counts.unmounted).toBe(0)
    const inputB = registry.get(APP_B)!.container.querySelector<HTMLInputElement>('.probe-input')!
    expect(inputB).not.toBeNull()

    // 每实例独立 errorHandler：B 的错误只落 B 的日志（appId=B）
    const boomB = defineComponent({
      name: 'BoomB',
      setup() {
        return () =>
          h(
            'button',
            {
              class: 'boom-b-btn',
              type: 'button',
              onClick: () => {
                throw new Error('boom-b')
              },
            },
            'b',
          )
      },
    })
    // 直接换 B 的组件身份（走 T13 的重建路径）注入会抛错的组件
    const recordB2 = await registry.ensure(APP_B, makeInput(boomB, 'ctx-B'))
    expect(() => recordB2.container.querySelector<HTMLButtonElement>('.boom-b-btn')!.click()).not.toThrow()
    expect(
      logs.events.some(({ event }) => event.appId === APP_B && event.phase === 'event'),
      'B 的错误落 B 的 errorHandler（每实例独立）',
    ).toBe(true)
  })

  it('共享运行时安装与显式注入按输入形状生效（注入清单是契约）', async () => {
    const { component } = makeSurfaceProbe('A')
    const installedOn: unknown[] = []
    const sharedPlugin = {
      install(app: unknown) {
        installedOn.push(app)
      },
    }

    const record = await registry.ensure(APP_A, {
      component,
      plugins: [sharedPlugin],
      provides: (active) => ({
        pluginContext: { marker: 'ctx-A' },
        [SURFACE_ACTIVE_KEY]: active,
      }),
    })

    expect(installedOn).toHaveLength(1)
    expect(installedOn[0], '插件装到该应用的 Vue 实例上').toBe(record.app)
    expect(record.container.querySelector('.probe-ctx')?.textContent, '注入清单生效').toBe('ctx-A')
  })
})
