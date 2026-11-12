import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { wasmnestPlugin } from '@binblink/wasmnest-plugin-sdk-mobile/vite'

export default defineConfig({
  plugins: [vue(), wasmnestPlugin()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    minify: 'terser',
  },
})
