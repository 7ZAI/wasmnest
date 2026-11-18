import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { appPath } from '../support/appPaths'

/**
 * wasm-app 与壳标题栏边界锁（2026-10-17 用户裁决的回归锁）
 *
 * 需求：桌面宿主前端展示 wasm-app 页面时，**壳标题栏固定常驻**（所有 wasm-app 的
 * 所有页面共用），应用只占标题栏**以下**的区域——应用不得自绘标题栏 / 窗口控制 /
 * 拖拽区，也不得按窗口整高（100vh）定高。
 *
 * 此前实现是两个方向都错：应用路由（ShellHost 的 v-else 分支）只渲染挂载槽，
 * 没有任何标题栏，导航退化成一颗悬浮返回胶囊（压在应用内容上）；而 bedcode 应用
 * 又在挂载槽里自绘了一条 TitleBar（品牌 + 三个窗口按钮），于是「标题栏」归应用、
 * 壳没有 chrome——加任何 app 都得重画一遍，且胶囊与标题栏互相叠。
 *
 * 本锁钉住：
 * - L1 应用 / 系统页路由 = 壳标题栏 + 内容（挂载槽 / 系统页卡），且标题栏在前
 *      （bareWindow 除外）；全仓不再有悬浮返回胶囊（它会盖住系统页页头的图标与标题）
 * - L2 终端独立窗口（bareWindow）仍不套壳标题栏（窗口 chrome 由应用自持）
 * - L3 挂载槽只吃剩余高度（flex: 1 1 0 + min-height: 0），不得写 height: 100%
 * - L4 wasm-app 主界面不自绘标题栏：无 TitleBar 组件、根容器用 h-full（不用 h-screen）、
 *      除终端独立窗口外不声明拖拽区
 * - L5 挂载包样式不在 :root 覆盖宿主 token（浅色主题下会整窗变暗）
 */

const HOST_SHELL = 'src/shell/ShellHost.vue'
const MOUNT_SLOT = 'src/shell/mount/AppMountSlot.vue'
// 桌面四应用工程目录（三仓拆分 §5-E7：住应用仓 apps/<slug>/desktop）
const DESKTOP_APPS = ['ai-chatbox', 'bedcode', 'file-transfer'].map((slug) =>
  appPath(slug, 'desktop'),
)
const APP_LAYOUT = appPath('bedcode', 'desktop', 'src/components/AppLayout.vue')
/** 退役的应用自绘标题栏（品牌 + 最小化 / 最大化 / 关闭三键） */
const RETIRED_APP_TITLEBAR = appPath('bedcode', 'desktop', 'src/components/TitleBar.vue')
/** 独立终端窗口视图：它跑在宿主另开的窗口里，窗口 chrome（拖拽区 / 窗口控制）归它自己 */
const BARE_WINDOW_VIEW = 'TerminalWindowView.vue'

const read = (path: string): string => readFileSync(path, 'utf-8')

/** `<template>` 块内容（剔除 HTML 注释：注释里写标签名不算真实用法） */
function templateOf(source: string): string {
  const start = source.search(/<template[\s>]/)
  if (start === -1) return ''
  const rest = source.slice(start)
  const end = rest.search(/^<\/template>/m)
  const body = end === -1 ? rest : rest.slice(0, end)
  return body.replace(/<!--[\s\S]*?-->/g, '')
}

/** 递归收集某目录下指定后缀的源码（相对路径用 POSIX 分隔符） */
function collect(dir: string, suffix: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue
      collect(path, suffix, out)
    } else if (entry.name.endsWith(suffix)) {
      out.push(path.split('\\').join('/'))
    }
  }
  return out
}

const template = templateOf(read(HOST_SHELL))
/** 应用分支 = 模板里最后一个 `<template v-else>` 起（前一个是 `v-else-if="isSysPage"`） */
const appBranchAt = template.lastIndexOf('<template v-else>')
const appBranch = appBranchAt === -1 ? '' : template.slice(appBranchAt)
const sysBranch = appBranchAt === -1 ? template : template.slice(0, appBranchAt)

