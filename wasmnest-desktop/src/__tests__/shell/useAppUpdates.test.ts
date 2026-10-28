/**
 * useAppUpdates 单测（应用版本更新全链路，壳侧兼容判断）
 *
 * 纯函数面（parseSemver / compareSemver / evaluateCompat）+ 动作状态机
 * （check / applyUpdate / clear）。invoke / 凭证 / 错误提示全部 mock——
 * 命令面的 Rust 侧测试见平台仓 src-tauri plugin_updates.rs。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/invoke', () => ({ invoke: vi.fn() }))
vi.mock('@/utils/appCommands', () => ({ ensureHostCredential: vi.fn(async () => 'cred') }))
vi.mock('@/utils/userError', () => ({ showUserError: vi.fn() }))
vi.mock('@/utils/frontendLogger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { invoke } from '@/utils/invoke'
import { showUserError } from '@/utils/userError'
import {
  compareSemver,
  evaluateCompat,
  parseSemver,
  useAppUpdates,
} from '@/shell/composables/useAppUpdates'

const { states, check, applyUpdate, clear } = useAppUpdates()

const COMPAT_OK = {
  hostRuntime: '0.0.1',
  mountContract: '1',
  sdkVersion: '0.0.1',
  witVersion: '0.0.1',
}

/** invoke mock 按命令名分发（get_app_version 固定 0.0.1，模块级缓存全文件共用） */
function mockInvoke(handler: (cmd: string, args?: Record<string, unknown>) => unknown) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) =>
    Promise.resolve(handler(cmd, args)),
  )
}

beforeEach(() => {
  vi.mocked(invoke).mockReset()
  for (const id of Object.keys(states.value)) clear(id)
})

describe('parseSemver / compareSemver', () => {
  it('严格解析 x.y.z[-pre]，形态非法返回 null', () => {
    expect(parseSemver('0.0.1')).toEqual({ major: 0, minor: 0, patch: 1, pre: null })
    expect(parseSemver('1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3, pre: ['rc', 1] })
    expect(parseSemver('v1.2.3')).toBeNull()
    expect(parseSemver('1.2')).toBeNull()
    expect(parseSemver('')).toBeNull()
  })

  it('核心三段逐位比较；pre-release 小于正式版', () => {
    expect(compareSemver('0.0.2', '0.0.1')).toBe(1)
    expect(compareSemver('0.0.1', '0.0.2')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareSemver('1.0.0-rc.2', '1.0.0-rc.1')).toBe(1)
    // 数字段 < 字母段（semver 规则 11.4）
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1)
  })

  it('任一形态非法 → null（不猜测）', () => {
    expect(compareSemver('0.0.1', 'abc')).toBeNull()
    expect(compareSemver('x.y.z', '0.0.1')).toBeNull()
  })
})

describe('evaluateCompat（三道判据）', () => {
  it('缺 compat 段 → 不兼容（旧发布物）', () => {
    expect(evaluateCompat(null, '0.0.1')?.key).toBe('shell.apps.update.reason.noCompat')
  })

  it('mountContract 不等 → 不兼容并点名两侧值', () => {
    const reason = evaluateCompat({ ...COMPAT_OK, mountContract: '2' }, '0.0.1')
    expect(reason?.key).toBe('shell.apps.update.reason.mountContract')
    expect(reason?.params).toEqual({ required: '2', current: '1' })
  })

  it('要求比当前宿主新 → 不兼容；相等 / 更旧 → 兼容', () => {
    expect(evaluateCompat({ ...COMPAT_OK, hostRuntime: '0.1.0' }, '0.0.1')?.key).toBe(
      'shell.apps.update.reason.hostRuntime',
    )
    expect(evaluateCompat({ ...COMPAT_OK, hostRuntime: '0.0.1' }, '0.0.1')).toBeNull()
    expect(evaluateCompat({ ...COMPAT_OK, hostRuntime: '0.0.0' }, '0.0.1')).toBeNull()
  })

  it('宿主版本形态异常 → hostRuntimeInvalid（fail-visible）', () => {
    expect(evaluateCompat({ ...COMPAT_OK, hostRuntime: 'abc' }, '0.0.1')?.key).toBe(
      'shell.apps.update.reason.hostRuntimeInvalid',
    )
  })
})

describe('check 动作', () => {
  it('最新版不比当前新 → up-to-date', async () => {
    mockInvoke((cmd) => {
      if (cmd === 'get_app_version') return '0.0.1'
      if (cmd === 'plugin_check_app_update')
        return {
          pluginId: 'com.wasmnest.app-a',
          currentVersion: '0.0.2',
          latestVersion: '0.0.2',
          tag: 'app-a-v0.0.2',
          zipAsset: 'app-a-desktop-v0.0.2.zip',
          sha256: 'a'.repeat(64),
          bytes: 1,
          compat: COMPAT_OK,
        }
      throw new Error(`unexpected command: ${cmd}`)
    })
    await check('com.wasmnest.app-a')
    expect(states.value['com.wasmnest.app-a']?.status).toBe('up-to-date')
  })

  it('有新版且兼容 → available 并带下载参数', async () => {
    mockInvoke((cmd) => {
      if (cmd === 'get_app_version') return '0.0.1'
      if (cmd === 'plugin_check_app_update')
        return {
          pluginId: 'com.wasmnest.app-b',
          currentVersion: '0.0.1',
          latestVersion: '0.0.2',
          tag: 'app-b-v0.0.2',
          zipAsset: 'app-b-desktop-v0.0.2.zip',
          sha256: 'b'.repeat(64),
          bytes: 1,
          compat: COMPAT_OK,
        }
      throw new Error(`unexpected command: ${cmd}`)
    })
    await check('com.wasmnest.app-b')
    const st = states.value['com.wasmnest.app-b']
    expect(st?.status).toBe('available')
    expect(st?.apply).toEqual({
      tag: 'app-b-v0.0.2',
      zipAsset: 'app-b-desktop-v0.0.2.zip',
      sha256: 'b'.repeat(64),
    })
  })

  it('有新版但缺 compat → incompatible（绝不出现 apply 参数）', async () => {
    mockInvoke((cmd) => {
      if (cmd === 'get_app_version') return '0.0.1'
      if (cmd === 'plugin_check_app_update')
        return {
          pluginId: 'com.wasmnest.app-c',
          currentVersion: '0.0.1',
          latestVersion: '0.0.2',
          tag: 'app-c-v0.0.2',
          zipAsset: 'app-c-desktop-v0.0.2.zip',
          sha256: 'c'.repeat(64),
          bytes: 1,
          compat: null,
        }
      throw new Error(`unexpected command: ${cmd}`)
    })
    await check('com.wasmnest.app-c')
    const st = states.value['com.wasmnest.app-c']
    expect(st?.status).toBe('incompatible')
    expect(st?.reason?.key).toBe('shell.apps.update.reason.noCompat')
    expect(st?.apply).toBeUndefined()
  })

  it('检查命令失败 → error 态（不 toast）', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_app_version') return '0.0.1'
      throw new Error('github down')
    })
    await check('com.wasmnest.app-d')
    expect(states.value['com.wasmnest.app-d']?.status).toBe('error')
    expect(showUserError).not.toHaveBeenCalled()
  })
})

