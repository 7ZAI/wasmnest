/**
 * 旧宿主 UI 退役面防回接锁（票 2026-10-09 阶段 B）
 * -----------------------------------------------------------------------------
 * 目的：旧前端宿主（MobileSwipeContainer 四页 + /mobile/** views + 旧嵌入面）退役后，
 * 钉死「不回接」——宿主 src/ 内不得再出现退役路由名 / 退役视图·组件符号。
 *
 * 与 ESLint 的分工：本锁是**测试期门禁**（`pnpm run test:run` 必跑），覆盖整个 src/
 * （含测试文件），不受 eslint ignores 影响，防止把退役面悄悄接回。
 *
 * 两把锁 + 一道正面钉：
 *   R1 退役路由名（mobile-devices / mobile-sessions / mobile-terminal / mobile-toolbox /
 *      mobile-preset-tasks / mobile-plugins / mobile-home-alt）不得以字符串字面量出现。
 *      —— 路由名带引号锁定，避免误伤 `--mobile-terminal-bg` 这类 CSS 变量子串。
 *   R2 退役视图 / 组件符号（MobileSwipeContainer / MobileNav / MobileLayout / MobileStatusBar /
 *      DevicesView / SessionsView / ToolboxView / PluginView / SettingsView / PresetTasksView /
 *      TerminalView / registerSettingsSection）不得以词边界符号出现。
 *      —— 词边界保证不误伤仍在服役的合法面：`PluginViewHost` /
 *      `registerTerminalView` / `TerminalViewContribution` 等均不含词边界匹配。
 *   R3 壳等价物正面在场（ShellView / ShellHost / ShellNotificationShade /
 *      ShellSettingsScreen + 路由 mobile-shell）——防「把新面也删掉」绕过退役锁（删空则 R1/R2 恒真）。
 *      （2026-10-14 Android 平台化：旧底部页签 ShellTabbar 被底部系统条 ShellSystemBar 取代。
 *      2026-10-14 二改：底部系统条整条退役——常驻导航条占掉一截应用可视高度且与
 *      Android 系统手势条重复；导航入口改为各非根屏页头返回 + 应用运行页胶囊
 *      （多任务 / 回主屏），ShellSystemBar 入 RETIRED_SYMBOLS 不回接。）
 *   R4 票 2026-10-10 批次 C1/C2/C4 退役面：旧嵌入扩展点（registerToolboxPage /
 *      registerNavTab / registerTerminalToolbarItem / registerTerminalView）及其
 *      宿主 UI 组件（PluginNavTabHost / PluginSettingsHost / PluginTerminalBar）与
 *      `mobile-settings-notifications` 路由不得回接；运行面解析不得再有回退链。
 *      —— 锁的是**调用面**而非单个文件：只要 src/ 里再出现任一退役符号即红。
 *   R5 票 2026-10-10 批次 D1 删除的孤儿组件 / composable 不得被重新接回宿主。
 *   R6 #24 死码批次（2026-10-24）删除的死路由视图 / 路由名 / 孤儿组件不得回接：
 *      文件浏览器全屏页（CodeExplorerView，路由 mobile-files）与三张业务设置子页
 *      （connection / authentication / egress——零导航源，业务真源已按票 2026-10-10 C4
 *      下沉 bedcode 应用）+ 五个零消费者孤儿 UI 组件 + components/index.ts 桶导出
 *      （零 import，且引用三个早已不存在的 Terminal 组件）。
 *   R7 #24 §4.2 迁移批次（2026-10-24）：宿主提供组件五件套（FileExplorer / FileSidebar /
 *      FileViewerModal / CodeViewerSettingsModal / codeViewer store）连同闭包随唯一
 *      消费者 bedcode 迁入应用仓 fileExplorer 域；provide 契约 wasmnestHostComponents
 *      整面退役，宿主侧文件不在场 + 契约符号不回接双钉。
 *   R8 应用设置贡献面退役（2026-10-25 用户裁决：宿主设置页不再陈列应用项，设置一律
 *      应用自持）：registerSettingsEntry 注册 API（壳 registry / 壳公共入口 / 插件
 *      context.ui 三落点）与 ShellSettingsEntry 类型整面删除，不得回接。桌面端的
 *      同名扩展点是另一套机制（wasmnest-desktop），不在本锁范围。
 *
 * 扫描一律跳过注释行：注释里出现退役字面量（如「旧宿主 MobileLayout 退役后……」）不应
 * 判违规——否则说明文字自身会触发红，还会诱导删注释。
 *
 * 例外（票 2026-10-10 C2）：`src/plugin/context.ts` 保留了四个退役扩展点的**显性抛错桩**
 * （§5.1.3 fail-visible 形态①，旧插件调用时当场指名报错而不是 undefined 调用崩在插件里）。
 * 那是退役面的一部分而非回接，故按文件白名单排除——排除名单是显式的，
 * 新增文件不会自动被放过。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC_DIR = join(process.cwd(), 'src')

/** 扫描到的源码文件（相对路径，POSIX 分隔符，便于断言信息可读） */
function collectFiles(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectFiles(full, exts))
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(relative(process.cwd(), full).split('\\').join('/'))
    }
  }
  return out
}

