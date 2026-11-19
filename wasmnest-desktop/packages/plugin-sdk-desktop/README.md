# @binblink/wasmnest-plugin-sdk-desktop

WasmNest Desktop wasm 应用开发工具包 — 提供应用所需的**类型定义**、**运行时代理**、**Vite 构建插件**与**共享 UI 组件**，应用只需依赖本包即可开发，无需引用宿主源码。

> 术语：本仓把「插件」称为 wasm 应用；包名 / CLI 名 / 标识符保留 `plugin` 原词（`plugin.json`、`wasmnest-plugin-api`）。
>
> 完整开发指南见仓库文档 [`wasm-app-dev-desktop.md`](../../docs/wasm-app-dev-desktop.md)；API 与扩展点参考 [`wasm-app-dev-guide.md`](../../docs/knowledge/wasm-app-dev-guide.md)。

[English](README_en.md) | 简体中文

## 安装

```bash
pnpm add -D @binblink/wasmnest-plugin-sdk-desktop
```

Peer 依赖（宿主已在运行时提供，插件侧安装用于构建与类型检查）：

| 依赖 | 版本 |
|------|------|
| vite | ^5.0.0 |
| vue | ^3.4.0 |

## 快速开始（推荐：脚手架）

```bash
# 创建 wasm 应用工程（id 与 name 为位置参数，非交互；--rust 附带 WASM 后端脚手架）
wasmnest-plugin-desktop create com.example.my-app "My App" --author "you" --rust

cd my-app
pnpm install
ppnpm run dev        # 浏览器开发环境（Dev Shell：空壳宿主 + HMR）
ppnpm run build      # 构建产物 dist/（vite 前端 + full 形态时 cargo wasm32）
ppnpm run manifest   # 按源码自动填充 plugin.json 的 contributes / permissions
```

更多命令（直接在应用工程里跑 CLI，非 npm script）：

```bash
wasmnest-plugin-desktop build --resources-dir ../wasmnest-desktop/src-tauri/resources/plugins/desktop
# 把产物复制到 src-tauri/resources/plugins/desktop/{id}/（内置 wasm 应用随安装包分发的方式）

wasmnest-plugin-desktop build --frontend-only / --rust-only   # 只构建一半（full 形态）
wasmnest-plugin-desktop dev [pluginDir] [--port <port>] [--host] [--open]
wasmnest-plugin-desktop manifest --check   # 只检查不写入（CI）
wasmnest-plugin-desktop validate [--dir]   # 校验 plugin.json（id 格式 / 必填 / pluginType / 权限白名单 / 产物存在性）
wasmnest-plugin-desktop doctor             # 环境自检（Node / Rust / wasm32 target / dev-shell / SDK）
```

构建产物复制到宿主 `src-tauri/resources/plugins/desktop/{id}/` 后，在宿主应用管理页启用。
用户侧安装走 zip 包（桌面端「插件」页 → 选 zip，落盘 `app_data_dir/plugins/{id}/`）。

## 手动创建插件

一个最小插件只需两个文件：

**`plugin.json`** — 插件清单（id / 权限 / 扩展点声明）：

```json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "platform": "desktop",
  "description": "示例插件",
  "author": "you",
  "main": "index.js",
  "pluginType": "frontend",
  "permissions": ["storage", "ui:sidebar"],
  "contributes": {
    "commands": [{ "id": "my-plugin.hello", "title": "Hello" }],
    "views": [{ "id": "my-plugin.sidebar", "type": "sidebar", "title": "My Plugin", "component": "MyPanel" }]
  }
}
```

必填字段：`name` / `version` / `platform` / `main` / `pluginType` / `permissions` / `contributes`
（校验真源 `bin/manifest-validate.js`；宿主反序列化无缺省，缺失即拒装）。
`pluginType` 取值 `frontend` / `backend` / `full`（语言无关三形态，2026-10-26 重定义，旧值 rust / rust-ts / ts-only 已退役）；`full` 时必须给 `rustLibrary`
（与 Cargo.toml 包名一致）。

