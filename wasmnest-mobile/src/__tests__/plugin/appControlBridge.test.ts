/**
 * 通用应用调用桥（移动 · 票 03 / spec §4.2）测试
 *
 * 契约（真源 = `plugin/appControlBridge.ts` 头注释 + spec §4.2.2，与桌面同一套语义）：
 * - `list()` 合并宿主清单与各应用 contributes.assistantTools；
 * - `invoke()` 白名单强制：未声明命令一律拒绝（tool.not_declared），不回退任意命令；
 * - 三类拒绝各自点名：app.not_installed / app.not_running / tool.not_declared / param.invalid；
 * - 审计只记 caller/target/command/risk/decision，不记参数原文；
 * - `open()` 走壳打开应用动作；
 * - 注入门控：仅 manifest 声明 `apps:control` 时 `context.apps` 存在，未声明字段缺省。
 *
 * 依赖桩：`@/plugin/commands`（plugin_list_loaded / plugin_invoke）、
 * `@/plugin/credentials`（ensureChannelToken）、`@/utils/frontendLogger`（审计断言）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/plugin/commands', () => ({
  pluginListLoaded: vi.fn(),
  pluginInvoke: vi.fn(),
}))
vi.mock('@/plugin/credentials', () => ({
  ensureChannelToken: vi.fn(),
}))
vi.mock('@/utils/frontendLogger', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  }
})

import { pluginListLoaded, pluginInvoke } from '@/plugin/commands'
import { ensureChannelToken } from '@/plugin/credentials'
import { logger } from '@/utils/frontendLogger'
import {
  createAppControlBridge,
  AppControlError,
  APP_NOT_INSTALLED,
  APP_NOT_RUNNING,
  TOOL_NOT_DECLARED,
  PARAM_INVALID,
  CALLER_UNAUTHORIZED,
} from '@/plugin/appControlBridge'
import { createPluginContext } from '@/plugin/context'
import type { PluginInfo } from '@/plugin/types'

const mockedListLoaded = vi.mocked(pluginListLoaded)
const mockedPluginInvoke = vi.mocked(pluginInvoke)
const mockedEnsureToken = vi.mocked(ensureChannelToken)

/** 构造宿主清单条目（PluginShellInfo 的桥内投影形状） */
function makePluginInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'com.wasmnest.monitor',
    name: 'Monitor',
    version: '1.0.0',
    kind: 'internal-business',
    state: { state: 'activated' },
    permissions: ['metrics:read'],
    contributes: {},
    ...overrides,
  }
}

/** 构造 assistantTools 条目 */
function makeTool(overrides: Record<string, unknown> = {}) {
  return {
    id: 'monitor.runtime-snapshot',
    title: '读取运行指标',
    description: '读取运行时指标快照',
    command: 'monitor.snapshot',
    argsSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read' as const,
    output: 'json' as const,
    ...overrides,
  }
}

/** 最小插件信息（权限按用例给） */
function makeInfo(permissions: string[] = []): PluginInfo {
  return {
    id: 'com.wasmnest.assistant',
    name: 'Nest',
    version: '0.0.1',
    description: '',
    author: '',
    main: '',
    pluginType: 'wasm' as any,
    permissions,
    state: 'activated' as any,
    contributes: {} as any,
    source: '',
    assetDir: '',
  } as PluginInfo
}

/** 调用方条目（桥内二次校验要求调用方在宿主清单里且持有 apps:control） */
const CALLER_ID = 'com.wasmnest.assistant'
function callerInfo(overrides: Record<string, unknown> = {}) {
  return makePluginInfo({
    id: CALLER_ID,
    name: 'Nest',
    permissions: ['apps:control', 'storage', 'network:http', 'ui:globalEntry'],
    contributes: {},
    ...overrides,
  })
}

/** 清单 = 本条用例的目标应用 + 调用方（调用方排末尾：list() 断言按下标取目标应用） */
function withCaller<T>(list: T[]): T[] {
  return [...list, callerInfo() as unknown as T]
}

