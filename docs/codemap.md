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
├─ wasmnest-desktop/                        # 桌面宿主（Tauri 2 + Vue 3）
│   ├─ src/                                 # 宿主壳（ShellHost：主屏 + 系统页 + 挂载槽），见 §2.1
│   ├─ src-tauri/                           # 桌面 Rust 宿主（插件机制接线 / 安全闸门 / 服务器），见 §2.2
│   ├─ packages/plugin-sdk-desktop/         # 桌面端内 SDK（npm + crates：wasmnest-plugin-api）
│   ├─ packages/plugin-{bench-test,sdk-fixtures,system-test}/  # 宿主测试夹具包
│   ├─ scripts/                             # dev-run / tauri-build / plugin-build / plugin-watch /
│   │                                       # plugin-dev / package-host / 图标生成 / target 治理
│   ├─ e2e/ · bench/                        # WDIO E2E（smoke/bench）· 基准数据打包（驱动在 wasmnest-test/perf-tests）
│   └─ resources/ · tailwind/postcss/stylelint/tsconfig/wdio…
├─ wasmnest-mobile/                         # 移动宿主（Tauri 2 Android + Vue 3）
│   ├─ src/                                 # 宿主壳（/mobile/shell：注册表 + 运行面）＋ 少量既有页面，见 §3.1
│   ├─ src-tauri/                           # 移动 Rust 宿主（含 gen/android 手写 Kotlin 面），见 §3.2
│   ├─ packages/plugin-sdk-mobile/          # 移动端内 SDK（wasmnest-plugin-api-mobile）
│   ├─ packages/plugin-component-test/      # 组合件桥测试夹具
│   └─ scripts/                             # dev-run / plugin-build / android-dev-log / target 治理
├─ scripts/                                 # 根工具（见 §5）：compose-wit / app-paths / lib-paths / app-script /
│                                           # adaptive-run / bump-version / package-sdks / target 治理 / wasip3-toolchain
├─ tools/componentize/                      # 组件化工具（wasm32-unknown-unknown core module → Component）
├─ release-manifest.json                    # 跨仓版本唯一表达（判据见 docs/contracts.md §2.1）
├─ .cargo/config.toml                       # sccache 强制前置 + 并发兜底（未装 sccache 直接失败，显性设计）
├─ .husky/pre-commit                        # WIT 漂移锁 + 暂存前端文件 eslint（见 docs/commands.md §7）
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

**产物流向**（应用源码住应用仓，产物落本仓宿主资源目录；`resources/plugins/**` 不入库）：

