import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

const host = process.env.TAURI_DEV_HOST

/**
 * 桌面宿主前端构建接线（桌面 UI 宿主修正 2026-10-17）
 *
 * `@` 别名与入口均指向宿主前端源码（`src/`，新 UI 宿主 = 方案 C 壳）。各 wasm
 * app 前端是独立构建的挂载包（scripts/build.js 各自产出 → resources/plugins/
 * desktop/<id>/index.js），宿主运行时经 useAppMount 装载，不在宿主构建内 import。
 */

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    // 显式绑 IPv4 回环：默认 'localhost' 在本机只监听 [::1]:1420，WebKitGTK 解析到
    // 127.0.0.1 时连接被拒 → 窗口白屏（devUrl 仍是 http://localhost:1420）
    host: host ? '0.0.0.0' : '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      // 排除巨型构建目录，避免 chokidar 扫描/监听数万文件霸占事件循环导致请求挂起
      // （2026-08-23 复发：packages/plugins 下各 Rust crate 的 target 共约 5.9GB
      // 未被覆盖，重编译期间 fs 事件风暴打满 vite 事件循环，HTTP 完全无响应）
      ignored: [
        '**/target/**',
        '**/src-tauri/gen/**',
        '**/dist/**',
        '**/node_modules/**',
        '**/.git/**',
      ],
    },
    hmr: host
      ? {
          protocol: 'ws',
          host: host,
          port: 1421,
        }
      : undefined,
    fs: {
      allow: [
        // 宿主前端源码（入口与 @ 别名均指向此处）
        resolve(import.meta.dirname, 'src'),
        // 插件 SDK 源码（@binblink/wasmnest-plugin-sdk-desktop 经 file: symlink 解析为真实路径，
        // 共享 UI 组件如 Select.vue 在 packages/ 下，dev server 需显式放行）
        resolve(import.meta.dirname, 'packages'),
        resolve(import.meta.dirname, 'index.html'),
        resolve(import.meta.dirname, 'public'),
        resolve(import.meta.dirname, 'node_modules'),
        resolve(import.meta.dirname, 'package.json'),
        resolve(import.meta.dirname, 'vite.config.ts'),
        resolve(import.meta.dirname, 'tailwind.config.js'),
        resolve(import.meta.dirname, 'postcss.config.js'),
        resolve(import.meta.dirname, 'tsconfig.json'),
      ],
    },
  },
  optimizeDeps: {
    entries: ['./index.html'],
    include: [
      'vue',
      'vue-router',
      'pinia',
      'vue-i18n',
      'vue-sonner',
      'loglevel',
      '@tauri-apps/api/core',
      '@tauri-apps/api/event',
      '@tauri-apps/api/path',
      '@tauri-apps/api/window',
      '@tauri-apps/plugin-os',
      '@tauri-apps/plugin-process',
    ],
    holdUntilCrawlEnd: false,
  },
  clearScreen: false,
})
