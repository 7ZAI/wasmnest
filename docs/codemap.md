# Code Map —— 平台仓代码导航

> **本文件是 `AGENTS.md` 的拆分文档（代码文件导航）**：仓结构树、端内模块导览、任务路由、代码查找纪律、文档索引。
> 本文件与 `AGENTS.md` 的硬约束（「必须 / 禁止」字样）**同级别**；机制细节与契约真源仍以代码头注释 / 能力仓 WIT / `release-manifest.json` 为准。
> 引用任何路径 / 命令 / 锁名前先 `ls` / `rg` 核对（**文档字面 ≠ 事实**）；与实际不符先修文档再继续。

## 1. 仓结构

**平台仓 = 双端宿主 + 端内 SDK + 根工具；Rust 无根 workspace。** 代码真源：能力仓（`../wasmnest-lib`，全部内部依赖 crate）、应用仓（`../wasmnest-apps`）、测试仓（`../wasmnest-test`）。平台经 Cargo sibling path 直接消费能力仓，不复制、不挂载。

```text
wasmnest/                                   # 平台仓根（本文件所在）
├─ AGENTS.md                                # 定位 / 冲突裁决 / 红线判据 / 导航骨架
├─ docs/                                    # ★ 本目录：AGENTS.md 的拆分文档（本文 + commands/architecture/…）
│                                           #   + knowledge/（迁自旧仓的 wasm 应用开发检查清单，issue #14）
├─ wasmnest-desktop/                        # 桌面宿主（Tauri 2 + Vue 3）
│   ├─ src/                                 # 宿主壳（ShellHost：主屏 + 系统页 + 挂载槽），见 §2.1
│   ├─ src-tauri/                           # 桌面 Rust 宿主（插件机制接线 / 安全闸门 / 服务器），见 §2.2
│   ├─ packages/plugin-sdk-desktop/         # 桌面端内 SDK（npm + crates；bin/ dev 工具与 tools/componentize 随包发布）
│   ├─ packages/plugin-{bench-test,sdk-fixtures,system-test}/  # 宿主测试夹具包
│   ├─ docs/                                # wasm 应用开发指南 + knowledge/ API 参考（迁自旧仓，issue #14）
│   ├─ scripts/                             # dev-run / tauri-build / plugin-build / plugin-dev /
│   │                                       # package-host / 图标生成 / target 治理
│   ├─ e2e/ · bench/                        # WDIO E2E（smoke/bench）· 基准数据打包（驱动在 wasmnest-test/perf-tests）
│   └─ resources/ · tailwind/postcss/stylelint/tsconfig/wdio…
├─ wasmnest-mobile/                         # 移动宿主（Tauri 2 Android + Vue 3）
│   ├─ src/                                 # 宿主壳（/mobile/shell：注册表 + 运行面）＋ 少量既有页面，见 §3.1
│   ├─ src-tauri/                           # 移动 Rust 宿主（含 gen/android 手写 Kotlin 面），见 §3.2
│   ├─ packages/plugin-sdk-mobile/          # 移动端内 SDK（wasmnest-plugin-api-mobile）
│   ├─ packages/plugin-component-test/      # 组合件桥测试夹具
│   ├─ docs/                                # 移动 wasm 应用开发指南（迁自旧仓，issue #14）
│   └─ scripts/                             # dev-run / plugin-build / android-dev-log / target 治理
├─ scripts/                                 # 根工具（见 §5）：compose-wit / app-paths / lib-paths / app-script /
│                                           # adaptive-run / bump-version / package-sdks / target 治理 / wasip3-toolchain
├─ release-manifest.json                    # 跨仓版本唯一表达（判据见 docs/contracts.md §2.1）
├─ .cargo/config.toml                       # sccache 强制前置 + 并发兜底（未装 sccache 直接失败，显性设计）
├─ .husky/pre-commit                        # WIT 漂移锁 + 暂存前端文件 eslint + markdown 死链锁（见 docs/commands.md §7）
└─ eslint.config.js                         # 双端共用前端静态锁（零资源访问红线，见 docs/frontend.md）
```

**能力仓（仓外 sibling `../wasmnest-lib`）**：`wasmnest-contract/`（包名 / 版本常量）、`wasmnest-wasm-core/`（机制内核 + `wit/core.wit` + `db/schema.sql`）、各能力域 / 传输面 crate；平台宿主 Cargo path 写死 `../../../wasmnest-lib/<crate>`，版本由 `release-manifest.json` 的 `repos.lib.tag` 钉住。

**双端一句话**：桌面 = 同窗口全屏挂载独立构建的应用包（机制 B）；移动 = 宿主壳运行面（`registerSurface` 等运行时注册），共享模块外置宿主全局与桌面不同（差异细则见 docs/architecture.md §4）。

**应用清单**（真源 = 各端构建注册表 + `release-manifest.json`；本表只是导航）：

| slug（应用仓目录） | 插件 id | 端 | 前端形态 |
| --- | --- | --- | --- |
| agent-hub | `com.wasmnest.agent-hub` | desktop | 桌面挂载包 |
| ai-chatbox | `com.wasmnest.ai-chatbox` | desktop + mobile | 挂载包 / 壳运行面 |
| bedcode（显示名 BedCode） | `com.wasmnest.terminal-session` | desktop + mobile | 挂载包 / 壳运行面 |
| file-transfer | `com.wasmnest.file-transfer` | desktop + mobile | 双端单产物（移动经 `desktop-compat` 桩） |
| monitor | `com.wasmnest.monitor` | desktop + mobile | 挂载包 / 壳运行面（只读运行指标） |

**产物流向**（应用源码住应用仓，产物落本仓宿主资源目录；`resources/plugins/**` 不入库）：

```text
../wasmnest-apps/apps/<slug>/<end>/            源码（前端 + rust/）
   │ 前端：desktop = vite 单文件包（全依赖打包，无 externals）
   │       mobile  = SDK vite 插件（vue/vue-i18n/pinia 外置宿主全局 __WASMNEST_SHARED__）
   │ 后端：desktop = wasm32-wasip3 直出 Component；mobile / file-transfer = wasm32-unknown-unknown + 桌面 SDK 的 tools/componentize
   ▼
wasmnest-desktop/src-tauri/resources/plugins/desktop/<id>/   { index.js, plugin.json, icon.svg, <rustLibrary>.wasm }
wasmnest-mobile/src-tauri/resources/plugins/mobile/<id>/     { 同上 }
   │ 桌面经 useAppMount 运行时装载；移动经壳运行面注册
   ▼
宿主扫描（桌面资源目录 + 用户安装目录；移动 APK assets + 安装目录）
```