describe('applyUpdate 动作', () => {
  async function primeAvailable(id: string) {
    mockInvoke((cmd) => {
      if (cmd === 'get_app_version') return '0.0.1'
      if (cmd === 'plugin_check_app_update')
        return {
          pluginId: id,
          currentVersion: '0.0.1',
          latestVersion: '0.0.2',
          tag: 'app-v0.0.2',
          zipAsset: 'app-desktop-v0.0.2.zip',
          sha256: 'd'.repeat(64),
          bytes: 1,
          compat: COMPAT_OK,
        }
      throw new Error(`unexpected command: ${cmd}`)
    })
    await check(id)
  }

  it('下载 + 升级安装成功 → up-to-date（命令参数含 upgrade: true）', async () => {
    const id = 'com.wasmnest.app-e'
    await primeAvailable(id)
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
    mockInvoke((cmd, args) => {
      calls.push({ cmd, args })
      if (cmd === 'plugin_download_update') return '/tmp/pkg.zip'
      if (cmd === 'plugin_install_from_file') return id
      throw new Error(`unexpected command: ${cmd}`)
    })
    await expect(applyUpdate(id)).resolves.toBe(true)
    const install = calls.find((c) => c.cmd === 'plugin_install_from_file')
    expect(install?.args).toMatchObject({ path: '/tmp/pkg.zip', upgrade: true })
    expect(states.value[id]?.status).toBe('up-to-date')
    expect(states.value[id]?.apply).toBeUndefined()
  })

  it('非 available 态不动作', async () => {
    const id = 'com.wasmnest.app-f'
    mockInvoke(() => {
      throw new Error('must not be called')
    })
    await expect(applyUpdate(id)).resolves.toBe(false)
  })

  it('安装失败 → showUserError + error 态', async () => {
    const id = 'com.wasmnest.app-g'
    await primeAvailable(id)
    mockInvoke((cmd) => {
      if (cmd === 'plugin_download_update') return '/tmp/pkg.zip'
      if (cmd === 'plugin_install_from_file') throw new Error('running')
      if (cmd === 'get_app_version') return '0.0.1'
      throw new Error(`unexpected command: ${cmd}`)
    })
    await expect(applyUpdate(id)).resolves.toBe(false)
    expect(showUserError).toHaveBeenCalled()
    expect(states.value[id]?.status).toBe('error')
  })
})

describe('useAppUpdates 出口', () => {
  it('与模块单例同源（states 引用一致）', () => {
    const a = useAppUpdates()
    const b = useAppUpdates()
    expect(a.states).toBe(b.states)
  })
})