> `sandbox` 已从 manifest 退役（审计票 06 裁决 2：前端不做隔离）——Rust 端类型会
> 直接忽略并丢弃该字段，写进清单无效，请勿再声明。

**`src/entry.ts`** — 应用入口（必须导出 `mountApp`，挂载包形态）：

```ts
import { createApp, h, type App as VueApp } from 'vue'

/** 与宿主 MOUNT_CONTRACT 同值；不匹配时宿主显性报错 */
export const mountContract = '1'

interface AppMountEnv {
  appId: string
  mountContract: string
  appInvoke: <T = unknown>(command: string, ...args: unknown[]) => Promise<T>
  appStorageGet: <T = unknown>(key: string) => Promise<T | undefined>
  appStorageSet: (key: string, value: unknown) => Promise<void>
  appStorageDelete: (key: string) => Promise<void>
  locale: string
  theme: string
  platform?: string
  initialRoute: string
  onEvent?: (type: string, payload: unknown) => void
}

let app: VueApp | null = null

export async function mountApp(root: HTMLElement, env: AppMountEnv) {
  app = createApp({ render: () => h('div', `Hello WasmNest! (${env.appId})`) })
  app.mount(root)
  return {
    async unmount() {
      app?.unmount()
      app = null
    },
  }
}
```

契约全字段（`invoke` / `appUpdate` / `appLinkCrypto*` / `mountMonitorPanel` 等）见 SDK `dev-shell/src/shell/types.ts`，与宿主 `useAppMount.ts` 逐字段同形（破坏性变更才 bump `mountContract`）。

## 挂载环境 API（AppMountEnv）

宿主装载应用时注入的 `env` 是应用访问宿主能力的**唯一通道**（权限仍写入 `plugin.json` 的 `permissions`，由宿主能力层门禁）：

| 能力 | 说明 | 所需权限 |
|------|------|----------|
| `env.appInvoke` | 本应用插件面命令（通道令牌已绑定本 app） | 由插件命令自身声明 |
| `env.appStorageGet/Set/Delete` | 本应用插件 KV | `storage`（**桌面端无默认授予，必须显式声明**） |
| `env.invoke` | 宿主面命令白名单代理（`plugin_list_loaded` / `get_app_settings` 等） | 无（宿主面命令自身有门禁） |
| `env.onEvent` | 宿主面事件出口（`navigate` 请求壳跳转 / `route` 自报内部当前页） | — |
| `env.appUpdate` | 统一更新检查（可选能力；旧宿主不注入） | — |
| `env.appLinkCryptoGet/Set` | 本应用链路加密策略（可选能力） | — |
| `env.apps` | 通用应用调用桥（可选能力；仅声明 `apps:control` 时注入） | `apps:control` |

权限声明示例：`"permissions": ["storage", "network:http"]`。

> 旧贡献面 `PluginContext`（`context.commands` / `context.terminal` / `context.session` / `context.ui` / `context.events` / `context.http` / `context.i18n`）是 `src/index.ts` + `activate()` 形态的能力面，已随 ADR 0057 退役；SDK 仍导出这些类型仅供老工程编译，新工程不要使用。

## 依赖与共享运行时

挂载包**自带全部依赖**：`import { createApp } from 'vue'` 正常打包进 `dist/index.js`，不读宿主全局，也不做外部化。

旧贡献面工程（`src/index.ts` + `activate()`）构建时才把 `vue` / `vue-i18n` / `pinia` / `vue-sonner` 外部化为 `window.__WASMNEST_SHARED__`，SDK 为此保留代理函数 `getVue` / `getI18n` / `getPinia` / `getRouter` / `getPluginContext`。新工程不要走这条路径——宿主只为旧形态保留共享运行时。

## Vite 构建集成

