# WasmNest

**双端 Wasm 应用宿主：桌面与 Android 共用一套应用契约，每个产品能力都是可独立构建的 wasm 应用。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![test](https://github.com/7ZAI/wasmnest/actions/workflows/test.yml/badge.svg)](https://github.com/7ZAI/wasmnest/actions/workflows/test.yml)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8D8?logo=tauri&logoColor=white)](https://tauri.app)
[![Vue 3](https://img.shields.io/badge/Vue-3-42B883?logo=vuedotjs&logoColor=white)](https://vuejs.org)
[![Rust](https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![WebAssembly](https://img.shields.io/badge/WebAssembly-Component-654FF0?logo=webassembly&logoColor=white)](https://component-model.bytecodealliance.org)
[![Wasmtime](https://img.shields.io/badge/Wasmtime-Runtime-00263E)](https://wasmtime.dev)
[![Status](https://img.shields.io/badge/status-alpha-orange)](#项目状态)

简体中文 | [English](README_en.md)

WasmNest 是一个基于 [WebAssembly Component Model](https://component-model.bytecodealliance.org/) 的双端 wasm 应用宿主：桌面端 Tauri 2 + Vue 3（Windows / macOS / Linux），移动端 Tauri 2（Android）+ Vue 3。

它解决的核心问题是**把产品能力从宿主代码中彻底解耦**：终端、AI 对话、文件传输、Agent 管理等产品能力不写进宿主，而是作为独立的 wasm 应用装载——应用逻辑（wasm Component）在 wasmtime 沙箱中按权限运行，应用前端与宿主同 webview、同可信域（信任边界详见 [ADR 0058](docs/adr/0058-frontend-trust-boundary-and-command-surface-threat-model.md)）；应用不被停用就继续运行，停用 / 卸载才是唯一销毁点。宿主只提供通用引擎、安全闸门与装配机制——应用可以自由生长，宿主保持极简。

## 目标

WasmNest 致力于让人快速构建**属于个人的本地「小程序」**，成为一个**小工具平台**：写好一个小工具，装进宿主即装即用；工具运行在自己的设备上，能做什么由权限说了算——没有默认授予，只有逐项批准。

> 项目处于研发起步期（`0.0.1`）：暂无真实用户，也没有对外 ABI 兼容义务，接口与形态可能直接调整。稳定的是设计边界，不是版本号。

## 特性与优势

| 用什么技术 | 达到什么效果 | 解决什么问题 |
| --- | --- | --- |
| **wasmtime 沙箱（应用逻辑面）**：每个应用的 wasm Component 独立实例 + 显式能力导入；应用前端不在此沙箱内——与宿主同 webview、同可信域（[ADR 0058](docs/adr/0058-frontend-trust-boundary-and-command-surface-threat-model.md)） | 应用逻辑默认零系统能力，只拿得到被批准的文件、网络等资源 | 应用逻辑失控或含恶意代码时，影响半径被压到最小 |
| **WIT / Component Model 跨语言契约**：宿主与应用只通过接口对话，不共享代码 | 应用可用任何能产出 wasm Component 的语言编写，宿主不在意语言与构建链 | 插件生态被锁死在宿主的语言和运行时上 |
| **能力即权限**：`plugin.json` 声明 ∩ 用户批准，无默认授予 | 应用能做什么由用户逐项决定，高风险能力按域细分 | 「装一个应用 = 交出全部权限」 |
| **独立构建的应用包 + 装配机制** | 新增、更换、下架能力不动宿主；停用 / 卸载才销毁回收 | 功能耦合进宿主，改一点就要重发一版 |
| **双端共享同一套 WIT 与 SDK** | 应用写一次，桌面与 Android 都能装载 | 双端生态分裂、重复开发 |
| **薄壳宿主 + 跨仓版本指纹** | 宿主只做引擎与装配，契约版本漂移当场报错 | 宿主随产品膨胀、集成问题静默潜伏 |

## 设计原则

| 原则 | 含义 |
| --- | --- |
| **宿主薄壳** | 宿主只回答「机制怎么做」，不回答「这件事是什么、给谁用、怎么组织」。凡按产品语义定义的类型、流程、存储、默认值与生命周期回调都属于应用；这条边界由测试锁钉住。 |
| **能力即权限** | 没有默认授予。生效权限 = `plugin.json` 声明 ∩ 用户批准；文件、网络、进程、PTY、WS 等高风险面按域拆分。移动端审批按内容 SHA-256 钉扎，目录被替换即自动撤销。 |
| **契约先行** | 核心 WIT 住在能力仓，端组合与 SDK 生成物住在平台仓；跨仓版本由 [`release-manifest.json`](release-manifest.json) 用精确 tag、契约版本和 WIT 指纹钉住，漂移即红。 |
| **双端锁步** | 双端共用同一套机制内核与 wasmtime 版本，但装配面各自演进；HTTP / WS / 认证 / 文件传输等跨端协议必须两端同步部署。 |

## 工作原理

```mermaid
flowchart TB
    subgraph Host["宿主（桌面 / Android）：Tauri 2 + Vue 3"]
        Shell["宿主壳<br/>主屏 · 系统页 · 挂载槽"]
        Gate["安全闸门<br/>权限 · 出站 · 文件授权 · CSP / ACL"]
        Engine["通用引擎<br/>wasmtime · 事件总线 · 存储 · 网络 / PTY / 文件原语"]
        Shell --> Gate
        Gate --> Engine
    end

    subgraph App["独立构建的应用包"]
        UI["前端包<br/>桌面 mountApp / 移动 activate"]
        Logic["应用逻辑<br/>wasm Component"]
    end

    UI -->|"同 webview 装载（同信任域）"| Shell
    Logic -->|"WIT · 只导入被批准的 host 能力"| Gate
    Engine -->|"host-* 原语 / 事件"| Logic
```

能力仓提供 WIT 契约真源与引擎实现，应用仓提供全部业务应用源码，`release-manifest.json` 钉住三者的跨仓版本。

一次装载的完整闭环：

1. **扫描与校验**：宿主扫描随包 `resources/plugins/<end>/<id>/` 与用户安装目录，按 `plugin.json` 校验端、必填字段与权限声明，缺项即拒装。
2. **授权**：生效权限 = 清单声明 ∩ 用户批准；移动端审批按目录内容 SHA-256 钉扎，内容被替换即自动撤销。
3. **实例化**：每个应用的 wasm Component 在独立的 wasmtime 实例中运行，只获得被批准的 host 导入。
4. **装载界面**：桌面经 `mountApp(root, env)` 把独立构建的前端包挂进同一 webview；移动经宿主壳运行面注册。
5. **生命周期**：切走只是藏起来（DOM / 组件实例保留），停用 / 卸载才销毁运行实例并回收权限；卸载还会清理存储与私有库。

## 双端形态

| | 桌面 | 移动 |
| --- | --- | --- |
| 宿主 | Tauri 2 + Vue 3（Windows / macOS / Linux） | Tauri 2 + Vue 3（Android） |
| 应用装载 | 同一窗口全屏挂载独立构建的应用包 | 宿主壳注册运行面 |
| 应用隔离 | 应用逻辑 wasmtime 沙箱实例 + 显式能力导入；应用前端与宿主同 webview、同可信域（[ADR 0058](docs/adr/0058-frontend-trust-boundary-and-command-surface-threat-model.md)） | 同左，另加内容绑定审批 |

应用不被停用就继续运行——切走只是藏起来（DOM / 组件实例保留），停用 / 卸载才是唯一销毁点；宿主壳不持有任何应用内部状态。双端装配细节见 [`docs/architecture.md`](docs/architecture.md) 与 [`docs/frontend.md`](docs/frontend.md)。

## 四仓协作

WasmNest 由四个平级仓库组成，默认按同场（sibling）布局摆放：

```text
<workspace>/
├─ wasmnest/        平台仓：双端宿主 + 端内 SDK + 构建 / 发布工具
├─ wasmnest-lib/    能力仓：应用无关引擎 + WIT 契约真源
├─ wasmnest-apps/   应用仓：全部业务 wasm 应用
└─ wasmnest-test/   测试仓：跨端真实互连测试（零 mock）
```

| 仓库 | 职责 | 主要内容 |
| --- | --- | --- |
| **[wasmnest](https://github.com/7ZAI/wasmnest)**（本仓） | 宿主与发布面 | 桌面 / 移动宿主、端内 SDK、WIT 拼装、跨仓版本清单、构建与打包工具 |
| **[wasmnest-lib](https://github.com/7ZAI/wasmnest-lib)** | 可复用机制 | wasm 运行时内核、host API 实现层、server 传输面、PTY / mDNS / 通知 / 加密等能力域引擎、契约常量 |
| **[wasmnest-apps](https://github.com/7ZAI/wasmnest-apps)** | 业务主场 | BedCode、AI Chatbox、File Transfer 等 wasm 应用（Agent Hub 已并入 BedCode） |
| **[wasmnest-test](https://github.com/7ZAI/wasmnest-test)** | 跨端门禁 | 真实移动端客户端 ↔ 真实桌面端服务器互连、跨仓契约锁 |

平台通过 Cargo sibling path 直接消费能力仓（不复制、不挂 submodule）。非标准布局可用 `WASMNEST_LIB_ROOT`、`WASMNEST_APPS_ROOT` 覆盖；缺失时显性报错，不会返回可能无效的路径。

## 内置应用与服务

业务应用全部住应用仓；下表是随宿主分发的内置清单。

| 业务应用 | 插件 id | 端 | 能力 |
| --- | --- | --- | --- |
| [**BedCode**](https://github.com/7ZAI/wasmnest-apps/tree/dev/apps/bedcode) | `com.wasmnest.bedcode` | 桌面 + 移动 | 终端会话中心：配对与信任、会话生命周期编排、任务队列与 Agent 集成；移动端为远程终端控制端 |
| [**AI Chatbox**](https://github.com/7ZAI/wasmnest-apps/tree/dev/apps/ai-chatbox) | `com.wasmnest.ai-chatbox` | 桌面 + 移动 | 多供应商 AI 对话：流式输出、多会话管理、JSONL 对话日志 |
| [**File Transfer**](https://github.com/7ZAI/wasmnest-apps/tree/dev/apps/file-transfer) | `com.wasmnest.file-transfer` | 桌面 + 移动 | 内网对端发现与双向文件传输：队列、暂停 / 恢复、断点续传、共享目录 |

**系统服务**（装配角色 `internal-business`）不进多任务卡，关闭的唯一入口是应用管理页（桌面）/ 应用详情页（移动）的「停用」。

| 系统服务 | 插件 id | 端 | 能力 |
| --- | --- | --- | --- |
| [**Monitor**](https://github.com/7ZAI/wasmnest-apps/tree/dev/servers/monitor) | `com.wasmnest.monitor` | 桌面 + 移动 | 运行监控：只读查看所有已加载 wasm 应用的运行时指标（内存 / 调用 / 燃料 / trap / 配额） |
| [**Auth Center**](https://github.com/7ZAI/wasmnest-apps/tree/dev/servers/auth-center) | `com.wasmnest.auth-center` | 桌面 | 认证中心：本机入站连接的唯一裁决者（fail-closed）；配对码 / QR / 信任 / 首连确认 / 认证策略 / 生物凭证 |

## 快速开始

### 前置要求

| 依赖 | 说明 |
| --- | --- |
| Node.js | ≥ 22（开发环境使用 24） |
| pnpm | `12.2.1`，由根 `package.json` 的 `packageManager` 固定；建议 `corepack enable` |
| Rust | stable（开发环境使用 1.98）；桌面应用另需 `scripts/wasip3-toolchain.sh` 钉住的 wasip3 nightly |
| sccache | **必需**。根 `.cargo/config.toml` 强制 `rustc-wrapper = "sccache"`，未安装时 cargo 直接失败（显性设计） |
| Tauri 2 | 桌面系统依赖见 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |
| Android | 仅移动端需要：Android Studio / SDK / NDK / JDK，版本随 Tauri 2 Android 工具链 |

### 获取四个仓库

```bash
mkdir wasmnest-workspace && cd wasmnest-workspace
git clone https://github.com/7ZAI/wasmnest.git
git clone https://github.com/7ZAI/wasmnest-lib.git
git clone https://github.com/7ZAI/wasmnest-apps.git
git clone https://github.com/7ZAI/wasmnest-test.git
```

### 安装依赖

```bash
cd wasmnest

# 根依赖（eslint / prettier / husky / 根脚本）
pnpm install

# 双端宿主各自独立 workspace，需要分别安装
pnpm --dir wasmnest-desktop install
pnpm --dir wasmnest-mobile install

# WIT 生成物与真源一致（日常开发门禁）
pnpm run check:wit

# 应用仓根依赖 + 各 app 工程依赖（每个 app 独立 pnpm workspace）
cd ../wasmnest-apps
pnpm install
for app in apps/*/desktop apps/*/mobile; do
  [ -f "$app/package.json" ] && (cd "$app" && pnpm install)
done

# 回到平台仓根；后续命令都在这里执行
cd ../wasmnest
```

> `pnpm run check:manifest` 校验的是**发布装配状态**：要求 `../wasmnest-lib` 与 `../wasmnest-apps` 的 HEAD 正好位于清单钉住的精确 tag（工作树干净）。日常开发分支通常领先 tag，此时报红属于预期。

测试仓不参与日常构建；改 HTTP / WS / 认证 / 文件传输等跨端协议时，再进入 `../wasmnest-test` 按该仓 README 安装依赖并跑真实互连。

### 运行桌面宿主

在平台仓根执行：

```bash
pnpm --dir wasmnest-desktop run tauri:dev
```

首次启动会自动补建缺失或陈旧的应用产物，并启动插件 watch。若应用依赖尚未安装，先完成上一步。

### 运行移动宿主

在平台仓根执行：

```bash
pnpm --dir wasmnest-mobile run tauri:android:dev
```

需要可用的 Android 设备或模拟器；应用改动进入宿主后需手动重新激活生效。

### 构建全部应用

在平台仓根执行：

```bash
pnpm --dir wasmnest-desktop run plugins:build
pnpm --dir wasmnest-mobile run plugins:build
```

产物写入 `src-tauri/resources/plugins/<end>/<id>/`，该目录不入库。桌面开发时的运行时副本在 `target/debug/resources/plugins/desktop/`，源目录删除不会自动同步。需要可分发宿主时，在桌面端跑 `pnpm run host:pack` 产出 `dist-host/` 资产（详见 [`docs/commands.md`](docs/commands.md) §3）。

## 开发一个应用

应用源码不在本仓：业务应用住 [`wasmnest-apps`](https://github.com/7ZAI/wasmnest-apps)，本仓只负责宿主、端内 SDK、装载与打包。

1. **选端与形态**：桌面应用是独立挂载包，入口为 `mountApp(root, env)`；移动应用是宿主壳运行面，入口为 `activate(context)` / `deactivate()`。File Transfer 是双端单 Rust 产物的特例（移动经 `desktop-compat` 桩）。
2. **声明清单**：`plugin.json` 写清 `id` / `platform` / `pluginType` / `permissions` / `contributes`；权限按最小集声明，未声明即拒。
3. **本地调试**：移动在应用工程内跑 `pnpm run dev` 起 SDK dev-shell（HMR）；桌面用桌面端 `pnpm run tauri:dev` 装载真实产物，或在应用工程内用 `dev:host`（需先用 `pnpm run host:pack` 产出宿主运行时）。
4. **接入与登记**：在桌面 / 移动端跑 `pnpm run plugins:build` 构建内置应用，桌面端用 `pnpm run plugins:dev -- --plugin <id>` 调试单个应用；新增 / 改名 / 停用应用必须同步 `release-manifest.json`，桌面应用还要同步构建与路由注册表（清单见 [`docs/codemap.md`](docs/codemap.md) §6）。
5. **契约与测试**：WIT / 权限 / 挂载契约见 [`docs/contracts.md`](docs/contracts.md)；应用侧工程结构、入口契约与测试要求见应用仓 [README](https://github.com/7ZAI/wasmnest-apps#readme) 与 [AGENTS.md](https://github.com/7ZAI/wasmnest-apps/blob/dev/AGENTS.md)。

## 常用命令

| 位置 | 命令 | 说明 |
| --- | --- | --- |
| 平台仓根 | `pnpm run check:wit` | WIT 拼装漂移锁（日常门禁） |
| 平台仓根 | `pnpm run check:links` | Markdown 死链锁 |
| 平台仓根 | `pnpm run test:run` | 根脚本自测 |
| 平台仓根 | `pnpm run check:manifest` | 发布装配一致性（开发分支通常为红） |
| 桌面 | `pnpm run tauri:dev` | 宿主开发（预建缺口 + 前端 watch） |
| 桌面 | `pnpm run plugins:dev -- --plugin <id>` | 单应用调试 |
| 桌面 / 移动 | `pnpm run plugins:build` | 全量构建内置应用 |
| 桌面 / 移动 | `pnpm run test:run` | 宿主与 SDK 的 vitest |
| 桌面 / 移动 | `cd src-tauri && cargo test` | 宿主 Rust 测试（部分 e2e 需先构建随包产物） |
| 移动 | `pnpm run tauri:android:dev` | Android 开发 |

> 包管理器一律 pnpm。**不要运行 `pnpm run test`**（vitest watch 不退出），一律用 `test:run`。发布打包（`tauri:build` / `host:pack`）、`cargo test`、E2E 等完整命令集见 [`docs/commands.md`](docs/commands.md)。

## 项目结构

```text
wasmnest/
├─ wasmnest-desktop/            # Tauri 2 桌面宿主
│  ├─ src/                      # 宿主壳（主屏 / 系统页 / 挂载槽 / 多任务预览）
│  ├─ src-tauri/                # Rust 宿主：插件域接线 + 安全闸门 + server
│  ├─ packages/plugin-sdk-desktop/  # 端内 SDK（bin/ dev 工具 + tools/componentize 随 npm 包发布）
│  ├─ scripts/                  # dev-run / plugin-build / host:pack
│  └─ e2e/ · bench/
├─ wasmnest-mobile/             # Tauri 2 Android 宿主
│  ├─ src/                      # 宿主壳（shell 注册表 + 运行面）
│  ├─ src-tauri/                # Rust 宿主 + gen/android 手写 Kotlin 面
│  └─ packages/plugin-sdk-mobile/
├─ scripts/                     # WIT 拼装 / 清单校验 / 路径 resolver / 打包 / 版本
├─ docs/                        # 架构 / 契约 / 前端 / 后端 / 安全 / 测试 / Git
│  ├─ adr/                      # 架构决策记录（ADR）
│  ├─ public/                   # 四仓共享通用规范
│  └─ knowledge/                # wasm 应用开发检查清单
├─ release-manifest.json        # 跨仓版本唯一表达
└─ AGENTS.md                    # 开发导航与硬边界（人与 AI 协作者共用）
```

## 架构与契约

**整体架构图**：[`docs/architecture/wasmnest-overall.html`](docs/architecture/wasmnest-overall.html)——archify 生成的可交互单文件架构图，克隆本仓后用浏览器打开即可（GitHub 网页端点击仅显示源码）。

### WIT 真源链

```text
能力仓 wit/core.wit + 各能力域 wit/<domain>.wit + wasmnest-contract
        │
        ├─ 平台仓 compose.json（声明本端组合了哪些分片）
        │        └─ node scripts/compose-wit.mjs --all
        ▼
双端 SDK 的 rust/wit/**（生成物，禁止手改，漂移锁钉住）
```

契约版本进入 wasm import 名。宿主与 guest 版本不一致时，实例化期会点名缺失的 interface 与需要重建的版本，而不是静默降级。

### 跨仓版本

`release-manifest.json` 同时校验：平台版本、能力仓 HEAD 精确 tag、应用仓 HEAD 精确 tag、契约版本、双端 WIT 指纹、每个端应用的产物名；其中 `hostRuntime` 段单独记录宿主运行时版本、构建 commit 与平台分发资产 sha256。发布顺序为 **能力仓 → 平台仓 → 应用仓**；未打 tag 的本地改动不会进入发布装配。

### 安全闸门

- **权限**：无默认授予，未声明即拒；高风险面按域拆分（`pty:spawn` / `pty:io`、`ws:client` / `ws:server`、`fs:pick` / `fs:read` / `fs:write` 等）。
- **出站**：三层判定（目标白名单 → 声明 URL → 记忆）+ 未命中一次授权；无 `AppHandle` 的无头 / 测试上下文 fail-closed。
- **前端**：Tauri ACL + CSP + 静态 lint 三层封锁，前端不能直连网络 / 文件 / 导航原语；三层封锁不含 IPC——同 webview 内的插件前端可经 `invoke` 触达宿主命令面，命令面信任边界与收敛裁决见 [ADR 0058](docs/adr/0058-frontend-trust-boundary-and-command-surface-threat-model.md)。
- **错误信封**：跨进程失败统一为 `{ code, request_id, params? }`，`code` 即前端 i18n key；技术细节只进宿主日志。

### 测试与锁

设计约束大量以可执行锁的形式存在：宿主零业务类型、CSP 三层封锁、命令注册完整性、热路径日志、i18n 逐字一致、WIT / 权限词汇 / wire 漂移等。锁失败时同步更新清单，禁止删锁或掏空断言。跨端协议改动还必须跑通测试仓的真实互连。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `check:manifest` 报红，但代码没改坏 | 它校验的是**发布装配**：能力仓 / 应用仓 HEAD 必须正好位于清单钉住的 tag。开发分支领先 tag 时红是预期；只有发布 / tag 流水线需要绿。 |
| cargo 命令直接失败，提示找不到 `sccache` | 根 `.cargo/config.toml` 强制 `rustc-wrapper = "sccache"`；安装并确保 `sccache` 在 PATH。这是显性失败设计，不要绕过。 |
| 改了应用但宿主里没生效 | 确认产物已写入 `src-tauri/resources/plugins/<end>/<id>/`；桌面 dev 运行时副本在 `target/debug/resources/plugins/desktop/`，源目录删除 / 重建不会自动同步。用 `plugins:build` / `plugins:dev` 重建，不要手工拷贝。 |
| 首次启动报缺少某个应用 | 应用依赖未安装或产物未构建。先按「安装依赖」装应用仓各工程，再跑 `plugins:build`，并确认兄弟目录布局正确。 |
| `pnpm run test` 一直不退出 | 它是 vitest watch 模式；一律用 `test:run`。 |
| Android 设备找不到 / 无线调试断连 | 先 `adb devices -l`；配对、反向隧道与多设备处理见 [`docs/commands.md`](docs/commands.md) §4.1。 |

## 文档

| 需求 | 入口 |
| --- | --- |
| 开发导航与硬约束 | [`AGENTS.md`](AGENTS.md) |
| 代码文件导航 / 任务路由 / 锁索引 | [`docs/codemap.md`](docs/codemap.md) |
| 命令全集 | [`docs/commands.md`](docs/commands.md) |
| 架构与宿主薄壳边界 | [`docs/architecture.md`](docs/architecture.md) |
| 整体架构图 | [`docs/architecture/wasmnest-overall.html`](docs/architecture/wasmnest-overall.html) |
| 架构决策记录（ADR） | [`docs/adr/`](docs/adr/README.md) |
| 插件 / SDK / WIT 契约 | [`docs/contracts.md`](docs/contracts.md) |
| 前端规范 | [`docs/frontend.md`](docs/frontend.md) |
| Rust 后端规范 | [`docs/backend.md`](docs/backend.md) |
| 安全与日志红线 | [`docs/security.md`](docs/security.md) |
| 测试与完成定义 | [`docs/testing.md`](docs/testing.md) |
| Git 与跨仓提交顺序 | [`docs/git.md`](docs/git.md) |
| 依赖方向与禁行清单 | [`docs/boundaries.md`](docs/boundaries.md) |
| 四仓通用规范 | [`docs/public/`](docs/public/) |

## 开发与贡献

1. **先读边界**：[`AGENTS.md`](AGENTS.md) 与 [`docs/public/`](docs/public/)（git 提交 / 注释命名 / 测试验证 / 版本号 / issue 管理）。硬约束与安全红线不是建议。
2. **小步提交**：只改任务必要文件，不夹带无关重构；提交信息遵循 Conventional Commits，不添加 AI 生成标记。
3. **实跑验证**：门禁 = CI required checks（PR：`check-wit` / `node-root` / `node-desktop` / `node-mobile` / `rust-check`）+ husky pre-commit + 本地命令 + 测试锁；全量 `cargo test` 与随包产物 e2e 在主线（当前 `dev`）推送 / nightly 跑。跳过了钩子不等于门禁通过，需要手工补跑并在交付说明里列出「跑了什么 / 没跑什么 / 风险」。
4. **跨仓改动**：按能力仓 → 平台仓 → 应用仓的顺序提交并打精确 tag，随后同步 `release-manifest.json` 并跑 `check:manifest`。
5. **Issue 优先**：跨会话的 backlog 以 [GitHub Issues](https://github.com/7ZAI/wasmnest/issues) 为真源，仓库内提供 bug / feature / contract-change 模板。

## 项目状态

- 版本线 `0.0.1`，研发起步期，接口可能发生破坏性变更。
- 平台仓 tag 形如 `vX.Y.Z`；能力仓 `lib-vX.Y.Z`，应用仓 `apps-vX.Y.Z`，测试仓 `test-vX.Y.Z`。
- 只有发布时才 bump 版本号和打 tag；日常开发不 bump。
- CI 分层见 [`.github/workflows/test.yml`](.github/workflows/test.yml)：PR 跑 node 层与 Rust 快检，主线（当前 `dev`）/ nightly 跑全量 `cargo test` 与随包产物 e2e。
- 路线图与任务清单通过 GitHub Issues 维护。

## 许可证

[MIT](LICENSE) © 2026 7ZAI
