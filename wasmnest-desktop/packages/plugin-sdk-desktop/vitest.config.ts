import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    globals: true,
    /**
     * `dev-shell/__tests__/**` —— dev-shell 的漂移锁（挂载契约 / 视觉真源）。
     *
     * 放在 dev-shell 目录（而非 SDK 根 `__tests__/`）是为了让测试与被测代码同处一地；
     * 放这里而不是 `dev-shell/src/__tests__/` 是因为 SDK 的 `files` 白名单整份打包
     * `dev-shell/src`，测试不该进 npm 包。
     *
     * 锁只做**文本层**比对（契约字段集 / token 声明 / tailwind theme / alias 接线），
     * 不挂载 SFC：宿主源码不在 npm 包内，按路径 import 会把宿主拖进依赖图。
     */
    include: ['__tests__/**/*.test.ts', 'dev-shell/__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
})
