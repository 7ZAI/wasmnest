/**
 * 宿主消息集 drift 锁（桌面 UI 宿主修正 2026-10-17）
 *
 * app 独立挂载包需自足：bedcode app 打包了宿主机制文案副本（host-zh-CN /
 * host-en，供 app 视图消费 errors.* / common.* / desktop.* / settings.* 顶层
 * key）。宿主侧消息集与 app 侧副本必须逐字一致——只改一边会让 app 界面在
 * 对应语言下回显 key 原文（无感知断裂）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from "node:path"
import { appPath } from './support/appPaths'

const HOST = (lang: 'zh-CN' | 'en') => join(process.cwd(), 'src', 'i18n', `host-${lang}.ts`)
// bedcode app 自三仓拆分起住应用仓（apps/bedcode/desktop，spec §5-E7）
const APP = (lang: 'zh-CN' | 'en') =>
  appPath('bedcode', 'desktop', 'src/i18n', `host-${lang}.ts`)

describe('宿主消息集 ↔ bedcode 副本 drift 锁', () => {
  it('host-zh-CN 逐字一致（改一边即红）', () => {
    expect(readFileSync(APP('zh-CN'), 'utf-8')).toBe(readFileSync(HOST('zh-CN'), 'utf-8'))
  })
  it('host-en 逐字一致', () => {
    expect(readFileSync(APP('en'), 'utf-8')).toBe(readFileSync(HOST('en'), 'utf-8'))
  })
})
