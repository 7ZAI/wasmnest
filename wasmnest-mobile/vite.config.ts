import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { readFileSync, rmSync } from 'fs'

const host = process.env.TAURI_DEV_HOST

// 从 tauri.conf.json 读取应用版本（作为版本号的唯一来源）
const tauriConfPath = resolve(__dirname, 'src-tauri/tauri.conf.json')
let tauriConf: { version?: string }
try {
  tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'))
} catch (err) {
  throw new Error(
    `[vite] 读取 tauri.conf.json 失败（应用版本号唯一来源，无法注入 __APP_VERSION__）: ${err instanceof Error ? err.message : String(err)}`,
  )
}
const appVersion = tauriConf.version || '0.0.0'

// ==================== 构建时排除 dev-only 审查工具 ====================
// public/mock-harness.html 仅用于 dev server 纯前端 UI 审查（见 .scratch/mobile-ui-review/spec.md），
// 不允许进入生产构建产物。public 文件由 vite copyPublicDir 在 writeBundle 阶段复制（不经 rollup bundle，
// generateBundle 中删除无效），故在 writeBundle 后删除。
const excludeDevOnlyPublicAssets: Plugin = {
  name: 'wasmnest:exclude-dev-only-public',
  apply: 'build',
  writeBundle() {
    rmSync(resolve(__dirname, 'dist', 'mock-harness.html'), { force: true })
  },
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue(), excludeDevOnlyPublicAssets],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    host: host ? '0.0.0.0' : '0.0.0.0',
    port: 1423,
    strictPort: true,
    watch: {
      // 排除巨型构建目录，避免 chokidar 扫描/监听数万文件霸占事件循环导致请求挂起
      ignored: [
        '**/src-tauri/target/**',
        '**/src-tauri/gen/**',
        '**/rust/target/**',
        '**/dist/**',
        '**/node_modules/**',
        '**/.git/**',
      ],
    },
    hmr: host
      ? {
          protocol: 'ws',
          host: host,
          port: 1424,
        }
      : undefined,
    fs: {
      allow: [
        resolve(__dirname, 'src'),
        // 品牌标志真源：壳内 logo 直接引用应用图标 icon.svg，避免前端再复制一份图形
        // 后与源文件漂移（只放行只读静态图标目录，不开放 src-tauri 其余内容）。
        resolve(__dirname, 'src-tauri/icons'),
        // 插件 SDK 源码（@binblink/wasmnest-plugin-sdk-mobile 经 file: symlink 解析为真实路径，
        // 共享 UI 组件如 Select.vue 在 packages/ 下，dev server 需显式放行）
        resolve(__dirname, 'packages'),
        resolve(__dirname, 'index.html'),
        resolve(__dirname, 'public'),
        resolve(__dirname, 'node_modules'),
        resolve(__dirname, 'package.json'),
        resolve(__dirname, 'vite.config.ts'),
        resolve(__dirname, 'tailwind.config.js'),
        resolve(__dirname, 'postcss.config.js'),
        resolve(__dirname, 'tsconfig.json'),
      ],
    },
  },
  optimizeDeps: {
    entries: ['./index.html'],
    // 移动端 SDK 是 file: 快照拷贝（非 workspace symlink），其控制器（如 global-dialog）
    // 是模块级单例：若被 vite 预打包成 .vite/deps 副本，宿主包说明符导入（prebundle 拷贝）
    // 与组件相对导入（源文件）会分裂成两个模块实例，openGlobalDialog 的广播到不了组件。
    // 整包排除预打包，所有导入直解析到同一源文件，保证单实例（桌面端无此问题：workspace
    // symlink 使两条解析路径 realpath 归一）。
    exclude: ['@binblink/wasmnest-plugin-sdk-mobile'],
    include: [
      'vue',
      'vue-router',
      'pinia',
      '@tauri-apps/api/core',
      '@tauri-apps/api/event',
      '@tauri-apps/api/window',
      '@tauri-apps/plugin-dialog',
      '@tauri-apps/plugin-os',
      '@skipperndt/plugin-machine-uid',
      // 终端栈：TerminalView 是懒加载路由，依赖只经该 chunk 可达。必须逐个显式列出——
      // addon-webgl 仅出现在 useTerminalRenderer 的 `await import()` 里，dep scanner 不扫动态
      // 导入，启动预热漏掉它 → 首次进终端时运行时发现新依赖 → 「optimized dependencies
      // changed. reloading」整页重载，导航中的 TerminalView.vue 动态导入失败（Failed to fetch
      // dynamically imported module），终端卡在 loading，且整页重载清空 useMobileConnection
      // 的内存态连接状态 → 设备列表退回「未连接」历史列表。
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@xterm/addon-web-links',
      '@xterm/addon-unicode11',
      '@xterm/addon-webgl',
      'ansi_up',
      'html5-qrcode',
      'uuid',
    ],
    holdUntilCrawlEnd: false,
  },
  // 插件前端不进宿主构建：运行时经 asset protocol 从插件目录直读（见 src/plugin/loader.ts）。
  // 原 `chunkFileNames` 对 `wasm-apps/*` chunk 的特判随三仓拆分退役（app 源码住应用仓，
  // 宿主构建不再出现该前缀的 chunk）。
  build: {},
  clearScreen: false,
})
