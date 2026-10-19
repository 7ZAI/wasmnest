import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 壳共享样式接线锁（2026-10-17 验证 P0-2 的回归锁）
 *
 * 背景：`src/shell/styles/shell.css` 曾是一份 12KB 的**零引用死文件**——里面是 9 个壳组件
 * 依类名消费的全部共享样式（tone 底色 / 状态点 / 按钮 / chip / 壁纸 / 动效）。
 * 没有任何 import 时，样式全部静默失效：图标无底色、`.sdot` 塌成 0×0、壁纸不显示，
 * 而组件代码、类型检查、单测全绿（类名在模板里照写，CSS 只是没进构建）。
 *
 * 本锁钉两条：① 全局样式表必须在入口接线（含顺序）；② 被消费的共享类必须仍在
 * shell.css 里定义（防「删样式但类名还在模板里」同形态回退）。
 */

const SHELL_CSS = 'src/shell/styles/shell.css'
const MAIN_TS = 'src/main.ts'

/** 从 CSS 文本抓顶层类选择器（`.foo` / `.foo.bar` 取首个）；忽略声明块内的值 */
function cssClassNames(css: string): Set<string> {
  const names = new Set<string>()
  for (const match of css.matchAll(/^\s*\.([a-zA-Z][\w-]*)/gm)) names.add(match[1])
  return names
}

/** 递归收集壳内 .vue/.ts 源码文本 */
function shellSourceText(): string {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(vue|ts)$/.test(entry.name)) out.push(readFileSync(p, 'utf-8'))
    }
  }
  // 壳域自 2026-10-19 目录整理后收在 src/shell/**：挂载槽（mount/AppMountSlot.vue）
  // 与系统页（sys/）均在 shell 树内，walk 自然覆盖，无需特判路径
  walk('src/shell')
  return out.join('\n')
}

describe('壳共享样式接线锁', () => {
  it('shell.css 由入口 main.ts 引入，且排在 style.css（token）之后', () => {
    const main = readFileSync(MAIN_TS, 'utf-8')
    const styleIdx = main.indexOf("import './style.css'")
    const shellIdx = main.indexOf("import './shell/styles/shell.css'")
    expect(styleIdx, 'main.ts 必须引入 style.css（token 真源）').toBeGreaterThanOrEqual(0)
    expect(shellIdx, 'main.ts 必须引入 shell.css（壳共享样式）').toBeGreaterThanOrEqual(0)
    expect(shellIdx, 'shell.css 必须在 style.css 之后引入').toBeGreaterThan(styleIdx)
  })

  it('shell.css 仍定义壳组件按类名消费的共享类', () => {
    const classes = cssClassNames(readFileSync(SHELL_CSS, 'utf-8'))
    // 逐个点名（不是数量断言）：少哪个，对应面就少一块样式
    for (const required of [
      'shell-root',
      // 图标图块基规则（系统页页头 / 主屏系统网格 / 多任务系统卡 / 应用图标共用）
      'glyph-box',
      'tone-system',
      'sdot',
      'shell-chip',
      'shell-btn',
      'shell-mini',
      'shell-sw',
      'shell-seg',
      'shell-rec',
      'home-wall',
      'shell-dlg-in',
      'shell-fade-in',
    ]) {
      expect(classes.has(required), `shell.css 缺少 .${required}`).toBe(true)
    }
  })

  it('定义过的共享类有消费方（防死文件 / 防改名后两边都留着）', () => {
    const classes = cssClassNames(readFileSync(SHELL_CSS, 'utf-8'))
    const source = shellSourceText()
    const consumed = [
      'shell-root',
      'tone-system',
      'sdot',
      'shell-chip',
      'shell-btn',
      'shell-mini',
      'shell-sw',
      'shell-seg',
      'shell-rec',
      'home-wall',
      'shell-dlg-in',
      'shell-fade-in',
    ]
    for (const cls of consumed) {
      expect(source.includes(cls), `.${cls} 在壳源码里没有消费方（样式或类名有一边过期）`).toBe(true)
      expect(classes.has(cls), `.${cls} 在 shell.css 里没有定义`).toBe(true)
    }
  })
})
