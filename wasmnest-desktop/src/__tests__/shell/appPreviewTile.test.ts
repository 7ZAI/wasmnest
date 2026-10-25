/**
 * AppPreviewTile 行为单测（spec `.scratch/2026-10-20-app-preview-contract` Seam 2）
 *
 * 只断言**外部可观察行为**：有预览 / 无预览 / 失败 / 超时 / 卸载 / 晚到结果 /
 * 不换发令牌 / 装饰层属性。不断言应用内部用了哪个组件、哪条命令。
 *
 * 宿主侧真实装载（`mountAppPreview` 的 bundle import）在单测里不可用：这里替换成
 * 可控的假装载，契约形状与 `useAppMount` 同形（`null` = 未导出）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

// ==================== 模块桩（预览容器依赖的全部宿主取数口） ====================
const mountAppPreview = vi.hoisted(() => vi.fn())
const appInvoke = vi.hoisted(() => vi.fn(async () => null))
const appStorageGet = vi.hoisted(() => vi.fn(async () => undefined))
// 预览路径严禁换发通道令牌 / 写存储（会作废主实例正在用的令牌 / 越权写）
const refreshChannelToken = vi.hoisted(() => vi.fn(async () => 'token'))
const appStorageSet = vi.hoisted(() => vi.fn(async () => {}))
const appStorageDelete = vi.hoisted(() => vi.fn(async () => {}))
const loggerWarn = vi.hoisted(() => vi.fn())
const loggerError = vi.hoisted(() => vi.fn())

vi.mock('@/shell/mount/useAppMount', () => ({
  mountAppPreview,
  PREVIEW_MOUNT_TIMEOUT_MS: 3000,
}))
vi.mock('@/utils/appCommands', () => ({
  appInvoke,
  appStorageGet,
  refreshChannelToken,
  appStorageSet,
  appStorageDelete,
}))
vi.mock('@/utils/frontendLogger', () => ({
  logger: { log: vi.fn(), warn: loggerWarn, error: loggerError },
}))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ settings: { ui: { language: 'zh-CN', theme: 'dark' } } }),
}))
vi.mock('@/composables/usePlatform', () => ({
  usePlatform: () => ({ platformInfo: { value: { isDesktop: true, isMobile: false } } }),
}))
// 图标解析会问宿主要 asset dir；单测里没有 Tauri，直接回 null → 回退壳内 glyph
vi.mock('@/utils/invoke', () => ({ invoke: vi.fn(async () => null) }))

import AppPreviewTile from '@/shell/mount/AppPreviewTile.vue'
import type { AppPreviewEnv, AppPreviewHandle } from '@/shell/mount/useAppMount'

const APP_ID = 'com.wasmnest.bedcode'

/** 预览句柄（unmount 可断言） */
function makeHandle(): AppPreviewHandle & { unmount: ReturnType<typeof vi.fn> } {
  return { unmount: vi.fn(async () => {}) }
}

function mountTile(props: Record<string, unknown> = {}): VueWrapper {
  return mount(AppPreviewTile, {
    props: { appId: APP_ID, lastRoute: '/sessions', icon: 'terminal', tone: 'primary', ...props },
    attachTo: document.body,
  })
}

function stateOf(wrapper: VueWrapper): string | undefined {
  return wrapper.attributes('data-preview-state') ?? wrapper.find('.app-preview').attributes('data-preview-state')
}

