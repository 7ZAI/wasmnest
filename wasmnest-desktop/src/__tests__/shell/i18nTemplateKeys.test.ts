import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import hostZhCN from '@/i18n/host-zh-CN'
import hostEn from '@/i18n/host-en'

/**
 * 壳模板 i18n key 存在性锁（2026-10-17 验证 P2-7 的回归锁）
 *
 * 背景：`AppMountSlot` 引用了 `shell.apps.loading` / `shell.apps.mountFailed` /
 * `common.actions.retry` 三个**从未注册**的 key，界面上直接回显 key 原文
 * （`shell.apps.mountFailed`）——组件能渲染、类型检查通过、没人发现。
 *
 * 本锁把 `t('字面量')` 的调用点当作契约，逐个在 zh-CN 与 en 两套消息集里查存在性：
 * 少一边 = 该语言下回显 key 原文，与「禁止硬编码 / 双语同步」同一条纪律。
 */

const SCAN_ROOTS = ['src/shell', 'src/components/AppMountSlot.vue']

/** 递归收集待扫描源码（.vue / .ts） */
function collectSources(): string[] {
  const files: string[] = []
  const walk = (target: string) => {
    const entries = readdirSync(target, { withFileTypes: true }).filter(Boolean)
    for (const entry of entries) {
      const p = join(target, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(vue|ts)$/.test(entry.name)) files.push(p)
    }
  }
  for (const root of SCAN_ROOTS) {
    try {
      walk(root)
    } catch {
      // 单文件根：walk 的 readdir 会抛 —— 直接当文件读取
      files.push(root)
    }
  }
  return files
}

/** 抓 `t('xxx')` / `$t('xxx')` 的字面量 key（动态 key 不在此列，由调用方保证） */
function literalKeys(text: string): Set<string> {
  const keys = new Set<string>()
  for (const match of text.matchAll(/(?<![\w.$])\$?t\(\s*'([^']+)'/g)) keys.add(match[1])
  return keys
}

/** 消息集是否含该点路径（值可以是字符串；中间节点是对象） */
function hasPath(messages: unknown, key: string): boolean {
  let node: unknown = messages
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return false
    node = (node as Record<string, unknown>)[segment]
    if (node === undefined) return false
  }
  return true
}

describe('壳模板 i18n key 存在性锁', () => {
  const files = collectSources()
  const used = new Map<string, string>()
  for (const file of files) {
    for (const key of literalKeys(readFileSync(file, 'utf-8'))) used.set(key, file)
  }

  it('扫描器不空转：抓到足量字面量 key（防正则失效导致全绿）', () => {
    expect(used.size).toBeGreaterThan(50)
  })

  it('每个字面量 key 在 zh-CN 与 en 中都存在', () => {
    const missingZh: string[] = []
    const missingEn: string[] = []
    for (const [key, file] of used) {
      if (!hasPath(hostZhCN, key)) missingZh.push(`${key} (${file})`)
      if (!hasPath(hostEn, key)) missingEn.push(`${key} (${file})`)
    }
    expect(missingZh, `zh-CN 缺 key：\n${missingZh.join('\n')}`).toEqual([])
    expect(missingEn, `en 缺 key：\n${missingEn.join('\n')}`).toEqual([])
  })
})
