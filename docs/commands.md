# 命令全集（根 / 桌面 / 移动 / 应用 / 工具）

> **本文件是 `AGENTS.md` 的拆分文档（命令）**：双端与根工具的全部命令、通用约定、target 治理、测试门禁。
> **包管理器一律 pnpm（禁止 npm）**；根 `pnpm install` 只为根 lint / husky / 根脚本，**两端依赖各自目录安装**；Rust **无根 workspace**，命令在各自 crate 根跑（宿主 = `<end>/src-tauri`）。

## 1. 通用约定

| 项 | 要求 |
| --- | --- |
| Tauri | **2**（写 API 前确认是 v2） |
| wasmtime | **双端 48**，升级必须双端同步（ADR 0019）；桌面 `[patch.crates-io]` 把 `wasmnest-plugin-api` 指回工作树 SDK（`desktop/src-tauri/Cargo.toml`），**patch 目标版本必须与能力仓声明一致**（不一致 cargo 直接失败，别去放宽） |
| wasip3 工具链 | 桌面一般应用走 `wasm32-wasip3`，pinned nightly 单一事实源在 `scripts/wasip3-toolchain.sh`（`WASIP3_NIGHTLY`，当前 `nightly-2026-09-16`；切换点 stable ≥ 1.99 写在该脚本头注） |
| sccache | 根 `.cargo/config.toml` 强制 `rustc-wrapper = "sccache"`——未装则一切 cargo 命令直接失败，**这是显性失败设计，不要加降级绕过**；绝不要设 `CARGO_INCREMENTAL=1`（sccache 会拒绝执行，见 `.cargo/config.toml` 注释） |
| 构建资源自适应 | 重型构建用 `node ../scripts/adaptive-run.mjs -- <cmd>`（可在任一目录以正确 cwd 执行）；逃生阀 `WASMNEST_ADAPTIVE=0`、档位 `WASMNEST_BUILD_PROFILE=parallel\|balanced\|serial` |
| Android 工具链 | JDK / SDK / NDK 由移动端 `src-tauri/gen/android` 分发包管理，不自行安装另一套 |

## 2. 平台仓根（`wasmnest/`）

| 命令 | 说明 |
| --- | --- |
| `pnpm install` | 根依赖（eslint / prettier / husky） |
| `pnpm run test:run` | 根脚本自测（`node --test "scripts/*.test.mjs"`：adaptive-run / build-profile） |
| `pnpm run check:wit` | WIT 拼装漂移锁（== husky 判据；改了契约真源后必跑） |
| `node scripts/compose-wit.mjs --all` | 双端重拼 WIT 生成物（bump / 改真源后） |
| `pnpm run check:manifest` | `release-manifest.json` 一致性（判据见 docs/contracts.md §1） |
| `node scripts/check-release-manifest.mjs --print-hash` | 打印当前双端 WIT 指纹（更新 manifest 用） |
| `node scripts/bump-version.mjs --patch\|--minor\|--major\|-v X.Y.Z [--desktop\|--mobile\|--both] [--commit] [--tag]` | 双端版本号（各 3 处） |
| `node scripts/package-sdks.mjs --list \| --target <desktop\|mobile\|all>` | 两端 SDK 构建 + 打包（npm tarball + crates + zip + SHA256 清单） |
| `node scripts/app-script.mjs <slug> <desktop\|mobile> <script>` | 转发到应用仓单 app 脚本（见 §5.3） |
| `node scripts/adaptive-run.mjs -- <cmd>` | 自适应构建包装 |
| `node scripts/audit-rust-tests.mjs` · `scripts/run-test-split.sh --crate <子串>` | Rust 测试体量审计 / 批量拆分（见 docs/testing.md §3） |

## 3. 桌面端（`wasmnest-desktop/`）

