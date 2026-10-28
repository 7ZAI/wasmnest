import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * useShellState（主屏 + 全屏面 + 卡片 MRU + 覆层 + 通知 + 真实生命周期）测试
 *
 * 2026-10-17 lifecycle-sync 契约：
 * - 路由是唯一事实源（syncFromRoute；app 路由 → 应用卡，id = pluginId）；
 * - openApp = 真实激活（preauthorize → activate）+ 挂载运行面（产卡 + 路由）；
 * - closeCard / stopApp = **真停用**（deactivate 成功后才摘面；失败留卡不静默丢）；
 * - 审批通知从待审批应用派生（真实数据源，不再是恒空桩）。
 *
 * 依赖桩：
 * - useShellApps 模块 mock：真实纯函数（pluginIdOfAppRoute 等）保留，composable
 *   状态/动作桩（refs 用普通对象 {value}，动作命令式调用，测试不依赖响应式）；
 * - useToast / i18n / router mock（避免 Tauri / vue-i18n 加载）。
 */

// ==================== mock 工厂（模块级单例桩；纯函数走真实实现） ====================

vi.mock('@/shell/composables/useShellApps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shell/composables/useShellApps')>()
  const st = {
    plugins: { value: [] as Array<{ id: string; name: string; route?: string; state?: string; permissions?: string[]; kind?: string; source?: string }> },
    loading: { value: false },
    listReady: { value: false },
    busyId: { value: null as string | null },
    installing: { value: false },
    lastError: { value: null as string | null },
    displayStates: { value: {} as Record<string, string> },
    tones: { value: {} as Record<string, string> },
    approvalApps: { value: [] as Array<{ id: string; name: string; permissions: string[] }> },
    appOf: (id: string) => st.plugins.value.find((p) => p.id === id),
    load: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    activate: vi.fn(() => Promise.resolve(true)),
    deactivate: vi.fn(() => Promise.resolve(true)),
    approve: vi.fn(() => Promise.resolve(true)),
    uninstall: vi.fn(() => Promise.resolve(true)),
    installFromZip: vi.fn(() => Promise.resolve(true)),
    setEnabled: vi.fn(() => Promise.resolve(true)),
    setAutostart: vi.fn(() => Promise.resolve(true)),
    isRunning: () => Promise.resolve(false),
  }
  return { ...actual, useShellApps: () => st }
})

const toastSuccess = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    show: () => '',
    success: toastSuccess,
    error: toastError,
    warning: () => '',
    info: () => '',
  }),
}))

// 安装编排经 invoke 选包（plugin_pick_app_package）；返回值按用例注入
vi.mock('@/utils/invoke', () => ({ invoke: invokeMock }))

vi.mock('@/i18n', () => ({
  default: { global: { t: (key: string) => key, te: () => false } },
}))

vi.mock('@/router', () => ({ default: { push: vi.fn() } }))

import router from '@/router'
import { clearAppRoutes, lastRouteOf, rememberAppRoute } from '@/shell/mount/appSession'
import { useShellState } from '@/shell/composables/useShellState'
import { useShellApps } from '@/shell/composables/useShellApps'

/** 测试用应用 id（= pluginId；ADR 0056 后 id 家族 = com.wasmnest，与 useShellApps 真源一致） */
const TERMINAL_PLUGIN_ID = 'com.wasmnest.bedcode'

