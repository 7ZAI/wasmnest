# @binblink/wasmnest-plugin-sdk-desktop

The WasmNest Desktop WASM app development kit — provides everything an app needs: **type definitions**, **runtime proxies**, a **Vite build plugin**, and **shared UI components**. Apps only need this package; no host source code required.

> Terminology: this repository calls "plugins" WASM apps; the package name, CLI name and identifiers keep the original `plugin` words (`plugin.json`, `wasmnest-plugin-api`).
>
> Full development guide: [`wasm-app-dev-desktop.md`](../../docs/wasm-app-dev-desktop.md) (Chinese); API & extension-point reference [`wasm-app-dev-guide.md`](../../docs/knowledge/wasm-app-dev-guide.md).

English | [简体中文](README.md)

## Install

```bash
pnpm add -D @binblink/wasmnest-plugin-sdk-desktop
```

Peer dependencies (provided by the host at runtime; installed in the plugin for building & type-checking):

| Dependency | Version |
|------------|---------|
| vite | ^5.0.0 |
| vue | ^3.4.0 |

## Quick Start (recommended: scaffold)

```bash
# Create a WASM app project (id and name are positional args, not interactive; --rust adds a WASM backend)
wasmnest-plugin-desktop create com.example.my-app "My App" --author "you" --rust

cd my-app
pnpm install
ppnpm run dev        # Browser dev environment (Dev Shell: empty host shell + HMR)
ppnpm run build      # Build dist/ (vite frontend + cargo wasm32 for rust-ts)
ppnpm run manifest   # Auto-fill plugin.json contributes / permissions from source
```

More commands (run the CLI directly inside the app project, not as npm scripts):

```bash
wasmnest-plugin-desktop build --resources-dir ../wasmnest-desktop/src-tauri/resources/plugins/desktop
# copies the build output into src-tauri/resources/plugins/desktop/{id}/ (how built-in WASM apps ship)

wasmnest-plugin-desktop build --frontend-only / --rust-only   # build only half (rust-ts)
wasmnest-plugin-desktop dev [pluginDir] [--port <port>] [--host] [--open]
wasmnest-plugin-desktop manifest --check   # check only, don't write (CI)
wasmnest-plugin-desktop validate [--dir]   # validate plugin.json (id format / required fields / pluginType / permission allowlist / artifact presence)
wasmnest-plugin-desktop doctor             # environment self-check (Node / Rust / wasm32 target / dev-shell / SDK)
```

Copy the build output into the host's `src-tauri/resources/plugins/desktop/{id}/` directory, then enable it on the host's app management page.
User-side install goes through a zip package (desktop "Plugins" page → pick zip, unpacked into `app_data_dir/plugins/{id}/`).

## Creating a Plugin Manually

A minimal plugin needs just two files:

**`plugin.json`** — plugin manifest (id / permissions / extension point declarations):

```json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "platform": "desktop",
  "description": "Example plugin",
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

Required fields: `name` / `version` / `platform` / `main` / `pluginType` / `permissions` / `contributes`
(validation source of truth `bin/manifest-validate.js`; the host deserializes with no defaults, so a missing field rejects the install).
`pluginType` accepts `frontend` / `backend` / `full` (language-agnostic three forms, redefined 2026-10-26; the old values `rust` / `rust-ts` / `ts-only` are retired); `full` requires `rustLibrary` (must match the Cargo.toml package name).

> `sandbox` has been retired from the manifest (audit ticket 06 ruling 2: the frontend is not sandboxed) — the Rust types ignore and drop the field, so declaring it has no effect. Do not declare it.

**`src/entry.ts`** — app entry (must export `mountApp`; mount-bundle form):

```ts
import { createApp, h, type App as VueApp } from 'vue'

/** Same value as the host MOUNT_CONTRACT; a mismatch is a visible host error */
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

The full contract (`invoke` / `appUpdate` / `appLinkCrypto*` / `mountMonitorPanel`, …) lives in the SDK's `dev-shell/src/shell/types.ts` and mirrors the host `useAppMount.ts` field by field (bump `mountContract` only on breaking changes).