```text
../wasmnest-apps/apps/<slug>/<end>/            源码（前端 + rust/）
   │ 前端：desktop = vite 单文件包（全依赖打包，无 externals）
   │       mobile  = SDK vite 插件（vue/vue-i18n/pinia 外置宿主全局 __WASMNEST_SHARED__）
   │ 后端：desktop = wasm32-wasip3 直出 Component；mobile / file-transfer = wasm32-unknown-unknown + tools/componentize
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
| `shell/` | 宿主壳：`ShellHost.vue` 根组件；`mount/`（`AppMountSlot.vue` + `useAppMount.ts` = 挂载槽 + 装载机制，`AppPreviewTile.vue` = 多任务卡的应用自绘预览面装载 / 3s 超时 / 回退品牌卡）；`sys/`（系统页）；`settings/`；`auth/`；`extensions/`（壳扩展点注册表：状态栏项 / 设置项 / 主题皮肤，只注册排序、不解释业务语义） |
| `shell/composables/useShellApps.ts` | **应用路由真源**：`SURFACE_ROUTES`（新增桌面应用必须同步，见 §6） |
| `shell/types.ts` · `state.ts` / `useShellState.ts` | 壳状态面（宿主零业务状态：装载即建、卸载即销毁） |
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

`dev-run.js`（宿主 dev：端口预检 → WASM/前端缺失预建 → tauri dev → `PLUGIN_WATCH_CMDS` 起前端 watch；bedcode 前端不参与 watch）、`plugin-build.js`（`PLUGINS` 注册表 = 4 个应用名单单一真源）、`plugin-dev.js`（单插件 dev）、`plugin-watch.js`（前端重载闭环）、`tauri-build.js`（updater 签名）、`package-host.mjs`（`host:pack` 宿主产物分发，见 docs/commands.md §3）、`check-target-size.js`（target 治理）、`generate-*.js`（图标生成）、`install-tauri-deps.sh`。**每个脚本头注释自解释。**

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
| `tools/componentize/` | Component 化工具（wasm32-unknown-unknown → Component；file-transfer 与移动产物用） |

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
| 改多任务卡片 / 应用预览面（`mountPreview`） | `wasmnest-desktop/src/shell/components/ShellTaskSwitcher.vue` + `src/shell/mount/{useAppMount.ts,AppPreviewTile.vue}`（`mountAppPreview(root, env)` = 装载入口，`PREVIEW_MOUNT_TIMEOUT_MS` = 3s）+ `src/shell/mount/appSession.ts`（`lastRoute`）；契约 = `AppPreviewEnv` / `AppPreviewHandle` / `MountPreview`（宿主与四个 app `entry.ts` 同形，L5 锁钉住）；应用侧内容裁决在 `../wasmnest-apps`；跑桌面 `test:run` + 应用仓各 app `test:run` / `build:frontend` + 真实 `tauri:dev` 目验 |
| 改移动宿主壳 / 运行面 / 注册表 | `wasmnest-mobile/src/shell/registry.ts`（职责边界：只注册不决策）+ 移动 SDK `src/types.ts`（`UIRegistry`）+ docs/architecture.md §4；优先移动 SDK dev-shell 预览 |
| 改插件机制 / 生命周期 / 能力接线（Rust） | 该端 `src-tauri/src/plugin/**`（每域一个文件，端口 adapter + 白名单条目同处，**先读文件头注释**）+ 能力仓对应 crate；跑该端 `cargo test` |
| 改权限 / 授权闸门 | 本端 SDK `rust/src/permission.rs`（词汇真源）+ docs/contracts.md §4 + docs/security.md §1；生成物重出（桌面 SDK 目录 `pnpm run gen:permissions`）；跑相关锁 |
| 改 WIT / ABI / 契约 | docs/contracts.md §2/§3 全链 + `scripts/compose-wit.mjs`；**不在端生成物里改**；改完重拼、重建受影响 app 产物、同步 manifest |
| 改 SDK（TS / Rust 面） | 该端 `packages/plugin-sdk-*/`（README + `src/types.ts` / `rust/src/lib.rs`）；跑 SDK `test:run`；发布走 `package-sdks.mjs`。**桌面 SDK 的 README / template / dev-shell 仍是旧贡献面形态（已知漂移，docs/contracts.md §5.2）——写新代码以应用仓现有 app 为形态基准** |
| 改构建 / dev 脚本 | 对应脚本头注释（自解释）+ 根 `scripts/app-paths.mjs`；桌面还有 `src/__tests__/scripts/pluginWatchCopy.test.ts` 等脚本锁 |
| 新增 / 改名 / 停用桌面应用 | 应用仓先按 `../wasmnest-apps/AGENTS.md` §5 清单走；本仓四处注册表 + 一处路由 + 两处锁必须同步：`scripts/plugin-build.js` `PLUGINS`、`scripts/plugin-dev.js` `PLUGINS`、`scripts/dev-run.js` `PLUGIN_WATCH_CMDS`、`src/shell/composables/useShellApps.ts` `SURFACE_ROUTES`（+ `src/router/index.ts` 路由条目）、`hostAppBoundaryLock.test.ts` 的 `APP_ENTRIES` + `release-manifest.json` |
| 新增 / 停用移动应用 | 移动构建自动扫描 `apps/*/mobile`（无注册表）；只需同步 `release-manifest.json`；机制差异读 docs/architecture.md §4 |
| 改跨端传输 / 认证 / 配对面 | docs/architecture.md §6（跨端协议）；改完去 `../wasmnest-test/cross-end-tests` 跑真实互连（零 mock） |
| 改 Android 原生（Kotlin / manifest / gradle） | `wasmnest-mobile/src-tauri/gen/android/**`；改 Kotlin 必须 gradlew 验证；`tauri android init` 重建后手工恢复手写面 |
| 排查「改了没生效」/ 产物路径 | 桌面 `scripts/{dev-run,plugin-watch,plugin-build}.js`、移动 `scripts/plugin-build.js`、根 `scripts/app-paths.mjs`；先确认产物是否真写进 `src-tauri/resources/plugins/<end>/<id>/`；再确认宿主扫描目录（桌面 dev 是 `target/debug/resources/…` 运行时副本——源目录删除不会自动同步，幽灵目录只在这里活着） |
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
| `hostAppBoundaryLock.test.ts` | `wasmnest-desktop/src/__tests__/` | 宿主零 app 源码 import、零 `__WASMNEST_SHARED__`、零旧贡献面；逐字校验四个桌面 app `src/entry.ts` 的 `mountApp` 契约；**L5 预览契约锁**：四个 entry 必须导出 `mountPreview` 且带 `appId` / `lastRoute` / `appInvoke` / `appStorageGet` / `locale` / `theme` 关键字段、宿主声明 `AppPreviewEnv` / `AppPreviewHandle` 且 `mountPreview?` 可选、预览路径禁用 `refreshChannelToken` / 写存储（**新增 / 改名桌面应用必须同步其 `APP_ENTRIES`**） |
| `i18nDriftLock.test.ts` | 同上 | 宿主 `src/i18n/host-{zh-CN,en}.ts` ↔ `apps/bedcode/desktop/src/i18n/host-{zh-CN,en}.ts` **逐字一致** |
| `tailwindContentCoverage.test.ts` | 同上 | 宿主 Tailwind content 不得残留 app 路径 |
| `appBundlePathLock.test.ts` · `appChromeLock.test.ts` | `wasmnest-desktop/src/__tests__/shell/` | 挂载包路径单一来源（`resources/plugins/desktop` 层级）；壳标题栏常驻、应用不得自绘标题栏/窗口控制/拖拽区 |
| `shellExtensions.test.ts` · `shellStatusBar.test.ts` · `shellExtensionWiring.test.ts` · `settings/settingsOrderLock.test.ts` | `wasmnest-desktop/src/__tests__/shell/` | 壳扩展点注册语义（排序 / 覆盖 / Disposable / 皮肤 token 校验）、状态栏分区与动作失败隔离、ShellHost 装配接线、设置页顺序（**关于固定最后**） |
| `appPreviewScale.test.ts` · `composables/useShellApps.test.ts` | `wasmnest-desktop/src/__tests__/shell/` | 宿主前端不设人为上限：256 条清单全量保留（不截断）；32 张多任务卡各自挂载预览、超时只回退自己、卸载时句柄逐一回收（上限 = 并发挂载能力，不是常量） |
| `pluginWatchCopy.test.ts` | `wasmnest-desktop/src/__tests__/scripts/` | 插件 watch 复制闭环 |
| 移动壳系列锁：`shellConstraintLocks`（含 **L7 壳内自足**）、`retiredHostUIRetirementLocks`、`shellRegistry` / `shellPermissions` / `shellMechanisms` / `shellHostEvents` / `shellAppSurface` / `shellAppRunScreen` / `shellHomeScreen` 等 20+ | `wasmnest-mobile/src/__tests__/shell/` | 壳内自足（不依赖旧界面目录）、退役路由 / 符号不回接、壳迁移面不得缩水、注册表 / 权限 / 机制行为 |
| `crate-structure-lock.test.mjs` | 根 `scripts/`（`pnpm run test:run`） | 契约 crate 常量保持 node 正则可解析的字面量形状；能力仓（`../wasmnest-lib`）无逃出 crate 目录的 `include!` / `include_str!` / `bindgen!` 路径；双端 `compose.json` 声明的 WIT 路径存在 |
| Rust 测试锁：`capabilities_lock.rs`（CSP）、`capability_crates_no_product_ids.rs`（零业务类型）、`capability_crates_unit_tests_only.rs`、`hot_path_logging_lock.rs`、`domain_contract_structure_locks.rs`、`empty_dir_lock.rs`、`lifecycle_command_registration_lock`、`command_registration_completeness_lock`（移动） | 双端 `src-tauri/tests/` | 见各自头注释（含「迁移锁后跑红一次」纪律，docs/testing.md §4） |

**锁是契约清单，不是障碍**：你的合法改动若使某把锁的清单 / 白名单过期，必须**同一提交内同步更新该清单**（并在交付说明里点名）；禁止删锁、缩窄 glob、把断言改恒真来「变绿」。

## 9. 文档索引

| 需求 | 入口 |
| --- | --- |
| 本仓命令全集（根 / 桌面 / 移动 / 应用 / target 治理 / husky） | `docs/commands.md` |
| 架构硬约束（宿主薄壳六判据 / 桌面挂载形态 / 双端差异 / 权限闸门 / 数据库 / 跨端协议） | `docs/architecture.md` |
| 插件与 SDK 契约（plugin.json / 权限 / WIT 链 / 生成物 / 变更流程） | `docs/contracts.md` |
| 前端规范（零资源访问三层封锁 / 挂载包形态 / 移动壳优先 / i18n） | `docs/frontend.md` |
| Rust 规范与注释命名 | `docs/backend.md` |
| 安全与日志红线 | `docs/security.md` |
| 单元测试 / 完成定义与验证 | `docs/testing.md` |
| 提交回滚与 Git 规则 | `docs/git.md` |
| 依赖方向 / 跨仓锁 / 禁行清单 | `docs/boundaries.md` |
| 跨仓版本 / 发布装配 | `release-manifest.json`、`scripts/check-release-manifest.mjs`、`scripts/bump-version.mjs` |
| WIT 拼装 / 契约版本 | `scripts/compose-wit.mjs`、`../wasmnest-lib/wasmnest-contract/src/lib.rs`、双端 `compose.json` |
| 应用侧硬约束（业务主场） | `../wasmnest-apps/AGENTS.md` + 各 app `plugin.json` / `scripts/build.js` |
| 能力仓（引擎 / 契约真源） | `../wasmnest-lib/`（`wasmnest-wasm-core/wit/core.wit`、各域 `wit/<domain>.wit`、`wasmnest-contract/`；平台侧唯一 resolver = `scripts/lib-paths.mjs`） |
| 跨端互连测试 | `../wasmnest-test/cross-end-tests/` |
| 旧仓（代码冻结 · 文档真源与回退点） | `../../BedCode/`：`docs/adr/`（ADR 0017/0019/0022/0030/0033/0051/0052/0056/0057 等）、`docs/knowledge/`（build-process / wasip3-toolchain / logging / plugin 清单等）、`docs/commands.md`、两端 `docs/code-map.md`——引用时注意旧仓代码与三仓现状有差异，机制以新仓代码为准 |
| 桌面 SDK | `wasmnest-desktop/packages/plugin-sdk-desktop/`（README 有已知漂移，docs/contracts.md §5.2） |
| 移动 SDK / 运行面类型 | `wasmnest-mobile/packages/plugin-sdk-mobile/`（`src/types.ts` = `UIRegistry` 真源） |
| 宿主构建 / dev 脚本 | 各端 `scripts/`（头注释自解释）+ 根 `scripts/{app-paths,app-script,adaptive-run}.mjs` |
| 沙箱 / 基准 | `e2e/specs/`、`../wasmnest-test/perf-tests/`（宿主侧基准驱动）、`tools/componentize/` |
| 编辑器 / 格式化 | `.editorconfig`、`.prettierrc.json`、根 `eslint.config.js`、两端 `tailwind.config.js` / `.stylelintrc.json` |