| 命令 | 说明 |
| --- | --- |
| `pnpm install` | 本端依赖（独立 workspace，`packages/*`） |
| `pnpm run tauri:dev` | 宿主 dev（`scripts/dev-run.js`：端口预检 → 插件 wasm / 前端缺失预建 → tauri dev → 前端 watch；**bedcode 前端不参与 watch**，改了它单独重建 §5.2）。宿主启动的 file watch 覆盖整个 `src-tauri/`——**别在宿主冷构建期间手工往 `src-tauri/` 拷产物**，会触发重启风暴（机制见 `scripts/dev-run.js` 头注释） |
| `pnpm run tauri:build` | 生产构建（`scripts/tauri-build.js` 解析 updater 签名；无密钥时自动关闭更新包产物） |
| `pnpm run host:pack` | 产出「可运行宿主产物」（`scripts/package-host.mjs`，供 wasm-app 工程 dev 使用，不需平台仓源码）——宿主构建产物分发面：产物目录可用环境变量 `WASMNEST_PLUGINS_DIR` 覆盖（未设置时行为与源码构建一致；发布链路不受影响）。例子：`node scripts/package-host.mjs --out dist/host-desktop` |
| `pnpm run plugins:build` | 全量应用构建（`scripts/plugin-build.js --all`，注册表 = 4 个应用名单单一真源，见 §5.1） |
| `pnpm run plugins:dev` | 单插件 dev 构建（`scripts/plugin-dev.js`，见 §5.2） |
| `pnpm run test:run` | vitest（宿主 `src/__tests__` + **桌面 SDK 契约测试** `packages/plugin-sdk-desktop/__tests__`） |
| `pnpm run test:e2e` | WDIO E2E（需 debug 二进制 + 已构建前端；`e2e/specs/{smoke,bench}.spec.ts`） |
| `pnpm run bench:zip` | 基准数据打包（宿主侧基准驱动已迁至 `../wasmnest-test/perf-tests`） |
| `cd src-tauri && cargo test` | 宿主 Rust 全量（含能力层 / CSP 锁、生命周期注册锁、e2e；**部分用例要求先构建随包插件产物** `resources/plugins/desktop`，见各测试头注释） |
| `pnpm run target:size` | target 治理（§6；`prebuild` 钩子自动跑） |

## 4. 移动端（`wasmnest-mobile/`）

| 命令 | 说明 |
| --- | --- |
| `pnpm install` | 本端依赖（独立工程 workspace） |
| `pnpm run tauri:android:dev` | Android dev（`scripts/dev-run.js`：adb 定位 / 插件 watch → tauri android dev；**插件改动进应用后需手动重新激活生效**） |
| `pnpm run tauri:android:build` | Android 构建（`--target aarch64`；另有 `:build:emulator`（x86_64 debug）/ `:build:fast` / `:build:all`） |
| `pnpm run plugins:build` | 扫描 `../wasmnest-apps/apps/*/mobile` 全量构建（无宿主侧注册表） |
| `pnpm run test:run` | vitest（宿主 `src/__tests__`；不含 SDK） |
| `cd packages/plugin-sdk-mobile && pnpm run test:run` | 移动 SDK 契约测试（独立 vitest 配置） |
| `cd src-tauri && cargo test` | 移动宿主 Rust 全量（含纯净性 / 退役面 / 注册完整性等锁） |
| `pnpm run tauri:android:dev:log` | Android 日志流（`scripts/android-dev-log.js`） |
| `pnpm run target:size` | target 治理（§6；`prebuild` 钩子自动跑） |

## 5. wasm 应用与插件

### 5.1 构建注册表与工具链

- **桌面**：应用名单单一真源 = `scripts/plugin-build.js` 的 `PLUGINS`（4 个：agent-hub / ai-chatbox / bedcode(terminal-session) / file-transfer）；`pnpm run plugins:build`（= `--all`，CI/release 走这条）遍历它。
- **移动**：无宿主侧注册表，`scripts/plugin-build.js` 自动扫描 `apps/*/mobile`。
- 桌面一般应用走 `wasm32-wasip3`（cdylib 直出 Component）；**file-transfer 例外**：双端单产物，走 `wasm32-unknown-unknown` + 平台仓 `tools/componentize`（产物落应用仓共享 target `<appsRoot>/target/wasm-apps/…`）。

### 5.2 单应用（单插件）调试命令

