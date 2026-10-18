/**
 * 系统页 chrome + 权限页图标锁（2026-10-17）
 *
 * 需求：系统页「权限 / 设置」的图标用 SVG 重画，并修掉这些页面上的分层越界——
 * 此前系统页没有常驻标题栏，靠一颗 `position: fixed; top: 10px; left: 12px` 的悬浮
 * 返回胶囊当导航，胶囊正好压住 `.sys-head` 左上角的系统页图标与标题（用户看到的
 * "图标显示不全 / 被入侵"）；权限页又是"页中页"（AuthorizationView 自带 wb-toolbar），
 * 在系统页里长出第二条带边框的状态栏，且它那个「返回」指向 `/settings`——把用户从
 * 系统页甩进应用设置。
 *
 * 本锁钉住：
 * - L1 系统页 = 常驻标题栏 + 系统页卡，标题栏在前（页体从标题栏以下开始，无浮层）；
 * - L2 权限页以 embedded 嵌入：页头归 ShellCardScreen，AuthorizationView 的 wb-toolbar
 *      只在非嵌入形态渲染；
 * - L3 权限页的资源分区带 SVG 图标（文件 / 网络），不再只有文字标签；
 * - L4 图标几何：shield 必须是「盾 + 勾」（≥2 条子路径），gear 必须是真齿轮（≥8 段弧，
 *      且不含旧版「圆 + 8 根短辐条」的辐条段——那个形状在 13px 下与主题太阳图标撞形）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const HOST_SHELL = 'src/shell/ShellHost.vue'
const SYS_SCREEN = 'src/shell/components/ShellCardScreen.vue'
const SYS_PERMS = 'src/shell/sys/SysPermsView.vue'
const AUTH_VIEW = 'src/views/AuthorizationView.vue'
const ICONS = 'src/shell/components/ShellIcon.vue'

const read = (path: string): string => readFileSync(path, 'utf-8')

/** `<template>` 块内容（剔除 HTML 注释：注释里写标签名不算真实用法） */
function templateOf(source: string): string {
  const start = source.search(/<template[\s>]/)
  if (start === -1) return ''
  const rest = source.slice(start)
  const end = rest.search(/^<\/template>/m)
  return (end === -1 ? rest : rest.slice(0, end)).replace(/<!--[\s\S]*?-->/g, '')
}