describe('AppPreviewTile 生命周期', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    mountAppPreview.mockReset()
    appInvoke.mockClear()
    appStorageGet.mockClear()
    refreshChannelToken.mockClear()
    appStorageSet.mockClear()
    appStorageDelete.mockClear()
    loggerWarn.mockClear()
    loggerError.mockClear()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('bundle 未导出 mountPreview（null）→ 保持品牌卡 fallback，不报错', async () => {
    mountAppPreview.mockResolvedValue(null)
    wrapper = mountTile()
    await flushPromises()

    expect(stateOf(wrapper)).toBe('fallback')
    // fallback 是完整品牌卡：图标可见（不空白）
    expect(wrapper.find('.app-preview-fallback .glyph-box').exists()).toBe(true)
    expect(wrapper.find('.app-preview-fallback').classes()).not.toContain('is-hidden')
    // 正常的不支持：不是错误，不告警
    expect(loggerWarn).not.toHaveBeenCalled()
  })

  it('挂载成功 → 预览面填入内容、fallback 淡出隐藏、状态 ready', async () => {
    const handle = makeHandle()
    mountAppPreview.mockImplementation(async (root: HTMLElement) => {
      root.innerHTML = '<div data-preview-drawn>app drawn</div>'
      return handle
    })
    wrapper = mountTile()
    await flushPromises()

    expect(stateOf(wrapper)).toBe('ready')
    expect(wrapper.find('[data-preview-drawn]').exists()).toBe(true)
    expect(wrapper.find('.app-preview-fallback').classes()).toContain('is-hidden')
  })

  it('预览环境是收窄只读面：含 appId / lastRoute / locale / theme，无宿主 invoke / 写存储 / 事件出口', async () => {
    mountAppPreview.mockImplementation(async (root: HTMLElement) => {
      root.textContent = 'ok'
      return makeHandle()
    })
    wrapper = mountTile({ lastRoute: '/tasks' })
    await flushPromises()

    expect(mountAppPreview).toHaveBeenCalledTimes(1)
    const [root, env] = mountAppPreview.mock.calls[0] as [HTMLElement, AppPreviewEnv]
    expect(root).toBe(wrapper.find('.app-preview-surface').element)
    expect(env.appId).toBe(APP_ID)
    expect(env.lastRoute).toBe('/tasks')
    expect(env.locale).toBe('zh-CN')
    expect(env.theme).toBe('dark')
    // 收窄面：没有宿主面命令 / 写存储 / 事件出口
    expect('invoke' in env).toBe(false)
    expect('appStorageSet' in env).toBe(false)
    expect('appStorageDelete' in env).toBe(false)
    expect('onEvent' in env).toBe(false)
    // 环境里的读写通道必须绑定本 appId（不串到别的应用命名空间）
    await env.appStorageGet('some-key')
    expect(appStorageGet).toHaveBeenCalledWith(APP_ID, 'some-key')
    await env.appInvoke('session.list', {})
    expect(appInvoke).toHaveBeenCalledWith(APP_ID, 'session.list', {})
  })

  it('挂载抛错 → 回退品牌卡 + logger.warn，不产生未处理 rejection', async () => {
    mountAppPreview.mockRejectedValue(new Error('boom'))
    wrapper = mountTile()
    await flushPromises()

    expect(stateOf(wrapper)).toBe('fallback')
    expect(wrapper.find('.app-preview-fallback .glyph-box').exists()).toBe(true)
    expect(loggerWarn).toHaveBeenCalledTimes(1)
    expect(String(loggerWarn.mock.calls[0][0])).toContain(`appId=${APP_ID}`)
  })

  it('挂载超时（3000ms）→ 回退品牌卡 + 告警，不再等待', async () => {
    vi.useFakeTimers()
    try {
      mountAppPreview.mockReturnValue(new Promise<AppPreviewHandle>(() => {}))
      wrapper = mountTile()
      await nextTick()
      // 超时前：fallback 仍在显示，不出现空白 / spinner
      expect(stateOf(wrapper)).toBe('loading')
      expect(wrapper.find('.app-preview-fallback').exists()).toBe(true)

      await vi.advanceTimersByTimeAsync(3000)

      expect(stateOf(wrapper)).toBe('fallback')
      expect(loggerWarn).toHaveBeenCalledTimes(1)
      expect(String(loggerWarn.mock.calls[0][1])).toContain('timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('卸载 → 调用 handle.unmount()', async () => {
    const handle = makeHandle()
    mountAppPreview.mockResolvedValue(handle)
    wrapper = mountTile()
    await flushPromises()

    wrapper.unmount()
    wrapper = null
    await flushPromises()

    expect(handle.unmount).toHaveBeenCalledTimes(1)
  })

  it('卸载后才 resolve 的晚到 handle → 立即 unmount，不挂到已卸载的卡片上', async () => {
    let resolveMount!: (handle: AppPreviewHandle) => void
    const pending = new Promise<AppPreviewHandle>((resolve) => {
      resolveMount = resolve
    })
    mountAppPreview.mockImplementation(async (root: HTMLElement) => {
      root.innerHTML = '<div data-preview-drawn>drawn before handle</div>'
      return pending
    })

    wrapper = mountTile()
    await flushPromises()
    wrapper.unmount()
    wrapper = null

    const late = makeHandle()
    resolveMount(late)
    await flushPromises()

    expect(late.unmount, '晚到句柄必须立刻卸载（预览实例不能活过卡片）').toHaveBeenCalledTimes(1)
    // 卡片已消失：晚到内容不得重新出现在文档里
    expect(document.querySelector('[data-preview-drawn]')).toBeNull()
  })

  it('unmount() 抛错 → logger.error，不阻断卡片关闭', async () => {
    const handle = makeHandle()
    handle.unmount.mockRejectedValue(new Error('cleanup failed'))
    mountAppPreview.mockResolvedValue(handle)
    wrapper = mountTile()
    await flushPromises()

    expect(() => wrapper!.unmount()).not.toThrow()
    wrapper = null
    await flushPromises()

    expect(loggerError).toHaveBeenCalledTimes(1)
  })

  it('预览路径不换发通道令牌、不写 / 删存储', async () => {
    mountAppPreview.mockResolvedValue(makeHandle())
    wrapper = mountTile()
    await flushPromises()

    expect(refreshChannelToken, '预览不得作废主实例正在用的令牌').not.toHaveBeenCalled()
    expect(appStorageSet).not.toHaveBeenCalled()
    expect(appStorageDelete).not.toHaveBeenCalled()
  })

  it('预览容器是装饰层：inert / aria-hidden / 不接收指针事件与文本选择', async () => {
    mountAppPreview.mockResolvedValue(makeHandle())
    wrapper = mountTile()
    await flushPromises()

    const surface = wrapper.find('.app-preview-surface')
    expect(surface.exists()).toBe(true)
    expect(surface.attributes('inert')).toBeDefined()
    expect(surface.attributes('aria-hidden')).toBe('true')
    expect(surface.attributes('style')).toContain('pointer-events: none')
    expect(surface.attributes('style')).toContain('user-select: none')
  })
})