describe('useShellState（主屏 + 全屏面 + 卡片 MRU + 覆层 + 通知 + 真实生命周期）', () => {
  const apps = useShellApps()

  beforeEach(() => {
    const s = useShellState()
    s.screen.value = 'home'
    s.cards.value = []
    s.activeCard.value = null
    s.panelOpen.value = false
    s.recentsOpen.value = false
    s.ctxMenu.value = null
    s.dialog.value = null
    s.dialogAppId.value = null
    s.installTarget.value = null
    s.homeQ.value = ''
    s.notifs.value = []
    s.notifPulse.value = 0
    apps.plugins.value = []
    apps.displayStates.value = {}
    apps.tones.value = {}
    apps.approvalApps.value = []
    apps.busyId.value = null
    apps.installing.value = false
    apps.lastError.value = null
    vi.mocked(apps.activate).mockReset()
    vi.mocked(apps.deactivate).mockReset()
    vi.mocked(apps.approve).mockReset()
    vi.mocked(apps.uninstall).mockReset()
    vi.mocked(apps.installFromZip).mockReset()
    vi.mocked(apps.installFromZip).mockResolvedValue(true)
    invokeMock.mockReset()
    toastError.mockClear()
    vi.mocked(router.push).mockClear()
    toastSuccess.mockClear()
    // 页面记忆是模块级单例：用例间必须清，否则「有没有记忆」会被前一个用例污染
    clearAppRoutes()
  })

  /** 种子：运行中应用（带挂载路由）；kind = 装配角色（manifest），服务型应用传 L1/L2 */
  function seedApp(id: string, name = id, route?: string, kind?: string) {
    apps.plugins.value = [{ id, name, route, state: 'running', kind }]
    apps.displayStates.value = { [id]: 'running' }
  }

  describe('系统页卡', () => {
    it('openSys：产卡 + MRU 置顶 + 切 card 屏 + 路由进入', () => {
      const s = useShellState()
      s.openSys('settings')
      expect(s.screen.value).toBe('card')
      expect(s.activeCard.value).toBe('sys:settings')
      expect(s.cards.value).toEqual(['sys:settings'])
      expect(router.push).toHaveBeenCalledWith('/sys/settings')

      s.openSys('apps')
      expect(s.cards.value).toEqual(['sys:apps', 'sys:settings'])
      expect(s.activeCard.value).toBe('sys:apps')

      // 重复打开 settings：重排到最前，不产重复卡
      s.openSys('settings')
      expect(s.cards.value).toEqual(['sys:settings', 'sys:apps'])
      expect(s.cards.value.length).toBe(2)
    })

    it('未知系统页不产卡', () => {
      const s = useShellState()
      s.openSys('nope')
      expect(s.cards.value).toEqual([])
    })
  })

  describe('应用面（真实生命周期）', () => {
    it('openApp：真实激活（preauthorize → activate）+ 产卡 + 路由进入', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      await s.openApp(TERMINAL_PLUGIN_ID)
      expect(apps.activate).toHaveBeenCalledWith(TERMINAL_PLUGIN_ID)
      expect(s.cards.value).toEqual([`app:${TERMINAL_PLUGIN_ID}`])
      expect(s.screen.value).toBe('card')
      expect(router.push).toHaveBeenCalledWith('/sessions')
      expect(s.notifs.value, '启动是静默动作，不落通知').toEqual([])
    })

    it('openApp 激活失败：不产卡不导航；未授权落审批弹窗', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      vi.mocked(apps.activate).mockResolvedValueOnce(false)
      // 失败后终态 = 待审批（后端审批门禁拒绝的典型形态）
      apps.plugins.value[0].state = 'approval'
      apps.displayStates.value[TERMINAL_PLUGIN_ID] = 'approval'
      await s.openApp(TERMINAL_PLUGIN_ID)
      expect(s.cards.value).toEqual([])
      expect(router.push).not.toHaveBeenCalled()
      expect(s.dialog.value).toBe('approval')
      expect(s.dialogAppId.value).toBe(TERMINAL_PLUGIN_ID)
    })

    it('openApp 无宿主运行面（无 route）：只激活不产卡（运行态在网格 chip 可见）', async () => {
      const s = useShellState()
      seedApp('com.wasmnest.ai-chatbox', 'AI Chatbox', undefined)
      await s.openApp('com.wasmnest.ai-chatbox')
      expect(apps.activate).toHaveBeenCalledWith('com.wasmnest.ai-chatbox')
      expect(s.cards.value).toEqual([])
      expect(s.screen.value).toBe('home')
      expect(router.push).not.toHaveBeenCalled()
      expect(s.notifs.value, '启动是静默动作，不落通知').toEqual([])
    })

    it('未知应用不产卡不动作', async () => {
      const s = useShellState()
      await s.openApp('ghost')
      expect(s.cards.value).toEqual([])
      expect(router.push).not.toHaveBeenCalled()
      expect(apps.activate).not.toHaveBeenCalled()
    })
  })

  describe('服务型应用不进多任务（keepalive spec §3.3）', () => {
    const MONITOR_ID = 'com.wasmnest.monitor'

    it('openApp：服务型应用（L1/L2）激活成功后进全屏面但不产卡', async () => {
      const s = useShellState()
      seedApp(MONITOR_ID, 'Monitor', '/monitor', 'internal-business')
      await s.openApp(MONITOR_ID)
      expect(apps.activate).toHaveBeenCalledWith(MONITOR_ID)
      expect(s.screen.value, '服务面也是全屏应用面').toBe('card')
      expect(s.activeCard.value).toBe(`app:${MONITOR_ID}`)
      expect(s.cards.value, '不产卡：切换器与「全部关闭」只消费 cards').toEqual([])
      expect(router.push).toHaveBeenCalledWith('/monitor')
    })

    it('syncFromRoute：直达服务路由（含 openApp 路由回环）不补卡', () => {
      const s = useShellState()
      seedApp(MONITOR_ID, 'Monitor', '/monitor', 'internal-business')
      s.syncFromRoute('/monitor')
      expect(s.screen.value).toBe('card')
      expect(s.activeCard.value).toBe(`app:${MONITOR_ID}`)
      expect(s.cards.value).toEqual([])
    })

    it('业务应用同路径仍产卡（守卫不外溢）', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      s.syncFromRoute('/sessions')
      expect(s.cards.value).toEqual([`app:${TERMINAL_PLUGIN_ID}`])
    })

    it('「全部关闭」只触达有卡应用，不误杀运行中的服务型应用', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      await s.openApp(TERMINAL_PLUGIN_ID)
      // 服务型应用运行中但无卡（openApp 不产卡，见上）
      apps.plugins.value = [
        ...apps.plugins.value,
        { id: MONITOR_ID, name: 'Monitor', route: '/monitor', state: 'running', kind: 'internal-business' },
      ]
      await s.stopAllCards()
      expect(apps.deactivate, '服务型应用无卡，不被全部关闭触达').toHaveBeenCalledTimes(1)
      expect(apps.deactivate).toHaveBeenCalledWith(TERMINAL_PLUGIN_ID)
      expect(apps.deactivate).not.toHaveBeenCalledWith(MONITOR_ID)
    })
  })

  describe('应用会话判定（主屏绿点数据源）', () => {
    it('无卡 = 无会话；打开应用后产卡 = 有会话；真停用摘卡后回到无会话', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      expect(s.hasAppSession(TERMINAL_PLUGIN_ID)).toBe(false)

      await s.openApp(TERMINAL_PLUGIN_ID)
      expect(s.hasAppSession(TERMINAL_PLUGIN_ID)).toBe(true)

      await s.closeCard(`app:${TERMINAL_PLUGIN_ID}`)
      expect(s.hasAppSession(TERMINAL_PLUGIN_ID)).toBe(false)
    })

    it('系统页卡不算应用会话；其他应用卡互不串扰', () => {
      const s = useShellState()
      s.openSys('settings')
      expect(s.hasAppSession('settings')).toBe(false)
      expect(s.hasAppSession(TERMINAL_PLUGIN_ID)).toBe(false)
    })
  })

  describe('卡片 MRU 与关闭（真停用）', () => {
    it('activateCard（多任务层点卡）：MRU 置顶 + 切到对应路由', () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      s.openSys('settings')
      s.activateCard(`app:${TERMINAL_PLUGIN_ID}`)
      expect(s.cards.value).toEqual([`app:${TERMINAL_PLUGIN_ID}`, 'sys:settings'])
      expect(s.activeCard.value).toBe(`app:${TERMINAL_PLUGIN_ID}`)
      expect(router.push).toHaveBeenLastCalledWith('/sessions')
    })

    it('关应用卡 = 真停用（deactivate 成功后才摘面）；系统页卡 = 只关页面', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      s.openSys('settings')
      s.openApp(TERMINAL_PLUGIN_ID)
      // 当前活动卡 app → 关掉切到 MRU 次卡 sys:settings
      await s.closeCard(`app:${TERMINAL_PLUGIN_ID}`)
      expect(apps.deactivate).toHaveBeenCalledWith(TERMINAL_PLUGIN_ID)
      expect(s.cards.value).toEqual(['sys:settings'])
      expect(s.activeCard.value).toBe('sys:settings')
      expect(router.push).toHaveBeenLastCalledWith('/sys/settings')

      // 系统页卡：关页不触发任何实例动作
      await s.closeCard('sys:settings')
      expect(s.cards.value).toEqual([])
      expect(s.activeCard.value).toBeNull()
      expect(s.screen.value).toBe('home')
      expect(router.push).toHaveBeenLastCalledWith('/')
    })

    it('停用失败：卡片保留（不留「关了还在跑」的假象）', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      await s.openApp(TERMINAL_PLUGIN_ID)
      vi.mocked(apps.deactivate).mockResolvedValueOnce(false)
      await s.closeCard(`app:${TERMINAL_PLUGIN_ID}`)
      expect(s.cards.value).toEqual([`app:${TERMINAL_PLUGIN_ID}`])
      expect(s.screen.value).toBe('card')
    })

    it('关活动卡切 MRU 次卡；无卡回主屏', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      await s.openApp(TERMINAL_PLUGIN_ID)
      s.openSys('settings')
      await s.closeCard(`app:${TERMINAL_PLUGIN_ID}`)
      expect(s.activeCard.value).toBe('sys:settings')
      expect(s.screen.value).toBe('card')
    })

    it('关非活动卡：只移除，不影响活动面', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      await s.openApp(TERMINAL_PLUGIN_ID)
      s.openSys('settings')
      await s.closeCard('sys:settings')
      expect(s.activeCard.value).toBe(`app:${TERMINAL_PLUGIN_ID}`)
      expect(s.screen.value).toBe('card')
    })

    it('移除最后一张卡（当前面为空）：收起多任务并回主屏', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      await s.openApp(TERMINAL_PLUGIN_ID)
      // 回主屏后卡片仍留在多任务里（后台运行），此时 activeCard 为 null
      s.goHome()
      s.recentsOpen.value = true

      await s.closeCard(`app:${TERMINAL_PLUGIN_ID}`)

      expect(s.cards.value).toEqual([])
      expect(s.activeCard.value).toBeNull()
      expect(s.screen.value).toBe('home')
      expect(s.recentsOpen.value, '空多任务层不留在屏幕上').toBe(false)
      expect(router.push).toHaveBeenLastCalledWith('/')
    })
  })

  describe('路由同步（事实源）', () => {
    it("syncFromRoute('/') → 主屏；'/sys/perms' → 系统页卡；app 路由 → 应用卡", () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')

      s.syncFromRoute('/sys/perms')
      expect(s.screen.value).toBe('card')
      expect(s.activeCard.value).toBe('sys:perms')
      expect(s.cards.value).toEqual(['sys:perms'])

      s.syncFromRoute('/sessions')
      expect(s.activeCard.value).toBe(`app:${TERMINAL_PLUGIN_ID}`)
      expect(s.cards.value).toEqual([`app:${TERMINAL_PLUGIN_ID}`, 'sys:perms'])

      // app 深链（/tasks /terminal-window/:id 等）同归应用卡，幂等不重复产卡
      s.syncFromRoute('/tasks')
      expect(s.cards.value).toEqual([`app:${TERMINAL_PLUGIN_ID}`, 'sys:perms'])
      expect(s.activeCard.value).toBe(`app:${TERMINAL_PLUGIN_ID}`)

      s.syncFromRoute('/')
      expect(s.screen.value).toBe('home')
      expect(s.activeCard.value).toBeNull()
    })
  })

  describe('全部关闭与返回（真停用）', () => {
    it('stopAllCards：每个应用卡真停用 + 清卡 + 落通知 + 回主屏', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      await s.openApp(TERMINAL_PLUGIN_ID)
      s.openSys('settings')
      await s.stopAllCards()
      expect(apps.deactivate).toHaveBeenCalledWith(TERMINAL_PLUGIN_ID)
      expect(s.cards.value).toEqual([])
      expect(s.screen.value).toBe('home')
      expect(router.push).toHaveBeenLastCalledWith('/')
      expect(s.notifs.value.length).toBe(1)
      expect(s.notifs.value[0].icon).toBe('layers')
    })

    it('stopAllCards：停用失败的卡保留', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      await s.openApp(TERMINAL_PLUGIN_ID)
      vi.mocked(apps.deactivate).mockResolvedValueOnce(false)
      await s.stopAllCards()
      expect(s.cards.value).toEqual([`app:${TERMINAL_PLUGIN_ID}`])
      expect(s.screen.value).toBe('card')
    })

    it('返回（Esc）逐层收覆层：dialog > ctx > panel > recents，耗尽后全屏 → 主屏', () => {
      const s = useShellState()
      s.screen.value = 'card'
      s.dialog.value = 'exit'
      s.ctxMenu.value = { appId: TERMINAL_PLUGIN_ID, x: 0, y: 0 }
      s.panelOpen.value = true

      s.goBack()
      expect(s.dialog.value).toBeNull()
      expect(s.ctxMenu.value).not.toBeNull()
      s.goBack()
      expect(s.ctxMenu.value).toBeNull()
      expect(s.panelOpen.value).toBe(true)
      s.goBack()
      expect(s.panelOpen.value).toBe(false)
      expect(s.screen.value).toBe('card')
      s.goBack()
      expect(s.screen.value).toBe('home')
      expect(router.push).toHaveBeenLastCalledWith('/')
      // 主屏上再返回：无操作（不重复 push）
      const calls = vi.mocked(router.push).mock.calls.length
      s.goBack()
      expect(vi.mocked(router.push).mock.calls.length).toBe(calls)
    })
  })

  describe('续接：后台运行的应用回到上次那一页', () => {
    it('openApp 有页面记忆 → 进记忆路径（不是落地页）', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      rememberAppRoute(TERMINAL_PLUGIN_ID, '/settings/session')
      await s.openApp(TERMINAL_PLUGIN_ID)
      expect(router.push).toHaveBeenLastCalledWith('/settings/session')
    })

    it('openApp 无记忆 → 落地页（反例：不凭空编路径）', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      await s.openApp(TERMINAL_PLUGIN_ID)
      expect(router.push).toHaveBeenLastCalledWith('/sessions')
    })

    it('activateCard（多任务行点击）同样走续接', () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      rememberAppRoute(TERMINAL_PLUGIN_ID, '/tasks')
      s.activateCard(`app:${TERMINAL_PLUGIN_ID}`)
      expect(router.push).toHaveBeenLastCalledWith('/tasks')
    })

    it('关掉应用（真停用成功）→ 记忆作废，下次重新落回落地页', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      rememberAppRoute(TERMINAL_PLUGIN_ID, '/tasks')
      await s.openApp(TERMINAL_PLUGIN_ID)
      await s.closeCard(`app:${TERMINAL_PLUGIN_ID}`)
      expect(lastRouteOf(TERMINAL_PLUGIN_ID), '实例停用后不该再记得那一页').toBeUndefined()
      vi.mocked(router.push).mockClear()
      await s.openApp(TERMINAL_PLUGIN_ID)
      expect(router.push).toHaveBeenLastCalledWith('/sessions')
    })

    it('停用失败 → 记忆保留（应用还在后台，不能顺手抹掉续接点）', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      rememberAppRoute(TERMINAL_PLUGIN_ID, '/tasks')
      await s.openApp(TERMINAL_PLUGIN_ID)
      vi.mocked(apps.deactivate).mockResolvedValueOnce(false)
      await s.closeCard(`app:${TERMINAL_PLUGIN_ID}`)
      expect(lastRouteOf(TERMINAL_PLUGIN_ID)).toBe('/tasks')
    })

    it('卸载应用 → 记忆作废', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      rememberAppRoute(TERMINAL_PLUGIN_ID, '/tasks')
      await s.uninstallApp(TERMINAL_PLUGIN_ID)
      expect(lastRouteOf(TERMINAL_PLUGIN_ID)).toBeUndefined()
    })
  })

  describe('多任务全屏层（覆层语义）', () => {
    it('toggleRecents：打开时收起通知中心 / 右键菜单（同锚点互斥）', () => {
      const s = useShellState()
      s.panelOpen.value = true
      s.ctxMenu.value = { appId: TERMINAL_PLUGIN_ID, x: 0, y: 0 }

      s.toggleRecents()
      expect(s.recentsOpen.value).toBe(true)
      expect(s.panelOpen.value).toBe(false)
      expect(s.ctxMenu.value).toBeNull()

      // 再点一次 = 收起（不改变其它覆层）
      s.toggleRecents()
      expect(s.recentsOpen.value).toBe(false)
    })

    it('切面 / 回主屏都会收起多任务层', () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      s.toggleRecents()
      s.openSys('settings')
      expect(s.recentsOpen.value, '切到别的面时面板必须收起').toBe(false)

      s.toggleRecents()
      s.goHome()
      expect(s.recentsOpen.value).toBe(false)
    })

    it('goBack 逐层收：多任务层在通知中心之后、回主屏之前', () => {
      const s = useShellState()
      s.screen.value = 'card'
      s.recentsOpen.value = true
      s.panelOpen.value = true

      s.goBack() // 先收通知中心
      expect(s.panelOpen.value).toBe(false)
      expect(s.recentsOpen.value).toBe(true)
      expect(s.screen.value).toBe('card')

      s.goBack() // 再收多任务
      expect(s.recentsOpen.value).toBe(false)
      expect(s.screen.value).toBe('card')

      s.goBack() // 最后回主屏
      expect(s.screen.value).toBe('home')
    })

    it('全部关闭：应用卡真停用 + 记忆清空', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      rememberAppRoute(TERMINAL_PLUGIN_ID, '/tasks')
      await s.openApp(TERMINAL_PLUGIN_ID)
      await s.stopAllCards()
      expect(s.cards.value).toEqual([])
      expect(lastRouteOf(TERMINAL_PLUGIN_ID)).toBeUndefined()
    })
  })

  describe('通知（机制面；审批从真实待审批应用派生）', () => {
    it('approvalNotifs：待审批应用派生通知（批准后自然消失）', () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      apps.approvalApps.value = [
        { id: 'com.wasmnest.file-transfer', name: 'File Transfer', permissions: ['storage', 'pty:spawn'] },
      ]
      const notifs = s.approvalNotifs()
      expect(notifs.length).toBe(1)
      expect(notifs[0].app).toBe('com.wasmnest.file-transfer')
      expect(notifs[0].sticky).toBe(true)
      // 无待审批 → 空（不再恒空桩，但真实空态就是空）
      apps.approvalApps.value = []
      expect(s.approvalNotifs()).toEqual([])
    })

    it('push / 单条关闭 / 清除全部只清非驻留', () => {
      const s = useShellState()
      s.pushNotif({ kind: 'event', icon: 'stop', source: 's', title: 't1' })
      s.pushNotif({ kind: 'info', icon: 'check', source: 's', title: 't2', sticky: true })
      expect(s.notifs.value.length).toBe(2)

      s.dismissNotif(s.notifs.value.find((n) => n.title === 't1')!.id)
      expect(s.notifs.value.length).toBe(1)
      expect(s.notifs.value[0].title).toBe('t2')

      s.pushNotif({ kind: 'event', icon: 'x', source: 's', title: 't3' })
      s.clearNotifs()
      expect(s.notifs.value.map((n) => n.title)).toEqual(['t2'])
    })

    it('notifPulse：每落一条新通知自增一次（清除/关闭不动脉冲）', () => {
      const s = useShellState()
      expect(s.notifPulse.value).toBe(0)
      s.pushNotif({ kind: 'event', icon: 'x', source: 's', title: 't1' })
      s.pushNotif({ kind: 'event', icon: 'x', source: 's', title: 't2' })
      expect(s.notifPulse.value).toBe(2)
      s.dismissNotif(s.notifs.value[0].id)
      s.clearNotifs()
      expect(s.notifPulse.value).toBe(2)
    })

    it('铃铛角标 = 通知条数 + 待审批数（审批是真实动作入口）', () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      s.pushNotif({ kind: 'event', icon: 'x', source: 's', title: 't' })
      apps.approvalApps.value = [{ id: 'x', name: 'X', permissions: [] }]
      expect(s.notifCountTotal.value).toBe(2)
    })
  })

  describe('stopApp / uninstallApp（真实生命周期）', () => {
    it('stopApp 开着卡：走 closeCard 同一路径（真停用 + 摘面）', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      await s.openApp(TERMINAL_PLUGIN_ID)
      const ok = await s.stopApp(TERMINAL_PLUGIN_ID)
      expect(apps.deactivate).toHaveBeenCalledWith(TERMINAL_PLUGIN_ID)
      expect(s.cards.value).toEqual([])
      expect(ok, '实例真停用 = 返回成功（服务停止确认弹窗据此收起）').toBe(true)
      expect(toastSuccess, '停止是静默动作，不落 toast').not.toHaveBeenCalled()
    })

    it('stopApp 无卡运行：直接真停用', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      const ok = await s.stopApp(TERMINAL_PLUGIN_ID)
      expect(apps.deactivate).toHaveBeenCalledWith(TERMINAL_PLUGIN_ID)
      expect(ok).toBe(true)
      expect(toastSuccess, '停止是静默动作，不落 toast').not.toHaveBeenCalled()
    })

    it('stopApp 停用失败：返回 false（实例仍在运行，确认面不得收起）', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      rememberAppRoute(TERMINAL_PLUGIN_ID, '/tasks')
      vi.mocked(apps.deactivate).mockResolvedValueOnce(false)
      const ok = await s.stopApp(TERMINAL_PLUGIN_ID)
      expect(ok).toBe(false)
      expect(lastRouteOf(TERMINAL_PLUGIN_ID), '停用失败 = 实例仍在跑，页面记忆保留').toBe(
        '/tasks',
      )
    })

    it('uninstallApp：卸载 + 摘运行面 + 关弹窗', async () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      await s.openApp(TERMINAL_PLUGIN_ID)
      s.dialog.value = 'uninstall'
      s.dialogAppId.value = TERMINAL_PLUGIN_ID
      await s.uninstallApp(TERMINAL_PLUGIN_ID)
      expect(apps.uninstall).toHaveBeenCalledWith(TERMINAL_PLUGIN_ID)
      expect(s.cards.value).toEqual([])
      expect(s.dialog.value).toBeNull()
    })
  })

  describe('外部应用包安装（宿主装配面，2026-10-28）', () => {
    const THIRD_PARTY_ID = 'com.wasmnest.third-party'
    const PICKED = { path: '/tmp/third-party.zip', pluginId: THIRD_PARTY_ID }

    it('取消选包（返回 null）→ 无事发生', async () => {
      const s = useShellState()
      invokeMock.mockResolvedValueOnce(null)
      await s.installApp()
      expect(apps.installFromZip).not.toHaveBeenCalled()
      expect(s.dialog.value).toBeNull()
    })

    it('新 id（未注册）→ 直接安装并落成功 toast；不弹确认', async () => {
      const s = useShellState()
      invokeMock.mockResolvedValueOnce(PICKED)
      await s.installApp()
      expect(apps.installFromZip).toHaveBeenCalledWith('/tmp/third-party.zip', false)
      expect(s.dialog.value, '新装不经确认弹窗').toBeNull()
      expect(toastSuccess).toHaveBeenCalledWith('shell.dialog.install.success')
    })

    it('已装同 id 但是内置来源 → fail-visible 拒绝（不安装不弹确认）', async () => {
      const s = useShellState()
      apps.plugins.value = [{ id: THIRD_PARTY_ID, name: 'Third Party', source: 'builtin' }]
      invokeMock.mockResolvedValueOnce(PICKED)
      await s.installApp()
      expect(apps.installFromZip).not.toHaveBeenCalled()
      expect(s.dialog.value).toBeNull()
      expect(toastError).toHaveBeenCalledWith('errors.shell.install.builtinConflict')
    })

    it('已装同 id 且运行中 → 拒绝就地升级', async () => {
      const s = useShellState()
      apps.plugins.value = [
        { id: THIRD_PARTY_ID, name: 'Third Party', source: 'user-installed', state: 'running' },
      ]
      apps.displayStates.value = { [THIRD_PARTY_ID]: 'running' }
      invokeMock.mockResolvedValueOnce(PICKED)
      await s.installApp()
      expect(apps.installFromZip).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith('errors.shell.install.runningConflict')
    })

    it('已装同 id（user-installed、未运行）→ 进就地升级确认（弹窗 + 选包目标）', async () => {
      const s = useShellState()
      apps.plugins.value = [
        { id: THIRD_PARTY_ID, name: 'Third Party', source: 'user-installed', state: 'dormant' },
      ]
      invokeMock.mockResolvedValueOnce(PICKED)
      await s.installApp()
      expect(apps.installFromZip).not.toHaveBeenCalled()
      expect(s.dialog.value).toBe('install-upgrade')
      expect(s.dialogAppId.value).toBe(THIRD_PARTY_ID)
      expect(s.installTarget.value).toEqual(PICKED)
    })

    it('确认升级成功 → 收弹窗 + 清选包目标 + toast', async () => {
      const s = useShellState()
      s.installTarget.value = PICKED
      s.dialog.value = 'install-upgrade'
      s.dialogAppId.value = THIRD_PARTY_ID
      await s.confirmInstallUpgrade()
      expect(apps.installFromZip).toHaveBeenCalledWith('/tmp/third-party.zip', true)
      expect(s.dialog.value).toBeNull()
      expect(s.installTarget.value).toBeNull()
      expect(toastSuccess).toHaveBeenCalledWith('shell.dialog.install.upgradeSuccess')
    })

    it('确认升级失败 → 保留确认面（不静默吞失败）', async () => {
      const s = useShellState()
      s.installTarget.value = PICKED
      s.dialog.value = 'install-upgrade'
      s.dialogAppId.value = THIRD_PARTY_ID
      vi.mocked(apps.installFromZip).mockResolvedValueOnce(false)
      await s.confirmInstallUpgrade()
      expect(s.dialog.value).toBe('install-upgrade')
      expect(s.installTarget.value).toEqual(PICKED)
    })

    it('无选包目标确认 → 不发升级（防无目标动作）', async () => {
      const s = useShellState()
      await s.confirmInstallUpgrade()
      expect(apps.installFromZip).not.toHaveBeenCalled()
    })
  })

  describe('卡片标题', () => {
    it('应用卡取应用名；系统页卡取系统页 i18n 名（未知回落 id）', () => {
      const s = useShellState()
      seedApp(TERMINAL_PLUGIN_ID, 'BedCode', '/sessions')
      s.openSys('settings')
      expect(s.cardTitleOf(`app:${TERMINAL_PLUGIN_ID}`)).toBe('BedCode')
      expect(s.cardTitleOf('sys:settings')).toContain('settings')
      expect(s.cardTitleOf('sys:nope')).toBe('nope')
    })
  })
})
