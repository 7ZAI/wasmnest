import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 表面保活源码锁（桌面端）
 *
 * 口径来源：`.scratch/2026-10-23-app-surface-keepalive/spec.md` §2.1 / §3.1。
 *   **切走 = 藏起来（detach）；停用 / 卸载 = 拆掉（dispose）。**
 *
 * 这里锁的是「销毁点唯一」与「挂载槽常驻」两条结构性事实。它们都不是纯函数，
 * 用组件测试很难覆盖全部路径（应用管理停用 / 全部关闭 / 卸载 / 错误终态），
 * 一旦有人把 `dispose` 塞回挂载槽的 `onBeforeUnmount`，或者把挂载槽改回
 * `v-if` 分支（切回主屏就销毁），本锁立即变红。
 */

const SHELL_HOST = 'src/shell/ShellHost.vue'
const MOUNT_SLOT = 'src/shell/mount/AppMountSlot.vue'
const USE_APP_MOUNT = 'src/shell/mount/useAppMount.ts'
const REGISTRY = 'src/shell/mount/appSurfaceRegistry.ts'

describe('表面保活：挂载槽常驻 + 销毁点唯一', () => {
  it('ShellHost 的挂载槽常驻渲染（v-show 隐藏），不随路由分支销毁', () => {
    const src = readFileSync(SHELL_HOST, 'utf-8')
    expect(src).toContain('<AppMountSlot v-show="isAppRoute"')
    // 回退征兆：挂载槽被塞回 v-if 分支（回到主屏 = 实例被销毁）
    expect(src, '挂载槽不得再用 v-if / v-else 分支控制存在性').not.toMatch(
      /<AppMountSlot\s[^>]*\bv-if/,
    )
  })

  it('ShellHost 持有唯一销毁点：应用离开运行态 → disposeAppBundle', () => {
    const src = readFileSync(SHELL_HOST, 'utf-8')
    expect(src).toContain('listAppSurfaces()')
    expect(src).toContain('void disposeAppBundle(appId)')
    // 运行态判据必须覆盖「降级但仍可用」，否则降级应用的表面会被误回收
    expect(src).toMatch(/RUNNING_DISPLAY_STATES = new Set\(\['running', 'degraded'\]\)/)
  })

  it('AppMountSlot 离开只 detach，不自己销毁实例', () => {
    const src = readFileSync(MOUNT_SLOT, 'utf-8')

    expect(src, '离开应用面必须摘槽保留实例').toContain('detachAppBundle')
    expect(src, '挂载槽不得调用禁止的旧卸载口').not.toContain('unmountAppBundle(')
    // 注释里提到 disposeAppBundle 是允许的（指向唯一销毁点），但不得有调用
    expect(src, '挂载槽不得自己销毁实例').not.toMatch(/disposeAppBundle\s*\(/)

    const unmountStart = src.indexOf('onBeforeUnmount(')
    expect(unmountStart).toBeGreaterThan(-1)
    const unmountBody = src.slice(unmountStart, src.indexOf('defineExpose'))
    expect(unmountBody, '组件卸载只是壳卸载，不等于应用停用').toContain('detachAppBundle')
  })

  it('切回已保活实例：先 attach，不重建、不换令牌、不闪加载面', () => {
    const src = readFileSync(MOUNT_SLOT, 'utf-8')
    const mountBody = src.slice(
      src.indexOf('async function mount('),
      src.indexOf('/** 宿主路由变化'),
    )

    expect(mountBody).toContain('hasAppSurface(appId)')
    expect(mountBody.indexOf('hasAppSurface(appId)'), '保活判定必须在首次装载之前').toBeLessThan(
      mountBody.indexOf('await buildEnv'),
    )
    expect(
      mountBody.indexOf("status.value = 'loading'"),
      '加载面只能出现在首次装载路径（切回闪加载 = 用户以为被重载）',
    ).toBeGreaterThan(mountBody.indexOf("status.value = 'mounted'"))
  })
})

describe('表面保活：租约与契约', () => {
  it('界面租约跟随实例生命周期：首次装载 acquire，dispose release', () => {
    const src = readFileSync(USE_APP_MOUNT, 'utf-8')

    const detachStart = src.indexOf('export function detachAppBundle')
    const detachBody = src.slice(detachStart, src.indexOf('/** 停用 / 卸载：真正销毁实例'))
    expect(detachBody, '切走不释放租约（应用还在跑）').not.toContain('notifySurfaceClose')

    const disposeStart = src.indexOf('export async function disposeAppBundle')
    const disposeBody = src.slice(disposeStart, src.indexOf('@deprecated 停用 / 卸载'))
    expect(disposeBody, 'dispose 才释放界面租约').toContain('notifySurfaceClose')

    // 兼容别名必须指向 dispose（旧调用点不会退化成「静默不销毁」）
    expect(src).toContain('export const unmountAppBundle = disposeAppBundle')
  })

  it('挂载契约新增 setActive 是可选成员（不破坏旧应用）', () => {
    const src = readFileSync(USE_APP_MOUNT, 'utf-8')
    expect(src).toContain('setActive?(active: boolean): void')
    // 新增可选成员属兼容变更：MOUNT_CONTRACT 不因此 bump（版本号本身由发布流程管理，
    // 本锁不钉具体值，只钉「可选」这一兼容性前提）
  })

  it('注册表是纯 DOM 记账（不依赖 Tauri / 装载机制，可单测）', () => {
    const src = readFileSync(REGISTRY, 'utf-8')
    expect(src).not.toContain('@tauri-apps')
    // 头注释会提到 useAppMount（指向装载层），这里锁的是**不 import** 它
    expect(src).not.toMatch(/from\s+'\.\/useAppMount'/)
    expect(src).not.toContain('invoke(')
  })
})
