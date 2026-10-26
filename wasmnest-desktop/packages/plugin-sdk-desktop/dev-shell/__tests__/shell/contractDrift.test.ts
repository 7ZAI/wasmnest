/**
 * @vitest-environment node
 *
 * 挂载契约漂移锁（dev-shell ↔ 桌面宿主）
 * -----------------------------------------------------------------------------
 * dev-shell 走的是**与宿主同一条装载路径**：app 的 `src/entry.ts` 导出
 * `mountApp(root, env)`，dev-shell 的挂载槽按同一份契约调用它。
 *
 * 契约声明因此有**三份**：宿主 `src/shell/mount/useAppMount.ts`、各 app 自己的
 * `src/entry.ts`、dev-shell `src/shell/types.ts`。三者之间没有编译期约束——
 * 只能靠这道锁：任何一份改了而另两份没跟上时，开发者会在预览里遇到与真机
 * 不同的行为（某个字段静默 undefined），而这恰恰是 dev-shell 唯一不该发生的事。
 *
 * 比对对象：
 *   · AppMountEnv / AppMountHandle / AppPreviewEnv / AppPreviewHandle 字段集
 *   · AppBundleModule 字段集（挂载包模块面：mountApp 必有 / mountPreview 可选）
 *
 * 宿主源码不在场时（npm 包内的 dev-shell）整组跳过：没有可比对象，跳过比
 * 「假装通过」诚实——真正的门禁在 monorepo 内跑。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** dev-shell/__tests__/shell → 仓库内桌面宿主：wasmnest-desktop */
const HOST_ROOT = resolve(here, '../../../../..')
/** 宿主挂载契约真源 */
const HOST_MOUNT_PATH = resolve(HOST_ROOT, 'src/shell/mount/useAppMount.ts')
/** dev-shell 侧的契约声明 */
const LOCAL_TYPES_PATH = resolve(here, '../../src/shell/types.ts')

const hostPresent = existsSync(HOST_MOUNT_PATH)
const describeIfHostPresent = hostPresent ? describe : describe.skip

const hostSource = hostPresent ? readFileSync(HOST_MOUNT_PATH, 'utf-8') : ''
const localSource = readFileSync(LOCAL_TYPES_PATH, 'utf-8')

/**
 * 提取 interface 体的一级字段名
 *
 * 用源码文本而非 TS 反射：宿主 useAppMount.ts 只 import 了类型（会被擦除），
 * 但它不在本包的依赖图里，按路径 import 会把整个宿主拖进 vitest 依赖图——
 * 文本比对既轻又不会误伤构建。
 */
function fieldsOf(source: string, name: string): string[] {
  const start = source.indexOf(`interface ${name} `)
  if (start < 0) throw new Error(`interface ${name} not found`)
  const open = source.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = source.slice(open + 1, end)
  return [...body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)(\?)?:/gm)].map((m) => m[1])
}

describeIfHostPresent('挂载契约与宿主一致', () => {
  it.each([
    'AppMountEnv',
    'AppMountHandle',
    'AppPreviewEnv',
    'AppPreviewHandle',
    'AppBundleModule',
  ])('should_matchHostFields_when_%sCompared', (name) => {
    const host = fieldsOf(hostSource, name)
    const local = fieldsOf(localSource, name)

    // 宿主新增字段而 dev-shell 没跟 → app 在真机拿到值、在预览里是 undefined；
    // 本地多出的字段同样测红——多出来的字段在真机上根本不存在。
    expect([...local].sort()).toEqual([...host].sort())
  })
})

describeIfHostPresent('退役的贡献面不回接', () => {
  it('should_notContainRetiredContributionApi_when_devShellSourceScanned', () => {
    // 桌面宿主已改「同窗口全屏挂载独立构建的 app 整包」（机制 B）：贡献面注册
    // （侧边栏面板 / 工具箱页 / 标题栏项 / 状态栏项…）整面退役，app 不再注册、
    // 宿主也不再消费。dev-shell 若把这些名字写回来，就是把退役形态复活成
    // 「看起来能用」的死面——比直接删掉更坏。
    const retired = [
      'registerSidebarPanel',
      'registerToolboxPage',
      'registerTitleBarItem',
      'registerStatusBarItem',
      'registerInputExtension',
      'registerTerminalToolbarItem',
      'registerPageToolbarItem',
      'registerFileHandler',
      'registerSettingsSection',
    ]
    const devShellSrc = resolve(here, '../../src')
    // 递归读 dev-shell 源码（锁只扫 dev-shell，不扫 SDK 与宿主）
    const files = collectFiles(devShellSrc, /\.(ts|vue)$/)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      // 只看**代码**：文档注释里提到这些名字是在说明「它退役了」，那是允许的
      const source = stripComments(readFileSync(file, 'utf-8'))
      for (const name of retired) {
        expect(source, `${file} 仍引用退役的贡献面 API：${name}`).not.toContain(name)
      }
    }
  })
})

/** 去掉注释（行注释 + 块注释） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 递归收集目录下的源码文件（跳过 node_modules / dist） */
function collectFiles(dir: string, filter: RegExp): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const full = resolve(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectFiles(full, filter))
    else if (filter.test(name)) out.push(full)
  }
  return out
}