**相邻仓**（本地 R1 布局）：`../wasmnest-lib`（能力仓，全部内部依赖 crate 的真源；平台经 Cargo sibling path 直接消费，版本由 `release-manifest.json` 钉 tag）、`../wasmnest-apps`（应用仓，业务主场，其 `AGENTS.md` 是应用侧硬约束）、`../wasmnest-test`（跨端测试仓，工程本体在 `cross-end-tests/`）。旧仓 `BedCode`（工作区外一级 `../../BedCode/`）代码冻结，转为**文档真源与回退点**（ADR / knowledge / code-map）。

## 2. 桌面端导览（`wasmnest-desktop/`）

### 2.1 前端宿主壳（`src/`）

| 路径 | 职责（头注释为准） |
| --- | --- |
| `main.ts` | 宿主入口（壳装配 / 路由 / i18n / 权限配置） |
| `router/index.ts` | 路由真源之一：`/` 主屏、`/sys/:pageId` 系统页、各 app 路由（指向 `AppMountSlot`）、未匹配显性 not-found |
| `shell/` | 宿主壳：`ShellHost.vue` 根组件；`mount/`（`AppMountSlot.vue` + `useAppMount.ts` = 挂载槽 + 装载机制，`appSurfaceRegistry.ts` = 表面实例记账（attach / detach / dispose，表面保活），`AppPreviewTile.vue` = 多任务卡的应用自绘预览面装载 / 3s 超时 / 回退品牌卡）；`sys/`（系统页）；`settings/`；`auth/`；`extensions/`（壳扩展点注册表：状态栏项 / 设置项 / 主题皮肤，只注册排序、不解释业务语义） |
| `shell/composables/useShellApps.ts` | **应用路由真源**：`SURFACE_ROUTES`（新增桌面应用必须同步，见 §6） |
| `shell/types.ts` · `state.ts` / `useShellState.ts` | 壳状态面（宿主零业务状态：首次打开创建、切走只藏、停用 / 卸载才销毁） |
| `components/` · `composables/` · `stores/` | 宿主公共组件 / 逻辑 / 存储 |
| `i18n/host-{zh-CN,en}.ts` | 宿主消息集（**与 bedcode 应用副本逐字一致**，`i18nDriftLock` 钉住） |
| `utils/` | `frontendLogger.ts`（落盘差异见头注释）、`invoke.ts`（带超时 IPC，错误信封）、`appCommands.ts`、`userError.ts` 等 |
| `__tests__/` | vitest 测试树（含各锁，见 §7） |

### 2.2 Rust 宿主（`src-tauri/src/`）

| 路径 | 职责（头注释为准） |
| --- | --- |
| `lib.rs` | crate 入口：模块声明、整核抽出垫片、bench_channel（`#[cfg(debug_assertions)]`）、PluginDevWatcher（emit `plugin:dev-reload`） |
| `commands.rs` · `system.rs` · `server.rs` | 宿主命令面 / 系统面（配置 / 日志）/ 服务器（peer 网络命令） |
| `plugin.rs` | 宿主侧插件能力面总入口（各域实现汇入 Linker，AbiPolicy 注入） |
| `plugin/*.rs` | ★ **插件域接线解密入口**：每域一个文件（api_call / app / assets / auth / bindings / connection / crypto / fs / guest_events / host_facts / http / lifecycle / mdns / notify / peer / platform / platform_picker / process / pty / task / timer / ws）。**端口 adapter + 白名单条目同处，先读文件头注释** |
| `assets.rs` | `plugin_get_asset_dir`（启动装配解析的唯一 plugins_dir，含 dev 回退） |
| `crypto.rs` | 宿主加密引擎（无业务语义的中性原语） |
| `first_party_dirs.rs` | 第一方免弹窗归属清单 |
| `mdns.rs` · `server/` | mDNS 发现 / 服务器实现 |
| `system/logging.rs` | tracing 装配（reload filter / 前端落盘） |
| `tests/` | 集成测试 + 大量锁：`capabilities_lock.rs`（CSP 三层封锁，见 docs/frontend.md §2.2）、`capability_crates_no_product_ids.rs`（宿主零业务类型）、`capability_crates_unit_tests_only.rs`、`hot_path_logging_lock.rs`、`component_e2e.rs`、`domain_contract_structure_locks.rs`、`empty_dir_lock.rs`、`a03_probe_products.rs` 等（头注释各自点名锁什么） |

### 2.3 桌面端测试夹具包（`packages/`）

| 包 | 用途 |
| --- | --- |
| `plugin-sdk-desktop` | 端内 SDK（见 docs/contracts.md §5） |
| `plugin-bench-test` | 桥接基准夹具 |
| `plugin-sdk-fixtures` | SDK 契约测试夹具 |
| `plugin-system-test` | 系统面测试夹具 |

### 2.4 桌面脚本（`scripts/`）

`dev-run.js`（宿主 dev：端口预检 → WASM/前端缺失预建 → tauri dev → `PLUGIN_WATCH_CMDS` 起前端 watch；bedcode 前端不参与 watch）、`plugin-build.js`（`PLUGINS` 注册表 = 5 个应用名单单一真源）、`plugin-dev.js`（单插件 dev）、`tauri-build.js`（updater 签名）、`package-host.mjs`（`host:pack` 宿主产物分发，见 docs/commands.md §3）、`check-target-size.js`（target 治理）、`generate-*.js`（图标生成）、`install-tauri-deps.sh`。**每个脚本头注释自解释。**插件前端 watch 闭环（`plugin-watch.js`）已随桌面 SDK 发布（`packages/plugin-sdk-desktop/bin/`），`dev-run.js` 反向引 SDK 内同一份实现。

## 3. 移动端导览（`wasmnest-mobile/`）

### 3.1 前端宿主壳（`src/`）

| 路径 | 职责（头注释为准） |
| --- | --- |
| `main.ts` | 宿主入口 |
| `shell/` | ★ **移动宿主壳优先（强制）**：新功能 / 重构 / 样式调整默认落这里（docs/frontend.md §3） |
| `shell/registry.ts` | 运行面注册表（**只注册不决策**；`registerSurface` 等） |
| `shell/index.ts` · `types.ts` · `permissions.ts` · `utils.ts` | 壳类型面 / 权限面 / 工具 |
| `shell/adapters/` · `components/` · `composables/` · `views/` | 壳公共组件 / 机制（复制进壳，不 import 旧目录，L7 锁） |
| `plugin/` | 移动插件系统：`loader.ts`（插件装载）、`registry.ts`（注册表）、`context.ts`（invoke 上下文 + **四点退役扩展点抛错桩**）、`commands.ts`、`permission.ts`、`terminal-stream.ts`、`sessionCommands.ts`、`shared-runtime.ts`（`__WASMNEST_SHARED__` 代理）等 |
| `utils/` | `frontendLogger.ts`（release 整体空实现，见头注释）、`connectionError.ts`、`clipboard.ts` 等 |
| `locales/{zh-CN,en}/` | 宿主 i18n（含 `errorCodes.ts`） |
| `components/` · `views/` · `composables/` · `stores/` · `services/` | 既有旧页面 / 服务（**只接受缺陷修复**，直到被 shell 彻底替换） |
| `__tests__/` | vitest 测试树（shell 系列锁 22 个，见 §7） |

