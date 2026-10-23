import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

/**
 * 多任务接线锁（2026-10-17 用户裁决的回归锁）
 *
 * 需求演进：
 * - 主屏**不再**展示「正在运行」区域；
 * - 打开过 / 后台运行的应用由**标题栏导航区的「多任务」入口**承载（紧贴「返回」右侧），
 *   形态是**全屏切换层**（安卓 recents：虚化背景 + 运行中应用的大卡片），不是小浮层面板。
 *
 * 这类改动的典型失败形态是「三处只改了两处」：组件写了但工具栏没入口 / 入口点了没层
 * 可开 / 主屏卡片带忘了删 / 全屏层被壳根的 overflow 裁成小窗——界面看起来正常，功能
 * 其实半截。本锁逐条钉住接线。
 */

const HOME = 'src/shell/components/ShellHome.vue'
const TOOLBAR = 'src/shell/components/ShellToolbar.vue'
const HOST = 'src/shell/ShellHost.vue'
const SWITCHER = 'src/shell/components/ShellTaskSwitcher.vue'
const RETIRED_PANEL = 'src/shell/components/ShellRecentsPanel.vue'
const ICONS = 'src/shell/components/ShellIcon.vue'

const read = (path: string): string => readFileSync(path, 'utf-8')

/** 去注释（注释里提到被删除的类名 / key 不算真实用法） */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('主屏不再展示运行区', () => {
  it('ShellHome 模板里没有卡片带（state.cards / hstrip / 旧文案 key）', () => {
    const home = stripComments(read(HOME))
    expect(home).not.toContain('state.cards')
    expect(home).not.toContain('hstrip')
    expect(home).not.toContain('shell.home.running')
    // 反例守卫：应用网格必须还在（别把主屏删空）
    expect(home).toContain("t('shell.home.appsTitle')")
  })
})

