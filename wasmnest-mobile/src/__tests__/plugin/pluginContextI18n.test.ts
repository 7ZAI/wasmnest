/**
 * PluginContext i18n API 查表契约
 *
 * 背景（2026-11-12 真机）：插件常把**错误正文**交给 `context.i18n.t()`（例如
 * `toast.showToast(t(err.message))`）。旧实现无条件前缀化并回显前缀 key，
 * 于是 toast 出现 `com.wasmnest.<plugin>.Command not found: …` 这类垃圾文案。
 *
 * 新契约：前缀 key 未注册时**返回调用方原文**（vue-i18n 标准「未注册回显 key」
 * 语义），并兼容已带命名空间的完整 key；已注册的短 key 行为不变。
 *
 * | 契约 | 输入 | 预期 |
 * |---|---|---|
 * | C-I1 | 已注册短 key | 返回 `<pluginId>.<key>` 的文案 |
 * | C-I2 | 未注册的短 key | 返回原短 key（不带插件前缀） |
 * | C-I3 | 错误正文（含空格/冒号/中文） | 原样返回，不拼插件前缀 |
 * | C-I4 | 已带命名空间的完整 key | 直接按完整 key 命中 |
 * | C-I5 | 宿主 i18n 不可用 | 原样返回 key |
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPluginContext } from '@/plugin/context'
import type { PluginInfo } from '@/plugin/types'

const PLUGIN_ID = 'com.wasmnest.bedcode'

const MESSAGES: Record<string, string> = {
  [`${PLUGIN_ID}.hello`]: '你好',
  'com.wasmnest.bedcode.tunnel.failed': '隧道连接失败',
}

/** 最小宿主 i18n 替身：命中返回文案，未命中回显 key（与 vue-i18n 同语义） */
const fakeHostI18n = {
  global: {
    t: (key: string, params?: Record<string, unknown>) => {
      const text = MESSAGES[key]
      if (text === undefined) return key
      if (!params) return text
      return text.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? ''))
    },
  },
}

function makeInfo(): PluginInfo {
  return {
    id: PLUGIN_ID,
    name: 'BedCode',
    version: '1.0.0',
    description: '',
    author: '',
    main: '',
    pluginType: 'wasm' as PluginInfo['pluginType'],
    permissions: [],
    state: 'activated' as PluginInfo['state'],
    contributes: {} as PluginInfo['contributes'],
    source: '',
    assetDir: '',
  } as PluginInfo
}

describe('PluginContext i18n 查表', () => {
  beforeEach(() => {
    ;(window as unknown as { __WASMNEST_SHARED__?: unknown }).__WASMNEST_SHARED__ = {
      i18n: fakeHostI18n,
    }
  })

  afterEach(() => {
    delete (window as unknown as { __WASMNEST_SHARED__?: unknown }).__WASMNEST_SHARED__
  })

  it('C-I1 已注册短 key：按插件命名空间命中', () => {
    expect(createPluginContext(makeInfo()).i18n.t('hello')).toBe('你好')
  })

  it('C-I2 未注册短 key：原样返回，不产出前缀化 key', () => {
    const ctx = createPluginContext(makeInfo())
    expect(ctx.i18n.t('missing.key')).toBe('missing.key')
    expect(ctx.i18n.t('missing.key')).not.toContain(PLUGIN_ID)
  })

  it('C-I3 错误正文原样返回（toast 不再出现 com.wasmnest.* 前缀垃圾）', () => {
    const ctx = createPluginContext(makeInfo())
    const message = 'Command not found: bedcode.tunnel-connect (host.internal, request_id=1c928a08)'
    expect(ctx.i18n.t(message)).toBe(message)
    expect(ctx.i18n.t('操作未完成，请稍后重试')).toBe('操作未完成，请稍后重试')
  })

  it('C-I4 已带命名空间的完整 key：直接命中', () => {
    const ctx = createPluginContext(makeInfo())
    expect(ctx.i18n.t('com.wasmnest.bedcode.tunnel.failed')).toBe('隧道连接失败')
  })

  it('C-I5 宿主 i18n 不可用：原样返回 key', () => {
    delete (window as unknown as { __WASMNEST_SHARED__?: unknown }).__WASMNEST_SHARED__
    expect(createPluginContext(makeInfo()).i18n.t('hello')).toBe('hello')
  })
})