describe('L1 应用路由 = 壳标题栏 + 挂载槽（标题栏固定常驻）', () => {
  it('应用分支先渲染 ShellToolbar（bareWindow 例外），再渲染挂载槽', () => {
    expect(appBranchAt, 'ShellHost 模板里找不到应用分支 <template v-else>').toBeGreaterThan(-1)
    expect(appBranch, '应用分支必须渲染壳标题栏（wasm-app 不入侵标题栏）').toContain(
      '<ShellToolbar v-if="!isBareWindow" />',
    )
    const toolbarAt = appBranch.indexOf('<ShellToolbar')
    const slotAt = appBranch.indexOf('<AppMountSlot')
    expect(slotAt, '应用分支必须渲染应用挂载槽').toBeGreaterThan(-1)
    expect(toolbarAt, '标题栏必须排在挂载槽之前（应用只占其下方区域）').toBeLessThan(slotAt)
  })

  it('全仓无悬浮返回胶囊（系统页也用常驻标题栏，浮层会盖住页头图标）', () => {
    expect(appBranch).not.toContain('ShellReturnCapsule')
    expect(sysBranch, '系统页必须有壳标题栏（此前无标题栏、靠悬浮胶囊导航）').toContain(
      '<ShellToolbar v-if="!isBareWindow" />',
    )
    expect(sysBranch).not.toContain('ShellReturnCapsule')
    // 组件本体也应退役：留着就迟早被某个面按「悬浮导航」再挂回去
    expect(
      existsSync('src/shell/components/ShellReturnCapsule.vue'),
      'ShellReturnCapsule 已退役（导航统一归 ShellToolbar）',
    ).toBe(false)
  })
})

describe('L2 终端独立窗口（bareWindow）不套壳标题栏', () => {
  it('bareWindow 判据真实存在且门控标题栏', () => {
    const source = read(HOST_SHELL)
    expect(source).toContain("route.meta.bareWindow === true")
    expect(appBranch).toContain('v-if="!isBareWindow"')
  })
})

describe('L3 挂载槽只吃剩余高度（标题栏以下的剩余空间）', () => {
  it('槽规则用 flex: 1 1 0 + min-height: 0，且不写 height: 100%', () => {
    const src = read(MOUNT_SLOT)
    const block = src.match(/\.app-mount-slot\s*\{[^}]*\}/)
    expect(block, 'AppMountSlot 缺少 .app-mount-slot 布局规则').not.toBeNull()
    // 去注释再断言：注释里会提到被禁止的写法（说明为什么不能用）
    const rule = block![0].replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rule, '槽必须能收缩（flex-basis 0）').toMatch(/flex:\s*1 1 0/)
    expect(rule, '槽必须允许内部滚动（min-height: 0）').toMatch(/min-height:\s*0/)
    expect(rule, 'height: 100% 按壳根整高算，会让应用整体下沉标题栏高后被裁').not.toMatch(
      /height:\s*100%/,
    )
  })

  it('应用包根元素被槽拉满（cross-instance 元素靠 :deep 选择）', () => {
    const src = read(MOUNT_SLOT)
    expect(src).toMatch(/\.app-mount-slot\s*>\s*:deep\(\*\)\s*\{/)
  })
})

describe('L4 wasm-app 主界面不自绘标题栏', () => {
  it('应用侧 TitleBar 已退役', () => {
    expect(existsSync(RETIRED_APP_TITLEBAR), '应用自绘标题栏会入侵壳 chrome').toBe(false)
  })

  it('bedcode 布局不再引入 TitleBar，根容器用 h-full 而非 h-screen', () => {
    // 去注释再断言：注释里正解释「为什么不能写 h-screen」
    const layout = read(APP_LAYOUT)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(layout).not.toContain('TitleBar')
    expect(layout, '应用高度必须相对挂载槽（h-full），写 h-screen 会溢出槽底').toContain('h-full')
    expect(layout).not.toContain('h-screen')
  })

  it('除终端独立窗口外，应用视图不声明窗口拖拽区', () => {
    const files = DESKTOP_APPS.flatMap((root) => collect(root, '.vue'))
    expect(files.length, 'app 源码扫描面不得为空（否则本锁空转）').toBeGreaterThan(20)
    const offenders = files.filter(
      (file) =>
        read(file).includes('data-tauri-drag-region') && !file.includes(BARE_WINDOW_VIEW),
    )
    expect(offenders, `非独立窗口视图抢了窗格拖拽区：${offenders.join(', ')}`).toEqual([])
  })
})

describe('L5 挂载包样式不覆盖宿主 token', () => {
  it('各 app style.css 不在 :root 重定义 --bg-page / --text-primary', () => {
    const apps = DESKTOP_APPS.filter((root) => existsSync(root))
    expect(apps.length, 'app 目录扫描面不得为空').toBeGreaterThanOrEqual(3)

    const offenders: string[] = []
    for (const root of apps) {
      const path = join(root, 'src/style.css')
      if (!existsSync(path)) continue
      // 挂载包 CSS 由 JS 在宿主 style.css 之后注入：同特异性 :root 会赢，浅色主题被拖暗
      if (/^:root\s*\{[^}]*--(bg-page|text-primary)\s*:/ms.test(read(path))) offenders.push(path)
    }
    expect(offenders, `挂载包在 :root 覆盖宿主 token：${offenders.join(', ')}`).toEqual([])
  })
})
