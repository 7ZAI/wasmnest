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
 * - L4 宿主树零 `registerSidebarPanel`（旧贡献面不复活）；
 * - L5 多任务卡缩略区改真实实例（2026-10-30 用户裁决）：应用自绘预览契约
 *   （`mountPreview` / `AppPreviewTile`）退役，不得回接；卡片由宿主把保活实例
 *   搬进卡片渲染，路径不得换发通道令牌 / 写存储（复用主实例身份）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { appPath, projectPath } from './support/appPaths'

const HOST_SRC = join(process.cwd(), 'src')

/** 宿主前端源码清单（剔除测试自身与 node_modules/dist） */
function hostSources(): string[] {
  const out: string[] = []
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist')
        continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|vue)$/.test(entry.name)) out.push(full)
    }
  }
  walk(HOST_SRC)
  return out
}

/**
 * 桌面 wasm app 的 entry.ts（契约 drift 检查对象；三仓拆分 §5-E7 住应用仓）
 *
 * 四个 L3 产品应用住 `apps/`；认证中心与 monitor（服务型 wasm：L1 基础服务 /
 * L2 内部业务，随宿主分发）住 `servers/`。
 */
const APP_ENTRIES = [
  ...['ai-chatbox', 'file-transfer', 'bedcode'].map((slug) =>
    appPath(slug, 'desktop', 'src/entry.ts'),
  ),
  projectPath('servers', 'auth-center', 'desktop', 'src/entry.ts'),
  projectPath('servers', 'monitor', 'desktop', 'src/entry.ts'),
]

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
    const offenders = hostSources().filter((f) =>
      readFileSync(f, 'utf-8').includes('__WASMNEST_SHARED__'),
    )
    expect(offenders, '宿主不得依赖/声明共享运行时全局').toEqual([])
  })

  it('L4 宿主前端零 registerSidebarPanel（贡献面不复活）', () => {
    const offenders = hostSources().filter((f) =>
      stripComments(readFileSync(f, 'utf-8')).includes('registerSidebarPanel'),
    )
    expect(offenders, '宿主不得回接旧贡献面注册').toEqual([])
  })

  it('L3 各 app entry.ts 导出 mountApp 契约（宿主 useAppMount 装载面）', () => {
    expect(APP_ENTRIES.length, 'app 清单不得为空（否则本锁空转）').toBe(5)
    for (const entry of APP_ENTRIES) {
      expect(existsSync(entry), `${entry} 缺失（app 前端必须可装载）`).toBe(true)
      const code = stripComments(readFileSync(entry, 'utf-8'))
      expect(code, `${entry} 必须导出 mountApp`).toContain('export async function mountApp(')
      expect(code, `${entry} 必须调用 app.mount(root)`).toContain('app.mount(root)')
      // 契约关键面：命令 / 存储 / 语言 / 初始路由
      for (const needle of ['appInvoke', 'appStorageGet', 'locale', 'initialRoute']) {
        expect(code, `${entry} 契约缺 ${needle}`).toContain(needle)
      }
      // 契约版本：宿主装载时按 MOUNT_CONTRACT 比对（分发化后版本不再天然一致，
      // 见 CONTRACT.md §6 / §7：不匹配 = 显性报错，不白屏）
      expect(code, `${entry} AppMountEnv 必须声明 mountContract`).toContain('mountContract: string')
      expect(code, `${entry} 必须导出 mountContract = '1'`).toContain(
        "export const mountContract = '1'",
      )
    }
  })

  it('L3 宿主声明 MOUNT_CONTRACT，且在动态 import 后、创建 app 前校验', () => {
    const mount = stripComments(readFileSync(join(HOST_SRC, 'shell/mount/useAppMount.ts'), 'utf-8'))
    expect(mount, "宿主必须导出 MOUNT_CONTRACT = '1'").toContain(
      "export const MOUNT_CONTRACT = '1'",
    )
    expect(mount, 'AppMountEnv 必须带 mountContract 字段').toContain('mountContract: string')
    expect(mount, '挂载包模块面必须声明 mountContract').toContain('mountContract?: string')
    // 校验必须在装载模块之后、调用 mountApp 之前（fail-visible，不静默挂空包）
    expect(mount, '装载后必须校验 bundle 的 mountContract').toMatch(
      /assertMountContract\(\s*appId\s*,\s*module\.mountContract\s*\)/,
    )
    expect(mount.indexOf('assertMountContract(appId')).toBeLessThan(
      mount.indexOf('module.mountApp('),
    )
  })

  it('L5 应用自绘预览契约退役：宿主不再声明 / 装载 mountPreview，卡片走真实实例', () => {
    const mount = stripComments(readFileSync(join(HOST_SRC, 'shell/mount/useAppMount.ts'), 'utf-8'))
    expect(mount, '宿主不得再声明自绘预览契约').not.toContain('mountPreview')
    expect(
      existsSync(join(HOST_SRC, 'shell/mount/AppPreviewTile.vue')),
      '自绘预览组件退役（卡片 = 真实实例）',
    ).toBe(false)

    // 全树扫描：任何宿主源码回接 mountPreview 都是半截回滚
    const offenders = hostSources().filter((f) =>
      stripComments(readFileSync(f, 'utf-8')).includes('mountPreview'),
    )
    expect(offenders, '宿主源码不得回接 mountPreview').toEqual([])

    const switcher = stripComments(
      readFileSync(join(HOST_SRC, 'shell/components/ShellTaskSwitcher.vue'), 'utf-8'),
    )
    expect(switcher, 'app 卡必须挂真实实例容器').toContain('AppSurfaceTile')
  })

  it('L5 卡片搬运路径不换发通道令牌、不写 / 删存储（复用主实例身份）', () => {
    // 卡片路径 = 实例搬运组件 + 多任务层；主挂载槽不在此列
    const previewFiles = [
      join(HOST_SRC, 'shell/mount/AppSurfaceTile.vue'),
      join(HOST_SRC, 'shell/components/ShellTaskSwitcher.vue'),
    ]
    for (const file of previewFiles) {
      expect(existsSync(file), `${file} 缺失（卡片接线不得被静默移除）`).toBe(true)
      const code = stripComments(readFileSync(file, 'utf-8'))
      expect(code, `${file} 卡片路径不得换发通道令牌`).not.toContain('refreshChannelToken')
      expect(code, `${file} 卡片路径不得写存储`).not.toContain('appStorageSet')
      expect(code, `${file} 卡片路径不得删存储`).not.toContain('appStorageDelete')
    }
  })
})