### 3.2 Rust 宿主（`src-tauri/src/`）

| 路径 | 职责（头注释为准） |
| --- | --- |
| `plugin/` | 插件系统：`loader.rs` / `manager.rs` / `registry.rs` / `bindings.rs` / `commands.rs` / `approval.rs`（**内容 SHA-256 钉扎审批**）/ `desktop_compat.rs`（file-transfer 双端单产物的 fail-visible 桩）/ `terminal_stream.rs` / `saf_io.rs` / `saf_path.rs` / `fs_mobile.rs` / `downloader.rs` / `host_ports.rs` / `peer_ports.rs` / `android_plugins.rs` / `types.rs` 等 |
| `auth/` · `connection/` · `peer/` | 认证 / 连接 / 配对面 |
| `file_service/` | SAF 文件服务 |
| `router.rs` · `handler.rs` · `commands.rs` | 路由 / 处理 / 命令注册（`command_registration_completeness_lock` 钉住） |
| `egress.rs` | 出站判定（三层，fail-closed） |
| `system.rs` · `mdns.rs` · `enums.rs` · `model.rs` · `state.rs` | 系统面 / 枚举 / 模型 / 状态 |
| `gen/android/` | **混装面**：`app/src/main/java/com/wasmnest/mobile/` 下手写 Kotlin（`MainActivity.kt` + 各 `*Plugin.kt`：SafPicker / FileDelete / AllFilesAccess / BiometricKey / DownloadsDir / DeviceInfo / TaskNotification / StatusBarStyle / ForegroundService / PluginAssetExtractor 等）——`tauri android init` 重建后需手工恢复；改 Kotlin 必须 gradlew 验证 |

> 移动宿主业务代码分桶盘点与薄壳例外表（B1–B6 判据 / 处置方向与票号 / Q2 截止条件，Rust 与旧前端五目录）→ `docs/host-exceptions.md`。

### 3.3 移动脚本（`scripts/`）

`dev-run.js`（Android dev：adb 定位 / 插件 watch；插件改动进应用后需**手动重新激活**生效）、`plugin-build.js`（扫描 `../wasmnest-apps/apps/*/mobile` 全量构建，无宿主侧注册表）、`android-dev-log.js`、`build-terminal-font.mjs`、`check-target-size.js`、`adb-fd0-shim.sh`、`lib/`。

## 4. 根工具（`scripts/` 与 `tools/`）

| 脚本 | 职责 |
| --- | --- |
| `compose-wit.mjs` | 双端 WIT 拼装（版本注入唯一发生处；`--all --check` = 漂移锁判据） |
| `check-release-manifest.mjs` | `release-manifest.json` 一致性校验（`--print-hash` 打印 WIT 指纹，更新 manifest 用） |
| `app-paths.mjs` | **应用仓路径 resolver 唯一入口**（`WASMNEST_APPS_ROOT` / R1 兄弟布局，缺仓显性抛错） |
| `lib-paths.mjs` | **能力仓路径 resolver 唯一入口**（`WASMNEST_LIB_ROOT` / R1 兄弟目录 `../wasmnest-lib`，缺仓显性抛错） |
| `app-script.mjs` | 转发到应用仓单 app 脚本（如 `build:frontend`） |
| `adaptive-run.mjs` | 自适应构建包装（档位 / 逃生阀） |
| `build-profile.mjs` | 构建档位采样（`adaptive-run` 底层） |
| `bump-version.mjs` | 双端版本号（各 3 处） |
| `package-sdks.mjs` | 双端 SDK 构建 + 打包（npm tarball + crates + zip，校验 npm/Cargo 版本一致） |
| `audit-rust-tests.mjs` · `split-rust-tests.mjs` · `run-test-split.sh` | Rust 测试体量审计 / 拆分 / 批量跑（见 docs/testing.md §3） |
| `wasip3-toolchain.sh` | wasip3 工具链 pinned nightly 单一事实源（`WASIP3_NIGHTLY`；切换点写在该脚本头注） |
| `packages/plugin-sdk-desktop/tools/componentize/` | Component 化工具（wasm32-unknown-unknown → Component；file-transfer 与移动产物用；随 npm 包发布） |

## 5. 能力仓（`../wasmnest-lib`）——记住边界

- 能力仓是**全部内部依赖 crate 的唯一真源**：平台宿主 Cargo path 写死 `../../../wasmnest-lib/<crate>`，不复制、不镜像、不挂 submodule。
- 能力仓改动一律去 `../wasmnest-lib` 提交、打 tag（`lib-vX.Y.Z`），平台只更新 `release-manifest.json` 的 `repos.lib.tag`（完整流程见 docs/git.md §1 与 docs/contracts.md §3）。
- 常用真源落点：`wasmnest-wasm-core/wit/core.wit`、能力域 `wit/<domain>.wit`（pty / http / ws 等）、`wasmnest-contract/src/lib.rs`、`wasmnest-server-base/src/constants.rs`（`PLUGIN_DEV_RELOAD = "plugin:dev-reload"` 等事件名）、`wasmnest-server-base` 的 `error.rs`（ADR 0030 错误信封）。
- `WASMNEST_LIB_ROOT` 可覆盖默认兄弟目录；node 侧唯一 resolver = `scripts/lib-paths.mjs`，测试仓 = `tests/common/repo_paths.rs::lib_root()`。

## 6. 任务路由：改 X 先读 Y

> 动手前先在 `git status` 认领改动来源，再按本表读对应文件头注释；**新增 / 改名桌面应用**涉及多仓多面，逐项点名（见「新增桌面应用」行）。

