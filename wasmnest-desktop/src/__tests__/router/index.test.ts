/**
 * 静态路由表契约（D3：路由直写 + 退役面 fail-visible）
 *
 * 桌面宿主前端整体下沉后，路由表是 app 内单一事实源。本测试钉：
 * - 默认落地 `/sessions`（原 `/plugins` 应用中心落地页随应用中心删除）；
 * - 菜单页 / 设置页 / 授权二级页 / 诊断页 / 两个深链页在位；
 * - `/plugins`、`/shell`、`/plugin/*` 退役路由不存在（fail-visible：直接访问
 *   落 not-found 兜底，不白屏、不静默回落）；
 * - 终端窗口路由 bareWindow（不套侧边栏外壳）。
 */

import { describe, it, expect } from 'vitest'
import router from '@/router'

function routeByName(name: string) {
  const route = router.getRoutes().find((r) => r.name === name)
  expect(route, `路由 ${name} 必须存在`).toBeTruthy()
  return route!
}

describe('Router Configuration（静态表）', () => {
  describe('route definitions', () => {
    it('root = 壳主屏（方案 C 恢复：宿主门面，非 redirect）', () => {
      const root = router.getRoutes().find((r) => r.path === '/')
      expect(root?.name).toBe('shell-home')
      expect(root?.redirect).toBeUndefined()
    })

    it('壳系统页路由：/sys/:pageId（设置 / 应用管理 / 权限）', () => {
      const sys = router.getRoutes().find((r) => r.path === '/sys/:pageId')
      expect(sys?.name).toBe('shell-sys')
    })

    it('菜单四项：配对 / 会话 / 任务 / 设置', () => {
      expect(routeByName('pairing').path).toBe('/pairing')
      expect(routeByName('sessions').path).toBe('/sessions')
      expect(routeByName('tasks').path).toBe('/tasks')
      expect(routeByName('settings').path).toBe('/settings')
    })

    it('设置二级路由与服务器诊断页在位（授权管理归系统页 /sys/perms；诊断页 URL 直达）', () => {
      // 设置子路由（/settings/:sub）挂载 bedcode 应用面（遗留 /settings/authorization
      // 深链由 app 内存路由显性重定向回 /settings）
      expect(routeByName('settings-sub').path).toBe('/settings/:sub(.*)?')
      expect(routeByName('server').path).toBe('/server')
    })

    it('应用面路由挂载槽：bedcode 既有路径 + 其余 app 单面路由（机制 B）', () => {
      // bedcode 应用面（保持既有路径与深链语义）
      expect(routeByName('pairing').path).toBe('/pairing')
      expect(routeByName('sessions').path).toBe('/sessions')
      expect(routeByName('tasks').path).toBe('/tasks')
      expect(routeByName('settings').path).toBe('/settings')
      expect(routeByName('history').path).toBe('/history')
      // 其余 app：独立界面单面路由（含 servers/ 下的认证中心）
      expect(routeByName('app-agent-hub').path).toBe('/hub')
      expect(routeByName('app-ai-chatbox').path).toBe('/chat')
      expect(routeByName('app-file-transfer').path).toBe('/transfer')
      expect(routeByName('app-monitor').path).toBe('/monitor')
      expect(routeByName('app-auth-center').path).toBe('/auth')
      // 全部指向 AppMountSlot（机制 B 挂载槽）
      for (const name of [
        'pairing',
        'sessions',
        'tasks',
        'history',
        'app-agent-hub',
        'app-ai-chatbox',
        'app-file-transfer',
        'app-monitor',
        'app-auth-center',
      ]) {
        const comp = routeByName(name).components?.default
        expect(comp?.__name ?? comp?.name, `路由 ${name} 必须挂载 AppMountSlot`).toMatch(
          /AppMountSlot/,
        )
      }
    })

    it('深链页：连接历史 + 终端窗口（bareWindow）', () => {
      expect(routeByName('history').path).toBe('/history')
      const terminalWindow = routeByName('terminal-window')
      expect(terminalWindow.path).toBe('/terminal-window/:id')
      expect(terminalWindow.meta.bareWindow).toBe(true)
    })

    it('not-found 兜底在位（D3 fail-visible）', () => {
      expect(routeByName('not-found')).toBeTruthy()
    })
  })

  describe('retired routes', () => {
    it('/plugins 应用中心路由不存在', () => {
      const paths = router.getRoutes().map((r) => r.path)
      expect(paths.filter((p) => p.startsWith('/plugins'))).toEqual([])
    })

    it('/shell 设备壳路由不存在', () => {
      const paths = router.getRoutes().map((r) => r.path)
      expect(paths.filter((p) => p.startsWith('/shell'))).toEqual([])
    })

    it('/plugin/* 插件视图路由不存在', () => {
      const paths = router.getRoutes().map((r) => r.path)
      expect(paths.filter((p) => p.startsWith('/plugin/'))).toEqual([])
    })
  })
})
