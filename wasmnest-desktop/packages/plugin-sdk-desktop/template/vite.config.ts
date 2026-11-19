import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

/**
 * {{NAME}} 前端构建（桌面挂载包形态）
 *
 * 入口 = `src/entry.ts`（`mountApp` 契约）；产物 = 单文件 `dist/index.js`，由宿主
 * 运行时装载。**不外部化** vue / `window.__WASMNEST_SHARED__`：挂载包自带全部依赖。
 */
export default defineConfig({
  plugins: [vue()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/entry.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    minify: 'terser',
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
})
