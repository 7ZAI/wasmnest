/**
 * 权限词汇 × 审批文案覆盖锁（票 01 / spec §4.1）
 *
 * 权限词的真源 = SDK `rust/src/permission.rs` → 生成物
 * `packages/plugin-sdk-desktop/bin/permission-vocabulary.json`。
 * 壳只做展示层映射（`src/shell/permissions.ts`），本锁保证两件事不漏：
 *
 * 1. 生成物里的**每个**权限词都有 `PERMISSION_I18N_KEY` 映射——漏一条的代价是
 *    审批弹窗里裸显英文 code（spec §4.1「审批文案必须写明授权语义」）；
 * 2. 每个映射项在 zh-CN / en 两份 locale 里都有 `.title` 与 `.desc` 文案——
 *    只有一种语言的文案等于另一种语言的用户看不懂自己批准了什么。
 *
 * 锁的语义是「新增权限词必须同时补映射与双语文案」，不是快照清单：
 * 因此这里只断言覆盖关系，不硬编码权限数量。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import hostZhCN from '@/i18n/host-zh-CN'
import hostEn from '@/i18n/host-en'
import { PERMISSION_I18N_KEY, permissionDescKey, permissionTitleKey } from '@/shell/permissions'

/** 权限词汇生成物（SDK 真源产物，只读） */
const VOCAB_PATH = join(
  process.cwd(),
  'packages/plugin-sdk-desktop/bin/permission-vocabulary.json',
)

const vocabulary = JSON.parse(readFileSync(VOCAB_PATH, 'utf-8')) as { permissions: string[] }

/** 按 `shell.apps.perm.*` 的 key 路径取 locale 文案（缺键返回 undefined） */
function lookup(locale: unknown, key: string): string | undefined {
  let node: unknown = locale
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

describe('权限审批文案覆盖锁', () => {
  it('权限词汇生成物可读且非空（否则本锁空转）', () => {
    expect(Array.isArray(vocabulary.permissions)).toBe(true)
    expect(vocabulary.permissions.length).toBeGreaterThan(10)
    expect(vocabulary.permissions).toContain('apps:control')
    expect(vocabulary.permissions).toContain('ui:globalEntry')
  })

  it('每个权限词都有 i18n 映射（新增词汇不得裸显英文 code）', () => {
    const unmapped = vocabulary.permissions.filter((p) => !(p in PERMISSION_I18N_KEY))
    expect(unmapped, `未登记审批文案的权限词: ${unmapped.join(', ')}`).toEqual([])
  })

  it('映射项在 zh-CN / en 都有 title 与 desc', () => {
    const missing: string[] = []
    for (const perm of vocabulary.permissions) {
      const titleKey = permissionTitleKey(perm)
      const descKey = permissionDescKey(perm)
      expect(titleKey, `${perm} 缺 title key`).toBeTruthy()
      expect(descKey, `${perm} 缺 desc key`).toBeTruthy()
      if (!lookup(hostZhCN, titleKey!)) missing.push(`zh-CN ${titleKey}`)
      if (!lookup(hostZhCN, descKey!)) missing.push(`zh-CN ${descKey}`)
      if (!lookup(hostEn, titleKey!)) missing.push(`en ${titleKey}`)
      if (!lookup(hostEn, descKey!)) missing.push(`en ${descKey}`)
    }
    expect(missing, `缺文案: ${missing.join(', ')}`).toEqual([])
  })

  it('apps:control 的文案写明「代你调用其他应用已声明命令」（不得弱化成读取信息）', () => {
    const zh = lookup(hostZhCN, 'shell.apps.perm.appsControl.desc') ?? ''
    const en = lookup(hostEn, 'shell.apps.perm.appsControl.desc') ?? ''
    expect(zh).toContain('调用')
    expect(zh).toContain('其他应用')
    expect(en.toLowerCase()).toContain('invoke')
    expect(en.toLowerCase()).toContain('other apps')
  })
})
