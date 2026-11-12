import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// 应用仓根（三仓拆分 §5-E7）：app 源码住独立应用仓；宿主测试仍有跨仓读取
// （file-transfer 组合件桥测试、i18n 副本对账），统一经 `@apps` 别名指向
// `<appsRoot>/apps`，不在测试里拼 `wasm-apps/` 硬路径。
const APPS_ROOT = process.env.WASMNEST_APPS_ROOT ?? resolve(__dirname, '../../wasmnest-apps')

export default defineConfig({
  plugins: [vue()],
  // 与 vite.config.ts 同源：`__APP_VERSION__` 由构建期注入（真源 tauri.conf.json），
  // 测试侧无注入即 ReferenceError —— 挂载壳屏（设置屏展示版本号）时必须可解析
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    // 全局装：Tauri core 的 Channel 替身（见 setup.ts 说明）
    setupFiles: ['src/__tests__/setup.ts'],
    // 票 15 / 2026-10-09 / 2026-10-10：应用域测试原随源码住 `wasm-apps/bedcode/src/**`。
    // 三仓拆分后 app 源码与测试都住应用仓，由各 app 自己的 vitest 运行（apps/*/mobile），
    // 本配置只跑移动宿主测试树（跨仓读取经 `@apps` 别名，见下）。
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/__tests__/']
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // 跨仓读应用源码（测试专用；构建期宿主不 import app 源码，产物经资源目录装载）
      '@apps': resolve(APPS_ROOT, 'apps'),
    },
  },
})