/** 去掉块注释 / 行注释 / HTML 注释，返回「可执行文本」用于扫描 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // 行注释：排除 `://`（协议）与 `"//"`（字符串里的双斜杠），只删真实注释
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, '$1')
}

/** 违规详情：文件名 + 命中文本，失败信息能直接定位 */
function scan(pattern: RegExp, files: string[]): string[] {
  const hits: string[] = []
  for (const file of files) {
    const text = stripComments(readFileSync(join(process.cwd(), file), 'utf8'))
    const match = text.match(pattern)
    if (match) hits.push(`${file} → ${match[0].trim().slice(0, 80)}`)
  }
  return hits
}

// 排除锁文件自身：被锁符号清单的定义就含这些字面量，扫到自己会自指红。
/**
 * 允许包含退役符号的文件（逐条登记，不做通配）
 *
 * `src/plugin/context.ts`：C2 的 fail-visible 抛错桩，见本文件头注「例外」。
 * `src/__tests__/plugin/pluginContextShell.test.ts`：钉死抛错桩行为的用例。
 * `src/__tests__/shell/shellSettingsScreen.test.ts`：钉死「通知入口不得回接」的反向断言。
 */
const R4_ALLOWED_FILES = [
  'src/plugin/context.ts',
  'src/__tests__/plugin/pluginContextShell.test.ts',
  'src/__tests__/shell/shellSettingsScreen.test.ts',
]

const SRC_CODE_FILES = collectFiles(SRC_DIR, ['.ts', '.vue']).filter(
  (f) => !f.endsWith('retiredHostUIRetirementLocks.test.ts'),
)

/** 退役路由名（旧 vue-router 的 name）：带引号锁定，防误伤 CSS 变量子串 */
const RETIRED_ROUTE_NAMES = [
  'mobile-devices',
  'mobile-sessions',
  'mobile-terminal',
  'mobile-toolbox',
  'mobile-preset-tasks',
  'mobile-plugins',
  'mobile-home-alt',
]

/** 退役视图 / 组件符号：词边界锁定（`PluginViewHost` 等服役面不误伤） */
const RETIRED_SYMBOLS = [
  'MobileSwipeContainer',
  'MobileNav',
  'MobileLayout',
  'MobileStatusBar',
  'DevicesView',
  'SessionsView',
  'ToolboxView',
  'PluginView',
  'SettingsView',
  'PresetTasksView',
  'TerminalView',
  'registerSettingsSection',
  // 2026-10-14 二改：底部系统条退役（入口收进各屏页头 + 应用运行页胶囊）
  'ShellSystemBar',
  // 2026-10-25 R8：应用设置贡献面退役（宿主设置页只陈列平台项，设置归应用自持）
  'registerSettingsEntry',
  'ShellSettingsEntry',
]

/** 票 2026-10-10 C1/C2/C4 退役的旧嵌入扩展点与其宿主 UI 组件 */
const RETIRED_EXTENSION_POINTS = [
  'registerToolboxPage',
  'registerNavTab',
  'registerTerminalToolbarItem',
  'registerTerminalView',
  'PluginNavTabHost',
  'PluginSettingsHost',
  'PluginTerminalBar',
]

/** 票 2026-10-10 C4 退役的设置路由（整页皆业务项，已下沉 bedcode 应用） */
const RETIRED_C4_ROUTES = ['mobile-settings-notifications', 'NotificationSettingsView']

/** 票 2026-10-10 D1 从宿主删除的孤儿（各自在 wasm-apps 下有自持副本） */
const RETIRED_ORPHANS = [
  'DeviceCard',
  'SessionListItem',
  'useAndroidFeatures',
  'useRunTime',
]

/** #24 死码批次（2026-10-24）退役的路由名（带引号锁定，口径同 R1） */
const RETIRED_24_ROUTE_NAMES = [
  'mobile-files',
  'mobile-settings-connection',
  'mobile-settings-authentication',
  'mobile-settings-egress',
]

/** #24 死码批次退役的视图符号（词边界锁定，口径同 R2） */
const RETIRED_24_VIEW_SYMBOLS = [
  'CodeExplorerView',
  'ConnectionSettingsView',
  'AuthenticationSettingsView',
  'EgressSettingsView',
]