挂载包只需 `vue()`，入口指向 `src/entry.ts`：

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/entry.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    outDir: resolve(__dirname, 'dist'),
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
```

`wasmnestPlugin()`（共享模块外部化到 `window.__WASMNEST_SHARED__`）只用于**旧贡献面工程**；挂载包不要启用——否则 `vue` 被改写成读宿主全局，运行期取不到。

产物文件名必须为 `index.js`（与 `plugin.json` 的 `main` 对应）。

## Rust WASM 后端（`--rust` 插件）

`--rust` 脚手架附带 Rust 侧 SDK crate **`wasmnest-plugin-api`**（本包 `rust/` 目录，MIT），用于编写编译为 WASM 组件、在宿主 wasmtime 沙箱内运行的后端逻辑。

### 启用

```toml
[dependencies]
wasmnest-plugin-api = { path = "<宿主>/packages/plugin-sdk-desktop/rust", features = ["wasm"] }
```

`wasm` feature 提供：

- `WasmPlugin` trait + `wasm_entry!` 宏 — 生成 WIT 契约（`rust/wit/wasmnest.wit`，单一事实来源）定义的全部组件导出
- `WasmHost` — 宿主 API 绑定（import 后端），经 bindgen 调用宿主能力
- `#[plugin_api]` 属性宏（由 `rust-macros/` 的 `wasmnest-plugin-api-macros` crate 提供）— 插件互调 IDL：trait 定义 → JSON-RPC 分派 + client 生成 + 防漂移比对

### 最小示例

```rust
use wasmnest_plugin_api::{CommandArgs, WasmHost, WasmPlugin};

struct MyPlugin;

impl WasmPlugin for MyPlugin {
    fn activate() -> anyhow::Result<()> {
        // 经 WasmHost 访问宿主能力（事件订阅、存储、HTTP 端点等）
        Ok(())
    }
}

wasmnest_plugin_api::wasm_entry!(MyPlugin);
```

### 构建

```bash
cargo build --target wasm32-unknown-unknown --no-default-features --features wasm --release
```

产物为 WASM 组件（Component Model），宿主以 wasmtime 沙箱加载运行；插件崩溃不影响宿主。不带 `wasm` feature 时可作为普通 Rust crate 使用（静态注册 / 库依赖）。

## 配置声明

插件配置在 `plugin.json` 的 `contributes.configuration` 声明，宿主据此渲染配置页；运行时经 `context.storage` 读写（统一键 `PLUGIN_CONFIG_STORAGE_KEY = 'config'`）。SDK 提供声明式助手保持两端一致：

```ts
import { defineConfiguration, PLUGIN_CONFIG_STORAGE_KEY } from '@binblink/wasmnest-plugin-sdk-desktop'

const config = defineConfiguration('My Plugin Settings', {
  apiKey: { type: 'string', title: 'API Key' },
  maxRetries: { type: 'number', title: 'Max Retries', default: 3 },
  debugMode: { type: 'boolean', title: 'Debug Mode', default: false },
})

// 运行时读取用户配置
const saved = await context.storage.get<typeof config.properties>(PLUGIN_CONFIG_STORAGE_KEY)
```

## 事件常量

事件主题遵循 `{domain}:{action}` 命名规范；各领域事件名由对应 wasm 应用工程自持（单一事实来源），
SDK 不内置具体业务事件名。例如终端会话应用（`wasm-apps/bedcode`）订阅的任务状态事件：

```ts
// 应用内订阅本领域事件（字符串字面量或抽为本地常量）
context.events.on('task:status-changed', (payload) => {
  // 任务状态变更（如 Agent CLI idle → in_progress）
})
```

## 应用更新检查（宿主统一默认实现）

manifest 声明 `update`（缺省 = 不参与检查）后，宿主负责查 GitHub Release、校验身份 / 完整性并做平台兼容裁决；应用设置页直接嵌入 SDK 默认卡片：

