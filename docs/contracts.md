# 插件与 SDK 契约（manifest / WIT / 权限 / 生成物）

> **本文件是 `AGENTS.md` 的拆分文档（契约）**：release-manifest 判据、WIT / 契约真源链、生成物清单、plugin.json 与 manifest、权限声明、WIT / ABI 变更流程、SDK。
> 本文件与 `AGENTS.md` 的硬约束**同级别**。真源在能力仓 sibling `../wasmnest-lib`；**改契约不在本仓生成物里改**。

## 1. release-manifest.json（跨仓版本唯一表达）

- **谁写**：平台仓发布流程；**谁读**：装配校验、各仓 release、CI。一致性判据（`pnpm run check:manifest`，逐条可复现）：
  1. `product` == 平台仓 `package.json` 版本；
  2. `repos.lib.tag` == 能力仓 `../wasmnest-lib` HEAD 的**精确 tag**（tag 漂移或工作树脏即红）；
  3. `contract.version` == `../wasmnest-lib/wasmnest-contract/src/lib.rs` 的 `PACKAGE_VERSION`；
  4. `contract.witSha256` == 双端组合 WIT 产物指纹（`node scripts/check-release-manifest.mjs --print-hash` 重算）；
  5. `apps` 段覆盖应用仓**全部** `apps/<slug>/<end>/plugin.json`（end 感知，`ends.<end>.artifact` == 该端 `rustLibrary + '.wasm'`）；每个 app 必填 `version`（semver），`ends.desktop` 必填 `package`（`<slug>-desktop-v<version>.zip`，应用仓 `app-release.yml` 的固定命名）与 `sha256`（64 位 hex）—— 发布时由 `scripts/vendor-apps.mjs` 按这两项下载并校验成品包；
  6. `repos.apps.tag` == 应用仓 HEAD 精确 tag（发布装配口径）；
  7. `hostRuntime` 段（宿主运行时独立版本线）：`version` 为 semver；`sourceCommit` 为 40 位 hex；`libTag` / `witVersion` / `sdkVersion` / `mountContract` 分别等于 `repos.lib.tag` / `contract.version` / 桌面 SDK 版本 / 宿主 `MOUNT_CONTRACT`。`artifacts` 字段**已退役**（2026-10-28：平台仓不再构建 / 发布任何 tar.gz，机器工件线 `host-release.yml` 与其回写脚本已删除）；字段残留即红（退役面 fail-visible），分发改走终端用户安装包。
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
- **桌面端清单扩展**：`backgroundTransport`（布尔，缺省 false）——服务端型应用在**运行期**（启动成功 → 停用 / Error）持有 `net.transport`（WS + HTTP + mDNS），界面挂载 / 卸载不决定其生死；代价是整段运行期对外可达，故必须同时声明 `ws:server` / `network:http` 至少一个（构建期 `manifest-validate.js` + 加载期 `wasm-core/manager/validation.rs` 双侧拒绝）。只在界面打开时供服的应用不要声明。

### 5.2 SDK（端内包，随端走）

- 桌面：`@binblink/wasmnest-plugin-sdk-desktop`（bin `wasmnest-plugin-desktop`；crate `wasmnest-plugin-api` + 宏 crate `rust-macros`）+ manifest / wasm-hash 工具面（`bin/manifest-gen.js` / `manifest-validate.js` / `wasm-hash.js`）。
- 移动：`@binblink/wasmnest-plugin-sdk-mobile`（bin `wasmnest-plugin`；crate `wasmnest-plugin-api-mobile`；含 `UIRegistry` 类型真源（`src/types.ts`）与 dev-shell）。
- SDK 版本一致性：npm `package.json` 与 `Cargo.toml` 必须一致（`scripts/package-sdks.mjs` 校验）；发布产物 = npm tarball + crates + zip + SHA256 清单。
- **桌面 dev-shell（2026-10-21 已对齐宿主）**：dev-shell 走**与宿主同一条装载路径**——加载 app 的 `src/entry.ts` 源码并调用 `mountApp(root, env)`，外围复刻宿主 chrome（标题栏 / 状态栏 / 挂载槽）。设计 token 走单一真源（alias 指向宿主 `src/style.css` + `src/shell/styles/shell.css`；npm 包内用自带副本，由 `dev-shell/__tests__/visualParity.test.ts` 钉住），挂载契约由 `dev-shell/__tests__/shell/contractDrift.test.ts` 与宿主 `src/shell/mount/useAppMount.ts` 逐字段比对。**改宿主挂载契约时必须同步改 dev-shell 侧声明，否则该锁测红**。
- **已知漂移（写明责任）**：桌面 SDK 的 `README.md` / `template/` 仍是旧贡献面形态（`activate(context)` + `__WASMNEST_SHARED__` 外置），与 ADR 0057 后的挂载包形态（`mountApp` + 自足打包）不一致——写新代码以应用仓现有 app 为准；该漂移的修复在**平台仓侧**（docs/codemap.md §6 任务路由「改 SDK」行）。

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
## 7. 发布线（唯一分发出口 = 终端用户安装包）