/**
 * #24 死码批次从磁盘删除的文件（路径级不在场钉死，口径同 R5 的 should_notExistOnDisk）。
 *
 * 五个孤儿组件只做路径级断言、不做符号扫描：壳 UI 库（`src/shell/components/ui/`）
 * 存在**同名活组件**（CollapseSection / LetterAvatar / LoadingDialog / QuickActionButton
 * 均由壳自持实现），裸符号词边界扫描会误伤在役面——这正是「宁窄勿宽」的取舍，
 * 防回接由路径断言承担。`components/index.ts` 同批删除（零 import 的死桶导出）。
 */
const RETIRED_24_FILES = [
  'src/views/CodeExplorerView.vue',
  'src/views/settings/ConnectionSettingsView.vue',
  'src/views/settings/AuthenticationSettingsView.vue',
  'src/views/settings/EgressSettingsView.vue',
  'src/components/BottomSheet.vue',
  'src/components/CollapseSection.vue',
  'src/components/LetterAvatar.vue',
  'src/components/LoadingDialog.vue',
  'src/components/QuickActionButton.vue',
  'src/components/index.ts',
]

/**
 * R6 符号扫描的显性豁免（逐条登记，不做通配，口径同 R4_ALLOWED_FILES）：
 * - `src/__tests__/composables/useLinkEncryption.test.ts`：票 06 结构锁以路径字符串
 *   断言 ConnectionSettingsView 不在场（R6 批次把「页内不渲染」升级为「文件已删」），
 *   路径里含退役符号属记账而非回接。
 */
const R6_ALLOWED_FILES = ['src/__tests__/composables/useLinkEncryption.test.ts']

/**
 * R7（issue #24 host-exceptions §4.2 FileExplorer 行）宿主提供组件五件套迁移退役面：
 * FileExplorer / FileSidebar / FileViewerModal / CodeViewerSettingsModal / codeViewer
 * store 随唯一消费者 bedcode 迁入应用仓（`apps/bedcode/mobile/src/fileExplorer/`），
 * 连同仅为其存活的闭包（FileTreeItem / 3 个文件域 icon / useFileTree / useCodeHighlight /
 * useSwipeTabs / clipboard / themeLabel）一并自宿主删除；provide 契约
 * `wasmnestHostComponents` 同步整面退役（App.vue 不再 provide，应用侧直接 import）。
 * 路径级不在场 + 契约符号不回接双钉；应用侧承接为跨仓事实，本锁只钉宿主侧。
 */
const RETIRED_HOST_PROVIDED_FILES = [
  'src/components/FileExplorer.vue',
  'src/components/FileSidebar.vue',
  'src/components/FileViewerModal.vue',
  'src/components/CodeViewerSettingsModal.vue',
  'src/components/FileTreeItem.vue',
  'src/components/icons/FolderOpenIcon.vue',
  'src/components/icons/FolderClosedIcon.vue',
  'src/components/icons/FileIcon.vue',
  'src/stores/codeViewer.ts',
  'src/composables/useFileTree.ts',
  'src/composables/useCodeHighlight.ts',
  'src/composables/useSwipeTabs.ts',
  'src/utils/clipboard.ts',
  'src/utils/themeLabel.ts',
]

/** R7 退役契约符号：provide/inject 键（宿主不再提供，应用侧不再注入） */
const RETIRED_HOST_PROVIDED_SYMBOLS = ['wasmnestHostComponents']

/** 壳等价物：退役面的正面替代——缺件即红，防「删新面绕过退役锁」 */
const REQUIRED_SHELL_FILES = [
  'src/shell/views/ShellView.vue',
  'src/shell/components/ShellHost.vue',
  'src/shell/components/ShellNotificationShade.vue',
  'src/shell/components/screens/ShellSettingsScreen.vue',
]

describe('R1 退役路由名不回接', () => {
  it('should_haveSourceToScan_when_lockRuns', () => {
    // 守卫：目录为空 / 路径写错时本锁会全部恒真，先证明扫描集非空
    expect(SRC_CODE_FILES.length).toBeGreaterThan(80)
  })

  it('should_notContainRetiredRouteNames_when_srcScanned', () => {
    const pattern = new RegExp(`['"](${RETIRED_ROUTE_NAMES.join('|')})['"]`)
    const hits = scan(pattern, SRC_CODE_FILES)
    expect(hits).toEqual([])
  })
})

describe('R2 退役视图 / 组件符号不回接', () => {
  it('should_notContainRetiredSymbols_when_srcScanned', () => {
    const pattern = new RegExp(`\\b(${RETIRED_SYMBOLS.join('|')})\\b`)
    const hits = scan(pattern, SRC_CODE_FILES)
    expect(hits).toEqual([])
  })
})