/** 取 `name: [ ... ]` 图标路径数组的内部文本 */
function iconBlock(source: string, name: string): string {
  const hit = source.match(new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\],`))
  expect(hit, `ShellIcon 缺少 ${name} 图标`).not.toBeNull()
  return hit![1]
}

describe('L1 系统页 = 常驻标题栏 + 系统页卡（无浮层压页头）', () => {
  it('系统页分支先渲染 ShellToolbar，再渲染 ShellCardScreen', () => {
    const template = templateOf(read(HOST_SHELL))
    const sysAt = template.indexOf('v-else-if="isSysPage"')
    expect(sysAt, 'ShellHost 模板里找不到系统页分支').toBeGreaterThan(-1)
    const appAt = template.lastIndexOf('<template v-else>')
    const sysBranch = template.slice(sysAt, appAt === -1 ? undefined : appAt)
    expect(sysBranch, '系统页必须有壳标题栏（此前无标题栏，靠悬浮胶囊导航）').toContain(
      '<ShellToolbar',
    )
    const toolbarAt = sysBranch.indexOf('<ShellToolbar')
    const screenAt = sysBranch.indexOf('<ShellCardScreen')
    expect(screenAt, '系统页分支必须渲染系统页卡').toBeGreaterThan(-1)
    expect(toolbarAt, '标题栏必须排在系统页卡之前（页体只占其下方区域）').toBeLessThan(screenAt)
  })

  it('系统页卡自身是定高纵向 flex（页头 / tabs / 页体三段各自让位给滚动）', () => {
    const src = read(SYS_SCREEN)
    const rule = (src.match(/\.card-screen\s*\{[^}]*\}/)?.[0] ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rule, '.card-screen 必须 flex: 1 + min-height: 0（否则页体会顶出窗口）').toMatch(
      /min-height:\s*0/,
    )
    expect(src, '页体必须独立滚动（标题栏与页头不跟着滚）').toMatch(
      /\.sys-body\s*\{[^}]*overflow-y:\s*auto/,
    )
  })
})

describe('L2 权限页以 embedded 嵌入系统页（不再长出第二条状态栏）', () => {
  it('SysPermsView 传 embedded', () => {
    expect(read(SYS_PERMS), '系统页权限面必须 embedded 嵌入').toContain(
      '<AuthorizationView embedded />',
    )
  })

  it('AuthorizationView 的 wb-toolbar 只在非嵌入形态渲染', () => {
    const view = read(AUTH_VIEW)
    expect(view, 'AuthorizationView 缺少 embedded 开关').toMatch(/embedded\?:\s*boolean/)
    // 页头容器的 class 按 embedded 二选一：wb-toolbar（独立页）/ 内容级操作行（嵌入）
    expect(view, '页头必须按 embedded 切换（嵌入态不得再画带边框的 wb-toolbar）').toMatch(
      /:class="[\s\S]{0,200}?embedded[\s\S]{0,200}?wb-toolbar/,
    )
    // 返回 + 标题只在独立页形态出现（嵌入态导航归壳标题栏）
    expect(view, '返回 / 标题必须被 !embedded 门控').toMatch(/v-if="!embedded"/)
  })

  it('嵌入态内容不再自带整页滚动与二次内边距（滚动归 .sys-body）', () => {
    const view = read(AUTH_VIEW)
    expect(view, '内容区 padding / 滚动必须按 embedded 二选一').toMatch(
      /embedded \? '' : 'flex-1 overflow-auto p-5'/,
    )
  })
})

describe('L3 权限页资源分区带 SVG 图标', () => {
  it('文件 / 网络分区标题与档位标题都渲染 ShellIcon', () => {
    const view = read(AUTH_VIEW)
    expect(view, '资源 → 图标映射缺失').toContain('RESOURCE_ICONS')
    expect(view, '资源图标未从壳图标集引入').toContain(
      "import ShellIcon from '@/shell/components/ShellIcon.vue'",
    )
    const hits = view.match(/RESOURCE_ICONS\[resource\] \?\? 'file'/g) ?? []
    expect(hits.length, '资源徽标行与记录分区标题都应带图标（≥2 处）').toBeGreaterThanOrEqual(2)
    expect(view, '策略分组标题应带锁图标').toContain('<ShellIcon name="lock"')
  })
})

describe('L4 图标图块基规则在壳共享样式（scoped 不外泄）', () => {
  it('shell.css 定义 .glyph-box 且 flex 居中（此前只在 ShellAppTile scoped 里）', () => {
    const css = read('src/shell/shell.css')
    const rule = (css.match(/\.glyph-box\s*\{[^}]*\}/)?.[0] ?? '').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    expect(rule, 'shell.css 必须定义 .glyph-box 基规则').not.toBe('')
    expect(rule, '图标必须居中（行内 span 会让 SVG 按基线偏下）').toMatch(
      /display:\s*flex/,
    )
    expect(rule).toMatch(/align-items:\s*center/)
    expect(rule).toMatch(/justify-content:\s*center/)
  })

  it('ShellAppTile 不再 scoped 定义 .glyph-box（否则其余三处仍无样式）', () => {
    const tile = read('src/shell/components/ShellAppTile.vue')
    const style = tile.slice(tile.indexOf('<style'))
    const code = style.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code, '.glyph-box 基规则应留在 shell.css，不在某个组件的 scoped 样式里').not.toMatch(
      /\.glyph-box\s*\{/,
    )
    // 应用自带图标的裁剪规则仍归本组件
    expect(code).toMatch(/\.glyph-box\.has-logo\s*\{/)
  })
})

describe('L5 图标几何：权限盾带勾、设置是真齿轮', () => {
  it('shield = 盾 + 勾（≥2 条子路径，含勾的折线）', () => {
    const block = iconBlock(read(ICONS), 'shield')
    const paths = block.match(/'/g) ?? []
    expect(paths.length / 2, 'shield 必须由盾 + 勾两条路径组成').toBeGreaterThanOrEqual(2)
    expect(block, 'shield 必须带勾（"已授权"语义）').toMatch(/'m8\.8 12\.2 /)
  })

  it('gear = 齿廓圆弧（≥8 段 A 弧），且不是旧版"圆 + 8 根辐条"', () => {
    const block = iconBlock(read(ICONS), 'gear')
    const arcs = block.match(/A\d/g) ?? []
    expect(arcs.length, '齿轮必须有齿廓（齿顶 / 齿谷交替的圆弧）').toBeGreaterThanOrEqual(8)
    // 旧版辐条：竖横各两根短线，13px 下正是"太阳"的观感
    for (const retired of ['M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3']) {
      expect(block, `齿轮不得回退到旧版辐条几何（${retired}）`).not.toContain(retired)
    }
  })
})
