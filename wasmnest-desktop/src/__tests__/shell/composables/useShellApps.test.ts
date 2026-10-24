import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * useShellApps（注册表投影 + 生命周期动作收口）测试
 *
 * 2026-10-17 lifecycle-sync 契约（D2/D3）：
 * - 清单 = `plugin_list_loaded` 真通道投影（id = pluginId，运行态归并，
 *   enabled / autostart 偏好另查命令面）；
 * - 打开 = plugin_preauthorize → plugin_activate（真激活）；关闭 = plugin_deactivate
 *   （真停用）；审批 / 卸载 / 启用 / 自启各走对应命令臂；
 * - 动作失败 → lastError 暴露 + 清单刷新（不吞错）。
 *
 * 依赖桩：`@tauri-apps/api/core.invoke`（utils/invoke 的底层）。失败承载按 ADR 0030
 * 走**错误信封**（`{code, request_id}` 对象），动作失败经 `showUserError` 提示——
 * toast 模块级 mock 掉，`lastError` 只断言错误码（它是分支判据，不是展示文案）。
 */

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

// showUserError 会直接 toast（ADR 0030 的集中提示层）；单测只关心 lastError 的码
vi.mock('vue-sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

// 管理命令已加宿主面凭证门（ADR 0058 方案 A）：凭证取用单独 mock——真实实现
// 会经 plugin_frontend_loader_session 再走一轮 invoke，把本文件的 mock 序列搅乱
vi.mock('@/utils/appCommands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/appCommands')>()),
  ensureHostCredential: vi.fn(async () => 'test-host-credential'),
}))

import { invoke } from '@tauri-apps/api/core'
import {
  TERMINAL_PLUGIN_ID,
  mapDisplayState,
  pluginIdOfAppRoute,
  useShellApps,
  type HostPluginInfo,
} from '@/shell/composables/useShellApps'

const mockedInvoke = vi.mocked(invoke)

/** 构造一条宿主插件信息（缺省运行中） */
function info(overrides: Partial<HostPluginInfo> = {}): HostPluginInfo {
  return {
    id: 'com.wasmnest.test-app',
    name: 'Test App',
    version: '1.0.0',
    description: '',
    author: '',
    main: 'index.js',
    pluginType: 'rust-ts',
    rustLibrary: 'wasmnest_plugin_test_app',
    permissions: ['storage'],
    state: { state: 'activated' },
    extensionPath: '/plugins/com.wasmnest.test-app',
    contributes: {},
    source: 'wasm',
    sizeBytes: 1234,
    ...overrides,
  }
}

