import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  // @ts-expect-error -- vite 5/8 双版本并存（node_modules/.pnpm），plugin-vue 的
  // Plugin<Api> 与 vitest 解析到的 vite PluginOption 类型不兼容——工作区既有噪音，
  // 仅行级压制，不改任何插件行为
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    globals: true,
    include: [
      // 桌面 UI 宿主修正（2026-10-17）：宿主前端恢复 wasmnest-desktop/src/（新 UI
      // 宿主 = 方案 C 壳），此处只跑宿主壳测试树；各 wasm app 测试由各自工程独立
      // vitest 运行（独立构建的挂载包，见各 app vitest.config.ts 与根测试编排）
      'src/__tests__/**/*.test.ts',
      // SDK 契约测试（宿主侧共享面）
      'packages/plugin-sdk-desktop/__tests__/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // app 源码与测试自三仓拆分起住应用仓（apps/*/desktop），不在本工程的覆盖率面内
      exclude: ['node_modules/', 'src/__tests__/'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