describe('createAppControlBridge（移动 · 通用应用调用桥）', () => {
  beforeEach(() => {
    mockedListLoaded.mockReset()
    mockedPluginInvoke.mockReset()
    mockedEnsureToken.mockReset()
    mockedEnsureToken.mockResolvedValue('test-token')
    vi.mocked(logger.log).mockClear()
    vi.mocked(logger.warn).mockClear()
    vi.mocked(logger.error).mockClear()
  })

  describe('list()', () => {
    it('返回已安装应用及其声明给助手的工具', async () => {
      mockedListLoaded.mockResolvedValueOnce(withCaller([
        makePluginInfo({
          id: 'com.wasmnest.monitor',
          contributes: { assistantTools: [makeTool()] },
        }),
        makePluginInfo({
          id: 'com.wasmnest.bedcode',
          kind: 'business-app',
          state: { state: 'degraded' },
          contributes: { assistantTools: [] },
        }),
      ]))
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      const apps = await bridge.list()
      // 3 = monitor + bedcode + 调用方自身（清单里必须有调用方，桥内二次校验要用）
      expect(apps).toHaveLength(3)
      expect(apps[0]).toMatchObject({
        id: 'com.wasmnest.monitor',
        name: 'Monitor',
        version: '1.0.0',
        kind: 'internal-business',
        state: 'activated',
      })
      expect(apps[0].tools).toHaveLength(1)
      expect(apps[0].tools[0]).toMatchObject({
        id: 'monitor.runtime-snapshot',
        command: 'monitor.snapshot',
        risk: 'read',
      })
      expect(apps[1].tools).toHaveLength(0)
    })

    it('contributes 不是对象时 tools 为空数组（防御性解析）', async () => {
      mockedListLoaded.mockResolvedValueOnce(withCaller([
        makePluginInfo({ contributes: 'not-an-object' }),
        makePluginInfo({ contributes: null }),
      ]))
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      const apps = await bridge.list()
      expect(apps[0].tools).toEqual([])
      expect(apps[1].tools).toEqual([])
    })
  })

  describe('invoke()', () => {
    it('已声明工具可调通：白名单通过 + plugin_invoke 路由', async () => {
      mockedListLoaded.mockResolvedValueOnce(withCaller([
        makePluginInfo({
          id: 'com.wasmnest.monitor',
          contributes: { assistantTools: [makeTool()] },
        }),
      ]))
      mockedPluginInvoke.mockResolvedValueOnce({ apps: 3, uptime: 120 })
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      const result = await bridge.invoke('com.wasmnest.monitor', 'monitor.snapshot')
      expect(result).toEqual({ apps: 3, uptime: 120 })
      expect(mockedPluginInvoke).toHaveBeenCalledWith(
        'com.wasmnest.monitor',
        'monitor.snapshot',
        null,
        'test-token',
      )
      // 审计：allowed + risk=read
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('decision=allowed'),
      )
    })

    it('目标未运行 → app.not_running', async () => {
      mockedListLoaded.mockResolvedValueOnce(withCaller([
        makePluginInfo({
          id: 'com.wasmnest.monitor',
          state: { state: 'deactivated' },
          contributes: { assistantTools: [makeTool()] },
        }),
      ]))
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      await expect(
        bridge.invoke('com.wasmnest.monitor', 'monitor.snapshot'),
      ).rejects.toMatchObject({ code: APP_NOT_RUNNING })
      expect(mockedPluginInvoke).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('decision=denied'),
      )
    })

    it('命令未声明 → tool.not_declared（白名单强制，不回退任意命令）', async () => {
      mockedListLoaded.mockResolvedValueOnce(withCaller([
        makePluginInfo({
          id: 'com.wasmnest.monitor',
          contributes: { assistantTools: [makeTool({ command: 'monitor.snapshot' })] },
        }),
      ]))
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      await expect(
        bridge.invoke('com.wasmnest.monitor', 'monitor.dangerous-undeclared'),
      ).rejects.toMatchObject({ code: TOOL_NOT_DECLARED })
      expect(mockedPluginInvoke).not.toHaveBeenCalled()
    })

    it('参数不合 argsSchema → param.invalid（required）', async () => {
      mockedListLoaded.mockResolvedValueOnce(withCaller([
        makePluginInfo({
          id: 'com.wasmnest.monitor',
          contributes: {
            assistantTools: [
              makeTool({
                command: 'monitor.snapshot',
                argsSchema: {
                  type: 'object',
                  properties: { timeout: { type: 'number' } },
                  required: ['timeout'],
                  additionalProperties: false,
                },
              }),
            ],
          },
        }),
      ]))
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      await expect(
        bridge.invoke('com.wasmnest.monitor', 'monitor.snapshot', {}),
      ).rejects.toMatchObject({ code: PARAM_INVALID })
      expect(mockedPluginInvoke).not.toHaveBeenCalled()
    })

    it('参数不合 argsSchema → param.invalid（additionalProperties）', async () => {
      mockedListLoaded.mockResolvedValueOnce(withCaller([
        makePluginInfo({
          id: 'com.wasmnest.monitor',
          contributes: {
            assistantTools: [
              makeTool({
                command: 'monitor.snapshot',
                argsSchema: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
              }),
            ],
          },
        }),
      ]))
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      await expect(
        bridge.invoke('com.wasmnest.monitor', 'monitor.snapshot', { sneaky: true }),
      ).rejects.toMatchObject({ code: PARAM_INVALID })
    })

    it('参数不合 argsSchema → param.invalid（枚举）', async () => {
      mockedListLoaded.mockResolvedValueOnce(withCaller([
        makePluginInfo({
          id: 'com.wasmnest.monitor',
          contributes: {
            assistantTools: [
              makeTool({
                command: 'monitor.snapshot',
                argsSchema: {
                  type: 'object',
                  properties: { format: { type: 'string', enum: ['json', 'text'] } },
                  additionalProperties: false,
                },
              }),
            ],
          },
        }),
      ]))
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      await expect(
        bridge.invoke('com.wasmnest.monitor', 'monitor.snapshot', { format: 'xml' }),
      ).rejects.toMatchObject({ code: PARAM_INVALID })
    })

    it('目标未安装 → app.not_installed', async () => {
      mockedListLoaded.mockResolvedValueOnce(withCaller([
        makePluginInfo({ id: 'com.wasmnest.monitor' }),
      ]))
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      await expect(
        bridge.invoke('com.wasmnest.nonexistent', 'some.command'),
      ).rejects.toMatchObject({ code: APP_NOT_INSTALLED })
    })

    it('审计不记录参数原文', async () => {
      mockedListLoaded.mockResolvedValueOnce(withCaller([
        makePluginInfo({
          id: 'com.wasmnest.monitor',
          contributes: { assistantTools: [makeTool()] },
        }),
      ]))
      mockedPluginInvoke.mockResolvedValueOnce({ secret: 'value' })
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      await bridge.invoke('com.wasmnest.monitor', 'monitor.snapshot')
      const auditCalls = vi.mocked(logger.log).mock.calls
      const auditText = auditCalls.map((c) => String(c[0])).join('\n')
      expect(auditText).not.toContain('secret')
      expect(auditText).not.toContain('value')
    })
  })

  describe('open()', () => {
    it('调用壳打开应用动作（打开前先复核调用方权限）', async () => {
      mockedListLoaded.mockResolvedValueOnce(withCaller([]))
      const openApp = vi.fn().mockResolvedValue(undefined)
      const bridge = createAppControlBridge('com.wasmnest.assistant', openApp)
      await bridge.open('com.wasmnest.monitor')
      expect(openApp).toHaveBeenCalledWith('com.wasmnest.monitor')
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('decision=allowed'),
      )
    })

    it('调用方未持 apps:control → caller.unauthorized，不触发打开', async () => {
      mockedListLoaded.mockResolvedValueOnce([callerInfo({ permissions: ['storage'] })])
      const openApp = vi.fn().mockResolvedValue(undefined)
      const bridge = createAppControlBridge('com.wasmnest.assistant', openApp)
      await expect(bridge.open('com.wasmnest.monitor')).rejects.toMatchObject({
        code: CALLER_UNAUTHORIZED,
      })
      expect(openApp).not.toHaveBeenCalled()
    })
  })
})

describe('context.apps 注入门控（票 03）', () => {
  beforeEach(() => {
    mockedListLoaded.mockReset()
    mockedPluginInvoke.mockReset()
    mockedEnsureToken.mockReset()
    mockedEnsureToken.mockResolvedValue('test-token')
    vi.mocked(logger.log).mockClear()
    vi.mocked(logger.warn).mockClear()
    vi.mocked(logger.error).mockClear()
  })

  it('声明 apps:control → context.apps 存在且可用', async () => {
    const ctx = createPluginContext(makeInfo(['apps:control', 'ui:globalEntry']))
    expect(ctx.apps).toBeDefined()
    mockedListLoaded.mockResolvedValueOnce(
      withCaller([
        makePluginInfo({
          id: 'com.wasmnest.monitor',
          contributes: { assistantTools: [makeTool()] },
        }),
      ]),
    )
    const apps = await ctx.apps!.list()
    expect(apps[0].tools).toHaveLength(1)
  })

  it('未声明 apps:control → 字段缺省（不注入空壳对象）', () => {
    const ctx = createPluginContext(makeInfo(['metrics:read']))
    expect('apps' in ctx).toBe(false)
    expect(ctx.apps).toBeUndefined()
  })
})
