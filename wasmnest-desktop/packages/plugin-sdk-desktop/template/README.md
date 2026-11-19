# {{NAME}}

{{NAME}} wasm 应用 — WasmNest Desktop wasm 应用工程（由 `wasmnest-plugin-desktop create` 生成）。

> 术语：本仓把「插件」称为 wasm 应用；`plugin.json` / CLI 命令 / SDK 包名仍用 `plugin` 原词。

## 快速开始

```bash
pnpm install        # 安装依赖（含 SDK、vite、vue）
pnpm run dev        # 浏览器开发环境（Dev Shell：空壳宿主 + 桌面端骨架，HMR）
pnpm run build      # 构建：vite（前端）+ cargo（WASM，仅 full 形态插件）
pnpm run manifest   # 按源码自动填充 plugin.json 的 contributes/permissions
```

## 目录结构

```
├── plugin.json        # 应用清单（id/name/权限/扩展点声明）
├── package.json       # 工程脚本：dev / build / manifest
├── vite.config.ts     # 前端构建配置（产物 dist/index.js，自带依赖不外部化）
├── tsconfig.json
├── src/
│   └── entry.ts       # 前端入口：导出 mountApp(root, env)（挂载包契约）
└── rust/              # WASM 后端（--rust 创建；纯前端应用无此目录）
    ├── Cargo.toml
    └── src/lib.rs     # WasmPlugin 实现（含 manifest 声明）
```

## 入口形态（挂载包）

桌面应用是**独立构建的挂载包**，入口固定为 `src/entry.ts`：

- 必须导出 `mountApp(root, env): Promise<AppMountHandle>`——宿主把 `root` 交给应用，应用在其上挂载自己的界面；
- `env` 提供 `appInvoke`（本应用插件命令）/ `appStorage*`（本应用 KV）/ `invoke`（宿主面白名单）/ `locale` / `theme` / `initialRoute` / `onEvent`；
- 返回 `{ unmount }`；可选 `setRoute` / `setActive` / `setLocale` / `setTheme` 接收宿主通知；
- `mountContract` 与宿主同值（当前 `'1'`），不匹配时宿主显性报错；
- **自带全部依赖**（vue 等正常 `import` 打包），不读 `window.__WASMNEST_SHARED__`。

旧贡献面形态（`src/index.ts` + `activate(context)` + `registerSidebarPanel` 等）已随桌面 UI 宿主修正（ADR 0057）退役，新工程不要使用。

## 安装到 WasmNest Desktop

`pnpm run build -- --resources-dir <宿主资源父目录>` 把产物复制到
`<父目录>/{id}/`（内置应用随安装包分发）；用户安装走宿主应用管理。

> 权限提醒：桌面端**无默认授予**——`storage` 等权限均需写入 `plugin.json` 的 `permissions`，
> 未声明即被拒（内置应用均显式声明了 `storage`）。

完整开发指南见仓库文档 `../../../docs/wasm-app-dev-desktop.md`。
