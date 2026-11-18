/**
 * 插件启动加载门禁测试（spec §3.5 / issue 02）
 *
 * 被测行为（loader.ts 实际实现）：
 * - autostart（持久化自启动偏好，随清单同位返回；缺省按装配角色）false → 跳过
 *   （移动端启动不启动应用）
 * - Activating 中间态 → 跳过（等最终态轮询兜底）
 * - pluginType: 'backend' → 跳过（无前端产物，后端自管）
 * - 其余状态（Activated / Degraded / Loaded / Error / NeedsApproval / Deactivated）
 *   + isAutostart=true → 放行调 loadFrontend（vitest 内动态 import 必失败 → 走
 *   markError 失败恢复路径作为「已尝试加载」探针）
 * - Degraded 在放行前 console.warn 标注降级原因（loader.ts:109-111）
 *
 * 门禁口径（移动端应用模型）：boot 只预载显式打开「启动时自动激活」的应用，
 * `plugin.enabled.{id}`（应用已启用 / 可用偏好）不再驱动启动——持久化 ≠ 自启动。
 *
 * 测试 seam：mock @tauri-apps/api/core 边界（loader 走 invoke 命令字符串拼装）。
 * 「尝试加载前端模块」的可观测结果 = 动态 import 在 vitest 内必然失败（asset://
 * 协议无服务器可解析）→ loader 失败恢复路径调用 plugin_mark_error。
 * 因此断言：mark_error 恰好出现在门禁放行的插件上，跳过的插件零调用；
 * Degraded 的降级原因经 console.warn 上报（含插件 id 与原始错误串）。
 *
 * 注：移动端 issue 04 诊断命令（spec §3.6 P2）未实施，无 plugin_frontend_load_report
 * → 不写「诊断失败不阻塞」case（issue 04 P2 范围外可拆票）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { logger } from '@/utils/frontendLogger'
import { pluginLoader } from '@/plugin/loader'
import type { PluginInfo } from '@/plugin/types'
import type { PluginShellInfo } from '@/plugin/commands'
import {
  makePluginInfo,
  makeDegradedPluginInfo,
  makeActivatingPluginInfo,
} from '@/__tests__/fixtures'

/** 壳清单条目 = 清单字段 + 自启偏好同位（后端 `MobileShellPluginInfo`） */
function shell(info: PluginInfo, autostart: boolean): PluginShellInfo {
  return { ...info, autostart }
}

// ==================== mock Tauri 边界 ====================

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  // asset protocol 路径转换：loader 用它构造插件入口 URL（测试环境无 asset 服务器，
  // 返回合法协议串即可让 loader 走到动态 import 步骤并稳定失败）
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}))

/** 取某插件的 plugin_mark_error 调用次数 */
function markErrorCount(pluginId: string): number {
  return mockInvoke.mock.calls.filter(
    ([c, a]) => c === 'plugin_mark_error' && (a as { pluginId?: string })?.pluginId === pluginId,
  ).length
}

let consoleWarnSpy: ReturnType<typeof vi.spyOn>
let consoleLogSpy: ReturnType<typeof vi.spyOn>
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  // 默认 mock 行为：所有命令静默返回（清单为空）
  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case 'plugin_frontend_loader_session':
        // 固定假凭证（ADR 0058：loadAll bootstrap 先取宿主面凭证）
        return Promise.resolve('test-host-loader-session-credential')
      case 'plugin_list_loaded':
        return Promise.resolve([])
      case 'plugin_mark_error':
        return Promise.resolve(undefined)
      default:
        return Promise.resolve(undefined)
    }
  })
  // 静音预期内的 log/warn/error（动态 import 失败、降级 warn 等）
  consoleWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  consoleLogSpy = vi.spyOn(logger, 'log').mockImplementation(() => {})
  consoleErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  // loader 单例跨用例清理：尝试对所有测试用插件 deactivate（idempotent，失败 ignore）
  for (const id of [
    'com.wasmnest.gate-ok',
    'com.wasmnest.gate-degraded',
    'com.wasmnest.gate-activating',
    'com.wasmnest.gate-loaded',
    'com.wasmnest.gate-error',
    'com.wasmnest.gate-approval',
    'com.wasmnest.gate-off',
    'com.wasmnest.gate-backend',
  ]) {
    await pluginLoader.deactivate(id).catch(() => {})
  }
  consoleWarnSpy.mockRestore()
  consoleLogSpy.mockRestore()
  consoleErrorSpy.mockRestore()
})

