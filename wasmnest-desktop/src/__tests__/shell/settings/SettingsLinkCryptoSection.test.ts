/**
 * SettingsLinkCryptoSection 行为契约（2026-11-04 用户裁决：策略属于应用）
 *
 * 契约清单：
 * - C1 只读展示本机指纹（供双端人工核对）；
 * - C2 只读列出「应用 × 策略 × 端点计数」；明文应用可见（审计面）；
 * - C3 宿主不提供任何写入口：没有档位控件 / 开关，也不调用写命令；
 * - C4 旧宿主缺能力字段：显性提示能力缺失，不假装有策略面；
 * - C5 读取失败不阻断设置页：显性错误行，不渲染过期数据。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import i18n from '@/i18n'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@/utils/invoke', () => ({ invoke: invokeMock }))

import SettingsLinkCryptoSection from '@/shell/settings/SettingsLinkCryptoSection.vue'

const t = (key: string, params?: Record<string, unknown>) =>
  (i18n.global.t as (k: string, p?: Record<string, unknown>) => string)(
    `settings.linkCrypto.${key}`,
    params,
  )

/**
 * 能力查询 wire 形状（能力仓 `LinkCryptoCapabilities`，serde camelCase）
 *
 * 夹具必须与真实宿主逐字同形；按 snake_case 造夹具会让「前端读错键名」的缺陷
 * 继续全绿（2026-11-03 宿主设置页踩过一次）。
 */
function capabilities(overrides: Record<string, unknown> = {}) {
  return {
    appScopedPolicy: true,
    policies: ['required', 'preferred', 'off'],
    identityFingerprint: 'abcd1234abcd1234',
    keyModels: ['paired-http-path-bound'],
    wsSession: true,
    ...overrides,
  }
}

function appPolicies() {
  return [
    { owner: 'com.wasmnest.bedcode', policy: 'required', endpointCount: 2 },
    { owner: 'com.wasmnest.file-transfer', policy: 'off', endpointCount: 1 },
  ]
}

function installMock(options: { caps?: unknown; apps?: unknown; error?: Error } = {}): void {
  invokeMock.mockImplementation((command: string) => {
    if (options.error) return Promise.reject(options.error)
    if (command === 'get_link_crypto_capabilities')
      return Promise.resolve(options.caps ?? capabilities())
    if (command === 'get_link_crypto_app_policies')
      return Promise.resolve(options.apps ?? appPolicies())
    return Promise.reject(new Error(`unexpected command: ${command}`))
  })
}

function mountSection() {
  return mount(SettingsLinkCryptoSection, { global: { plugins: [i18n] } })
}

beforeEach(() => {
  invokeMock.mockReset()
})

describe('SettingsLinkCryptoSection — 只读审计', () => {
  it('展示本机指纹与应用策略（required / off + 端点计数），不附说明文字', async () => {
    installMock()
    const wrapper = mountSection()
    await flushPromises()

    // 设置项只留标签与值：归属 / 默认值等说明文字已删（用户 2026-11-09 裁决）
    expect(wrapper.find('[data-testid="link-crypto-app-owned-hint"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="link-crypto-default-hint"]').exists()).toBe(false)
    // 新宿主支持 WS 帧级加密：不得再显示「WS 仍明文」缺口横幅
    expect(wrapper.find('[data-testid="link-crypto-ws-gap"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="link-crypto-fingerprint"]').text()).toBe('abcd1234abcd1234')

    const rows = wrapper.findAll('[data-testid="link-crypto-app-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('com.wasmnest.bedcode')
    expect(rows[0].text()).toContain(t('endpointCount', { count: 2 }))
    expect(rows[0].text()).toContain(t('policyRequired'))
    expect(rows[1].text()).toContain('com.wasmnest.file-transfer')
    expect(rows[1].text()).toContain(t('policyOff'))
  })

  it('旧宿主 wsSession=false：如实提示 WS 仍明文（不把明文说成已加密）', async () => {
    installMock({ caps: capabilities({ wsSession: false }) })
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="link-crypto-ws-gap"]').text()).toBe(t('wsNotEncrypted'))
  })

  it('没有任何写入口：无档位控件 / 开关，也不调用写命令', async () => {
    installMock()
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.findAll('input')).toHaveLength(0)
    expect(wrapper.findAll('[role="switch"]')).toHaveLength(0)
    expect(wrapper.findAll('button')).toHaveLength(0)
    const commands = invokeMock.mock.calls.map(([command]) => command as string)
    expect(commands.sort()).toEqual([
      'get_link_crypto_app_policies',
      'get_link_crypto_capabilities',
    ])
  })

  it('未设置策略的应用按明文执行：空清单给显性说明', async () => {
    installMock({ apps: [] })
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="link-crypto-empty"]').text()).toBe(t('appsEmpty'))
  })

  it('旧宿主缺能力字段：显性提示能力缺失，不渲染假策略', async () => {
    installMock({ caps: capabilities({ appScopedPolicy: false }), apps: appPolicies() })
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="link-crypto-unsupported"]').exists()).toBe(true)
    expect(wrapper.text()).toContain(t('capabilityMissing'))
    expect(wrapper.find('[data-testid="link-crypto-app-row"]').exists()).toBe(false)
  })

  it('读取失败：显性错误行，不展示过期数据', async () => {
    installMock({ error: new Error('command not found') })
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="link-crypto-load-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain(t('loadFailed'))
    expect(wrapper.find('[data-testid="link-crypto-app-row"]').exists()).toBe(false)
  })
})