| 任务 | 动手前必读 |
| --- | --- |
| 改桌面宿主壳 / 挂载槽 / 系统页 | `wasmnest-desktop/src/main.ts` + `src/shell/**`（`src/shell/composables/useShellApps.ts` = 应用路由真源）+ docs/architecture.md §2；跑桌面 `test:run` + 真实 `tauri:dev` 目验 |
| 改桌面设置页 / 状态栏 / 壳皮肤 | `src/shell/extensions/**`（注册表契约）+ `src/shell/components/ShellStatusBar.vue` + `src/shell/settings/Settings{ThemeSkin,Extensions}Section.vue` + `src/shell/sys/SysSettingsView.vue`（**关于固定最后**）；机制口径见 docs/frontend.md §6；跑桌面 `test:run`（含 `settingsOrderLock` / `shellExtensions` / `shellStatusBar`） |
| 改多任务卡片 / 应用预览面（`mountPreview`） | `wasmnest-desktop/src/shell/components/ShellTaskSwitcher.vue` + `src/shell/mount/{useAppMount.ts,AppPreviewTile.vue}`（`mountAppPreview(root, env)` = 装载入口，`PREVIEW_MOUNT_TIMEOUT_MS` = 3s）+ `src/shell/mount/appSession.ts`（`lastRoute`）；契约 = `AppPreviewEnv` / `AppPreviewHandle` / `MountPreview`（宿主与五个 app `entry.ts` 同形，L5 锁钉住）；应用侧内容裁决在 `../wasmnest-apps`；跑桌面 `test:run` + 应用仓各 app `test:run` / `build:frontend` + 真实 `tauri:dev` 目验 |
| 改移动宿主壳 / 运行面 / 注册表 | `wasmnest-mobile/src/shell/registry.ts`（职责边界：只注册不决策）+ 移动 SDK `src/types.ts`（`UIRegistry`）+ docs/architecture.md §4；优先移动 SDK dev-shell 预览 |
| 改插件机制 / 生命周期 / 能力接线（Rust） | 该端 `src-tauri/src/plugin/**`（每域一个文件，端口 adapter + 白名单条目同处，**先读文件头注释**）+ 能力仓对应 crate；跑该端 `cargo test` |
| 改权限 / 授权闸门 | 本端 SDK `rust/src/permission.rs`（词汇真源）+ docs/contracts.md §4 + docs/security.md §1；生成物重出（桌面 SDK 目录 `pnpm run gen:permissions`）；跑相关锁 |
| 改 WIT / ABI / 契约 | docs/contracts.md §2/§3 全链 + `scripts/compose-wit.mjs`；**不在端生成物里改**；改完重拼、重建受影响 app 产物、同步 manifest |
| 改 SDK（TS / Rust 面） | 该端 `packages/plugin-sdk-*/`（README + `src/types.ts` / `rust/src/lib.rs`）；跑 SDK `test:run`；发布走 `package-sdks.mjs`。**桌面 SDK 的 README / template 仍是旧贡献面形态（已知漂移，docs/contracts.md §5.2）——写新代码以应用仓现有 app 为形态基准** |
| 改桌面 dev-shell（浏览器预览） | `packages/plugin-sdk-desktop/dev-shell/`（`src/shell/types.ts` = 挂载契约声明 + `src/shell/mount/devAppMount.ts` = 装载 + `src/shell/components/**` = 宿主 chrome + `src/mock/**` = 命令 / 事件 mock）；**改宿主 `src/shell/mount/useAppMount.ts` 的契约或 `src/style.css` / `src/shell/styles/shell.css` 的 token 时必须同步 dev-shell 侧**（两道锁：`dev-shell/__tests__/shell/contractDrift.test.ts` + `dev-shell/__tests__/visualParity.test.ts`）；跑 SDK `test:run` |
| 改构建 / dev 脚本 | 对应脚本头注释（自解释）+ 根 `scripts/app-paths.mjs`；桌面还有 `src/__tests__/scripts/pluginWatchCopy.test.ts` 等脚本锁 |
| 新增 / 改名 / 停用桌面应用 | 应用仓先按 `../wasmnest-apps/AGENTS.md` §5 清单走；本仓四处注册表 + 一处路由 + 两处锁必须同步：`scripts/plugin-build.js` `PLUGINS`、`scripts/plugin-dev.js` `PLUGINS`、`scripts/dev-run.js` `PLUGIN_WATCH_CMDS`、`src/shell/composables/useShellApps.ts` `SURFACE_ROUTES`（+ `src/router/index.ts` 路由条目）、`hostAppBoundaryLock.test.ts` 的 `APP_ENTRIES` + `release-manifest.json` |
| 新增 / 停用移动应用 | 移动构建自动扫描 `apps/*/mobile`（无注册表）；只需同步 `release-manifest.json`；机制差异读 docs/architecture.md §4 |
| 改跨端传输 / 认证 / 配对面 | docs/architecture.md §6（跨端协议）；改完去 `../wasmnest-test/cross-end-tests` 跑真实互连（零 mock） |
| 改 Android 原生（Kotlin / manifest / gradle） | `wasmnest-mobile/src-tauri/gen/android/**`；改 Kotlin 必须 gradlew 验证；`tauri android init` 重建后手工恢复手写面 |
| 排查「改了没生效」/ 产物路径 | 桌面 `scripts/{dev-run,plugin-build}.js` 与 `packages/plugin-sdk-desktop/bin/plugin-watch.js`、移动 `scripts/plugin-build.js`、根 `scripts/app-paths.mjs`；先确认产物是否真写进 `src-tauri/resources/plugins/<end>/<id>/`；再确认宿主扫描目录（桌面 dev 是 `target/debug/resources/…` 运行时副本——源目录删除不会自动同步，幽灵目录只在这里活着） |
| 发布 / 版本 | docs/contracts.md §2.1（manifest 判据）+ `scripts/bump-version.mjs` + `scripts/package-sdks.mjs`；三仓 tag 规则见 docs/git.md §3 |
| 定位代码 | 本文 §7（代码查找纪律） |

## 7. 代码查找纪律

- 探索定位**先读目录级头注释**：本文 §1 树 → 目标目录（如 `src-tauri/src/plugin/` 每域一个文件，头注释写明职责与接线口径）→ 再 `ls` / `rg` 找文件；禁止未读头注释就全仓盲 grep。
- 两端同构文件（`frontendLogger` / `invoke` / `check-target-size` / `dev-run` / i18n 等）改动前先看另一端是否有同源副本——同构纪律要求同批修改或写明只改一端的原因。
- 生成物与源文件同名混淆高发（`rust/wit` vs `compose.json`；权限词汇 vs `permission.rs`）：改前确认自己在改「真源」还是「生成物」（docs/contracts.md §2.3）。
- 锁索引：分析「为什么这么写」时，优先找同名 `.test.ts` / `*_lock.rs`——本仓大量设计约束以锁形态存在，读锁最快（锁清单见 §8）。

## 8. 锁索引（读锁最快的设计约束）