describe('pluginLoader.loadAll 启动加载门禁', () => {
  it('自启动放行：6 态放行 + Activating/backend 跳过，Degraded 标注降级原因', async () => {
    const DEGRADED_REASON = 'startup init failed: db migration error'

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'plugin_frontend_loader_session') {
        return Promise.resolve('test-host-loader-session-credential')
      }
      if (cmd === 'plugin_list_loaded') {
        return Promise.resolve([
          shell(
            makePluginInfo({
              id: 'com.wasmnest.gate-ok',
              name: 'Gate Ok',
              state: { state: 'activated' },
            }),
            true,
          ),
          shell(
            makeDegradedPluginInfo({
              id: 'com.wasmnest.gate-degraded',
              name: 'Gate Degraded',
              error: DEGRADED_REASON,
            }),
            true,
          ),
          shell(
            makeActivatingPluginInfo({ id: 'com.wasmnest.gate-activating', name: 'Gate Activating' }),
            true,
          ),
          shell(
            makePluginInfo({
              id: 'com.wasmnest.gate-loaded',
              name: 'Gate Loaded',
              state: { state: 'loaded' },
            }),
            true,
          ),
          shell(
            makePluginInfo({
              id: 'com.wasmnest.gate-error',
              name: 'Gate Error',
              state: { state: 'error', error: 'boom' },
            }),
            true,
          ),
          shell(
            makePluginInfo({
              id: 'com.wasmnest.gate-approval',
              name: 'Gate Approval',
              state: { state: 'needsApproval' },
            }),
            true,
          ),
          shell(
            makePluginInfo({
              id: 'com.wasmnest.gate-off',
              name: 'Gate Off',
              state: { state: 'deactivated' },
            }),
            true,
          ),
          // backend 形态：无前端产物，后端自管，跳过（loader.ts 自启动门禁）
          shell(
            makePluginInfo({
              id: 'com.wasmnest.gate-backend',
              name: 'Gate Backend',
              pluginType: 'backend',
              state: { state: 'activated' },
            }),
            true,
          ),
        ])
      }
      return Promise.resolve(undefined)
    })

    await pluginLoader.loadAll()

    // 失败恢复是 async：等几个 tick 让 markError 微任务跑完
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    // 自启动放行：6 状态（Activated/Degraded/Loaded/Error/NeedsApproval/Deactivated）
    // 全部放行调 loadFrontend → vitest 内动态 import 必失败 → 各 1 次 markError
    expect(markErrorCount('com.wasmnest.gate-ok')).toBe(1)
    expect(markErrorCount('com.wasmnest.gate-degraded')).toBe(1)
    expect(markErrorCount('com.wasmnest.gate-loaded')).toBe(1)
    expect(markErrorCount('com.wasmnest.gate-error')).toBe(1)
    expect(markErrorCount('com.wasmnest.gate-approval')).toBe(1)
    expect(markErrorCount('com.wasmnest.gate-off')).toBe(1)
    // 跳过：Activating 中间态 + backend 形态
    expect(markErrorCount('com.wasmnest.gate-activating')).toBe(0)
    expect(markErrorCount('com.wasmnest.gate-backend')).toBe(0)

    // Degraded 的降级原因经 console.warn 标注（含插件 id 与原始错误串）
    const warns = consoleWarnSpy.mock.calls.map((args) => String(args[0]))
    const degradedWarn = warns.find(
      (w) => w.includes('com.wasmnest.gate-degraded') && w.toLowerCase().includes('degraded'),
    )
    expect(degradedWarn).toBeTruthy()
    expect(degradedWarn!).toContain(DEGRADED_REASON)

    // F2 锁：自启偏好随清单同位返回，loader 不再逐插件查询
    expect(
      mockInvoke.mock.calls.filter(([c]) => c === 'plugin_is_autostart'),
    ).toHaveLength(0)
  })

  it('autostart=false 门禁：跳过前端加载（持久化 ≠ 自启动，偏好随清单同位）', async () => {
    // 同一批插件中：开了自启动的放行、未开的跳过（与运行时状态无关）
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'plugin_list_loaded') {
        return Promise.resolve([
          // 已激活且开了自启动 → 放行
          shell(
            makePluginInfo({
              id: 'com.wasmnest.gate-on',
              name: 'Gate On',
              state: { state: 'activated' },
            }),
            true,
          ),
          // 已激活但未开自启动 → 跳过（即使运行时是 Activated）
          shell(
            makePluginInfo({
              id: 'com.wasmnest.gate-off',
              name: 'Gate Off',
              state: { state: 'activated' },
            }),
            false,
          ),
          // Loaded 且未开自启动 → 跳过（boot 不预载，等壳里点击）
          shell(
            makePluginInfo({
              id: 'com.wasmnest.gate-off-loaded',
              name: 'Gate Off Loaded',
              state: { state: 'loaded' },
            }),
            false,
          ),
        ])
      }
      return Promise.resolve(undefined)
    })

    await pluginLoader.loadAll()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    // 仅自启动插件走到 loadFrontend（vitest 内动态 import 必失败 → markError 1 次）
    expect(markErrorCount('com.wasmnest.gate-on')).toBe(1)
    // 未开自启动者零加载尝试
    expect(markErrorCount('com.wasmnest.gate-off')).toBe(0)
    expect(markErrorCount('com.wasmnest.gate-off-loaded')).toBe(0)

    // F2 锁：清单已带偏好，单点偏好查询零调用（1+N 次串行 IPC 不再存在）
    expect(
      mockInvoke.mock.calls.filter(([c]) => c === 'plugin_is_autostart'),
    ).toHaveLength(0)
  })
})