describe('注册表投影（plugin_list_loaded 真通道）', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
    // 模块级单例状态（跨用例存活）逐项复位，防清单/加载态污染
    const apps = useShellApps()
    apps.plugins.value = []
    apps.listReady.value = false
    apps.loading.value = false
    apps.lastError.value = null
  })

  it('清单投影：id = pluginId，运行态归并，路由表覆盖全部有前端界面的应用（机制 B）', async () => {
    mockedInvoke
      .mockResolvedValueOnce([
        info({ id: TERMINAL_PLUGIN_ID, name: 'BedCode' }),
        info({ id: 'com.wasmnest.ai-chatbox', name: 'AI Chatbox' }),
        info({ id: 'com.wasmnest.file-transfer', name: 'File Transfer', state: { state: 'deactivated' } }),
      ])
      .mockResolvedValueOnce(true) // bedcode enabled
      .mockResolvedValueOnce(false) // bedcode autostart
      .mockResolvedValueOnce(false) // ai-chatbox enabled
      .mockResolvedValueOnce(false) // ai-chatbox autostart
      .mockResolvedValueOnce(false) // file-transfer enabled
      .mockResolvedValueOnce(false) // file-transfer autostart

    const apps = useShellApps()
    await apps.load()

    expect(mockedInvoke.mock.calls[0][0]).toBe('plugin_list_loaded') // 首个 invoke = 清单真通道
    const list = apps.plugins.value
    expect(list.length).toBe(3)
    expect(list[0].id).toBe(TERMINAL_PLUGIN_ID)
    expect(list[0].route).toBe('/sessions')
    expect(list[0].state).toBe('running')
    expect(list[1].id).toBe('com.wasmnest.ai-chatbox')
    expect(list[1].route).toBe('/chat') // 桌面 UI 宿主修正：全部 wasm app 有独立界面路由
    expect(list[1].state).toBe('running')
    expect(list[2].state).toBe('dormant') // deactivated → 未启动
    expect(list[0].enabled).toBe(true)
    expect(list[0].autostart).toBe(false)
    expect(apps.listReady.value).toBe(true)
    expect(apps.lastError.value).toBeNull()
  })

  it('清单投影不设人为上限：256 个应用全部保留（宿主无硬编码上限）', async () => {
    const infos = Array.from({ length: 256 }, (_, i) =>
      info({ id: `com.wasmnest.scale.manifest${String(i).padStart(3, '0')}` }),
    )
    mockedInvoke.mockResolvedValueOnce(infos).mockResolvedValue(false)

    const apps = useShellApps()
    await apps.load()

    expect(apps.plugins.value).toHaveLength(256)
    expect(apps.plugins.value[0].id).toBe('com.wasmnest.scale.manifest000')
    expect(apps.plugins.value[255].id).toBe('com.wasmnest.scale.manifest255')
    expect(apps.lastError.value).toBeNull()
  })

  it('清单拉取失败：lastError 暴露错误码 + listReady 仍置位（不吞错、不停加载态）', async () => {
    // 非信封形状（普通 Error）→ 落到 host.internal 兜底码（ADR 0030）
    mockedInvoke.mockRejectedValueOnce(new Error('backend down'))
    const apps = useShellApps()
    await apps.load()
    expect(apps.plugins.value).toEqual([])
    expect(apps.listReady.value).toBe(true)
    expect(apps.lastError.value).toBe('host.internal')
  })

  it('偏好查询失败不影响清单投影（按各 key 缺省取向容错：enabled 可见 / autostart 关）', async () => {
    mockedInvoke
      .mockResolvedValueOnce([info({ id: 'com.wasmnest.test-app' })])
      .mockRejectedValueOnce(new Error('pref backend down'))
      .mockRejectedValueOnce(new Error('pref backend down'))
    const apps = useShellApps()
    await apps.load()
    expect(apps.plugins.value.length).toBe(1)
    expect(apps.plugins.value[0].enabled).toBe(true)
    expect(apps.plugins.value[0].autostart).toBe(false)
    expect(apps.lastError.value).toBeNull() // 清单成功，偏好失败不污染主错误
  })

  it('approvalApps 派生：只取展示态 approval 的应用', async () => {
    mockedInvoke
      .mockResolvedValueOnce([
        info({ id: 'com.wasmnest.a', state: { state: 'needsApproval' } }),
        info({ id: 'com.wasmnest.b', state: { state: 'activated' } }),
      ])
      .mockResolvedValue(false)
    const apps = useShellApps()
    await apps.load()
    expect(apps.approvalApps.value.map((a) => a.id)).toEqual(['com.wasmnest.a'])
  })
})

describe('PluginState 归并（展示态五档）', () => {
  it('activated→running / degraded→degraded / needsApproval→approval / error→error / 其余→dormant', () => {
    expect(mapDisplayState('activated')).toBe('running')
    expect(mapDisplayState('degraded')).toBe('degraded')
    expect(mapDisplayState('needsApproval')).toBe('approval')
    expect(mapDisplayState('error')).toBe('error')
    expect(mapDisplayState('activating')).toBe('dormant')
    expect(mapDisplayState('loaded')).toBe('dormant')
    expect(mapDisplayState('deactivated')).toBe('dormant')
    expect(mapDisplayState('whatever')).toBe('dormant')
  })
})

describe('应用路由 → 属主 pluginId（faceOfRoute 反向映射）', () => {
  it('挂载路由与深链同归 bedcode 应用面；未知路径无属主', () => {
    expect(pluginIdOfAppRoute('/sessions')).toBe(TERMINAL_PLUGIN_ID)
    expect(pluginIdOfAppRoute('/sessions/123')).toBe(TERMINAL_PLUGIN_ID)
    expect(pluginIdOfAppRoute('/pairing')).toBe(TERMINAL_PLUGIN_ID)
    expect(pluginIdOfAppRoute('/tasks')).toBe(TERMINAL_PLUGIN_ID)
    expect(pluginIdOfAppRoute('/settings/authorization')).toBe(TERMINAL_PLUGIN_ID)
    expect(pluginIdOfAppRoute('/terminal-window/x')).toBe(TERMINAL_PLUGIN_ID)
    expect(pluginIdOfAppRoute('/unknown-page')).toBeUndefined()
  })
})