平台仓**不再发布任何 tar.gz**（2026-10-28 用户裁决）：机器工件线（`host-v*` + `host-release.yml`
+ `update-host-runtime-artifacts.mjs` + `hostRuntime.artifacts`）已整体删除，字段残留会被
`check:manifest` 判红。**有且只有一条发布线**：

| 项 | 值 |
| --- | --- |
| tag | `v<product>`（平台仓 tag 规则 = `vX.Y.Z`，**不带 host 前缀**） |
| workflow | `.github/workflows/product-release.yml`（`vendor` → `build` → `publish`） |
| 资产 | Windows `WasmNest-<ver>-release-x64-setup.exe`（NSIS perMachine）、Linux `WasmNest-<ver>-release-amd64.deb` + `WasmNest_<ver>_amd64.AppImage`、`latest.json`、各产物 `.sha256` |
| 消费方 | 终端用户 / 宿主自动升级（`plugins.updater.endpoints`） |

### 7.1 随包应用（vendor 阶段）

安装包里的应用**不本地构建**，直接取应用仓已发布的成品：

```
<slug>-<end>-v<X.Y.Z>.zip     plugin.json + index.js（已构建）+ icon + *.wasm（扁平一层）
<slug>-<end>-v<X.Y.Z>.json    元数据：artifact.sha256 / wasm.wasmHash / source.libRef
```

`scripts/vendor-apps.mjs` 按 `release-manifest.json` 的 `apps.<id>.version` +
`ends.desktop.package` / `sha256` 下载并铺进 `src-tauri/resources/plugins/desktop/<pluginId>/`，
执行三道校验（任一不过即中断，绝不产出空壳 / 坏壳安装包）：

1. zip 实际 sha256 == 清单 `ends.desktop.sha256`；
2. 元数据 `source.libRef` == 清单 `repos.lib.tag`（WIT 版本写在 import 名里，不等则实例化必失败）；
3. 解出的 `plugin.json`：`id` / `version` / `platform`（含本端）/ `rustLibrary + '.wasm'` / `main` 全对齐清单。

> 应用版本是**清单字段**，不是「latest」：任何一个 app 发版，都要把平台清单里该 app 的
> `version` + `sha256`（+ `package`）同批更新，否则 `vendor` 会因 sha 不符直接红。

### 7.2 `latest.json`（自动升级入口）

- 生产者 = `scripts/build-latest-json.mjs`（`product-release.yml` 的 publish job），**禁止手写**。
- 必填：`version`（= `manifest.product`）/ `pub_date` / `platforms`；`platforms` 键是 Tauri updater 的 target key：

| target key | 产物 | 说明 |
| --- | --- | --- |
| `windows-x86_64` | `*-setup.exe` + `.sig` | NSIS（就地升级走新安装包） |
| `linux-x86_64` | `*.AppImage[.tar.gz]` + `.sig` | **Linux 唯一可升级形态** |

- `.deb` **不进** `platforms`（updater 在 Linux 只支持 AppImage 就地替换），但仍作为资产发布。
- `url` = `https://github.com/<repo>/releases/download/<tag>/<file>`；`signature` = 同名 `.sig` 内容。
- 失败口径：同 target 0 个 / 多于 1 个 / 缺 `.sig` / 空签名 → 抛错（残缺 `latest.json` 会让已装客户端的升级检查长期失败且无人察觉）。

### 7.3 签名物料（只在 GitHub Secrets，不入库）

| Secret | 作用 | 缺失后果 |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` | 升级包 minisign 签名 | 不生成 `.sig` → `latest.json` 组装失败 |
| `WINDOWS_CERTIFICATE_BASE64` / `_PASSWORD` | Windows Authenticode（`.pfx`） | 安装包弹「未知发布者」（SmartScreen） |

- 公钥真源 = `wasmnest-desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，必须与私钥配对；换钥 = 换公钥 + 换两个 secret，同时进行。
- 缺密钥时 `product-release.yml` **显性失败**，不产出未签名安装包；只验证流水线用 `workflow_dispatch` 的 `unsigned=true`（强制不发布）。
- 2023-06 后不再签发可导出 `.pfx` 的纯软件证书；改用云签名（Azure Trusted Signing / SSL.com eSigner）时，把「导入证书」步骤换成 `bundle.windows.signCommand`，其余契约不变。

### 7.4 版本真源

- 资产名里的 `<ver>` = `manifest.product`，构建时用 `--config '{"version":"<product>"}'` 覆盖；`tauri.conf.json` 的 `version` 仍是 `set-host-version.mjs` 的写入点（两条版本线共用一份构建配置，不改文件）。
- 发布前一致性：`manifest.product` == 根 `package.json` 版本 == tag 去掉 `v`；`product-release.yml` 逐项校验，不一致即红。