describe('标题栏多任务入口（导航区，紧贴「返回」右侧）', () => {
  it('入口在 nav 内，且排在「返回」之后（不是右侧工具区）', () => {
    const toolbar = stripComments(read(TOOLBAR))
    expect(toolbar, '入口开合全屏多任务层').toContain('state.toggleRecents()')
    expect(toolbar, '入口用 recents 图标（移动端多任务同视觉）').toContain('name="recents"')
    expect(toolbar, '入口要有文字标签（与返回 / 主屏同形态）').toContain("t('shell.nav.tasks')")
    expect(toolbar, '有后台应用时显示数量').toContain('state.cards.value.length')

    const back = toolbar.indexOf("t('shell.nav.back')")
    const tasks = toolbar.indexOf("t('shell.nav.tasks')")
    const home = toolbar.indexOf("t('shell.nav.home')")
    expect(back, '返回按钮必须在场').toBeGreaterThan(-1)
    expect(tasks, '多任务必须紧跟返回（右侧）').toBeGreaterThan(back)
    expect(home, '主屏按钮跟在多任务之后').toBeGreaterThan(tasks)
  })

  it('ShellHost 挂载全屏多任务层（入口有对象可开）', () => {
    expect(stripComments(read(HOST))).toContain('<ShellTaskSwitcher />')
  })

  it('ShellIcon 图标表定义了 recents（否则入口按钮空白）', () => {
    expect(read(ICONS)).toMatch(/recents:\s*\[/)
  })
})

describe('全屏形态（安卓 recents：虚化背景 + 大卡片）', () => {
  it('小浮层面板已退役，换成全屏切换层', () => {
    expect(existsSync(RETIRED_PANEL), '旧的小面板组件不该还在').toBe(false)
    expect(existsSync(SWITCHER), '全屏切换层必须存在').toBe(true)
  })

  it('Teleport 到 body + fixed 铺满 + 背景虚化（否则被壳根 overflow 裁掉/无模糊）', () => {
    const src = stripComments(read(SWITCHER))
    expect(src, '壳根是 overflow:hidden 的定高 flex，全屏层必须逃出去').toContain(
      '<Teleport to="body">',
    )
    expect(src).toMatch(/\.ts-root\s*\{[^}]*position:\s*fixed/)
    expect(src).toMatch(/\.ts-root\s*\{[^}]*inset:\s*0/)
    expect(src, '背景虚化 = 安卓多任务的核心观感').toContain('backdrop-filter: blur(')
    expect(src, 'WebKit 需要前缀（WebKitGTK 实测只认 -webkit-）').toContain(
      '-webkit-backdrop-filter',
    )
  })

  it('卡片是应用窗口形态（缩略区 16/10 + 自适应多行网格 + 超高滚动），不是列表行', () => {
    const src = stripComments(read(SWITCHER))
    // 缩略区保持应用窗口比例（16/10），不是一行一个的列表行
    expect(src).toMatch(/\.ts-thumb\s*\{[^}]*flex:\s*1/)
    // 卡片带 = 每行最多 3 张的多行网格（超 3 张换行、整组居中），
    // 放不下自动换行；卡片过多时超出高度滚动查看
    // 每行最多 3 张卡（用户 2026-10-19 裁决：超 3 张换行，整组居中）
    expect(src).toMatch(/\.ts-cards\s*\{[^}]*grid-template-columns:\s*repeat\(3,/)
    expect(src).toMatch(/\.ts-cards\s*\{[^}]*overflow-y:\s*auto/)
    expect(src).toContain('role="listitem"')
  })
})

describe('全屏层动作走唯一实现（不复制编排）', () => {
  it('切换 / 单关 / 全关分别转发 activateCard / closeCard / stopAllCards', () => {
    const src = stripComments(read(SWITCHER))
    expect(src).toContain('state.activateCard(')
    expect(src).toContain('state.closeCard(')
    expect(src).toContain('state.stopAllCards(')
    // 反例：不得自己拼路由或直接调生命周期命令（那是 useShellState 的职责）
    expect(src).not.toContain('router.push')
    expect(src).not.toContain("invoke('plugin_deactivate'")
  })
})

describe('后台应用卡片：信息条在顶部（2026-10-20 用户裁决）', () => {
  it('名称条排在缩略区之前，且以应用图标打头', () => {
    const src = stripComments(read(SWITCHER))
    const meta = src.indexOf('class="ts-meta"')
    const thumb = src.indexOf('class="ts-thumb"')
    expect(meta, '卡片必须有信息条').toBeGreaterThan(-1)
    expect(thumb, '缩略区必须还在').toBeGreaterThan(meta)
    // 信息条的第一个视觉元素是图标（应用走 ShellAppTile，系统页走 glyph-box）
    expect(src.slice(meta, thumb)).toMatch(/<ShellAppTile|<span v-else class="glyph-box/)
  })

  it('不再用 chip 重复「运行中」（异常态仍保留提示）', () => {
    const src = stripComments(read(SWITCHER))
    expect(src, 'running 态必须跳过 chip').toContain("st === 'running'")
    expect(src, '不再直接渲染「运行中」文案').not.toContain("t('shell.state.running')")
  })
})

describe('卡片缩略区接线应用预览面（spec 2026-10-20-app-preview-contract）', () => {
  it('app 卡走 AppPreviewTile，系统页卡保持原 glyph 分支', () => {
    const src = stripComments(read(SWITCHER))
    const thumb = src.indexOf('class="ts-thumb"')
    expect(thumb, '缩略区必须还在').toBeGreaterThan(-1)

    // app 卡：应用自绘预览面（未导出 / 失败 / 超时由组件内部回退品牌卡）
    const appPreviewIdx = src.indexOf('<AppPreviewTile', thumb)
    expect(appPreviewIdx, 'app 卡必须在缩略区挂 AppPreviewTile').toBeGreaterThan(thumb)
    expect(src, '预览面需要 lastRoute 才能续接上次页面').toContain(':last-route="lastRouteOf(')
    // 系统页卡没有 app bundle：继续用 glyph，不塞预览组件
    const sysGlyphIdx = src.indexOf('class="glyph-box tone-system ts-sys-glyph"', appPreviewIdx)
    expect(sysGlyphIdx, '系统页卡必须保留 glyph 分支').toBeGreaterThan(appPreviewIdx)
  })

  it('预览容器不在打开按钮内部（单一覆盖层动作，避免嵌套交互元素）', () => {
    const src = stripComments(read(SWITCHER))
    const buttonStart = src.indexOf('class="ts-card-main"')
    expect(buttonStart, '唯一打开动作按钮必须在场').toBeGreaterThan(-1)
    const buttonEnd = src.indexOf('</button>', buttonStart)
    expect(buttonEnd, '打开按钮必须是自闭合空按钮').toBeGreaterThan(buttonStart)

    const insideButton = src.slice(buttonStart, buttonEnd)
    expect(insideButton, '预览面不得嵌进 button（应用可能自绘按钮 / 输入框）').not.toContain(
      'AppPreviewTile',
    )
    expect(insideButton, '视觉层不得放进 button').not.toContain('ts-thumb')
    expect(insideButton, '信息条不得放进 button').not.toContain('ts-meta')
  })

  it('视觉层不承载点击（pointer-events:none），关闭键层序高于覆盖层', () => {
    const src = stripComments(read(SWITCHER))
    expect(src).toMatch(/\.ts-card \.ts-meta,\s*\.ts-card \.ts-thumb\s*\{[^}]*pointer-events:\s*none/)
    expect(src).toMatch(/\.ts-card-main\s*\{[^}]*position:\s*absolute/)
    expect(src).toMatch(/\.ts-card-x\s*\{[^}]*z-index:\s*2/)
  })
})

describe('多任务缩放过渡（安卓 recents 观感）', () => {
  it('卡片缩放上浮入场，退出时轻微缩回，并尊重 reduced-motion', () => {
    const src = stripComments(read(SWITCHER))
    const keyframes = src.match(/@keyframes ts-card-in\s*\{[\s\S]*?\n\}/)?.[0] ?? ''

    expect(keyframes, '入场必须带缩放').toContain('scale(')
    expect(keyframes, '入场必须带上浮').toContain('translateY(')
    expect(src, '退出时卡片随全屏层缩回').toContain('.ts-fade-leave-to .ts-card')
    expect(src, 'Teleport 到 body 的层必须自带 reduced-motion 覆盖').toContain(
      'prefers-reduced-motion',
    )
  })
})

describe('命令面板退役（工具栏搜索入口按用户裁决移除）', () => {
  it('组件文件已删，壳内不再挂载 / 不再有开关', () => {
    expect(existsSync('src/shell/components/ShellCommandPalette.vue')).toBe(false)
    const shellSources = [HOST, TOOLBAR, 'src/shell/composables/useShellState.ts'].map((p) => read(p))
    for (const src of shellSources) {
      const code = stripComments(src)
      expect(code).not.toContain('ShellCommandPalette')
      expect(code).not.toContain('paletteOpen')
    }
    // 反例守卫：多任务入口必须还在（别把导航区删空）
    expect(stripComments(read(TOOLBAR))).toContain('state.toggleRecents()')
  })
})

describe('图标还原为应用自带那张', () => {
  it('主屏与多任务都给 ShellAppTile 传 pluginId（否则只剩哈希 glyph）', () => {
    expect(stripComments(read(HOME))).toContain(':plugin-id="app.id"')
    expect(stripComments(read(SWITCHER))).toContain(':plugin-id="idOf(key)"')
  })

  it('ShellAppTile 经 asset 协议渲染应用图标，失败回退 glyph', () => {
    const tile = stripComments(read('src/shell/components/ShellAppTile.vue'))
    expect(tile).toContain('appIconUrl')
    expect(tile).toMatch(/<img[\s\S]*:src="logo"/)
    // 回退分支必须在：加载不出来时仍要能显示图标（不是空块）
    expect(tile).toContain('<ShellIcon v-else')
  })

  it('注册表投影把 manifest.icon 带进应用条目（图标文件名单一来源）', () => {
    const apps = stripComments(read('src/shell/composables/useShellApps.ts'))
    expect(apps).toMatch(/iconFile:\s*typeof info\.icon/)
  })
})
