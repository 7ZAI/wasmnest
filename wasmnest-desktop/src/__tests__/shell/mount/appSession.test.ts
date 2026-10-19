import { describe, it, expect, beforeEach } from 'vitest'
import { clearAppRoutes, forgetAppRoute, lastRouteOf, rememberAppRoute } from '@/shell/mount/appSession'

/**
 * 应用页面记忆（appSession）契约
 *
 * 需求来源：多任务层「后台运行的应用再次打开时回到离开时那一页」——挂载包在离开
 * 应用面时被卸载，重开是全新挂载，只有宿主存着路径才能续接。
 *
 * 机制判据（不是业务）：按 appId 原样存一个应用自报的路径串；非法输入忽略；
 * 停用 / 卸载清掉；进程内内存态。
 */

const APP = 'com.wasmnest.terminal-session'
const OTHER = 'com.wasmnest.agent-hub'

describe('应用页面记忆（appSession）', () => {
  beforeEach(() => {
    clearAppRoutes()
  })

  it('记录后能取回（正例）', () => {
    rememberAppRoute(APP, '/tasks')
    expect(lastRouteOf(APP)).toBe('/tasks')
  })

  it('后一次记录覆盖前一次（同一应用只保留最近一页）', () => {
    rememberAppRoute(APP, '/pairing')
    rememberAppRoute(APP, '/settings/session')
    expect(lastRouteOf(APP)).toBe('/settings/session')
  })

  it('无记录 / 别的应用不受影响（反例）', () => {
    rememberAppRoute(APP, '/tasks')
    expect(lastRouteOf(OTHER)).toBeUndefined()
  })

  it('非法输入不落表：根路径 / 空串 / 非绝对路径 / 空 appId', () => {
    rememberAppRoute(APP, '/')
    rememberAppRoute(APP, '')
    rememberAppRoute(APP, 'tasks')
    rememberAppRoute('', '/tasks')
    expect(lastRouteOf(APP)).toBeUndefined()
    expect(lastRouteOf('')).toBeUndefined()
  })

  it('forgetAppRoute 清掉单条（幂等：重复或未知 id 不抛）', () => {
    rememberAppRoute(APP, '/tasks')
    rememberAppRoute(OTHER, '/hub')
    forgetAppRoute(APP)
    expect(lastRouteOf(APP)).toBeUndefined()
    expect(lastRouteOf(OTHER), '只清目标应用，别的应用记忆保留').toBe('/hub')
    expect(() => forgetAppRoute(APP)).not.toThrow()
    expect(() => forgetAppRoute('ghost')).not.toThrow()
  })

  it('clearAppRoutes 清空全部（全部关闭 / 测试隔离用）', () => {
    rememberAppRoute(APP, '/tasks')
    rememberAppRoute(OTHER, '/hub')
    clearAppRoutes()
    expect(lastRouteOf(APP)).toBeUndefined()
    expect(lastRouteOf(OTHER)).toBeUndefined()
  })
})
