/**
 * Dev Shell Vite 配置（桌面端 · 挂载包形态）
 *
 * 环境变量：
 *   WASMNEST_DEV_PLUGINS  逗号分隔的应用说明，每项 `<应用目录>[::<入口文件>]`
 *                         （由 `wasmnest-plugin-desktop dev` 注入；入口缺省时
 *                         本文件按挂载包约定解析，见 `resolveEntry`）
 *   WASMNEST_DEV_PORT     端口（缺省 5173，也可用 vite --port 覆盖）
 *
 * 两个关键接线：
 *
 * 1. **设计 token 单一真源**：monorepo 内 dev-shell 与宿主同仓，直接 alias 到宿主
 *    `src/style.css` 与 `src/shell/styles/shell.css`（跟随宿主更新，零维护）；
 *    npm 包内没有宿主，退回自带副本（`files` 白名单携带），副本与宿主的一致性
 *    由 `dev-shell/__tests__/visualParity.test.ts` 钉住。
 *
 * 2. **挂载包虚拟模块**：每个被调试应用注入两个模块——挂载包入口（`src/entry.ts`，
 *    导出 `mountApp`）与领域种子模块（`src/index.ts`，导出 `devMock`）。两者都
 *    由 vite 解析进构建图，改代码即 HMR。
 */
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEV_SHELL_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** 宿主前端源码根（wasmnest-desktop/src） */
const HOST_SRC = resolve(DEV_SHELL_ROOT, '../../../src')
/** 宿主壳样式目录（wasmnest-desktop/src/shell/styles） */
const HOST_SHELL_STYLES = resolve(HOST_SRC, 'shell/styles')
/** dev-shell 自带的样式副本（npm 包内使用） */
const BUNDLED_STYLES = resolve(DEV_SHELL_ROOT, 'src/styles')

/** 设计 token 目录：宿主在场 → 用宿主；否则用自带副本 */
const TOKEN_STYLE_DIR = existsSync(join(HOST_SRC, 'style.css')) ? HOST_SRC : BUNDLED_STYLES
/** 壳样式目录：同上 */
const SHELL_STYLE_DIR = existsSync(join(HOST_SHELL_STYLES, 'shell.css'))
  ? HOST_SHELL_STYLES
  : BUNDLED_STYLES

/** token 别名（入口以 `@wasmnest/desktop-styles/style.css` 形式引入） */
const TOKEN_STYLE_ALIAS = '@wasmnest/desktop-styles'
/** 壳样式别名 */
const SHELL_STYLE_ALIAS = '@wasmnest/desktop-shell-styles'

/** 单个被调试应用 */
export interface DevPluginSpec {
  /** 应用目录（绝对路径） */
  dir: string
  /** 挂载包入口（绝对路径）；缺省由 `resolveEntry` 按约定解析 */
  entry?: string
}

/**
 * 解析应用的挂载包入口
 *
 * 桌面 app 是**独立构建的挂载包**（机制 B）：入口 = `src/entry.ts`，导出
 * `mountApp(root, env)`。`src/index.ts` 是「dev-shell 兼容出口」（只导出
 * `devMock`）——它**不是**挂载入口，故优先取 `src/entry.ts`；两者都没有时返回
 * null（由装载器显性报错，不静默加载一个空模块）。
 */
export function resolveEntry(dir: string): string | null {
  const entry = resolve(dir, 'src/entry.ts')
  if (existsSync(entry)) return entry
  const legacy = resolve(dir, 'src/index.ts')
  if (existsSync(legacy)) return legacy
  return null
}

/** 解析 WASMNEST_DEV_PLUGINS 环境变量 */
export function parseDevPlugins(): DevPluginSpec[] {
  const raw = process.env.WASMNEST_DEV_PLUGINS
  if (!raw) return []
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [dir, entry] = item.split('::')
      const absDir = resolve(dir)
      return {
        dir: absDir,
        entry: entry ? resolve(dir, entry) : undefined,
      }
    })
}

