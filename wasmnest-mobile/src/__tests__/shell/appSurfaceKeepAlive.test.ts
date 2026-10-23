import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 运行面保活源码锁（移动端）
 *
 * 口径来源：`.scratch/2026-10-23-app-surface-keepalive/spec.md` §3.2。
 *   **surface 由壳根常驻的池渲染，用 Teleport 在「运行屏插槽」与「隐藏池」之间移动**——
 *   移动只改 DOM 挂载点，不重建组件实例，切回来界面状态原样。
 *
 * 锁的是三条结构性事实（都不是单个纯函数能覆盖的）：
 *   ① 运行屏不再直接渲染 surface（否则切走即卸载，保活失效）；
 *   ② 池内条目按「打开过 ∩ 运行中」过滤，停用即出池；
 *   ③ 非前台应用走 Teleport disabled（留在隐藏池里，不渲染但实例在）。
 */

const SHELL_HOST = 'src/shell/components/ShellHost.vue'
const APP_RUN_SCREEN = 'src/shell/components/screens/ShellAppRunScreen.vue'
const APP_SURFACE = 'src/shell/components/ShellAppSurface.vue'

describe('移动端运行面保活：池 + Teleport', () => {
  it('壳根常驻隐藏池，按「打开过 ∩ 运行中」渲染条目', () => {
    const src = readFileSync(SHELL_HOST, 'utf-8')

    expect(src).toContain('app-surface-pool')
    expect(src).toContain('surfaceApps')
    expect(src, '池内只留打开过且仍在运行的应用').toMatch(
      /opened\.value\.has\(a\.id\)\s*&&\s*RUNNING_APP_STATES\.has\(a\.state\)/,
    )
    // 移动端运行态只有 running（ShellAppState 五档，无 degraded）
    expect(src).toMatch(/RUNNING_APP_STATES = new Set\(\['running'\]\)/)
    expect(src, '停用 / 卸载 / 错误终态必须出池').toContain('dropSurface(appId)')
  })

  it('非前台应用禁用 Teleport：内容留在隐藏池（实例不重建）', () => {
    const src = readFileSync(SHELL_HOST, 'utf-8')

    expect(src).toContain('<Teleport')
    expect(src, '目标 = 运行屏插槽；无插槽时退回池').toContain("outletEl ?? 'body'")
    expect(src, '前台判据必须进 disabled（否则所有应用同时抢插槽）').toContain(
      ':disabled="!outletEl || !isSurfaceActive(app.id)"',
    )
    expect(src, '前后台信号写入口').toContain('setActiveSurface(')
  })

  it('运行屏只提供插槽并登记，不直接渲染 surface', () => {
    const src = readFileSync(APP_RUN_SCREEN, 'utf-8')

    expect(src).toContain('data-testid="app-surface-outlet"')
    expect(src).toContain('markSurfaceOpened(')
    expect(src).toContain('setSurfaceOutlet(')
    expect(src, '离开运行屏必须注销自己登记的插槽').toContain(
      'releaseSurfaceOutlet(outletEl.value)',
    )
    // 回退征兆：运行屏自己 import 并渲染 surface（切走即销毁）
    expect(src, '运行屏不得直接 import ShellAppSurface').not.toMatch(
      /import\s+ShellAppSurface\s+from/,
    )
  })

  it('surface 容器提供可选前后台信号（应用可据此暂停轮询）', () => {
    const src = readFileSync(APP_SURFACE, 'utf-8')

    expect(src).toContain('provide(SURFACE_ACTIVE_KEY')
    expect(src).toContain('activeSignal(props.appId)')
  })
})
