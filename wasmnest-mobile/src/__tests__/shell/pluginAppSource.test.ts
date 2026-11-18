/**
 * 插件系统 → 宿主壳 适配器 行为契约测试
 *
 * 覆盖：插件运行时状态到壳运行态的映射、权限授予口径、运行面解析优先级、
 *       启动/停止的分形态分流，以及「不支持的能力返回 false」这一诚实口径。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, h } from 'vue'

// ==================== 替身（只替跨进程/第三方边界） ====================
vi.mock('@/plugin/commands', () => ({
  pluginListLoaded: vi.fn(async () => []),
  pluginGetInfo: vi.fn(async () => null),
  pluginPreauthorize: vi.fn(async () => {}),
  pluginApprove: vi.fn(async () => {}),
  pluginActivate: vi.fn(async () => {}),
  pluginDeactivate: vi.fn(async () => {}),
  pluginInstallFromFile: vi.fn(async () => 'installed-id'),
  pluginPeekAppPackage: vi.fn(async () => ({
    path: '/sdcard/app.zip',
    pluginId: 'com.test.picked',
    hasRetainedData: false,
    installed: false,
  })),
  pluginUninstall: vi.fn(async () => {}),
}))

vi.mock('@/plugin/loader', () => ({
  pluginLoader: {
    activate: vi.fn(async () => {}),
    deactivate: vi.fn(async () => {}),
    getActivePlugin: vi.fn(() => undefined),
  },
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => false),
}))

import { open as dialogOpen } from '@tauri-apps/plugin-dialog'
import * as cmds from '@/plugin/commands'
import { pluginLoader } from '@/plugin/loader'
import { getPluginRegistry } from '@/plugin/registry'
import { getShellRegistry } from '@/shell/registry'
import type { PluginInfo, PluginState } from '@/plugin/types'
import { createPluginAppSource, PLUGIN_APP_SOURCE_ID, toShellApp } from '@/shell/adapters/pluginAppSource'
import { logger } from '@/utils/frontendLogger'

/** 最小插件信息 */
function info(state: PluginState, patch: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: 'com.test.app',
    name: '测试应用',
    version: '1.2.3',
    description: '',
    author: '',
    main: 'index.js',
    pluginType: 'full',
    permissions: [],
    contributes: {},
    state,
    source: 'apk-asset',
    extensionPath: '/tmp/app',
    sizeBytes: 1024,
    ...patch,
  } as PluginInfo
}

const registry = getPluginRegistry()
const shellRegistry = getShellRegistry()

beforeEach(() => {
  vi.clearAllMocks()
  registry.clearPlugin('com.test.app')
  shellRegistry.clearApp('com.test.app')
})

describe('插件状态 → 壳运行态', () => {
  it('should_beRunning_when_pluginActivated', () => {
    expect(toShellApp(info({ state: 'activated' })).state).toBe('running')
  })

  it('should_beRunning_when_pluginDegraded', () => {
    // 降级但实例存活、命令可用；显示成「已停止」会让用户误以为没起来
    expect(toShellApp(info({ state: 'degraded', error: 'slow' })).state).toBe('running')
  })

  it('should_beApproval_when_pluginNeedsApproval', () => {
    // 待审批必须是独立档：提前拍平成「已停用」会让授权管理与通知栏的待处理区失去真源
    expect(toShellApp(info({ state: 'needsApproval' })).state).toBe('approval')
  })

  it('should_beErrorWithReason_when_pluginErrored', () => {
    const app = toShellApp(info({ state: 'error', error: 'boom' }))
    expect(app.state).toBe('error')
    expect(app.error).toBe('boom')
  })

  it('should_beStopped_when_pluginLoadedOrActivating', () => {
    expect(toShellApp(info({ state: 'loaded' })).state).toBe('stopped')
    expect(toShellApp(info({ state: 'activating' })).state).toBe('stopped')
  })

  it('should_beDisabled_when_pluginDeactivated', () => {
    expect(toShellApp(info({ state: 'deactivated' })).state).toBe('disabled')
  })
})

describe('权限映射', () => {
  it('should_markGrantedAndLockStorage_when_approved', () => {
    const app = toShellApp(
      info({ state: 'activated' }, { permissions: ['storage', 'fs:write'] }),
    )

    expect(app.permissions.map((p) => p.granted)).toEqual([true, true])
    expect(app.permissions.find((p) => p.key === 'storage')?.locked).toBe(true)
    expect(app.permissions.find((p) => p.key === 'fs:write')?.locked).toBe(false)
  })

  it('should_markNotGranted_when_pluginNeedsApproval', () => {
    const app = toShellApp(info({ state: 'needsApproval' }, { permissions: ['fs:read'] }))
    // 未人工批准 ⇒ 一律未授予（不编造逐项授予状态：后端没有暴露它）
    expect(app.permissions[0].granted).toBe(false)
  })

  it('should_beOfficial_when_packagedInApkAssets', () => {
    expect(toShellApp(info({ state: 'loaded' })).official).toBe(true)
    expect(toShellApp(info({ state: 'loaded' }, { source: 'user' })).official).toBe(false)
  })
})