| 锁 | 位置（本仓） | 钉住什么 |
| --- | --- | --- |
| `hostAppBoundaryLock.test.ts` | `wasmnest-desktop/src/__tests__/` | 宿主零 app 源码 import、零 `__WASMNEST_SHARED__`、零旧贡献面；逐字校验五个桌面 app `src/entry.ts` 的 `mountApp` 契约；**L5 预览契约锁**：五个 entry 必须导出 `mountPreview` 且带 `appId` / `lastRoute` / `appInvoke` / `appStorageGet` / `locale` / `theme` 关键字段、宿主声明 `AppPreviewEnv` / `AppPreviewHandle` 且 `mountPreview?` 可选、预览路径禁用 `refreshChannelToken` / 写存储（**新增 / 改名桌面应用必须同步其 `APP_ENTRIES`**） |
| `i18nDriftLock.test.ts` | 同上 | 宿主 `src/i18n/host-{zh-CN,en}.ts` ↔ `apps/bedcode/desktop/src/i18n/host-{zh-CN,en}.ts` **逐字一致** |
| `tailwindContentCoverage.test.ts` | 同上 | 宿主 Tailwind content 不得残留 app 路径 |
| `appBundlePathLock.test.ts` · `appChromeLock.test.ts` | `wasmnest-desktop/src/__tests__/shell/` | 挂载包路径单一来源（`resources/plugins/desktop` 层级）；壳标题栏常驻、应用不得自绘标题栏/窗口控制/拖拽区 |
| `appSurfaceKeepAlive.test.ts` · `useAppMountKeepAlive.test.ts` | `wasmnest-desktop/src/__tests__/shell/mount/` | **表面保活**：挂载槽常驻（`v-show`，不得回 `v-if` 分支）、销毁点唯一在 `ShellHost` 运行态 disposer、挂载槽切走只 `detach`、界面租约跟实例生命周期（首次创建 acquire / dispose release）、`setActive?` 是可选契约；装载层行为（复用不重建、detach 不销毁、并发首次 mount 合并为一次） |
| `shellExtensions.test.ts` · `shellStatusBar.test.ts` · `shellExtensionWiring.test.ts` · `settings/settingsOrderLock.test.ts` | `wasmnest-desktop/src/__tests__/shell/` | 壳扩展点注册语义（排序 / 覆盖 / Disposable / 皮肤 token 校验）、状态栏分区与动作失败隔离、ShellHost 装配接线、设置页顺序（**关于固定最后**） |
| `pluginWatchCopy.test.ts` · `pluginPrecheck.test.ts` | `wasmnest-desktop/src/__tests__/scripts/` | 插件 watch 复制闭环（`copyIfChanged` / `copyManifestIfChanged` / `copyWatchArtifacts` 三组临时目录行为锁，#23 将复制链提为可注入依赖的导出）；**dev 预检四步行为锁**（`scripts/plugin-precheck.mjs` 陈旧判定 / `--out` 直写 resources / `--rust-only` 快路径 / fail-fast / WASM→前端→清单→退役清理四步顺序，可注入依赖不触发真实构建）+ 接线锁 2 条轻量：`startPluginWatch` 调用共享复制链、`dev-run.js` 的 `runPluginPrecheck()` 先于宿主启动点（issue #12 / #23，内部函数名不再逐个点名）；bedcode `--frontend-only` 由沙箱 fixture 驱动真实 build.js |
| 移动壳系列锁：`shellConstraintLocks`（含 **L7 壳内自足**）、`retiredHostUIRetirementLocks`、`shellRegistry` / `shellPermissions` / `shellMechanisms` / `shellHostEvents` / `shellAppSurface` / `shellAppRunScreen` / `appSurfaceKeepAlive` / `useAppSurfaces` / `shellHomeScreen` 等 20+ | `wasmnest-mobile/src/__tests__/shell/` | 壳内自足（不依赖旧界面目录）、退役路由 / 符号不回接、壳迁移面不得缩水、注册表 / 权限 / 机制行为；**运行面保活**（运行屏只提供插槽、池按「打开过 ∩ 运行中」过滤、停用即出池、Teleport 前后台切换不重建） |
| `crate-structure-lock.test.mjs` | 根 `scripts/`（`pnpm run test:run`） | 契约 crate 常量保持 node 正则可解析的字面量形状；能力仓（`../wasmnest-lib`）无逃出 crate 目录的 `include!` / `include_str!` / `bindgen!` 路径；双端 `compose.json` 声明的 WIT 路径存在 |
| `check-markdown-links.mjs` | 根 `scripts/`（`pnpm run check:links`；husky pre-commit 暂存含 .md 时自动跑，issue #14） | 仓内跟踪 markdown 的**相对链接**（含图片）目标必须存在；外链 URL 与纯锚点不探测（跳过即明说，不做假绿）。挪动 / 改名 .md 或其链接目标时同一提交内过此锁 |
| `with-global-tauri-lock.test.mjs`（issue #22 / #16 / ADR 0058） | 根 `scripts/`（`pnpm run test:run`） | 双端 `tauri.conf.json` 的 `app.withGlobalTauri === false`（纯配置项无行为面，文本断言是唯一防回归手段；Seam 3 已跑红一次） |
| Rust 测试锁：`capabilities_lock.rs`（CSP）、`capability_crates_no_product_ids.rs`（零业务类型）、`capability_crates_unit_tests_only.rs`、`hot_path_logging_lock.rs`、`domain_contract_structure_locks.rs`、`empty_dir_lock.rs`、`lifecycle_command_registration_lock`、`command_registration_completeness_lock`（移动） | 双端 `src-tauri/tests/` | 见各自头注释（含「迁移锁后跑红一次」纪律，docs/testing.md §4） |

**锁是契约清单，不是障碍**：你的合法改动若使某把锁的清单 / 白名单过期，必须**同一提交内同步更新该清单**（并在交付说明里点名）；禁止删锁、缩窄 glob、把断言改恒真来「变绿」。

### 8.1 源码文本锁盘点清单（owner + 处置，issue #18，2026-10-24）

上表之外的逐文件盘点：所有**读仓内源码 / 配置 / 清单文本做断言**的测试文件（判据：`readFileSync` 源文件并对文本做 `toContain` / 正则断言；读临时目录 fixture 的纯行为测试不在列）。新增源码文本锁的准入门槛见 docs/testing.md §4；本清单过期与代码同批更新。

**owner 一律 `binblink`**（现状无人认领）。性质三档：**边界契约**（跨构建单元 / 跨仓 / 发布面 / 退役面 / 安全红线，无编译期约束只能文本比对）、**接线锁**（入口真的调用了共享模块，应保持单条轻量）、**源码文本锁**（裁决 / 样式 / 结构事实——部分给出豁免理由保留，给不出理由的标待改造）。