/**
 * 虚拟模块：导出被调试应用列表
 *
 * 每项 `{ dir, manifest, entry, devMock }`：
 * - `entry` = 挂载包模块（`src/entry.ts`；缺失 = null）
 * - `devMock` = 领域种子模块（`src/index.ts`；缺失 = null；与 entry 同文件时复用）
 */
function devPluginsVirtual(plugins: DevPluginSpec[]): Plugin {
  const VIRTUAL_ID = 'virtual:dev-plugins'
  return {
    name: 'wasmnest-dev-shell:virtual-plugins',
    resolveId(id) {
      if (id === VIRTUAL_ID) return '\0' + VIRTUAL_ID
    },
    load(id) {
      if (id !== '\0' + VIRTUAL_ID) return
      if (plugins.length === 0) return 'export default []'
      const imports: string[] = []
      const records: string[] = []
      plugins.forEach((p, i) => {
        const manifestPath = resolve(p.dir, 'plugin.json')
        imports.push(`import manifest${i} from ${JSON.stringify(manifestPath)}`)
        const entryPath = p.entry ?? resolveEntry(p.dir)
        if (entryPath) {
          imports.push(`import * as entry${i} from ${JSON.stringify(entryPath)}`)
        }
        // 领域种子出口（app 自持演示数据）：与挂载入口同文件时复用同一模块。
        // 模块命名空间里取 `devMock` 导出才是**种子本身**（app 的 src/index.ts
        // 形如 `export const devMock = peerDevMock`）——直接把命名空间当种子传下去
        // 会让消费方读到 `{ devMock: {...} }` 而取不到字段。
        const entryExpr = entryPath ? `entry${i}` : 'null'
        const devMockPath = resolve(p.dir, 'src/index.ts')
        if (existsSync(devMockPath) && devMockPath !== entryPath) {
          imports.push(`import * as devmock${i} from ${JSON.stringify(devMockPath)}`)
        }
        const devMockExpr =
          existsSync(devMockPath) && devMockPath !== entryPath
            ? `(devmock${i}.devMock ?? null)`
            : entryPath === devMockPath
              ? `(entry${i}.devMock ?? null)`
              : 'null'
        records.push(
          `{ dir: ${JSON.stringify(p.dir)}, manifest: manifest${i}, entry: ${entryExpr}, devMock: ${devMockExpr} }`,
        )
      })
      return `${imports.join('\n')}\n\nexport default [\n  ${records.join(',\n  ')},\n]\n`
    },
  }
}

export default defineConfig(() => {
  const plugins = parseDevPlugins()

  // fs.allow：dev-shell 自身 + 宿主 token 目录 + 被调试应用目录
  // （file: SDK 依赖为软链，需放行真实路径）
  const allow = new Set<string>([DEV_SHELL_ROOT, TOKEN_STYLE_DIR, SHELL_STYLE_DIR])
  for (const p of plugins) {
    allow.add(p.dir)
    try {
      allow.add(realpathSync(p.dir))
    } catch {
      // 目录不存在时 vite 会给出更明确的错误，此处仅尽力放行
    }
  }

  return {
    plugins: [vue(), devPluginsVirtual(plugins)],
    resolve: {
      // 强制应用源码与 dev-shell 共用同一份 vue 实例（provide/inject、响应式共享依赖它）
      dedupe: ['vue', 'vue-i18n', 'pinia', 'vue-router'],
      alias: {
        [TOKEN_STYLE_ALIAS]: TOKEN_STYLE_DIR,
        [SHELL_STYLE_ALIAS]: SHELL_STYLE_DIR,
      },
    },
    // main.ts 使用 top-level await 串行初始化 → 装载应用 → 挂载
    build: {
      target: 'esnext',
    },
    server: {
      port: Number(process.env.WASMNEST_DEV_PORT || 5173),
      fs: { allow: [...allow] },
    },
  }
})