describe('运行面解析（票 2026-10-10 C1：只认 registerSurface）', () => {
  it('should_returnUndefined_when_appRegisteredNoSurface', () => {
    const surface = createPluginAppSource()
    expect(surface.resolveSurface?.('com.test.app')).toBeUndefined()
  })

  it('should_returnSurfaceComponent_when_appRegisteredSurface', () => {
    const component = defineComponent({ name: 'AppSurface', setup: () => () => h('div') })
    // 生产顺序：list() 先把应用写进壳注册表，激活后才 registerSurface
    shellRegistry.upsertApps(PLUGIN_APP_SOURCE_ID, [toShellApp(info({ state: 'activated' }))])
    shellRegistry.registerSurface('com.test.app', { component })

    expect(createPluginAppSource().resolveSurface?.('com.test.app')).toBe(component)
  })

  it('should_returnUndefined_when_appNotInRegistryAtAll', () => {
    // 反例面：应用从未被 list() 写入壳注册表（未安装 / 已卸载）时不得凭空解析出运行面
    expect(createPluginAppSource().resolveSurface?.('com.not.installed')).toBeUndefined()
  })

  it('should_notRequireSurface_when_appRegisteredOnlyLegacyUi', () => {
    // 反例面（退役锁）：旧嵌入扩展点（工具箱页 / 终端主视图）的注册面已整面退役，
    // 应用即使注册了它们也不得被壳当成整个应用的运行面——这里只能有 surface 一条路。
    // 退役扩展点本身的存在性由 context.ts 的显性抛错与 R4 退役锁钉住。
    shellRegistry.upsertApps(PLUGIN_APP_SOURCE_ID, [toShellApp(info({ state: 'activated' }))])

    expect(createPluginAppSource().resolveSurface?.('com.test.app')).toBeUndefined()
  })
})