describe('R4 旧嵌入扩展点与其宿主 UI 组件不回接（票 2026-10-10 C1/C2）', () => {
  it('should_notContainRetiredExtensionPoints_when_srcScanned', () => {
    const files = SRC_CODE_FILES.filter((f) => !R4_ALLOWED_FILES.includes(f))
    const hits = scan(new RegExp(`\\b(${RETIRED_EXTENSION_POINTS.join('|')})\\b`), files)
    expect(hits).toEqual([])
  })

  it('should_keepOnlySurfaceFallback_when_run', () => {
    // 运行面解析的正路：只认 registerSurface。回退链是「壳用旧宿主插件形式加载页面」
    // 的实际代码，删掉后这里钉住它不再以任何形式回来。
    const adapter = readFileSync(join(process.cwd(), 'src/shell/adapters/pluginAppSource.ts'), 'utf8')
    expect(stripComments(adapter)).not.toMatch(/toolboxViews|navTabs|terminalView\b/)
  })
})

describe('R4b 已下沉业务设置路由不回接（票 2026-10-10 C4）', () => {
  it('should_notContainRetiredC4SettingsRoutes_when_srcScanned', () => {
    const files = SRC_CODE_FILES.filter((f) => !R4_ALLOWED_FILES.includes(f))
    const hits = scan(new RegExp(`(${RETIRED_C4_ROUTES.join('|')})`), files)
    expect(hits).toEqual([])
  })
})

describe('R5 已删除的宿主孤儿组件不得回接（票 2026-10-10 D1）', () => {
  it('should_notContainRetiredOrphans_when_srcScanned', () => {
    const hits = scan(new RegExp(`\\b(${RETIRED_ORPHANS.join('|')})\\b`), SRC_CODE_FILES)
    expect(hits).toEqual([])
  })

  it('should_notExistOnDisk_when_orphansRetired', () => {
    for (const file of [
      'src/components/DeviceCard.vue',
      'src/components/SessionListItem.vue',
      'src/composables/useAndroidFeatures.ts',
      'src/composables/useRunTime.ts',
    ]) {
      expect(existsSync(join(process.cwd(), file)), `${file} 应已删除`).toBe(false)
    }
  })
})

describe('R6 #24 死码批次：死路由视图 / 路由名 / 孤儿组件不回接', () => {
  it('should_notContainRetired24RouteNames_when_srcScanned', () => {
    const pattern = new RegExp(`['"](${RETIRED_24_ROUTE_NAMES.join('|')})['"]`)
    const hits = scan(pattern, SRC_CODE_FILES)
    expect(hits).toEqual([])
  })

  it('should_notContainRetired24ViewSymbols_when_srcScanned', () => {
    const files = SRC_CODE_FILES.filter((f) => !R6_ALLOWED_FILES.includes(f))
    const hits = scan(new RegExp(`\\b(${RETIRED_24_VIEW_SYMBOLS.join('|')})\\b`), files)
    expect(hits).toEqual([])
  })

  it('should_notExistOnDisk_when_retired24FilesDeleted', () => {
    for (const file of RETIRED_24_FILES) {
      expect(existsSync(join(process.cwd(), file)), `${file} 应已删除（#24 死码批次）`).toBe(false)
    }
  })
})

describe('R7 #24 §4.2 迁移批次：宿主提供组件五件套不回接', () => {
  it('should_notExistOnDisk_when_hostProvidedComponentsMigrated', () => {
    for (const file of RETIRED_HOST_PROVIDED_FILES) {
      expect(
        existsSync(join(process.cwd(), file)),
        `${file} 应已删除（随唯一消费者 bedcode 迁应用仓，见 docs/host-exceptions.md §4.2）`,
      ).toBe(false)
    }
  })

  it('should_notContainHostProvidedContractSymbol_when_srcScanned', () => {
    const hits = scan(
      new RegExp(`['"](${RETIRED_HOST_PROVIDED_SYMBOLS.join('|')})['"]`),
      SRC_CODE_FILES,
    )
    expect(hits).toEqual([])
  })
})

describe('R3 壳等价物在场（正面钉）', () => {
  it('should_keepShellEquivalentsPresent_when_lockRuns', () => {
    for (const file of REQUIRED_SHELL_FILES) {
      expect(existsSync(join(process.cwd(), file)), `${file} 应存在（旧宿主的壳内等价面）`).toBe(
        true,
      )
    }
    const router = readFileSync(join(process.cwd(), 'src/router/index.ts'), 'utf8')
    expect(router, '壳默认路由 mobile-shell 应在 router 在场').toContain('mobile-shell')
  })

  it('should_notExistOnDisk_when_systemBarRetired', () => {
    // 2026-10-14 二改：底部系统条已整条退役，文件不得回到磁盘（符号另由 R2 锁死）
    expect(
      existsSync(join(process.cwd(), 'src/shell/components/ShellSystemBar.vue')),
      '底部系统条应已删除（导航改由各屏页头与应用运行页胶囊承担）',
    ).toBe(false)
  })
})
