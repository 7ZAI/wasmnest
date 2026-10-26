/**
 * 应用运行面适配器（注册表承载）行为契约测试
 * （Level 1：每应用一个独立 Vue 应用，`.scratch/2026-10-24-mobile-app-surface-vue-instances/spec.md`）
 *
 * 被测：`src/shell/components/ShellAppSurface.vue` × 真实 surfaceRuntime 注册表。
 * 旧版「壳组件树直接渲染 surface」的断言已随承载方式退役——独立 Vue 应用不在
 * 壳的组件树里，断言换为其**外部可观察行为**：容器进插槽、生命周期计数、
 * 注入值、前后台信号、失败态可见。
 *
 * | 契约 | 规则 | 预期 |
 * |---|---|---|
 * | C-S1 | 有运行面 | 注册表建实例、容器挂进本屏插槽、应用 DOM 在场 |
 * | C-S2 | 预留位 | 应用在册但没注册运行面 | 渲染 ShellPlaceholderSurface + 注册表零实例 |
 * | C-S3 | 加载态（回归锁） | 清单未拉完且查不到应用 | 加载文案，**不**出 notFound |
 * | C-S4 | 空态 | 清单已就绪仍查不到 | notFound 文案 |
 * | C-S5 | 保活 | 适配器卸载只 detach | 实例 / DOM / 生命周期保留；重挂同一容器 |
 * | C-S6 | 失败态 fail-visible | 组件非法 | 点名应用的失败文案 + 重试可恢复 |
 * | C-S7 | 环境注入（契约） | 独立应用拿不到壳组件树 provide | SURFACE_ACTIVE_KEY 随 attach 翻转；宿主环境键透传 |
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, inject, onMounted, onUnmounted, ref, nextTick } from 'vue'
import type { ShellApp } from '@/shell/types'
import { SURFACE_ACTIVE_KEY } from '@/shell/composables/useAppSurfaces'
import { getSurfaceAppRegistry } from '@/shell/surfaceRuntime'
import { clearHostSurfaceEnv, registerHostSurfaceEnv } from '@/shell/hostSurfaceEnv'

const apps = ref<ShellApp[]>([])
const listReady = ref(true)
/** 当前要给出的运行面组件（undefined = 未注册运行面）；ref：换组件要推动 computed 重算 */
const surfaceComponent = ref<unknown>()

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
// 共享运行时（i18n / router）在适配器测试面用轻桩：真实共享行为由 #33 的契约锁负责
vi.mock('@/locales', () => ({ default: { install: () => {} } }))
vi.mock('@/router', () => ({ default: { install: () => {} } }))
vi.mock('@/shell/composables/useShellApps', () => ({
  useShellApps: () => ({
    getApp: (id: string) => apps.value.find((a: ShellApp) => a.id === id),
    resolveSurface: (id: string) => (apps.value.some((a) => a.id === id) ? surfaceComponent.value : undefined),
    listReady,
  }),
}))
vi.mock('@/shell/components/ShellPlaceholderSurface.vue', () => ({
  default: { name: 'ShellPlaceholderSurface', props: ['app'], template: '<div class="placeholder" />' },
}))

import ShellAppSurface from '@/shell/components/ShellAppSurface.vue'

/** 探针组件：生命周期计数 + 前后台信号 / 宿主环境注入的可见输出 */
function makeProbe(counts: { mounted: number; unmounted: number }) {
  return defineComponent({
    name: 'FakeSurface',
    setup() {
      const active = inject(SURFACE_ACTIVE_KEY, ref(null))
      const platform = inject('platformInfo', null)
      onMounted(() => { counts.mounted += 1 })
      onUnmounted(() => { counts.unmounted += 1 })
      return () =>
        h('div', { class: 'fake-surface' }, [
          h('span', { class: 'probe-active' }, String(active?.value)),
          h('span', { class: 'probe-platform' }, String((platform as { value?: unknown } | null)?.value ?? 'none')),
        ])
    },
  })
}

function app(id: string): ShellApp {
  return { id, name: id, version: '1.0.0', state: 'running', permissions: [], contributions: {} }
}

/** 冲刷 ensure→attach 微任务链（注册表内部 await + 挂载渲染批次） */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
}

/** 轮询等待外部可观察条件成立（并行跑批下 watch 的 flush 时序不固定，步数等待不可靠） */
async function until(cond: () => boolean, rounds = 30): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i++) await nextTick()
  expect(cond(), '等待条件超时').toBe(true)
}