| 命令（在 `wasmnest-desktop/` 或 `wasmnest-mobile/` 跑） | 说明 |
| --- | --- |
| `pnpm run plugins:dev -- --plugin <id>` | 单插件 dev 构建（桌面 `scripts/plugin-dev.js`；可用 id 见 §5.1 PLUGINS 键，如 `com.wasmnest.ai-chatbox`） |
| `node scripts/plugin-build.js --plugin <id>` | 单插件全量（前端 + rust）构建 |
| `node scripts/plugin-build.js` | 无参数默认构建 `com.wasmnest.terminal-session`（bedcode） |
| `pnpm run plugins:build:frontend` / `plugins:build:rust` | 桌面便捷转发（ai-chatbox 单 app，走 `app-script.mjs`） |
| `node ../scripts/app-script.mjs <slug> <desktop\|mobile> <script>` | 转发应用仓单 app 脚本（见 §5.3） |

**bedcode 前端 dev 口径**：不参与 `tauri:dev` 的 watch（整包构建最重且每次写入都触发宿主重启）；改它的 UI 请单独重建：`pnpm run plugins:build` 或应用目录 `node scripts/build.js --frontend-only`。

### 5.3 app-script 转发（`scripts/app-script.mjs`）

平台仓直接调应用仓脚本的唯一入口（源码读取同理只能经 `scripts/app-paths.mjs`）：`node scripts/app-script.mjs <slug> <end> <script>`，例如 `build:frontend` / `build:rust`。**宿主构建期禁止 import 任何 app 源码**（桌面 `hostAppBoundaryLock` 会测红）；宿主与 app 只有「运行时装载产物」一条关系。

### 5.4 产物落点与排查

- 产物目录：`<end>/src-tauri/resources/plugins/<end>/<id>/`（`resources/plugins/**` **不入库**，只由构建 / watch 脚本写入，勿手工拷）。
- 桌面 dev 运行时的资源副本在 `target/debug/resources/plugins/desktop/`——源目录删除后副本**不会**自动同步（幽灵目录只在那里活着）；排查「改了没生效」先查这条，再看 `scripts/{dev-run,plugin-watch,plugin-build}.js` 与根 `scripts/app-paths.mjs`。
- 每次 `tauri:dev` 的插件前端改动闭环：改 app 源码 → vite rebuild → 复制进 resources → 宿主 `PluginDevWatcher` emit `plugin:dev-reload` → 前端 reloadPlugin 重载。

## 6. 构建资源与 target 治理

- 宿主 `src-tauri/target` 阈值 **15GB**：`prebuild` 自动 `cargo clean`（`scripts/check-target-size.js`）；历史值与理由见脚本头注释，改阈值前先读它。
- **共享 target 目录只报告不自动删**：宿主 `target/fixtures`、`target/wasm-apps`（应用共享）等——删掉等于丢共享编译缓存；`cargo clean` 只对宿主自己的 target 目录用。
- 仓库根级历史共享落点 `target/server-libs`（server-lib 拆出后 6 crate 的共享落点）/ `target/host-kits`（wasm-core-lib-split 后机制内核 + 能力域同族）由桌面端治理脚本**报告**（不删）；跨端测试迁出后 `wasmnest-test` 的 target 不在本仓统计内。
- sccache 是编译缓存主力：`cargo clean` 后依赖不重编（命中缓存）。

## 7. 测试门禁与 husky

- **禁止跑 `pnpm run test`（vitest watch 不退出）**——一律 `test:run`。
- husky pre-commit 自动跑两道：① WIT 漂移锁（`compose-wit.mjs --all --check`）② 暂存前端文件 eslint（两端 `src` / `packages` 面，error 阻断）。钩子跳过（node 缺失等）**不等于门禁通过**——手工补跑。
- 跨端真实互连测试在 `../wasmnest-test/cross-end-tests`（同进程 path 依赖两端 `src-tauri`，零 mock）；改传输 / 认证 / 配对面必去跑（写法见该工程 README / 各测试头注释）。
- 完整测试矩阵（按改动类型）见 `docs/testing.md`。