| 锁文件（端） | 锁对象 | 性质 | 处置方向 | 为何不能用行为测试表达 |
| --- | --- | --- | --- | --- |
| `hostAppBoundaryLock.test.ts`（桌面） | 宿主零 app 源码 import / 零 `__WASMNEST_SHARED__`；`mountApp` / `mountPreview` 契约逐字同形 | 边界契约 | 保留 | 宿主与独立挂载包是运行时装载关系，无编译期约束；契约漂移只在文本可比对时可见 |
| `i18nDriftLock.test.ts`（桌面） | 宿主 ↔ bedcode 两份 host 消息集逐字一致 | 边界契约 | 保留 | 两份独立构建的消息集副本无共享真源，漂移即用户可见断裂，只能逐字比对 |
| `tailwindContentCoverage.test.ts`（桌面） | Tailwind content 只扫宿主源码 + SDK 组件 | 边界契约 | 保留 | 被测对象就是 `tailwind.config.js` 的扫描范围文本本身 |
| `appBundlePathLock.test.ts`（桌面） | 挂载包路径单一来源；禁 `plugins/desktop` 落点字面量 | 边界契约 | 保留 | 同一路径约定前后端各写一遍的事故只能靠禁字面量防复发 |
| `i18nTemplateKeys.test.ts`（桌面） | 全壳 `t('字面量')` key 必须在 zh-CN 与 en 消息集存在 | 边界契约 | 保留（含防空转断言） | 跨全部模板与两套消息集的交叉一致性，无单点行为可测 |
| `style/pageTransition.test.ts`（桌面） | 过渡统一：退役过渡名零残留、命名唯一、无 out-in、token 单一来源 | 边界契约（行为面已提纯函数） | 保留 | 跨 6 文件的统一性契约（同 i18nDriftLock）；效果切换已行为化（`applyPageTransitionEffect`） |
| `shell/mount/appSurfaceKeepAlive.test.ts`（桌面） | 销毁点唯一、挂载槽常驻 `v-show`、租约跟实例生命周期 | 源码文本（结构事实） | 保留（头注释已述理由） | 覆盖停用 / 全部关闭 / 卸载 / 错误终态全路径的组件测试不现实；结构性事实是跨组件装配不变量 |
| `shell/shellExtensionWiring.test.ts`（桌面） | ShellHost 真的挂状态栏 / 皮肤 token 接壳根 | 接线锁 | 保留单条轻量 | 组件测试全绿而装配缺失的场景无运行时覆盖；接线点唯一 |
| `shell/shellStyleWiring.test.ts`（桌面） | 入口接线 shell.css（含顺序）+ 被消费共享类仍在 | 接线锁 | 保留单条轻量 | 零引用死样式静默失效教训：类名照写而 CSS 没进构建，组件测试测不出 |
| `shell/recentsWiring.test.ts`（桌面） | 多任务四处装配点（主屏无运行区 / 工具栏入口 / 全屏层 / Host 挂载） | 挂载行为 + 接线锁 | 已改造（#23，2026-10-24） | 原 81 处 `toContain` 逐调用点按 #12 样板收敛为挂载行为（主屏无运行区 / 导航顺序 / 开关状态收敛=工具栏↔全屏层联合挂载共享 useShellState 同一 ref / 动作转发 / 卡片装配 DOM / 图标接线）；接线剩 1 条（ShellHost 模板挂 `<ShellTaskSwitcher />`）+ 退役面存在性扫描（ShellRecentsPanel / ShellCommandPalette）；几何纯函数面归 recentsLayout.test.ts |
| `shell/recentsLayout.test.ts`（桌面） | 卡片尺寸方向 / 几何（纯函数行为测试在场）+ 组件接线 3 条 | 接线锁（混合） | 收敛：接线 3 条 → 1 条 | 方向 / 几何已行为化；接线断言只证 `ShellTaskSwitcher` 真的用了 `recentsLayout` |
| `shell/settings/settingsOrderLock.test.ts`（桌面） | 设置分组顺序（关于固定最后） | 挂载行为（DOM 顺序） | 已改造（#23，2026-10-24） | 已按预告改法落地：挂载 SysSettingsView 断言分组标题的 DOM 顺序（分组组件以桩替身渲染），关于固定最后；源码顺序正则已删 |
| `shell/selectionStyle.test.ts`（桌面） | 选中态两套语言（勾章 / 黑底白字） | 源码文本（样式裁决） | 保留 | happy-dom 不计算 scoped CSS，选中填充色是样式表事实 |
| `shell/surfaceLadder.test.ts`（桌面） | 透明度三档阶梯（92% / 96%+blur / 实心） | 源码文本（样式裁决） | 保留 | 同上：透明度 / blur 是 CSS 事实，DOM 断言不可达 |
| `shell/wallpaperScope.test.ts`（桌面） | 壁纸挂壳根、宿主页面不得自铺底色 | 源码文本（裁决） | 保留 | 挂载层级与背景归属是渲染结构事实；「不得存在」的禁令只能扫描 |
| `shell/appChromeLock.test.ts`（桌面） | 壳标题栏常驻、应用不得自绘标题栏 / 窗口控制 / 拖拽区 | 源码文本（裁决 + 禁字面量） | 保留（改 bedcode 时同批维护） | 「不得出现标题栏 / 100vh」是宿主与 app 双侧禁令，禁字面量形态只能文本断言 |
| `shell/sysPermsChrome.test.ts`（桌面） | 系统页 chrome 常驻、权限页去「页中页」、SVG 图标重画 | 源码文本（裁决） | 保留（图标在场可随 Phase 2 顺带行为化） | 分层越界（fixed 悬浮胶囊压图标）是布局事实；SVG path 是品牌几何延续 |
| `shell/toolbarThemeToggle.test.ts`（桌面） | 主题切换按钮图标画当前态、文案说目标态 | 挂载行为 | 已改造（#23，2026-10-24） | 已按预告改法落地：mount ShellToolbar + 切主题断言图标（DOM path）/ aria-label / 尺寸；sun 光线内缩几何以 ShellIcon 渲染 DOM 断言（渲染资产），双语动作文案以消息对象断言（跨两套消息集契约）保留 |
| `shell/customWallpaper.test.ts`（桌面） | 偏好只存文件名 / URL 防穿越（行为测试在场）+ 命令调用落点 3 处 | 接线锁（混合） | 收敛：调用点 3 条 → 单条 | 行为部分已行为化；调用落点只证接线唯一性 |
| `brandMark.test.ts`（桌面） | 品牌位全仓 2 处、笔画与 icon.svg 逐字同源、旧笔画零残留 | 源码文本（品牌几何） | 保留 | SVG 描边曲线与图标的逐字同源是渲染资产事实，DOM 比对不了 path 数据 |
| `components/SplashLoading.test.ts`（桌面） | 绘画动画行为 + 品牌位尺寸与描边偏移公式（纯函数真源）+ CSS 动画回退退役扫描 | 挂载行为 + 纯函数 + 退役面 1 条 | 已改造（#23，2026-10-24） | clamp 档位与 offset 公式提纯到 splashTiming.ts（`SPLASH_LOGO_SIZE` / `splashStrokeOffset`，组件内联绑定消费，happy-dom CSSOM 丢 clamp 值 → 组件面以哨兵值注入证明绑定）；rAF 内联样式字符串断言已删（行为由逐帧驱动用例承载）；CSS animation 回退退役禁令 1 条保留（WebKitGTK 退化静态事故，行为测不出「曾经会动」） |
| `components/SplashLoadingTheme.test.ts`（桌面） | 开屏双主题四条不变量（SFC + 静态首屏 css + index.html 接线） | 源码文本（样式裁决） | 保留 | happy-dom 不解析 scoped CSS 变量；静态首屏在 JS 挂载前，只有文本可断言 |
| `shell/SplashLoading.test.ts`（移动） | 启动面真源线框与 icon.svg 逐字同源（124 条 / 双色 / 品牌 token）+ rAF 绘画行为 + 测量失败与 reduced-motion 降级 + 尺寸 / 偏移纯函数 | 挂载行为 + 纯函数 + 退役面 1 条 | 新增（2026-10-24） | 与桌面同组件、移动端只做前端展示（Android 原生开屏不动）；壳内禁硬编码色，品牌色走 `shell.css` 的 `:root` token（SplashLoading teleport 到 body，token 由 `main.ts` 提前加载） |
| `scripts/pluginWatchCopy.test.ts`（桌面） | copyIfChanged / copyManifestIfChanged / copyWatchArtifacts 行为（临时目录 fixture）+ 接线组：watch 1 条、dev-run 1 条、bedcode build.js（fixture 驱动真实脚本） | 行为测试 + 接线锁 | 已改造（#23，2026-10-24） | watch 复制链提为可注入依赖的导出 `copyWatchArtifacts`（plugin-watch.js 最小 diff，命令形态不变）并临时目录行为锁定（幂等 / 摘要感知 / fail-visible 记账）；接线剩 2 条轻量（startPluginWatch 调用共享复制链、dev-run 的 `runPluginPrecheck()` 先于宿主启动点——后者理由成立保留）；bedcode `--frontend-only` 由源码正则改为沙箱 fixture 驱动真实 build.js（假 vite / cargo 记账，不触发真实构建） |
| `scripts/runtimeCrateGate.test.ts`（桌面） | runtime crate 打包门禁纯函数行为 + Cargo.toml crate 身份（包名 / 二进制名 / git tag 依赖） | 边界契约（发布面） | 保留（tag 升级同批更新） | crate 身份就是 Cargo.toml 文本事实，`cargo package` / install 契约无行为替身 |
| `package-contents.test.ts`（桌面 SDK） | SDK 发布内容自足（files / exports / bin / 工具落点） | 边界契约（发布面） | 保留 | 「npm 包里必须有什么」本身就是包清单文本契约 |
| `composables/useLinkEncryption.test.ts`（移动） | 配置持久化 / 子开关行为 + WS 加密退役零残留扫描 | 边界契约（退役面） | 保留退役面 | 退役面 fail-visible：残留以任何形式回接即违规，只能扫描源码面 |
| `shell/appSurfaceKeepAlive.test.ts`（移动） | 池常驻渲染 + Teleport 移动不重建 +「打开过 ∩ 运行中」过滤 | 源码文本（结构事实） | 保留（头注释已述理由） | 同桌面保活锁：Teleport 前后台全路径组件测试不现实 |
| `shell/retiredHostUIRetirementLocks.test.ts`（移动） | 旧宿主 UI 退役路由 / 符号零回接 + 正面钉（mobile-shell 默认路由在位）；R6 = #24 死码批次（死路由视图 / 路由名 / 孤儿组件零回接 + 路径级不在场钉）、R7 = #24 迁移批次（宿主提供组件五件套文件不在场 + `wasmnestHostComponents` 契约符号零回接） | 边界契约（退役面） | 保留 | 退役面防回接 = 禁字面量扫描；测试期门禁与 ESLint 分工（防 ignores 改窄） |
| `host_product_vocabulary_lock.rs`（移动 `src-tauri/tests/`，issue #24） | 移动宿主 Rust 源码 B1–B6 产品词汇零未登记（17 针 + 机制复合词 carve-out；白名单逐文件×逐词登记，来源 `docs/host-exceptions.md` §3/§4，#25 直连栈收敛后对应行随之删） | 边界契约（薄壳红线） | 保留（Seam 3 已跑红一次：`struct TestSessionStatus;` ⇒ 红点名文件与词） | B1–B6 命中是词汇存在性事实，产品语义没有行为替身；命中处置 = 例外登记或迁移票 |
| `shell/shellConstraintLocks.test.ts`（移动） | L1–L7 壳层约束（零资源访问 / 裸 invoke / 授权弹窗单挂载 / 无静默 catch / i18n / token-bound / 壳内自足） | 边界契约（安全红线） | 保留 | 安全三层封锁与壳内自足是禁区扫描不是行为；与 ESLint 分工为测试期门禁 |
| `with-global-tauri-lock.test.mjs`（根 scripts） | 双端 `tauri.conf.json` 的 `app.withGlobalTauri === false`（issue #22 / #16 / ADR 0058，2026-10-24） | 边界契约（暴露面收缩 + 跨构建单元） | 保留（Seam 3 已跑红一次） | 纯配置项无行为面：其全部效果恰是「`window.__TAURI__` 全局永不注入」这个否定事实，行为测试只能断言在场行为、断言不了缺席；conf 是 Rust 侧构建输入，改它不经任何编译检查。owner=binblink（平台仓）。已知例外：wdio 手动 harness（`@wdio/tauri-plugin` 1.4.0 webview execute 硬依赖该全局）属仓外测试基础设施、不进 CI 门禁，不构成回开理由 |
| `shell/shellHomeScreen.test.ts`（移动） | 主屏行为契约 + 跨端系统图标 path 与桌面 ShellIcon 逐字一致 | 边界契约（跨端，行为面不动） | 保留跨端契约 | 移动 / 桌面两套独立构建的图标资产无共享真源，一致性只有文本可比对 |
| `shell/shellNotifications.test.ts`（移动） | 通知行为契约 + 滑动指示层 color-mix 派生 1 条 | 源码文本（样式，单条） | 保留 | happy-dom 不解析 CSS，color-mix 派生色是样式表事实 |
| `shell/shellRecents.test.ts`（移动） | 多任务行为契约 + CSS 视觉裁决 + 退役 key 零残留 + ShellHost 过渡名接线 1 条 | 源码文本（混合） | 保留（CSS 与退役面有理由；接线单条合规） | CSS 视觉事实同上；退役 key 零残留同退役面；接线单条符合门槛 |
| `shell/wallpaperScope.test.ts`（移动） | 壁纸挂宿主根 + 运行面例外（app-run 底色层） | 源码文本（裁决） | 保留 | 同桌面壁纸作用域锁（双端同口径镜像） |
| `cli.test.ts`（移动 SDK） | validate 权限白名单子进程回归 + CLI 常量 ↔ `rust/src/permission.rs` 双真源同步 | 边界契约（副本同步） | 保留 | JS 硬编码白名单与 Rust 真源无编译期约束，漂移只有双文本比对可断言 |
| `componentize-manifest.test.ts`（移动 SDK） | 组件化工具落点（桌面 SDK exports + CLI 搜索链） | 边界契约（发布面） | 保留 | 跨包发布落点是 package.json exports 文本契约 |
| `contractDrift.test.ts`（移动 dev-shell） | dev-shell mini 壳 ↔ 宿主壳 types / nav 同形 | 边界契约（同构漂移） | 保留 | npm 自包含同构实现无编译期约束（头注释已述） |
| `visualParity.test.ts`（移动 dev-shell） | dev-shell ↔ 宿主视觉真源（token / Tailwind 主题）同源 | 边界契约（同构漂移） | 保留 | 同上；视觉漂移事故（墨纸体系）实证 |
| `crate-structure-lock.test.mjs`（根） | 契约 crate 字面量形状 / 无 `include!` 逃逸 / compose.json WIT 路径存在 | 边界契约（结构） | 保留（已在上表登记） | 字面量形状是给 node 正则消费的构建契约，非运行时行为 |