const registry = getSurfaceAppRegistry()
const counts = { mounted: 0, unmounted: 0 }
const probe = makeProbe(counts)

/** 非法定义：组件装配即抛（触发注册表创建阶段失败 → 适配器失败态）。
    get 陷阱放行 `__` 前缀键——Vue ref 赋值与响应式探测会读内部标记，全抛会把
    `surfaceComponent.value = badComponent` 本身炸掉。 */
const badComponent = new Proxy(function BadSurface() {}, {
  get(_target, key) {
    if (typeof key === 'string' && key.startsWith('__')) return undefined
    throw new Error('bad surface component')
  },
})

beforeEach(async () => {
  apps.value = [app('a')]
  listReady.value = true
  surfaceComponent.value = undefined
  clearHostSurfaceEnv()
  for (const id of registry.list()) await registry.dispose(id)
  // 计数清零必须放在 dispose 之后：上一测试遗留实例的卸载也会推动计数
  counts.mounted = 0
  counts.unmounted = 0
})

describe('C-S1/C-S2 挂载优先级', () => {
  it('should_delegateToRegistry_when_appHasSurface', async () => {
    surfaceComponent.value = probe
    const wrapper = mount(ShellAppSurface, { props: { appId: 'a' } })
    await settle()

    expect(registry.has('a'), '注册表建出该应用的实例').toBe(true)
    const record = registry.get('a')!
    expect(
      wrapper.find('[data-testid="app-surface-outlet"]').element.contains(record.container),
      '容器挂进本屏插槽',
    ).toBe(true)
    expect(wrapper.find('.fake-surface').exists(), '应用 DOM 在场').toBe(true)
    expect(counts.mounted).toBe(1)
  })

  it('should_renderPlaceholderAndKeepZeroInstances_when_appKnownButNoSurface', async () => {
    const wrapper = mount(ShellAppSurface, { props: { appId: 'a' } })
    await settle()

    expect(wrapper.find('.placeholder').exists()).toBe(true)
    expect(registry.list(), '无运行面 = 零实例').toEqual([])
    expect(wrapper.text()).not.toContain('shell.run.notFound')
  })
})

describe('C-S3/C-S4 空态与加载态', () => {
  it('should_showNotFound_when_appMissingAndListReady', () => {
    apps.value = []
    listReady.value = true
    const wrapper = mount(ShellAppSurface, { props: { appId: 'missing' } })

    expect(wrapper.text()).toContain('shell.run.notFound')
    expect(wrapper.text()).not.toContain('shell.common.loading')
  })

  it('should_showLoading_when_appMissingButListStillLoading', () => {
    // 回归锁：这就是「从插件设置页返回闪应用不存在」的那段窗口
    apps.value = []
    listReady.value = false
    const wrapper = mount(ShellAppSurface, { props: { appId: 'missing' } })

    expect(wrapper.text()).toContain('shell.common.loading')
    expect(wrapper.text()).not.toContain('shell.run.notFound')
  })

  it('should_stopShowingLoading_when_listLandsWithoutTheApp', async () => {
    apps.value = []
    listReady.value = false
    const wrapper = mount(ShellAppSurface, { props: { appId: 'missing' } })
    expect(wrapper.text()).toContain('shell.common.loading')

    listReady.value = true
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('shell.run.notFound')
    expect(wrapper.text()).not.toContain('shell.common.loading')
  })
})