```vue
<script setup lang="ts">
import AppUpdateSection from '@binblink/wasmnest-plugin-sdk-desktop/ui/app-update'
</script>

<template>
  <AppUpdateSection />
</template>
```

- 默认数据面 = `PluginContext.appUpdate.check`（宿主注入，appId / 凭证已绑定）；应用也可给 `AppUpdateSection` 传 `check` 使用自实现，或只用 `useAppUpdate()` 自己画 UI。
- 检查结果状态：`up-to-date` / `available` / `incompatible` / `error`；不兼容会带原因 key，不出现更新按钮。
- **安装动作不在应用内**：统一在宿主应用管理页执行（需先停用、替换目录并重新审批）。

## 共享 UI 组件

`./ui` 子路径导出的组件遵循宿主设计 token，插件 UI 与宿主观感一致（**禁止使用原生 `<select>` 等系统控件外观**）：

```vue
<script setup lang="ts">
import { ref } from 'vue'
import Select from '@binblink/wasmnest-plugin-sdk-desktop/ui'

const value = ref('a')
const options = [
  { value: 'a', label: '选项 A' },
  { value: 'b', label: '选项 B' },
]
</script>

<template>
  <Select v-model="value" :options="options" size="sm" />
</template>
```

当前提供（每个子路径 = 一个独立导出，默认导出组件本身）：

| 子路径 | 组件 | 用途 |
|--------|------|------|
| `./ui` | `Select` | 下拉选择（`update:modelValue` / `open` 事件，`md` / `sm` 尺寸） |
| `./ui/markdown-editor` | `MarkdownEditor` | Markdown 编辑区（语法工具栏 + 预览切换，`v-model`） |
| `./ui/terminal-input-rail` | `TerminalInputRail` | 终端输入导航条（终端右侧悬浮，一根横线 = 一次用户输入，位置映射 buffer 相对位置） |
| `./ui/plugin-global-dialog` | `PluginGlobalDialog` | 宿主全局弹窗（应用根挂载一次；渲染由全局弹窗控制器驱动，插件经 `context.ui.showDialog` 操控，挂载方无 props） |
| `./ui/zoom-compensation` | （无组件） | fixed 定位覆盖层在根元素 CSS zoom 下的坐标换算（自校准；当前 F=1，作防御性 no-op 保留） |
| `./ui/app-update` | `AppUpdateSection` | 应用更新检查（宿主统一 GitHub Release 判定；可传 `check` / `labels` 覆盖） |

## 子路径导出总览

| 子路径 | 内容 |
|--------|------|
| `@binblink/wasmnest-plugin-sdk-desktop` | 主 API：类型 + 运行时代理 + 配置助手 + 事件常量 |
| `@binblink/wasmnest-plugin-sdk-desktop/vite` | `wasmnestPlugin()` Vite 构建插件 |
| `@binblink/wasmnest-plugin-sdk-desktop/types` | 纯类型导出（仅类型，无运行时） |
| `@binblink/wasmnest-plugin-sdk-desktop/ui` | 共享 Vue 组件：`Select` |
| `@binblink/wasmnest-plugin-sdk-desktop/ui/markdown-editor` | `MarkdownEditor` |
| `@binblink/wasmnest-plugin-sdk-desktop/ui/terminal-input-rail` | `TerminalInputRail` |
| `@binblink/wasmnest-plugin-sdk-desktop/ui/plugin-global-dialog` | `PluginGlobalDialog` |
| `@binblink/wasmnest-plugin-sdk-desktop/ui/zoom-compensation` | zoom 坐标换算工具 |
| `@binblink/wasmnest-plugin-sdk-desktop/ui/app-update` | `AppUpdateSection`（应用更新检查） |

## 本地开发本 SDK

```bash
pnpm run build      # tsup 构建 dist（ESM + d.ts）
pnpm run test:run   # vitest run
```