## Mount Environment API (AppMountEnv)

The `env` injected by the host at mount time is the **single channel** through which an app accesses host capabilities (permissions are still declared in `plugin.json` `permissions` and enforced by the capability layer):

| Capability | Description | Required permission |
|-----------|-------------|---------------------|
| `env.appInvoke` | This app's plugin-side commands (channel token bound to this app) | declared by the plugin command itself |
| `env.appStorageGet/Set/Delete` | This app's plugin KV | `storage` (**no default grant on desktop — must be declared explicitly**) |
| `env.invoke` | Host-side command whitelist proxy (`plugin_list_loaded` / `get_app_settings`, …) | none (host-side commands are gated themselves) |
| `env.onEvent` | Host-side event outlet (`navigate` requests shell navigation / `route` reports the app's internal page) | — |
| `env.appUpdate` | Unified update check (optional; older hosts do not inject) | — |
| `env.appLinkCryptoGet/Set` | This app's link-encryption policy (optional) | — |

Permission example: `"permissions": ["storage", "network:http"]`.

> The legacy contribution surface `PluginContext` (`context.commands` / `context.terminal` / `context.session` / `context.ui` / `context.events` / `context.http` / `context.i18n`) belongs to the `src/index.ts` + `activate()` form retired by ADR 0057. The SDK still exports those types so old projects keep compiling — do not use them in new projects.

## Dependencies and shared runtime

Mount bundles are **self-contained**: `import { createApp } from 'vue'` is bundled into `dist/index.js` (no host global, no externalization).

Only legacy contribution-surface projects (`src/index.ts` + `activate()`) externalize `vue` / `vue-i18n` / `pinia` / `vue-sonner` into `window.__WASMNEST_SHARED__`; the SDK keeps `getVue` / `getI18n` / `getPinia` / `getRouter` / `getPluginContext` for those. New projects must not use that path — the host keeps the shared runtime for the old form only.

## Vite Build Integration

A mount bundle only needs `vue()`, with the entry pointing at `src/entry.ts`:

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

`wasmnestPlugin()` (externalizing shared modules to `window.__WASMNEST_SHARED__`) is for **legacy contribution-surface projects** only; do not enable it in mount bundles — it rewrites `vue` to the host global, which is unavailable at runtime.

The output filename must be `index.js` (matching `main` in `plugin.json`).

## Rust WASM Backend (`--rust` plugins)

The `--rust` scaffold includes the Rust-side SDK crate **`wasmnest-plugin-api`** (in this package's `rust/` directory, MIT) for backend logic compiled into a WASM component that runs inside the host's wasmtime sandbox.

### Enable

```toml
[dependencies]
wasmnest-plugin-api = { path = "<host>/packages/plugin-sdk-desktop/rust", features = ["wasm"] }
```

The `wasm` feature provides:

- `WasmPlugin` trait + `wasm_entry!` macro — generates all component exports defined by the WIT contract (`rust/wit/wasmnest.wit`, single source of truth)
- `WasmHost` — host API bindings (import backend), calling host capabilities via bindgen
- `#[plugin_api]` attribute macro (from `wasmnest-plugin-api-macros`, the `rust-macros/` crate) — inter-plugin call IDL: trait definition → JSON-RPC dispatch + client generation + drift detection

### Minimal Example

```rust
use wasmnest_plugin_api::{CommandArgs, WasmHost, WasmPlugin};

struct MyPlugin;

impl WasmPlugin for MyPlugin {
    fn activate() -> anyhow::Result<()> {
        // Access host capabilities via WasmHost (events, storage, HTTP endpoints, ...)
        Ok(())
    }
}

wasmnest_plugin_api::wasm_entry!(MyPlugin);
```

### Build

```bash
cargo build --target wasm32-unknown-unknown --no-default-features --features wasm --release
```

The output is a WASM component (Component Model) loaded by the host inside the wasmtime sandbox — a crashing plugin never affects the host. Without the `wasm` feature it works as a regular Rust crate (static registration / library dependency).

## Configuration Declaration

Declare plugin config in `plugin.json` under `contributes.configuration`; the host renders a config page from it. At runtime, read/write via `context.storage` (unified key `PLUGIN_CONFIG_STORAGE_KEY = 'config'`). The SDK provides a declarative helper to keep both ends consistent:

```ts
import { defineConfiguration, PLUGIN_CONFIG_STORAGE_KEY } from '@binblink/wasmnest-plugin-sdk-desktop'

const config = defineConfiguration('My Plugin Settings', {
  apiKey: { type: 'string', title: 'API Key' },
  maxRetries: { type: 'number', title: 'Max Retries', default: 3 },
  debugMode: { type: 'boolean', title: 'Debug Mode', default: false },
})

// Read user config at runtime
const saved = await context.storage.get<typeof config.properties>(PLUGIN_CONFIG_STORAGE_KEY)
```

## Event Constants

Event topics follow the `{domain}:{action}` convention; each domain owns its event names in its own WASM app package (single source of truth). The SDK ships no business-specific event names. For example, the bedcode app (`wasm-apps/bedcode`) subscribes to its task status event:

```ts
// Inside an app, subscribe to its domain event (string literal or a local constant)
context.events.on('task:status-changed', (payload) => {
  // Task status change (e.g. Agent CLI idle → in_progress)
})
```

## Shared UI Components

Components exported via the `./ui` subpath follow the host design tokens so plugin UI matches the host look & feel (**native `<select>` etc. system controls are banned**):

```vue
<script setup lang="ts">
import { ref } from 'vue'
import Select from '@binblink/wasmnest-plugin-sdk-desktop/ui'

const value = ref('a')
const options = [
  { value: 'a', label: 'Option A' },
  { value: 'b', label: 'Option B' },
]
</script>

<template>
  <Select v-model="value" :options="options" size="sm" />
</template>
```

Currently provided (each subpath is an independent export that default-exports the component):

| Subpath | Component | Purpose |
|---------|-----------|---------|
| `./ui` | `Select` | Dropdown (`update:modelValue` / `open` events, `md` / `sm` sizes) |
| `./ui/markdown-editor` | `MarkdownEditor` | Markdown editing area (syntax toolbar + preview toggle, `v-model`) |
| `./ui/terminal-input-rail` | `TerminalInputRail` | Terminal input navigation rail (floating on the right of the terminal; one line = one user input, position mapped to the buffer) |
| `./ui/plugin-global-dialog` | `PluginGlobalDialog` | Host global dialog (mounted once at the app root; rendering driven by the global dialog controller, apps drive it via `context.ui.showDialog`, no props on mount) |
| `./ui/zoom-compensation` | (no component) | Coordinate conversion for fixed-position overlays under root CSS zoom (self-calibrating; currently F=1, kept as a defensive no-op) |

## Subpath Exports

| Subpath | Contents |
|---------|----------|
| `@binblink/wasmnest-plugin-sdk-desktop` | Main API: types + runtime proxies + config helper + event constants |
| `@binblink/wasmnest-plugin-sdk-desktop/vite` | `wasmnestPlugin()` Vite build plugin |
| `@binblink/wasmnest-plugin-sdk-desktop/types` | Pure types (types only, no runtime) |
| `@binblink/wasmnest-plugin-sdk-desktop/ui` | Shared Vue component: `Select` |
| `@binblink/wasmnest-plugin-sdk-desktop/ui/markdown-editor` | `MarkdownEditor` |
| `@binblink/wasmnest-plugin-sdk-desktop/ui/terminal-input-rail` | `TerminalInputRail` |
| `@binblink/wasmnest-plugin-sdk-desktop/ui/plugin-global-dialog` | `PluginGlobalDialog` |
| `@binblink/wasmnest-plugin-sdk-desktop/ui/zoom-compensation` | zoom coordinate conversion helper |

## Developing this SDK

```bash
pnpm run build      # tsup build → dist (ESM + d.ts)
pnpm run test:run   # vitest run
```
