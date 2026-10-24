/**
 * 移动端运行面保活：注册表承载（行为锁）
 *
 * 口径来源：`.scratch/2026-10-24-mobile-app-surface-vue-instances/spec.md`
 * （承接 `.scratch/2026-10-23-app-surface-keepalive/spec.md` 的用户可感知语义：
 * 首次打开创建、切走保留、停用 / 卸载才销毁）。
 *
 * 旧版「池 + Teleport」结构锁（app-surface-pool / Teleport / disabled 字符串）
 * 已随承载方式退役——锁换成行为断言 + 防回接守卫：
 *   ① 对账派生销毁：应用离开运行态 → 实例 dispose、打开记录清空（停用即销毁）；
 *   ② 后台应用也建实例（打开过 ∩ 运行中，与是否前台无关）；
 *   ③ 无运行面零实例（不为无界面服务建空 Vue 应用）；
 *   ④ 壳接线防回接：ShellHost 不再渲染 Teleport 池，对账与打开登记在场。
 * （detach 不 unmount / dispose 才 unmount 的注册表级判据由
 * surfaceAppRegistry.test.ts 的 T5–T9 锁住，此处不重复。）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import type { ShellApp } from '@/shell/types'
import { getSurfaceAppRegistry, reconcileSurfaceApps } from '@/shell/surfaceRuntime'
import { dropSurface, isSurfaceOpened, markSurfaceOpened, useAppSurfaces } from '@/shell/composables/useAppSurfaces'

const SHELL_HOST = 'src/shell/components/ShellHost.vue'
const APP_RUN_SCREEN = 'src/shell/components/screens/ShellAppRunScreen.vue'

const registry = getSurfaceAppRegistry()

const counts = { mounted: 0, unmounted: 0 }
const Probe = defineComponent({
  name: 'KeepAliveProbe',
  setup() {
    onMounted(() => { counts.mounted += 1 })
    onUnmounted(() => { counts.unmounted += 1 })
    return () => h('div', { class: 'keepalive-probe' })
  },
})

const apps = ref<ShellApp[]>([])

function runningApp(id: string, state: ShellApp['state'] = 'running'): ShellApp {
  return { id, name: id, version: '1.0.0', state, permissions: [], contributions: {} }
}

/** 打开记录真源（useAppSurfaces 模块级单例的 opened 集合） */
const { opened } = useAppSurfaces()

/** 测试用对账输入：清单 ref + 真实打开记录 + 按运行态给出探针组件的解析器 */
function reconcile() {
  return reconcileSurfaceApps({
    apps: apps.value,
    opened: opened.value,
    resolveSurface: (appId) => (apps.value.some((a) => a.id === appId && a.state === 'running') ? Probe : undefined),
  })
}

// 共享运行时（i18n / router）在适配器测试面用轻桩：真实共享行为由 #33 的契约锁负责
vi.mock('@/locales', () => ({ default: { install: () => {} } }))
vi.mock('@/router', () => ({ default: { install: () => {} } }))

beforeEach(async () => {
  apps.value = []
  for (const id of registry.list()) await registry.dispose(id)
  for (const id of ['a', 'b']) dropSurface(id)
  // 计数器清零必须放在 dispose 之后：上一测试的实例卸载也会推动计数
  counts.mounted = 0
  counts.unmounted = 0
})

describe('对账（派生销毁兜底；用户动作路径的显式销毁见 useShellApps 接线）', () => {
  it('打开过 ∩ 运行中 ∩ 有运行面 → ensure 出实例（后台应用也建，保持 detached）', async () => {
    apps.value = [runningApp('a'), runningApp('b')]
    markSurfaceOpened('a')
    markSurfaceOpened('b')

    await reconcile()

    expect(registry.list().sort()).toEqual(['a', 'b'])
    for (const id of ['a', 'b']) {
      const record = registry.get(id)!
      expect(record.container.parentElement, '对账只建不 attach（attach 由运行屏适配器决定）').toBeNull()
    }
    expect(counts.mounted).toBe(2)
  })

  it('应用离开运行态 → 实例 dispose、打开记录清空（停用即销毁，下次全新）', async () => {
    apps.value = [runningApp('a')]
    markSurfaceOpened('a')
    await reconcile()
    expect(registry.has('a')).toBe(true)

    apps.value = [runningApp('a', 'stopped')]
    await reconcile()

    expect(registry.has('a'), '停用 → 实例销毁').toBe(false)
    expect(counts.unmounted, '组件真正 unmount').toBe(1)
    expect(isSurfaceOpened('a'), '打开记录同步清空（下次打开全新实例）').toBe(false)
  })

  it('从未打开过的运行中应用不建实例（无界面可保，零 UI 成本）', async () => {
    apps.value = [runningApp('a')]
    // 不 markSurfaceOpened
    await reconcile()

    expect(registry.list()).toEqual([])
    expect(counts.mounted).toBe(0)
  })

  it('无运行面（如无界面服务）→ 零实例', async () => {
    apps.value = [runningApp('a')]
    markSurfaceOpened('a')

    // 运行中且打开过，但从未注册过运行面（解析恒为 undefined）
    await reconcileSurfaceApps({ apps: apps.value, opened: opened.value, resolveSurface: () => undefined })

    expect(registry.list(), '不为无运行面应用建空 Vue 应用').toEqual([])
    expect(counts.mounted).toBe(0)
  })

  it('对账幂等：同组件身份重复 ensure 不重建', async () => {
    apps.value = [runningApp('a')]
    markSurfaceOpened('a')
    await reconcile()
    await reconcile()

    expect(counts.mounted).toBe(1)
  })
})

describe('壳接线防回接（承载已切注册表，禁止回退 Teleport 池）', () => {
  it('ShellHost 不再渲染保活池 / Teleport，对账在场', () => {
    const src = readFileSync(SHELL_HOST, 'utf-8')

    expect(src, '池容器不得回接').not.toContain('app-surface-pool')
    expect(src, 'Teleport 承载不得回接').not.toContain('<Teleport')
    expect(src, '对账接线必须在场').toContain('reconcileSurfaceApps')
    expect(src, '壳卸载只 detach 不 dispose').toContain('surfaceRegistry.detach')
  })

  it('运行屏保留打开登记，不直接渲染 surface', () => {
    const src = readFileSync(APP_RUN_SCREEN, 'utf-8')

    expect(src, '打开登记（保活判据）').toContain('markSurfaceOpened(')
    expect(src, '运行屏不得自己解析 / 直接渲染运行面组件').not.toContain('resolveSurface')
  })
})
