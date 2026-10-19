# 插件与 SDK 契约（manifest / WIT / 权限 / 生成物）

> **本文件是 `AGENTS.md` 的拆分文档（契约）**：release-manifest 判据、WIT / 契约真源链、生成物清单、plugin.json 与 manifest、权限声明、WIT / ABI 变更流程、SDK。
> 本文件与 `AGENTS.md` 的硬约束**同级别**。真源在能力仓 sibling `../wasmnest-lib`；**改契约不在本仓生成物里改**。

## 1. release-manifest.json（跨仓版本唯一表达）

- **谁写**：平台仓发布流程；**谁读**：装配校验、各仓 release、CI。一致性判据（`pnpm run check:manifest`，逐条可复现）：
  1. `product` == 平台仓 `package.json` 版本；
  2. `repos.lib.tag` == 能力仓 `../wasmnest-lib` HEAD 的**精确 tag**（tag 漂移或工作树脏即红）；
  3. `contract.version` == `../wasmnest-lib/wasmnest-contract/src/lib.rs` 的 `PACKAGE_VERSION`；
  4. `contract.witSha256` == 双端组合 WIT 产物指纹（`node scripts/check-release-manifest.mjs --print-hash` 重算）；
  5. `apps` 段覆盖应用仓**全部** `apps/<slug>/<end>/plugin.json`（end 感知，`ends.<end>.artifact` == 该端 `rustLibrary + '.wasm'`）；
  6. `repos.apps.tag` == 应用仓 HEAD 精确 tag（发布装配口径）。
- **什么时候必须动它**：新增 / 改名 / 停用应用或变更 `rustLibrary`；WIT / 契约版本变更；能力仓指针移动；发布版本号变更。改动后跑 `pnpm run check:manifest`。

## 2. WIT / 契约真源链

```text
真源（能力仓 sibling `../wasmnest-lib`）：
  wasmnest-wasm-core/wit/core.wit                # 核心机制面
  各能力域 wit/<domain>.wit                      # 例如 wasmnest-pty-engine/wit/pty.wit
  wasmnest-contract/src/lib.rs                   # 包名与版本唯一手写处（零依赖 crate；PACKAGE_NAME / PACKAGE_VERSION / PACKAGE）
        │
端清单（本仓，声明「组合了什么」）：
  wasmnest-desktop/packages/plugin-sdk-desktop/compose.json   # core + 各 cap 分片（含端独有 wit-src/cap-*.wit）
  wasmnest-mobile/packages/plugin-sdk-mobile/compose.json
        │  node scripts/compose-wit.mjs --all（版本注入唯一发生在这里）
        ▼
生成物（本仓，**入库但禁止手改**，漂移由 husky / CI / 测试锁钉）：
  wasmnest-{desktop,mobile}/packages/plugin-sdk-{desktop,mobile}/rust/wit/**
```

**bump 政策**（ADR 0051 D4）：任何 WIT 变更（含函数级追加）→ patch；interface 增删 / 签名变 → minor。bump 后必须：重拼双端 WIT → 重建**受影响应用**的 wasm 产物（版本进入 import 名，宿主与 guest 不等即实例化失败，失败信息点名版本）→ 同步 manifest 的 `contract.version` / `witSha256` → `pnpm run check:wit` 与 `pnpm run check:manifest` 双绿。

## 3. WIT / ABI 变更流程（改契约不在本仓生成物里改）

1. 改能力仓真源（`../wasmnest-lib`）：`wasmnest-wasm-core/wit/core.wit` 或能力域 `wit/<domain>.wit`；按 bump 政策改 `wasmnest-contract/src/lib.rs` 的 `PACKAGE_VERSION`。
2. 能力仓提交 + 打 tag（`lib-vX.Y.Z`）；平台仓同步 `release-manifest.json`（`repos.lib.tag` / `contract.version`），不移动任何 submodule 指针（平台直接读 sibling 工作树）。
3. `node scripts/compose-wit.mjs --all` 重拼双端生成物 → `pnpm run check:wit`。
4. 受影响端更新 SDK 侧 Rust / TS 面（`packages/plugin-sdk-*/`），跑 SDK 测试。
5. 应用仓按当前 SDK **全量重建**受影响 app 产物（版本进入 import 名，旧产物实例化期被点名）。
6. `node scripts/check-release-manifest.mjs --print-hash` 更新 `contract.witSha256` → `pnpm run check:manifest` 全绿。
7. 涉及行为的改动补测试（含失败路径）；不留「兼容旧产物」的冗余路径（研发起步期，无 ABI 兼容义务）。

## 4. 权限

