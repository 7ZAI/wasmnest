import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 通用应用调用桥（票 02 / spec §4.2）测试
 *
 * 契约（真源 = `shell/mount/appControlBridge.ts` 头注释 + spec §4.2.2）：
 * - `list()` 合并宿主清单与各应用 contributes.assistantTools；
 * - `invoke()` 白名单强制：未声明命令一律拒绝（tool.not_declared），不回退任意命令；
 * - 三类拒绝各自点名：app.not_running / tool.not_declared / param.invalid；
 * - 审计只记 caller/target/command/risk/decision，不记参数原文；
 * - `open()` 走壳 openApp。
 *
 * 依赖桩：`@/utils/invoke`（plugin_list_with_prefs）、`@/utils/appCommands`（appInvoke）、
 * `@/utils/frontendLogger`（审计断言）。
 */

vi.mock('@/utils/invoke', () => ({ invoke: vi.fn() }))
vi.mock('@/utils/appCommands', () => ({
  appInvoke: vi.fn(),
  ensureHostCredential: vi.fn(),
  invalidateChannelToken: vi.fn(),
}))
vi.mock('@/utils/frontendLogger', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { invoke } from '@/utils/invoke'
import { appInvoke } from '@/utils/appCommands'
import { logger } from '@/utils/frontendLogger'
import {
  createAppControlBridge,
  AppControlError,
  APP_NOT_RUNNING,
  TOOL_NOT_DECLARED,
  PARAM_INVALID,
  APP_OPEN_FAILED,
  CALLER_UNAUTHORIZED,
} from '@/shell/mount/appControlBridge'

const mockedInvoke = vi.mocked(invoke)
const mockedAppInvoke = vi.mocked(appInvoke)

/** 构造宿主清单条目 */
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

describe('createAppControlBridge（通用应用调用桥）', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
    mockedAppInvoke.mockReset()
    vi.mocked(logger.log).mockClear()
    vi.mocked(logger.warn).mockClear()
    vi.mocked(logger.error).mockClear()
  })

  describe('list()', () => {
    it('返回已安装应用及其声明给助手的工具', async () => {
      mockedInvoke.mockResolvedValueOnce(withCaller([
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
      mockedInvoke.mockResolvedValueOnce(withCaller([
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
    it('已声明工具可调通：白名单通过 + appInvoke 路由', async () => {
      mockedInvoke.mockResolvedValueOnce(withCaller([
        makePluginInfo({
          id: 'com.wasmnest.monitor',
          contributes: { assistantTools: [makeTool()] },
        }),
      ]))
      mockedAppInvoke.mockResolvedValueOnce({ apps: 3, uptime: 120 })
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      const result = await bridge.invoke('com.wasmnest.monitor', 'monitor.snapshot')
      expect(result).toEqual({ apps: 3, uptime: 120 })
      expect(mockedAppInvoke).toHaveBeenCalledWith(
        'com.wasmnest.monitor',
        'monitor.snapshot',
        null,
      )
      // 审计：allowed + risk=read
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('decision=allowed'),
      )
    })

    it('目标未运行 → app.not_running', async () => {
      mockedInvoke.mockResolvedValueOnce(withCaller([
        makePluginInfo({
          id: 'com.wasmnest.monitor',
          state: { state: 'dormant' },
          contributes: { assistantTools: [makeTool()] },
        }),
      ]))
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      await expect(
        bridge.invoke('com.wasmnest.monitor', 'monitor.snapshot'),
      ).rejects.toMatchObject({ code: APP_NOT_RUNNING })
      expect(mockedAppInvoke).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('decision=denied'),
      )
    })

    it('命令未声明 → tool.not_declared（白名单强制，不回退任意命令）', async () => {
      mockedInvoke.mockResolvedValueOnce(withCaller([
        makePluginInfo({
          id: 'com.wasmnest.monitor',
          contributes: { assistantTools: [makeTool({ command: 'monitor.snapshot' })] },
        }),
      ]))
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      await expect(
        bridge.invoke('com.wasmnest.monitor', 'monitor.dangerous-undeclared'),
      ).rejects.toMatchObject({ code: TOOL_NOT_DECLARED })
      expect(mockedAppInvoke).not.toHaveBeenCalled()
    })

    it('参数不合 argsSchema → param.invalid（required）', async () => {
      mockedInvoke.mockResolvedValueOnce(withCaller([
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
      expect(mockedAppInvoke).not.toHaveBeenCalled()
    })

    it('参数不合 argsSchema → param.invalid（additionalProperties）', async () => {
      mockedInvoke.mockResolvedValueOnce(withCaller([
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
      mockedInvoke.mockResolvedValueOnce(withCaller([
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
      mockedInvoke.mockResolvedValueOnce(withCaller([
        makePluginInfo({ id: 'com.wasmnest.monitor' }),
      ]))
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      await expect(
        bridge.invoke('com.wasmnest.nonexistent', 'some.command'),
      ).rejects.toMatchObject({ code: 'app.not_installed' })
    })

    it('审计不记录参数原文', async () => {
      mockedInvoke.mockResolvedValueOnce(withCaller([
        makePluginInfo({
          id: 'com.wasmnest.monitor',
          contributes: { assistantTools: [makeTool()] },
        }),
      ]))
      mockedAppInvoke.mockResolvedValueOnce({ secret: 'value' })
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      await bridge.invoke('com.wasmnest.monitor', 'monitor.snapshot')
      const auditCalls = vi.mocked(logger.log).mock.calls
      const auditText = auditCalls.map((c) => String(c[0])).join('\n')
      expect(auditText).not.toContain('secret')
      expect(auditText).not.toContain('value')
    })
  })

  describe('调用方权限二次校验（spec §4.2.2 step 1）', () => {
    it('调用方未持 apps:control → caller.unauthorized（fail-closed）', async () => {
      mockedInvoke.mockResolvedValueOnce([
        makePluginInfo({ id: 'com.wasmnest.monitor', contributes: { assistantTools: [makeTool()] } }),
        callerInfo({ permissions: ['storage'] }),
      ])
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      await expect(bridge.list()).rejects.toMatchObject({ code: CALLER_UNAUTHORIZED })
      // list() 已消耗一次清单；invoke 再取一次，仍应被拒
      mockedInvoke.mockResolvedValueOnce([
        makePluginInfo({ id: 'com.wasmnest.monitor', contributes: { assistantTools: [makeTool()] } }),
        callerInfo({ permissions: ['storage'] }),
      ])
      await expect(
        bridge.invoke('com.wasmnest.monitor', 'monitor.snapshot'),
      ).rejects.toMatchObject({ code: CALLER_UNAUTHORIZED })
      expect(mockedAppInvoke).not.toHaveBeenCalled()
    })

    it('调用方不在清单里（已卸载）→ caller.unauthorized', async () => {
      mockedInvoke.mockResolvedValueOnce([
        makePluginInfo({ id: 'com.wasmnest.monitor', contributes: { assistantTools: [makeTool()] } }),
      ])
      const bridge = createAppControlBridge('com.wasmnest.assistant', vi.fn())
      await expect(
        bridge.invoke('com.wasmnest.monitor', 'monitor.snapshot'),
      ).rejects.toMatchObject({ code: CALLER_UNAUTHORIZED })
    })
  })

  describe('open()', () => {
    it('调用壳 openApp（成功 = 已激活）', async () => {
      mockedInvoke.mockResolvedValueOnce(withCaller([]))
      const openApp = vi.fn().mockResolvedValue(true)
      const bridge = createAppControlBridge('com.wasmnest.assistant', openApp)
      await bridge.open('com.wasmnest.monitor')
      expect(openApp).toHaveBeenCalledWith('com.wasmnest.monitor')
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('decision=allowed'),
      )
    })

    it('激活失败（openApp 返回 false）→ app.open_failed，不假装成功', async () => {
      mockedInvoke.mockResolvedValueOnce(withCaller([]))
      const openApp = vi.fn().mockResolvedValue(false)
      const bridge = createAppControlBridge('com.wasmnest.assistant', openApp)
      await expect(bridge.open('com.wasmnest.monitor')).rejects.toMatchObject({
        code: APP_OPEN_FAILED,
      })
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`reason=${APP_OPEN_FAILED}`),
      )
    })
  })
})