describe('生命周期动作（真实命令面）', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
    const apps = useShellApps()
    apps.plugins.value = []
    apps.listReady.value = false
    apps.loading.value = false
    apps.lastError.value = null
    mockedInvoke
      .mockResolvedValueOnce([info({ id: 'com.wasmnest.test-app' })]) // load 清单
      .mockResolvedValue(false) // 偏好查询
  })

  async function seeded() {
    const apps = useShellApps()
    await apps.load()
    return apps
  }

  it('打开 = plugin_preauthorize → plugin_activate，成功刷新清单', async () => {
    const apps = await seeded()
    mockedInvoke
      .mockResolvedValueOnce(undefined) // preauthorize
      .mockResolvedValueOnce(undefined) // activate
      .mockResolvedValueOnce([info({ id: 'com.wasmnest.test-app', state: { state: 'activated' } })]) // refresh 清单
      .mockResolvedValue(false)
    const ok = await apps.activate('com.wasmnest.test-app')
    expect(ok).toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith('plugin_preauthorize', {
      pluginId: 'com.wasmnest.test-app',
      credential: expect.any(String),
    })
    expect(mockedInvoke).toHaveBeenCalledWith('plugin_activate', {
      pluginId: 'com.wasmnest.test-app',
      credential: expect.any(String),
    })
    expect(apps.lastError.value).toBeNull()
  })

  it('打开失败：preauthorize 拒绝 → false + lastError 码 + 清单刷新（不进入激活）', async () => {
    const apps = await seeded()
    mockedInvoke
      // 宿主真实形状：AppError 序列化后的信封对象（不是 Error）
      .mockRejectedValueOnce({ code: 'host.plugin.activate', request_id: 'req-1' })
      .mockResolvedValueOnce([info({ id: 'com.wasmnest.test-app' })]) // activate 失败后的清单刷新
      .mockResolvedValue(false)
    const ok = await apps.activate('com.wasmnest.test-app')
    expect(ok).toBe(false)
    // lastError = 信封 code（供分支判断）；展示文案由 showUserError 走 errors.<code>
    expect(apps.lastError.value).toBe('host.plugin.activate')
    // 未走到 activate 臂
    expect(mockedInvoke).not.toHaveBeenCalledWith('plugin_activate', expect.anything())
  })

  it('关闭 = plugin_deactivate（真停用），成功刷新清单', async () => {
    const apps = await seeded()
    mockedInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([info({ id: 'com.wasmnest.test-app', state: { state: 'deactivated' } })])
      .mockResolvedValue(false)
    const ok = await apps.deactivate('com.wasmnest.test-app')
    expect(ok).toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith('plugin_deactivate', {
      pluginId: 'com.wasmnest.test-app',
      credential: expect.any(String),
    })
    expect(apps.plugins.value[0].state).toBe('dormant')
  })

  it('审批 = plugin_approve；卸载 = plugin_uninstall；偏好 = plugin_set_enabled / plugin_set_autostart', async () => {
    const apps = await seeded()

    mockedInvoke
      .mockResolvedValueOnce(['storage'])
      .mockResolvedValueOnce([info({ id: 'com.wasmnest.test-app' })])
      .mockResolvedValue(false)
    expect(await apps.approve('com.wasmnest.test-app')).toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith('plugin_approve', {
      pluginId: 'com.wasmnest.test-app',
      credential: expect.any(String),
    })

    mockedInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([])
      .mockResolvedValue(false)
    expect(await apps.uninstall('com.wasmnest.test-app')).toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith('plugin_uninstall', {
      pluginId: 'com.wasmnest.test-app',
      credential: expect.any(String),
    })

    mockedInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([info({ id: 'com.wasmnest.test-app' })])
      .mockResolvedValue(false)
    expect(await apps.setEnabled('com.wasmnest.test-app', true)).toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith('plugin_set_enabled', { pluginId: 'com.wasmnest.test-app', enabled: true })

    mockedInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([info({ id: 'com.wasmnest.test-app' })])
      .mockResolvedValue(false)
    expect(await apps.setAutostart('com.wasmnest.test-app', true)).toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith('plugin_set_autostart', { pluginId: 'com.wasmnest.test-app', autostart: true })
  })

  it('偏好动作同样占用 busyId（防连点；动作完成后复位）', async () => {
    const apps = await seeded()
    // 挂起 set_enabled 的 invoke：等待期间 busyId 必须占用（防 toggle 连点），
    // 释放后动作完成并复位（确定性构造，无定时器）
    let release!: (v?: unknown) => void
    mockedInvoke.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = resolve
      }),
    )
    const p = apps.setEnabled('com.wasmnest.test-app', true)
    await Promise.resolve() // 让 action 进入 invoke 等待点
    expect(apps.busyId.value).toBe('com.wasmnest.test-app')
    release()
    mockedInvoke.mockResolvedValueOnce([info({ id: 'com.wasmnest.test-app' })])
    mockedInvoke.mockResolvedValue(false)
    expect(await p).toBe(true)
    expect(apps.lastError.value).toBeNull()
    expect(apps.busyId.value).toBeNull()
  })

  it('isRunning 走真通道查询', async () => {
    const apps = await seeded()
    mockedInvoke.mockResolvedValueOnce(true)
    expect(await apps.isRunning('com.wasmnest.test-app')).toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith('plugin_is_running', { pluginId: 'com.wasmnest.test-app' })
  })
})