describe('运行面解析的告警口径', () => {
  it('should_notWarn_when_appNotRunningHasNoSurface', () => {
    // 非运行态没有运行面是正常事实（随激活注册、随停用回收）。对账会拿清单里的
    // 应用逐条查询，若一律 warn，停用后台应用就会刷黄警（2026-11-09 真机日志）。
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    shellRegistry.upsertApps(PLUGIN_APP_SOURCE_ID, [toShellApp(info({ state: 'deactivated' }))])

    expect(createPluginAppSource().resolveSurface?.('com.test.app')).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()

    warn.mockRestore()
  })

  it('should_warn_when_runningAppHasNoSurface', () => {
    // 运行中却拿不到运行面是真缺口：保留 fail-visible 告警，点名应用
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    shellRegistry.upsertApps(PLUGIN_APP_SOURCE_ID, [toShellApp(info({ state: 'activated' }))])

    expect(createPluginAppSource().resolveSurface?.('com.test.app')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('com.test.app')

    warn.mockRestore()
  })
})

describe('启动与停止', () => {
  it('should_preauthorizeThenLoadFrontend_when_pluginHasFrontend', async () => {
    vi.mocked(cmds.pluginGetInfo).mockResolvedValueOnce(info({ state: 'loaded' }))
    const source = createPluginAppSource()

    await source.launch('com.test.app')

    expect(cmds.pluginPreauthorize).toHaveBeenCalledWith('com.test.app')
    expect(pluginLoader.activate).toHaveBeenCalledWith('com.test.app')
    // 带前端模块的插件不能走裸 pluginActivate，否则扩展点不会注册
    expect(cmds.pluginActivate).not.toHaveBeenCalled()
  })

  it('should_activateBackendOnly_when_pluginIsBackendForm', async () => {
    vi.mocked(cmds.pluginGetInfo).mockResolvedValueOnce(
      info({ state: 'loaded' }, { pluginType: 'backend' }),
    )
    const source = createPluginAppSource()

    await source.launch('com.test.app')

    // backend 形态没有前端入口，loader 会尝试 import 不存在的入口而失败
    expect(cmds.pluginActivate).toHaveBeenCalledWith('com.test.app')
    expect(pluginLoader.activate).not.toHaveBeenCalled()
  })

  it('should_deactivateFrontendAndBackend_when_stopCalled', async () => {
    const source = createPluginAppSource()
    await source.stop('com.test.app')

    expect(pluginLoader.deactivate).toHaveBeenCalledWith('com.test.app')
    // 前端从未加载过的插件（如 rust-only）loader 无记录，仍需通知后端
    expect(cmds.pluginDeactivate).toHaveBeenCalledWith('com.test.app')
  })
})

describe('能力诚实口径', () => {
  it('should_notAdvertisePermissionGrant_when_backendHasNoCommand', () => {
    const source = createPluginAppSource()
    // 后端没有逐项授权命令：能力本身不成立，不提供可被 UI 误判为「支持」的方法
    expect(source.setPermissionGrant).toBeUndefined()
  })

  it('should_returnNullWithoutInstalling_when_userCancelsFilePicker', async () => {
    vi.mocked(dialogOpen).mockResolvedValueOnce(null as unknown as string)
    const source = createPluginAppSource()

    // null = 用户取消（不是失败）：调用方据此不弹错误提示
    await expect(source.installFromLocalPackage?.()).resolves.toBeNull()
    expect(cmds.pluginInstallFromFile).not.toHaveBeenCalled()
  })

  it('should_installChosenPackage_when_userPicksFile', async () => {
    vi.mocked(dialogOpen).mockResolvedValueOnce('/sdcard/app.zip')
    const source = createPluginAppSource()

    // 返回安装后的应用 id：壳要用它把「已安装」通知挂到正确的应用上。
    // 无旧数据 = 不询问，按默认「不恢复」安装。
    await expect(source.installFromLocalPackage?.()).resolves.toBe('installed-id')
    expect(cmds.pluginInstallFromFile).toHaveBeenCalledWith('/sdcard/app.zip', false, false)
  })

  it('should_askBeforeInstalling_when_freshInstallHasRetainedData', async () => {
    vi.mocked(dialogOpen).mockResolvedValueOnce('/sdcard/app.zip')
    vi.mocked(cmds.pluginPeekAppPackage).mockResolvedValueOnce({
      path: '/sdcard/app.zip',
      pluginId: 'com.test.returning',
      hasRetainedData: true,
      installed: false,
    })
    const decideRestore = vi.fn(async () => true)
    const source = createPluginAppSource()

    await source.installFromLocalPackage?.(decideRestore)

    // 询问发生在安装之前，且用户选择被带进安装命令（恢复 = 保留私有库 + KV）
    expect(decideRestore).toHaveBeenCalledWith({ pluginId: 'com.test.returning' })
    expect(cmds.pluginInstallFromFile).toHaveBeenCalledWith('/sdcard/app.zip', false, true)
  })

  it('should_discardRetainedData_when_userDeclinesRestore', async () => {
    vi.mocked(dialogOpen).mockResolvedValueOnce('/sdcard/app.zip')
    vi.mocked(cmds.pluginPeekAppPackage).mockResolvedValueOnce({
      path: '/sdcard/app.zip',
      pluginId: 'com.test.returning',
      hasRetainedData: true,
      installed: false,
    })
    const source = createPluginAppSource()

    await source.installFromLocalPackage?.(async () => false)

    expect(cmds.pluginInstallFromFile).toHaveBeenCalledWith('/sdcard/app.zip', false, false)
  })

  it('should_notInstall_when_userCancelsRestorePrompt', async () => {
    vi.mocked(dialogOpen).mockResolvedValueOnce('/sdcard/app.zip')
    vi.mocked(cmds.pluginPeekAppPackage).mockResolvedValueOnce({
      path: '/sdcard/app.zip',
      pluginId: 'com.test.returning',
      hasRetainedData: true,
      installed: false,
    })
    const source = createPluginAppSource()

    // 取消询问 = 取消安装（不是「不恢复并继续」——那会在用户没确定时删数据）
    await expect(source.installFromLocalPackage?.(async () => null)).resolves.toBeNull()
    expect(cmds.pluginInstallFromFile).not.toHaveBeenCalled()
  })

  it('should_notAsk_when_appIsAlreadyInstalled', async () => {
    vi.mocked(dialogOpen).mockResolvedValueOnce('/sdcard/app.zip')
    vi.mocked(cmds.pluginPeekAppPackage).mockResolvedValueOnce({
      path: '/sdcard/app.zip',
      pluginId: 'com.test.installed',
      hasRetainedData: true,
      installed: true,
    })
    const decideRestore = vi.fn(async () => true)
    const source = createPluginAppSource()

    await source.installFromLocalPackage?.(decideRestore)

    // 已安装应用的自身数据不是「旧数据」：不询问（重装走升级链路，恒保数据）
    expect(decideRestore).not.toHaveBeenCalled()
  })

  it('should_callApproveCommand_when_approvingApp', async () => {
    const source = createPluginAppSource()

    await source.approve?.('com.test.app')

    // 审批是后端事实（整单权限 + 内容哈希钉扎），适配器只转发不自作主张
    expect(cmds.pluginApprove).toHaveBeenCalledWith('com.test.app')
  })

  it('should_reportSourceId_when_created', () => {
    expect(createPluginAppSource().id).toBe(PLUGIN_APP_SOURCE_ID)
  })
})

describe('卸载（运行期收口）', () => {
  it('should_endRunBeforeUninstall_when_removingApp', async () => {
    const source = createPluginAppSource()

    await source.remove?.('com.test.app')

    // 卸载即结束运行期：前端对称拆解（注册表 / 事件 / 运行期 store 作用域 + 后端停用）
    // 必须先于后端删包——否则应用卸载后其运行面与 store 会残留在 WebView 直到重载
    expect(pluginLoader.deactivate).toHaveBeenCalledWith('com.test.app')
    expect(cmds.pluginUninstall).toHaveBeenCalledWith('com.test.app', false)
    const deactivateOrder = vi.mocked(pluginLoader.deactivate).mock.invocationCallOrder[0]
    const uninstallOrder = vi.mocked(cmds.pluginUninstall).mock.invocationCallOrder[0]
    expect(deactivateOrder).toBeLessThan(uninstallOrder)
  })
})