describe('C-S5 保活（适配器卸载只 detach）', () => {
  it('should_keepInstance_when_adapterUnmounted', async () => {
    surfaceComponent.value = probe
    const first = mount(ShellAppSurface, { props: { appId: 'a' } })
    await settle()
    const container = registry.get('a')!.container
    expect(counts.mounted).toBe(1)

    first.unmount()
    await settle()

    expect(counts.unmounted, 'detach 不 unmount').toBe(0)
    expect(registry.has('a'), '实例仍在注册表').toBe(true)
    expect(container.parentElement, '容器脱离文档但整棵保留').toBeNull()
    expect(container.querySelector('.fake-surface'), '应用 DOM 子树保留').not.toBeNull()

    // 重挂适配器：同一个容器放回插槽（不重新 createApp / mount）
    const second = mount(ShellAppSurface, { props: { appId: 'a' } })
    await settle()
    expect(registry.get('a')!.container).toBe(container)
    expect(counts.mounted, '不重复 mount').toBe(1)
    second.unmount()
  })

  it('should_notAttach_when_adapterUnmountedWhileCreating', async () => {
    // 独立 appId：避免前序用例遗留的异步续跑污染这一条（同一 appId 会共享实例）
    apps.value = [app('a'), app('race')]
    surfaceComponent.value = probe
    const wrapper = mount(ShellAppSurface, { props: { appId: 'race' } })
    // 不等 ensure 的微任务链：创建还在途就切走
    wrapper.unmount()
    await settle()

    expect(registry.has('race'), '实例照常建出（后台保活）').toBe(true)
    const record = registry.get('race')!
    expect(record.container.parentElement, '不得 attach 到已卸载的插槽').toBeNull()
    expect(record.active.value, '前台信号不得被错误推成 true').toBe(false)
  })

  it('should_disposeAndRecreate_when_registryDisposed', async () => {
    surfaceComponent.value = probe
    const wrapper = mount(ShellAppSurface, { props: { appId: 'a' } })
    await settle()
    const oldContainer = registry.get('a')!.container

    // 先摘适配器（detach，实例保留），再走外部 dispose——与真实停用路径同时序
    wrapper.unmount()
    await settle()
    expect(counts.unmounted, '摘适配器不得销毁实例').toBe(0)

    await registry.dispose('a')

    expect(counts.unmounted, 'dispose 是唯一 unmount 路径').toBe(1)
    expect(oldContainer.isConnected).toBe(false)
    expect(registry.has('a')).toBe(false)

    // 重开：全新实例（新容器、重新 mount）
    const fresh = mount(ShellAppSurface, { props: { appId: 'a' } })
    await settle()
    expect(counts.mounted).toBe(2)
    expect(registry.get('a')!.container).not.toBe(oldContainer)
    fresh.unmount()
  })
})

describe('C-S6 失败态 fail-visible', () => {
  it('should_showFailureAndRetry_when_componentInvalid', async () => {
    surfaceComponent.value = badComponent
    const wrapper = mount(ShellAppSurface, { props: { appId: 'a' } })
    await until(() => wrapper.text().includes('shell.run.mountFailed'))

    expect(registry.list(), '半挂载实例不留').toEqual([])
    expect(wrapper.find('button[aria-label="shell.common.retry"]').exists(), '失败态提供重试入口').toBe(true)

    // 组件修复后重建（spec §4.8「下次打开 / 重试可以重新创建」——用「下次打开」
    // 路径断言：与 C-S1 同构的 onMounted 管线；重试按钮走同一条 ensure 管线）
    wrapper.unmount()
    surfaceComponent.value = probe
    const fresh = mount(ShellAppSurface, { props: { appId: 'a' } })
    await until(() => fresh.element.querySelector('.fake-surface') !== null)

    expect(fresh.text()).not.toContain('shell.run.mountFailed')
    fresh.unmount()
  })
})

describe('C-S7 环境注入（注入清单是契约）', () => {
  it('should_bridgeActiveSignal_and_hostEnvKeys_when_surfaceMounted', async () => {
    registerHostSurfaceEnv({ platformInfo: ref('PLATFORM-MARK') })
    surfaceComponent.value = probe
    const wrapper = mount(ShellAppSurface, { props: { appId: 'a' } })
    await settle()

    // 前后台信号随 attach 翻 true；宿主环境键原样透传（同一份响应式引用）
    expect(wrapper.find('.probe-active').text()).toBe('true')
    expect(wrapper.find('.probe-platform').text()).toBe('PLATFORM-MARK')

    // 切走（detach）：信号翻 false，实例与 DOM 保留
    wrapper.unmount()
    await settle()
    const container = registry.get('a')!.container
    expect(container.querySelector('.probe-active')?.textContent).toBe('false')
    await registry.dispose('a')
  })

  it('should_fallBackToSignalOnly_when_hostEnvNotCollected', async () => {
    // 壳尚未收集环境（例如壳重挂窗口）：信号仍必须在场，其余键回退 undefined
    surfaceComponent.value = probe
    const wrapper = mount(ShellAppSurface, { props: { appId: 'a' } })
    await settle()

    expect(wrapper.find('.probe-active').text()).toBe('true')
    expect(wrapper.find('.probe-platform').text()).toBe('none')
    wrapper.unmount()
    await registry.dispose('a')
  })
})
