/**
 * 宿主 / 应用边界锁（桌面 UI 宿主修正 2026-10-17）
 *
 * 新形态：宿主壳（wasmnest-desktop/src/）与各 wasm app 前端（独立挂载包）是
 * **运行时装载**关系（useAppMount + mountApp 契约），禁止构建期源码耦合：
 * - L1 宿主前端源码零 `wasm-apps/` 相对引用（不得 import app 源码树——跨仓
 *   拆分的构建期耦合源；AppMountSlot 只按资源约定运行时装载产物）；
 * - L2 宿主前端零 `__WASMNEST_SHARED__`（外部化机制不复活）；
 * - L3 mountApp 契约 drift：宿主 useAppMount 声明的 AppMountEnv/AppMountHandle
 *   与各 app entry.ts 的契约同形（关键字段在场），防止单侧改写契约静默断裂；
 * - L4 宿主树零 `registerSidebarPanel`（旧贡献面不复活）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { appPath } from './support/appPaths'

const HOST_SRC = join(process.cwd(), 'src')

/** 宿主前端源码清单（剔除测试自身与 node_modules/dist） */
function hostSources(): string[] {
  const out: string[] = []
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|vue)$/.test(entry.name)) out.push(full)
    }
  }
  walk(HOST_SRC)
  return out
}

/** 四个桌面 wasm app 的 entry.ts（契约 drift 检查对象；三仓拆分 §5-E7 住应用仓） */
const APP_ENTRIES = ['agent-hub', 'ai-chatbox', 'file-transfer', 'bedcode'].map((slug) =>
  appPath(slug, 'desktop', 'src/entry.ts'),
)

/** 剔除注释（needle 只约束可执行代码） */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('宿主 / 应用边界锁', () => {
  it('L1 宿主前端零 wasm-apps 源码引用（构建期耦合不复活）', () => {
    const offenders = hostSources().filter((f) => {
      const code = stripComments(readFileSync(f, 'utf-8'))
      // 应用源码自三仓拆分起住应用仓：除相对路径形态外，`@apps` 测试别名同样禁止
      // 进入宿主构建代码（它只是测试期 resolver）
      return /from\s+['"]\.{2}\/wasm-apps|from\s+['"]\.{3}\/wasm-apps|['"]\.\.\/\.\.\/wasm-apps|from\s+['"]@apps\//.test(
        code,
      )
    })
    expect(offenders, '宿主不得 import app 源码树（运行时装载，见 useAppMount）').toEqual([])
  })

  it('L2 宿主前端零 __WASMNEST_SHARED__（外部化机制不复活）', () => {
    const offenders = hostSources().filter((f) => readFileSync(f, 'utf-8').includes('__WASMNEST_SHARED__'))
    expect(offenders, '宿主不得依赖/声明共享运行时全局').toEqual([])
  })

  it('L4 宿主前端零 registerSidebarPanel（贡献面不复活）', () => {
    const offenders = hostSources().filter((f) => stripComments(readFileSync(f, 'utf-8')).includes('registerSidebarPanel'))
    expect(offenders, '宿主不得回接旧贡献面注册').toEqual([])
  })

  it('L3 各 app entry.ts 导出 mountApp 契约（宿主 useAppMount 装载面）', () => {
    expect(APP_ENTRIES.length, 'app 清单不得为空（否则本锁空转）').toBe(4)
    for (const entry of APP_ENTRIES) {
      expect(existsSync(entry), `${entry} 缺失（app 前端必须可装载）`).toBe(true)
      const code = stripComments(readFileSync(entry, 'utf-8'))
      expect(code, `${entry} 必须导出 mountApp`).toContain('export async function mountApp(')
      expect(code, `${entry} 必须调用 app.mount(root)`).toContain('app.mount(root)')
      // 契约关键面：命令 / 存储 / 语言 / 初始路由
      for (const needle of ['appInvoke', 'appStorageGet', 'locale', 'initialRoute']) {
        expect(code, `${entry} 契约缺 ${needle}`).toContain(needle)
      }
    }
  })
})