**Phase 2 首批改造建议（误红风险最高，均桌面端——已随 issue #23 于 2026-10-24 全部落地，#12 样板推广执行）**：

1. `shell/recentsWiring.test.ts`（已改造）：81 处逐调用点断言收敛为挂载行为 + ShellHost 接线 1 条 + 退役面扫描；mutate 证明：删 ShellHost 挂载 / 主屏回铺运行带 / 工具栏脱离共享开关各红一次。
2. `scripts/pluginWatchCopy.test.ts` watch 组 2 条 + bedcode `build.js` 1 条（已改造）：复制链提纯为 `copyWatchArtifacts` 行为锁，bedcode 改沙箱 fixture 驱动真实 build.js；mutate 证明：复制链退回无条件 cpSync / `--frontend-only` 漏调 buildFrontend 各红一次。
3. `shell/settings/settingsOrderLock.test.ts`（已改造）：mount 断言分组 DOM 顺序；mutate 证明：关于挪到复位之前红两次。
4. `shell/toolbarThemeToggle.test.ts`（已改造）：mount + 切主题断言图标 / aria-label；mutate 证明：图标写死月亮红两条。
5. `components/SplashLoading.test.ts` rAF / clamp 2 条（已改造）：clamp 档位与 offset 公式提纯 `splashTiming.ts` + 挂载断言；mutate 证明：档位回退 96px / 组件解绑尺寸常量各红一次。

