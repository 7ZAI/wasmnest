/**
 * `useAppUpdate` 状态机（SDK 默认更新检查）
 *
 * 数据面用注入的 `check` 替身（不触达宿主 / 网络）：锁住「可用 / 最新 / 不兼容 /
 * 失败」四态与并发去重；默认宿主能力的接线由宿主 `env.appUpdate` 契约测试覆盖。
 */
import { describe, expect, it, vi } from 'vitest'
import { useAppUpdate } from '../src/update'
import type { AppUpdateCheckResult } from '../src/types'

const available: AppUpdateCheckResult = {
  status: 'available',
  currentVersion: '0.0.1',
  latestVersion: '0.0.2',
}

describe('useAppUpdate', () => {
  it('starts idle and exposes supported when a checker is injected', () => {
    const update = useAppUpdate({ check: async () => available })
    expect(update.status.value).toBe('idle')
    expect(update.checking.value).toBe(false)
    expect(update.supported.value).toBe(true)
  })

  it('lands on available and keeps both versions', async () => {
    const update = useAppUpdate({ check: async () => available })
    await update.check()
    expect(update.status.value).toBe('available')
    expect(update.latestVersion.value).toBe('0.0.2')
    expect(update.currentVersion.value).toBe('0.0.1')
    expect(update.reason.value).toBeUndefined()
  })

  it('lands on up-to-date', async () => {
    const update = useAppUpdate({
      check: async () => ({ status: 'up-to-date', currentVersion: '0.0.2', latestVersion: '0.0.2' }),
    })
    await update.check()
    expect(update.status.value).toBe('up-to-date')
  })

  it('keeps incompatible reason for the view layer', async () => {
    const reason = { key: 'shell.apps.update.reason.hostRuntime', params: { required: '9.0.0', current: '0.0.1' } }
    const update = useAppUpdate({
      check: async () => ({
        status: 'incompatible',
        currentVersion: '0.0.1',
        latestVersion: '0.0.2',
        reason,
      }),
    })
    await update.check()
    expect(update.status.value).toBe('incompatible')
    expect(update.reason.value).toEqual(reason)
  })

  it('normalizes thrown errors / intermediate statuses to error', async () => {
    const thrown = useAppUpdate({
      check: async () => {
        throw new Error('network down')
      },
    })
    await thrown.check()
    expect(thrown.status.value).toBe('error')

    const intermediate = useAppUpdate({ check: async () => ({ status: 'checking' }) })
    await intermediate.check()
    expect(intermediate.status.value).toBe('error')
  })

  it('deduplicates concurrent checks into one in-flight request', async () => {
    let resolve!: (value: AppUpdateCheckResult) => void
    const check = vi.fn(
      () =>
        new Promise<AppUpdateCheckResult>((r) => {
          resolve = r
        }),
    )
    const update = useAppUpdate({ check })
    const first = update.check()
    const second = update.check()
    expect(check).toHaveBeenCalledTimes(1)
    resolve(available)
    await Promise.all([first, second])
    expect(update.status.value).toBe('available')
  })
})
