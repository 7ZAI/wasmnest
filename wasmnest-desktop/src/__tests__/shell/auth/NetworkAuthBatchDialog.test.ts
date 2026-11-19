/**
 * NetworkAuthBatchDialog 渲染与应答契约
 *
 * 被测行为（外部可见输出）：
 * - 批量事件到达后完整展示应用名与全部 origin，不折叠、不省略；
 * - 三个按钮映射到宿主批量三态（allow / deny / deny_always），都经
 *   `plugin_network_auth_batch_respond` 回传并带宿主凭证；
 * - 事件到达时排队：前一批未答完不被后到事件覆盖；
 * - Esc / 点遮罩按「本次拒绝」处理；
 * - 应答失败不抛错也不重开弹窗，队列继续前进；
 * - 层级高于插件启停遮罩。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import NetworkAuthBatchDialog from '@/shell/auth/NetworkAuthBatchDialog.vue'
import LoadingOverlay from '@/components/LoadingOverlay.vue'

const tauriEvent = vi.hoisted(() => ({
  lastBatchHandler: null as ((e: { payload: unknown }) => void) | null,
}))

const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (e: { payload: unknown }) => void) => {
    tauriEvent.lastBatchHandler = handler
    return () => {}
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: {
      'zh-CN': {
        desktop: {
          auth: {
            netAuthBatchTitle: '网络访问授权（{count} 个地址）',
            netAuthBatchRequest: '应用 {plugin} 请求访问以下 {count} 个网络地址',
            netAuthBatchOriginList: '待授权的网络地址',
            netAuthBatchScope: '同意后，这些地址（主机与端口）以后不再询问',
            netAuthBatchAllow: '允许这 {count} 个地址',
            netAuthBatchDeny: '本次拒绝',
            netAuthBatchDenyAlways: '以后都拒绝',
          },
        },
      },
    },
  })
}

const stubs = { Teleport: false, Transition: false }

function mountDialog(): VueWrapper {
  return mount(NetworkAuthBatchDialog, {
    global: { plugins: [createTestI18n()], stubs },
    attachTo: document.body,
  })
}

function mountMask(): VueWrapper {
  return mount(LoadingOverlay, {
    props: { visible: true },
    global: { stubs },
    attachTo: document.body,
  })
}

const DEFAULT_ORIGINS = ['https://registry.npmjs.org:443', 'https://registry.npmmirror.com:443']

async function emitBatch(overrides: Record<string, unknown> = {}): Promise<void> {
  await flushPromises()
  tauriEvent.lastBatchHandler?.({
    payload: {
      requestId: 'req-batch-1',
      batchId: 'batch-1',
      pluginId: 'com.wasmnest.bedcode',
      origins: DEFAULT_ORIGINS,
      ...overrides,
    },
  })
  await flushPromises()
}

async function clickButton(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll('.max-w-md button')).find(
    (b) => b.textContent?.trim() === label,
  )
  expect(button, `找不到按钮「${label}」`).toBeTruthy()
  await button!.click()
  await flushPromises()
}

function respondCalls(): unknown[][] {
  return mockInvoke.mock.calls.filter((call) => call[0] === 'plugin_network_auth_batch_respond')
}

function zIndexOf(root: Element): number {
  const token = root.className
    .split(/\s+/)
    .find((c) => /^z-(\d+|\[\d+\])$/.test(c))
  if (!token) throw new Error(`overlay root has no z utility class: ${root.className}`)
  return Number(token.replace(/^z-/, '').replaceAll(/[\[\]]/g, ''))
}

describe('NetworkAuthBatchDialog 组件', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    tauriEvent.lastBatchHandler = null
    mockInvoke.mockReset()
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'plugin_frontend_loader_session') return Promise.resolve('loader-session')
      return Promise.resolve(undefined)
    })
  })

  it('事件到达后完整展示应用与全部 origin，并说明授权范围', async () => {
    const wrapper = mountDialog()
    await emitBatch()

    const dialog = document.querySelector('.max-w-md')
    expect(dialog).toBeTruthy()
    expect(dialog?.textContent).toContain('网络访问授权（2 个地址）')
    expect(dialog?.textContent).toContain('com.wasmnest.bedcode')
    for (const origin of DEFAULT_ORIGINS) {
      expect(dialog?.textContent).toContain(origin)
    }
    expect(dialog?.textContent).toContain('同意后，这些地址（主机与端口）以后不再询问')
    const labels = Array.from(document.querySelectorAll('.max-w-md button')).map((b) =>
      b.textContent?.trim(),
    )
    expect(labels).toEqual(
      expect.arrayContaining(['以后都拒绝', '本次拒绝', '允许这 2 个地址']),
    )
    wrapper.unmount()
  })

  it('未收到事件时不渲染任何弹窗', () => {
    const wrapper = mountDialog()
    expect(document.querySelector('.max-w-md')).toBeNull()
    wrapper.unmount()
  })

  it('「允许」回传 allow 并带宿主凭证，弹窗随即关闭', async () => {
    const wrapper = mountDialog()
    await emitBatch()

    await clickButton('允许这 2 个地址')

    expect(respondCalls()).toHaveLength(1)
    expect(respondCalls()[0][1]).toEqual({
      requestId: 'req-batch-1',
      decision: 'allow',
      credential: 'loader-session',
    })
    await vi.waitFor(() => {
      expect(document.querySelector('.max-w-md')).toBeNull()
    })
    wrapper.unmount()
  })

  it('「本次拒绝」与「以后都拒绝」是两个决定', async () => {
    const wrapper = mountDialog()
    await emitBatch()
    await clickButton('本次拒绝')
    expect(respondCalls()[0][1]).toMatchObject({
      requestId: 'req-batch-1',
      decision: 'deny',
    })

    await emitBatch({ requestId: 'req-batch-2', batchId: 'batch-2' })
    await clickButton('以后都拒绝')
    expect(respondCalls()[1][1]).toMatchObject({
      requestId: 'req-batch-2',
      decision: 'deny_always',
    })
    wrapper.unmount()
  })

  it('后到事件排队，不覆盖在途批次；应答后显示下一批', async () => {
    const wrapper = mountDialog()
    await emitBatch()
    await emitBatch({
      requestId: 'req-batch-2',
      batchId: 'batch-2',
      origins: ['https://mirrors.huaweicloud.com:443'],
    })

    let dialog = document.querySelector('.max-w-md')
    expect(dialog?.textContent).toContain('registry.npmjs.org')
    expect(dialog?.textContent).not.toContain('mirrors.huaweicloud.com')

    await clickButton('本次拒绝')

    dialog = document.querySelector('.max-w-md')
    expect(dialog?.textContent).toContain('mirrors.huaweicloud.com')
    expect(dialog?.textContent).toContain('网络访问授权（1 个地址）')
    expect(respondCalls()).toHaveLength(1)
    wrapper.unmount()
  })

  it('Esc 按本次拒绝回传（不落账）', async () => {
    const wrapper = mountDialog()
    await emitBatch()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(respondCalls()).toHaveLength(1)
    expect(respondCalls()[0][1]).toMatchObject({
      requestId: 'req-batch-1',
      decision: 'deny',
    })
    await vi.waitFor(() => {
      expect(document.querySelector('.max-w-md')).toBeNull()
    })
    wrapper.unmount()
  })

  it('应答失败不抛错也不重开弹窗，队列继续前进', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'plugin_frontend_loader_session') return Promise.resolve('loader-session')
      if (cmd === 'plugin_network_auth_batch_respond') {
        return Promise.reject(new Error('request expired'))
      }
      return Promise.resolve(undefined)
    })
    const wrapper = mountDialog()
    await emitBatch()
    await emitBatch({
      requestId: 'req-batch-2',
      batchId: 'batch-2',
      origins: ['https://registry.yarnpkg.com:443'],
    })

    await clickButton('本次拒绝')

    expect(respondCalls()).toHaveLength(1)
    const dialog = document.querySelector('.max-w-md')
    expect(dialog?.textContent).toContain('registry.yarnpkg.com')
    wrapper.unmount()
  })

  it('授权弹窗层级必须高于启停 LoadingOverlay', async () => {
    const dialogWrapper = mountDialog()
    const maskWrapper = mountMask()
    await emitBatch()

    const roots = Array.from(document.body.querySelectorAll('.fixed.inset-0'))
    const maskRoot = roots.find((el) => el.querySelector('.loading-overlay-orb'))
    const authRoot = roots.find((el) => el.querySelector('.max-w-md'))
    expect(maskRoot).toBeTruthy()
    expect(authRoot).toBeTruthy()
    expect(zIndexOf(authRoot!)).toBeGreaterThan(zIndexOf(maskRoot!))

    maskWrapper.unmount()
    dialogWrapper.unmount()
  })
})