## 9. 文档索引

| 需求 | 入口 |
| --- | --- |
| 本仓命令全集（根 / 桌面 / 移动 / 应用 / target 治理 / husky） | `docs/commands.md` |
| 架构硬约束（宿主薄壳六判据 / 桌面挂载形态 / 双端差异 / 权限闸门 / 数据库 / 跨端协议） | `docs/architecture.md` |
| 插件与 SDK 契约（plugin.json / 权限 / WIT 链 / 生成物 / 变更流程） | `docs/contracts.md` |
| 前端规范（零资源访问三层封锁 / 挂载包形态 / 移动壳优先 / i18n） | `docs/frontend.md` |
| Rust 规范与注释命名 | `docs/backend.md` |
| 安全与日志红线 | `docs/security.md` |
| 决策记录（ADR 索引；0055–0057 出处登记 / 0058 前端信任边界威胁模型） | `docs/adr/README.md` |
| 单元测试 / 完成定义与验证 | `docs/testing.md` |
| wasm 应用开发检查清单（双端红线，迁自旧仓 issue #14） | `docs/knowledge/wasm-app-development-checklist.md` |
| 桌面 wasm 应用开发指南 / API 参考（迁自旧仓 issue #14；SDK README 死链的现去向） | `wasmnest-desktop/docs/wasm-app-dev-desktop.md`、`wasmnest-desktop/docs/knowledge/wasm-app-dev-guide.md` |
| 移动 wasm 应用开发指南（迁自旧仓 issue #14） | `wasmnest-mobile/docs/wasm-app-dev-mobile.md` |
| 提交回滚与 Git 规则 | `docs/git.md` |
| 依赖方向 / 跨仓锁 / 禁行清单 | `docs/boundaries.md` |
| 跨仓版本 / 发布装配 | `release-manifest.json`、`scripts/check-release-manifest.mjs`、`scripts/bump-version.mjs` |
| WIT 拼装 / 契约版本 | `scripts/compose-wit.mjs`、`../wasmnest-lib/wasmnest-contract/src/lib.rs`、双端 `compose.json` |
| 应用侧硬约束（业务主场） | `../wasmnest-apps/AGENTS.md` + 各 app `plugin.json` / `scripts/build.js` |
| 能力仓（引擎 / 契约真源） | `../wasmnest-lib/`（`wasmnest-wasm-core/wit/core.wit`、各域 `wit/<domain>.wit`、`wasmnest-contract/`；平台侧唯一 resolver = `scripts/lib-paths.mjs`） |
| 跨端互连测试 | `../wasmnest-test/cross-end-tests/` |
| 本机环境：LayerFS 部署事实 + MCP 工具面（唯一 12 工具 / 多 agent 接入与超时 / 排障） | `docs/layerfs.md` |
| 旧仓（代码冻结 · 文档真源与回退点） | `../../BedCode/`：`docs/adr/`（ADR 0017/0019/0022/0030/0033/0051/0052 等，冻结于 0054；0055–0057 正文未成文，出处登记在本仓 `docs/adr/README.md`）、`docs/knowledge/`（build-process / wasip3-toolchain / logging / plugin 清单等）、`docs/commands.md`、两端 `docs/code-map.md`——引用时注意旧仓代码与三仓现状有差异，机制以新仓代码为准 |
| 桌面 SDK | `wasmnest-desktop/packages/plugin-sdk-desktop/`（README 有已知漂移，docs/contracts.md §5.2） |
| 移动 SDK / 运行面类型 | `wasmnest-mobile/packages/plugin-sdk-mobile/`（`src/types.ts` = `UIRegistry` 真源） |
| 宿主构建 / dev 脚本 | 各端 `scripts/`（头注释自解释）+ 根 `scripts/{app-paths,app-script,adaptive-run}.mjs` |
| 沙箱 / 基准 | `e2e/specs/`、`../wasmnest-test/perf-tests/`（宿主侧基准驱动）、`packages/plugin-sdk-desktop/tools/componentize/` |
| 编辑器 / 格式化 | `.editorconfig`、`.prettierrc.json`、根 `eslint.config.js`、两端 `tailwind.config.js` / `.stylelintrc.json` |