- **无默认授予**：权限位必须在 `plugin.json.permissions` 显式声明（`storage` 也一样），未声明即被拒。
- 词汇唯一真源 = 本端 SDK `rust/src/permission.rs`；打包 CLI 与宿主前端的列表都是**生成物**（桌面 SDK `bin/permission-vocabulary.json` 与各 `permission.vocabulary.ts`），禁止手抄；改真源后重跑桌面 SDK 目录 `pnpm run gen:permissions`。
- 高风险面按域拆分（`pty:spawn` / `pty:io`、`ws:client` / `ws:server`、`process:run` / `app:cli`、`task:run`、`crypto:*`、`fs:pick` vs `fs:read/write`……）：需要多少声明多少；文件走宿主授权链（docs/architecture.md §5），**不要试图绕过**。
- 出站（egress）走三层判定 + 声明（docs/architecture.md §5；`preauthUrls` 见 §4.1）；HTTPS 目标再校验收紧口径见能力仓 `wasmnest-server-http` 注释。
- 权限闸门的机制面（审批 SHA-256 钉扎 / fail-closed）见 docs/architecture.md §5 与 docs/security.md。

## 5. plugin.json 与 manifest

### 5.1 plugin.json 必填与端差异

- 必填字段：`name` / `version` / `platform` / `main` / `pluginType` / `permissions` / `contributes`（宿主反序列化无缺省，缺失即拒装）。
- `platform`：`desktop` / `mobile` / `both`，**必须覆盖本端**（两端宿主在扫描与 zip 安装两条入口 fail-visible 拒绝错端产物）；仅真正的双端单产物（file-transfer）写 `both`。
- `pluginType`：桌面内置应用 `rust-ts`（必须给 `rustLibrary`，与 Cargo 包名一致）；移动应用 `wasm`。
- `contributes` / `permissions` 可按源码自动填充（本端 SDK `bin/manifest-gen.js` 等）；**自动填充是便利不是真源**，声明仍须与实际调用一致。
- `wasmHash` 由桌面构建链注入**产物目录**的 `plugin.json`（按 `<rustLibrary>.wasm` 现算 SHA-256）；**源清单不写该键**。
- **移动端清单扩展**：`preauthDirs`（预授权目录，支持 `${downloads}` 等占位）/ `preauthUrls`（出站 URL 白名单 glob），宿主在 preauthorize 阶段收齐后一次弹窗；**桌面上这两个键无效**。

### 5.2 SDK（端内包，随端走）

- 桌面：`@binblink/wasmnest-plugin-sdk-desktop`（bin `wasmnest-plugin-desktop`；crate `wasmnest-plugin-api` + 宏 crate `rust-macros`）+ manifest / wasm-hash 工具面（`bin/manifest-gen.js` / `manifest-validate.js` / `wasm-hash.js`）。
- 移动：`@binblink/wasmnest-plugin-sdk-mobile`（bin `wasmnest-plugin`；crate `wasmnest-plugin-api-mobile`；含 `UIRegistry` 类型真源（`src/types.ts`）与 dev-shell）。
- SDK 版本一致性：npm `package.json` 与 `Cargo.toml` 必须一致（`scripts/package-sdks.mjs` 校验）；发布产物 = npm tarball + crates + zip + SHA256 清单。
- **已知漂移（写明责任）**：桌面 SDK 的 `README.md` / `template/` / `dev-shell/` 仍是旧贡献面形态（`activate(context)` + `__WASMNEST_SHARED__` 外置），与 ADR 0057 后的挂载包形态（`mountApp` + 自足打包）不一致——写新代码以应用仓现有 app 为准；该漂移的修复在**平台仓侧**（docs/codemap.md §6 任务路由「改 SDK」行）。

## 6. 生成物与产物治理（能改 vs 不能改）

| 面 | 性质 | 规矩 |
| --- | --- | --- |
| `packages/plugin-sdk-*/rust/wit/**` | 生成物（compose-wit） | **禁止手改**；改真源后重拼（§2 / §3）。被跟踪入库 + 漂移锁 |
| `plugin-sdk-desktop/bin/permission-vocabulary.json`、`**/permission.vocabulary.ts` | 生成物（权限词汇） | 真源 = 本端 SDK `rust/src/permission.rs`；重跑 `pnpm run gen:permissions`（桌面 SDK 目录） |
| `src-tauri/resources/plugins/**` | 构建产物 | 不入库；只由构建 / watch 脚本写入（勿手工拷） |
| `src-tauri/gen/schemas/**` | Tauri 生成物（ACL 清单） | 入库；由 `tauri dev/build` 重生成，不手工编辑 |
| `src-tauri/gen/android/**` | 混装：脚手架生成 + **手写 Kotlin 源码** | 手写面（`MainActivity.kt`、各 `*Plugin.kt`）是版本跟踪的一部分；`tauri android init` 重建后需手工恢复；改 Kotlin 必须 gradlew 验证 |
| `**/target/**`、`**/dist/**`、`node_modules/**` | 构建产物 | 不入库（.gitignore 已覆盖） |
| `pnpm-lock.yaml` / 被跟踪的 `Cargo.lock` | 锁文件 | **只经包管理器变更，禁止手编**（宿主 `src-tauri/Cargo.lock` 刻意不入库；SDK / 夹具的 Cargo.lock 入库） |
| 不入库清单补充 | — | `*.local`、`gen/android/.../assets/_up_/`、宿主 `src-tauri/Cargo.lock`、生成物权限词汇文件（.gitignore / .prettierignore 已覆盖） |
| 发布签名材料 | — | 本地持有，不入库（TAURI_SIGNING_PRIVATE_KEY 等，见 docs/security.md §1） |