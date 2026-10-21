/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

/**
 * 虚拟模块：被调试应用列表（vite 虚拟模块，见 dev-shell/vite.config.ts）
 *
 * `entry` = 挂载包模块（app 的 `src/entry.ts`，导出 `mountApp`）；缺失 = null。
 * `devMock` = 领域种子模块（app 的 `src/index.ts`，导出 `devMock`）；缺失 = null。
 */
declare module 'virtual:dev-plugins' {
  export interface DevPluginRecordSpec {
    dir: string
    manifest: Record<string, unknown>
    entry: any
    devMock: any
  }
  const records: DevPluginRecordSpec[]
  export default records
}
