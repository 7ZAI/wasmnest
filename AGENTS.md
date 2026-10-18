# AGENTS.md

> **本文件是 wasmnest（平台仓）——双端宿主 + 端内 SDK——的开发导航与硬边界，面向人类与 AI 协作者（含 vibe coding）。**
> 只给方向、判据与导航；机制细节、契约版本、历史与踩坑在各自真源里（代码头注释、SDK README、能力仓 WIT / `contracts/`、`release-manifest.json`），需要时按指针去读，不在本文件复制。
> 机制描述与真源冲突时，以真源 + 平台仓锁为准，并回来修正本文件。

## 0. 定位与冲突裁决

**本仓定位**：四仓（平台 / 能力 / 应用 / 跨端测试）里唯一的**宿主与发布面**——桌面与移动两个宿主（`wasmnest-desktop/`、`wasmnest-mobile/`：`src-tauri` + 前端 + 端内 SDK）、根构建 / 发布工具（`scripts/`）、WIT 拼装与跨仓版本表达（`release-manifest.json`）都住这里。能力仓只提供应用无关的引擎与契约真源，应用仓只提供业务语义（wasm 应用）。**新增能力先问「这是机制还是产品语义」**，机制落能力仓、产品落应用仓，宿主只做装配与安全闸门（§5 红线）。

冲突按下述优先级裁决（高者胜）：

1. **用户当前明确指令**
2. **安全与架构红线**（§5 宿主薄壳、§8 安全红线）——确需越线时停下向用户确认，禁止自行放松
3. **本文档硬约束**（「必须 / 禁止」字样）
4. **跨仓真源**（能力仓 WIT / `contracts/` / `release-manifest.json` / SDK 生成物 / 代码自身）
5. **通用工程经验**

维护口径：

- **路径基准**：仓内路径相对平台仓根。跨仓按 R1 同场布局记为 `../wasmnest-lib`（能力仓，同时以 git submodule 挂在 `packages/`）、`../wasmnest-apps`（应用仓）、`../wasmnest-test`（跨端测试仓 `cross-end-tests/`）；布局不标准时用显式环境变量 `WASMNEST_APPS_ROOT`（平台 → 应用），resolver 唯一入口 = `scripts/app-paths.mjs`（测试侧是 `wasmnest-*/src/__tests__/support/appPaths.ts` 与移动 vitest 的 `@apps` 别名）。
- **文档字面 ≠ 事实**：引用任何路径 / 命令 / 锁名 / 版本前先用 `ls` / `rg` 核对；与实际不符先修文档再继续。
- **最小改动**：只改任务必要文件；禁止顺手重构相邻代码、擅自升级依赖（wasmtime / SDK 升级先做双端影响评估）；设计取舍不猜，先问用户。
- **项目阶段（研发起步期）**：无真实用户、无对外 ABI 兼容义务——破坏性变更可直接进行，但跨仓契约按 tag 钉住（§2.3），退役面必须 **fail-visible**（点名缺失 + 给出路），禁止静默降级成「查不到就返回空」。

### 0.1 Agent 工作流（vibe coding 简则）

1. **开工自检**：`git status` 认领改动来源；读相关模块头注释与本文件 §4 的「先读 Y」；确认要改的是哪一端（桌面 / 移动 / SDK / 工具）。
2. **边界判定**：动宿主侧前先过 §5.1 三问（能离宿主实现吗 → 携带产品语义吗 → 才放宿主）；改跨仓面（WIT / 清单 / 应用注册表）先读 §2。判不准就停下问用户。
3. **小步实现**：最小 diff 完成一个可验证单元；不并行夹带无关改动；生成物不手改（§2.5）。
4. **针对性验证**：按 §10 跑改动类型对应的最小测试集；改锁 / 改注册表 / 改 WIT 时必须跑对应锁。
5. **交付说明**：列出「改了什么 / 为什么 / 跑了什么命令与结果 / 没跑什么与风险」；凡按 §2 边界需要跨仓同步的（清单、子模块指针、应用注册表），逐项点名。

## 1. 仓速览

**结构**（平台仓 = 双端宿主 + 端内 SDK + 根工具；Rust 无根 workspace）：

```text
wasmnest/                                   # 平台仓根
├─ wasmnest-desktop/                        # 桌面宿主（Tauri 2 + Vue 3）
│   ├─ src/                                 # 宿主壳（ShellHost：主屏 + 系统页 + 挂载槽）
│   ├─ src-tauri/                           # 桌面 Rust 宿主（插件机制接线 / 安全闸门 / 服务器 / 图标…）
│   ├─ packages/plugin-sdk-desktop/         # 桌面端内 SDK（npm + crates：wasmnest-plugin-api）
│   ├─ packages/plugin-*/                   # 宿主测试夹具包（bench / fixtures / system-test）
│   ├─ scripts/                             # dev-run / tauri-build / plugin-build / plugin-watch / plugin-dev / target 治理
│   ├─ e2e/ · bench/                        # WDIO E2E（smoke/bench）· 桥接基准工程
│   └─ resources/ · tailwind/postcss/stylelint/tsconfig/wdio…
├─ wasmnest-mobile/                         # 移动宿主（Tauri 2 Android + Vue 3）
│   ├─ src/                                 # 宿主壳（/mobile/shell：注册表 + 运行面）＋ 少量既有页面
│   ├─ src-tauri/                           # 移动 Rust 宿主（含 gen/android 手写 Kotlin 面）
│   ├─ packages/plugin-sdk-mobile/          # 移动端内 SDK（wasmnest-plugin-api-mobile）
│   └─ scripts/                             # dev-run / plugin-build / android-dev-log / target 治理
├─ packages/                                # ★ git submodule → 能力仓（wasmnest-lib，钉 tag）：引擎 + 契约 + WIT 真源
├─ scripts/                                 # 根工具（见 §3.2）：compose-wit / app-paths / app-script / adaptive-run / 版本与清单
├─ tools/componentize/                      # 组件化工具（wasm32-unknown-unknown core module → Component）
├─ release-manifest.json                    # 跨仓版本唯一表达（§2.3）
├─ .cargo/config.toml                       # sccache 强制前置 + 并发兜底（未装 sccache 直接失败，是显性设计）
├─ .husky/pre-commit                        # WIT 漂移锁 + 暂存前端文件 eslint（§10）
└─ eslint.config.js                         # 双端共用前端静态锁（§6.2）
```

**双端一句话**：桌面 = 同窗口全屏挂载独立构建的应用包（机制 B）；移动 = 宿主壳运行面（`registerSurface` 等运行时注册），共享模块外置宿主全局与桌面不同（§5.4）。

**应用清单**（真源 = 各端构建注册表 + `release-manifest.json`；本表只是导航）：

| slug（应用仓目录） | 插件 id | 端 | 前端形态 |
| --- | --- | --- | --- |
| agent-hub | `com.wasmnest.agent-hub` | desktop | 桌面挂载包 |
| ai-chatbox | `com.wasmnest.ai-chatbox` | desktop + mobile | 挂载包 / 壳运行面 |
| bedcode（显示名 BedCode） | `com.wasmnest.terminal-session` | desktop + mobile | 挂载包 / 壳运行面 |
| file-transfer | `com.wasmnest.file-transfer` | desktop + mobile | 双端单产物（移动经 `desktop-compat` 桩，§5.4） |

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

**相邻仓**（本地 R1 布局）：`../wasmnest-lib`（能力仓，代码真源；本仓仅以 submodule 钉 tag 引用）、`../wasmnest-apps`（应用仓，业务主场，其 `AGENTS.md` 是应用侧硬约束）、`../wasmnest-test`（跨端真实互连测试）。旧仓 `BedCode`（工作区外一级 `../../BedCode/`）代码冻结，转为**文档真源与回退点**（ADR / knowledge / code-map）。

## 2. 边界与跨仓契约（先读这节再动手）

### 2.1 依赖方向（禁止反向引用）

- **平台 → 能力**：只经 `packages/`（submodule）的路径依赖与 WIT / `contracts/` 真源。**禁止在 `packages/` 工作树内直接改文件**（submodule 会变脏，`check:manifest` 即红，见 §2.3）；能力仓改动一律去 `../wasmnest-lib` 提交、打 tag 后回来移动 submodule 指针。
- **平台 → 应用**：源码读取的唯一入口是 `scripts/app-paths.mjs`（`WASMNEST_APPS_ROOT` / R1 兄弟布局，缺仓显性抛错）与 `scripts/app-script.mjs`（转发单 app 脚本）；测试侧经 `support/appPaths.ts` / `@apps` 别名。**宿主构建期禁止 import 任何 app 源码**（桌面边界锁会测红）——宿主与 app 只有「运行时装载产物」一条关系。
- **应用 / 能力 → 平台**：禁止反向引用平台源码（应用只认 SDK 发布版本 / WIT bundle / ABI）；能力仓在 L1 档位下仍有测试期读取平台源的既有锁（6 处，随能力仓 submodule），**不得新增**这类反向边。

### 2.2 跨仓锁（读对方仓源码的锁；改本仓结构 / 文案前先看它们）

| 锁 | 位置（本仓） | 钉住什么 |
| --- | --- | --- |
| `hostAppBoundaryLock.test.ts` | `wasmnest-desktop/src/__tests__/` | 宿主零 app 源码 import、零 `__WASMNEST_SHARED__`、零旧贡献面；逐字校验四个桌面 app `entry.ts` 的 `mountApp` 契约（**新增 / 改名桌面应用必须同步该清单**） |
| `i18nDriftLock.test.ts` | 同上 | 宿主 `src/i18n/host-{zh-CN,en}.ts` ↔ `apps/bedcode/desktop/src/i18n/host-{zh-CN,en}.ts` **逐字一致**（改任一边必须同改另一边） |
| `tailwindContentCoverage.test.ts` | 同上 | 宿主 Tailwind content 不得残留 app 路径（app 类各自编译） |
| `appBundlePathLock.test.ts` / `appChromeLock.test.ts` | 同上 | 挂载包路径单一来源（`resources/plugins/desktop` 层级）；壳标题栏常驻、应用不得自绘标题栏/窗口控制/拖拽区 |
| 移动壳系列锁（`shellConstraintLocks` / `retiredHostUIRetirementLocks` 等） | `wasmnest-mobile/src/__tests__/shell/` | 壳内自足（不依赖旧界面目录）、退役路由 / 符号不回接、壳迁移面不得缩水 |

**锁是契约清单，不是障碍**：你的合法改动若使某把锁的清单 / 白名单过期，必须**同一提交内同步更新该清单**（并在交付说明里点名）；禁止删锁、缩窄 glob、把断言改恒真来「变绿」。

### 2.3 release-manifest.json（跨仓版本唯一表达）

- **谁写**：平台仓发布流程；**谁读**：装配校验、各仓 release、CI。一致性判据（`pnpm run check:manifest`，逐条可复现）：
  1. `product` == 平台仓 `package.json` 版本；
  2. `repos.lib.tag` == submodule `packages/` 的**精确 tag**（指针漂移或工作树脏即红）；
  3. `contract.version` == `packages/contracts/wasmnest-plugin-package.rs` 的 `PACKAGE_VERSION`；
  4. `contract.witSha256` == 双端组合 WIT 产物指纹（`node scripts/check-release-manifest.mjs --print-hash` 重算）；
  5. `apps` 段覆盖应用仓**全部** `apps/<slug>/<end>/plugin.json`（end 感知，`ends.<end>.artifact` == 该端 `rustLibrary + '.wasm'`）；
  6. `repos.apps.tag` == 应用仓 HEAD 精确 tag（发布装配口径）。
- **什么时候必须动它**：新增 / 改名 / 停用应用或变更 `rustLibrary`；WIT / 契约版本变更（3、4）；能力仓指针移动（2）；发布版本号变更（1）。改动后跑 `pnpm run check:manifest`。

### 2.4 WIT / 契约真源链（改契约不在端生成物里改）

```text
真源（能力仓，submodule packages/）：
  wasmnest-wasm-core/wit/core.wit                # 核心机制面
  各能力域 wit/<domain>.wit                      # 例如 wasmnest-pty-engine/wit/pty.wit
  contracts/wasmnest-plugin-package.rs           # 包名与版本唯一手写处（PACKAGE_NAME / PACKAGE_VERSION / PACKAGE）
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

### 2.5 生成物清单（能改 vs 不能改）

| 面 | 性质 | 规矩 |
| --- | --- | --- |
| `packages/plugin-sdk-*/rust/wit/**` | 生成物（compose-wit） | **禁止手改**；改真源后重拼。被跟踪入库 + 漂移锁 |
| `plugin-sdk-desktop/bin/permission-vocabulary.json`、`**/permission.vocabulary.ts` | 生成物（权限词汇） | 真源 = 本端 SDK `rust/src/permission.rs`；重跑 `pnpm run gen:permissions`（桌面 SDK） |
| `src-tauri/resources/plugins/**` | 构建产物 | 不入库；只由构建 / watch 脚本写入（勿手工拷） |
| `src-tauri/gen/schemas/**` | Tauri 生成物（ACL 清单） | 入库；由 `tauri dev/build` 重生成，不手工编辑 |
| `src-tauri/gen/android/**` | 混装：脚手架生成 + **手写 Kotlin 源码** | 手写面（`MainActivity.kt`、各 Plugin.kt）是版本跟踪的一部分；`tauri android init` 重建后需手工恢复 |
| `**/target/**`、`**/dist/**`、`node_modules/**` | 构建产物 | 不入库（.gitignore 已覆盖） |
| `pnpm-lock.yaml` / 被跟踪的 `Cargo.lock` | 锁文件 | **只经包管理器变更，禁止手编**（宿主 `src-tauri/Cargo.lock` 刻意不入库；SDK / 夹具的 Cargo.lock 入库） |

### 2.6 Agent 禁行清单（速查）

- 不手改生成物（§2.5）；不在 `packages/` 工作树内改能力仓文件（§2.1）。
- 不在宿主构建期 import app 源码；不复活旧贡献面（`registerSidebarPanel` 等）与 `__WASMNEST_SHARED__`（桌面）。
- 不由前端直接发起 HTTP / WS / 文件访问、不裸用 `__TAURI__`、不旁路授权弹窗（§6.2 / §8）。
- 不为「让测试变绿」删锁 / 缩 glob / 掏空断言（§2.2）。
- 不提交密钥 / 凭据 / 产物；不手编锁文件；不 `cargo clean` 共享 target 目录（§3.5）。
- 不开工就改：先 `git status`，**非本任务的在途改动一律不碰、不回滚**（§11）。
- 不自动 `--force` 覆盖远端；不在 commit message 里加 AI 协作者标记（§11）。
- 不跑 `pnpm run test`（vitest watch 不退出）——一律 `test:run`（§3.1）。

## 3. 命令

> **包管理器一律 pnpm（禁止 npm）**；根 `pnpm install` 只为根 lint / husky / 根脚本，**两端依赖各自目录安装**；Rust **无根 workspace**，命令在各自 crate 根跑（宿主 = `<end>/src-tauri`）。

### 3.1 通用约定

| 项 | 要求 |
| --- | --- |
| Tauri | **2**（写 API 前确认是 v2） |
| wasmtime | **双端 48**，升级必须双端同步（ADR 0019）；桌面 `[patch.crates-io]` 把 `wasmnest-plugin-api` 指回工作树 SDK，**patch 目标版本必须与能力仓声明一致**（不一致 cargo 直接失败，别去放宽） |
| wasip3 工具链 | 桌面一般应用走 `wasm32-wasip3`，pinned nightly 单一事实源在 `scripts/wasip3-toolchain.sh`（`WASIP3_NIGHTLY`，当前 `nightly-2026-09-16`；切换点 stable ≥ 1.99 写在该脚本头注） |
| sccache | 根 `.cargo/config.toml` 强制 `rustc-wrapper = "sccache"`——未装则一切 cargo 命令直接失败，**这是显性失败设计，不要加降级绕过** |
| 构建资源自适应 | 重型构建用 `node ../scripts/adaptive-run.mjs -- <cmd>`；逃生阀 `WASMNEST_ADAPTIVE=0`、档位 `WASMNEST_BUILD_PROFILE=parallel|balanced|serial` |
| Android 工具链 | JDK / SDK / NDK 由移动端 `src-tauri/gen/android` 分发包管理，不自行安装另一套 |

### 3.2 平台仓根（`wasmnest/`）

| 命令 | 说明 |
| --- | --- |
| `pnpm install` | 根依赖（eslint / prettier / husky） |
| `pnpm run test:run` | 根脚本自测（`node --test scripts/*.test.mjs`：adaptive-run / build-profile） |
| `pnpm run check:wit` | WIT 拼装漂移锁（== husky 判据；改了契约真源后必跑） |
| `node scripts/compose-wit.mjs --all` | 双端重拼 WIT 生成物（bump / 改真源后） |
| `pnpm run check:manifest` | `release-manifest.json` 一致性（§2.3） |
| `node scripts/check-release-manifest.mjs --print-hash` | 打印当前双端 WIT 指纹（更新 manifest 用） |
| `node scripts/bump-version.mjs --patch\|--minor\|--major\|-v X.Y.Z [--desktop\|--mobile\|--both] [--commit] [--tag]` | 双端版本号（各 3 处） |
| `node scripts/package-sdks.mjs --list \| --target <desktop\|mobile\|all>` | 两端 SDK 构建 + 打包（npm tarball + crates + zip） |
| `node scripts/app-script.mjs <slug> <desktop\|mobile> <script>` | 转发到应用仓单 app 脚本（如 `build:frontend`） |
| `node scripts/adaptive-run.mjs -- <cmd>` | 自适应构建包装（可在任一目录以正确 cwd 执行） |
| `node scripts/audit-rust-tests.mjs` · `scripts/run-test-split.sh --crate <子串>` | Rust 测试体量审计 / 批量拆分（§6.5） |

### 3.3 桌面端（`wasmnest-desktop/`）

| 命令 | 说明 |
| --- | --- |
| `pnpm install` | 本端依赖（独立 workspace，`packages/*`） |
| `pnpm run tauri:dev` | 宿主 dev（`scripts/dev-run.js`：端口预检 → 插件 wasm / 前端缺失预建 → tauri dev → 3 个插件前端 watch；bedcode 前端不参与 watch，改了单独重建） |
| `pnpm run tauri:build` | 生产构建（`scripts/tauri-build.js` 解析 updater 签名；无密钥时自动关闭更新包产物） |
| `pnpm run plugins:build` | 全量应用构建（`scripts/plugin-build.js --all`，注册表 = 4 个应用单一真源） |
| `pnpm run plugins:dev` | 单插件 dev 构建（`scripts/plugin-dev.js`） |
| `pnpm run test:run` | vitest（宿主 `src/__tests__` + **桌面 SDK 契约测试**） |
| `pnpm run test:e2e` | WDIO E2E（需 debug 二进制 + 已构建前端；`e2e/specs/{smoke,bench}.spec.ts`） |
| `pnpm run bench` / `bench:full` | 桥接基准（`src-tauri` 的 `wasm_bridge_bench`，无参数=冒烟） |
| `cd src-tauri && cargo test` | 宿主 Rust 全量（含能力层 / CSP 锁、生命周期注册锁、e2e；**部分用例要求先构建随包插件产物**，见各测试头注释） |
| `pnpm run target:size` | target 治理（§3.5；`prebuild` 钩子自动跑） |

### 3.4 移动端（`wasmnest-mobile/`）

| 命令 | 说明 |
| --- | --- |
| `pnpm install` | 本端依赖（独立工程 workspace） |
| `pnpm run tauri:android:dev` | Android dev（`scripts/dev-run.js`：adb 定位 / 插件 watch → tauri android dev；**插件改动进应用后需手动重新激活生效**） |
| `pnpm run tauri:android:build` | Android 构建（`--target aarch64`；另有 `:build:emulator` / `:build:fast` / `:build:all`） |
| `pnpm run plugins:build` | 扫描 `../wasmnest-apps/apps/*/mobile` 全量构建（无宿主侧注册表） |
| `pnpm run test:run` | vitest（宿主 `src/__tests__`；不含 SDK） |
| `cd packages/plugin-sdk-mobile && pnpm run test:run` | 移动 SDK 契约测试（独立 vitest 配置） |
| `cd src-tauri && cargo test` | 移动宿主 Rust 全量（含纯净性 / 退役面 / 注册完整性等锁） |
| `pnpm run target:size` | target 治理（§3.5；`prebuild` 钩子自动跑） |

### 3.5 构建资源与 target 治理

- 宿主 `src-tauri/target` 阈值 **15GB**：`prebuild` 自动 `cargo clean`（`scripts/check-target-size.js`）；历史值与理由见脚本头注释，改阈值前先读它。
- **共享 target 目录只报告不自动删**：`target/fixtures`、`target/wasm-apps`（应用共享）等——删掉等于丢共享编译缓存；`cargo clean` 只对宿主自己的 target 目录用。
- 根级 `target/server-libs` / `target/host-kits` 等历史共享落点由桌面端 target 治理脚本报告（跨端测试迁出后 `wasmnest-test` 的 target 不在本仓统计内）。
- sccache 是编译缓存主力：`cargo clean` 后依赖不重编（命中缓存）；**绝不要设 `CARGO_INCREMENTAL=1`**（sccache 会拒绝执行，见 `.cargo/config.toml` 注释）。

## 4. 任务路由：改 X 先读 Y

| 任务 | 动手前必读 |
| --- | --- |
| 改桌面宿主壳 / 挂载槽 / 系统页 | `wasmnest-desktop/src/main.ts` + `src/shell/**`（`useShellApps.ts` = 应用路由真源）+ §5.2；跑桌面 `test:run` + 真实 `tauri:dev` 目验 |
| 改移动宿主壳 / 运行面 / 注册表 | `wasmnest-mobile/src/shell/registry.ts`（职责边界：只注册不决策）+ `plugin-sdk-mobile/src/types.ts`（`UIRegistry`）+ §6.4；优先移动 SDK dev-shell 预览 |
| 改插件机制 / 生命周期 / 能力接线（Rust） | 该端 `src-tauri/src/plugin/**`（每个域一个文件，端口 adapter + 白名单条目同处，**先读文件头注释**）+ 能力仓对应 crate；跑该端 `cargo test` |
| 改权限 / 授权闸门 | 本端 SDK `rust/src/permission.rs`（词汇真源）+ §7.2；生成物重出（桌面 `gen:permissions`）；跑相关锁 |
| 改 WIT / ABI / 契约 | §2.4 全链 + `scripts/compose-wit.mjs`；**不在端生成物里改**；改完重拼、重建受影响 app 产物、同步 manifest |
| 改 SDK（TS / Rust 面） | 该端 `packages/plugin-sdk-*/`（README + `src/types.ts` / `rust/src/lib.rs`）；跑 SDK `test:run`；发布走 `package-sdks.mjs`。**桌面 SDK 的 README / template / dev-shell 仍是旧贡献面形态（已知漂移）——写新代码以应用仓现有 app 为形态基准** |
| 改构建 / dev 脚本 | 对应脚本头注释（自解释）+ 根 `scripts/app-paths.mjs`；桌面还有 `src/__tests__/scripts/pluginWatchCopy.test.ts` 等脚本锁 |
| 新增 / 改名 / 停用桌面应用 | 应用仓先按 `../wasmnest-apps/AGENTS.md` §5 清单走；本仓四处注册表 + 一处路由 + 两处锁必须同步：`scripts/plugin-build.js` `PLUGINS`、`scripts/plugin-dev.js` `PLUGINS`、`scripts/dev-run.js` `PLUGIN_WATCH_CMDS`、`src/shell/useShellApps.ts` `SURFACE_ROUTES`（+ `src/router/index.ts` 路由条目）、`hostAppBoundaryLock.test.ts` 的 `APP_ENTRIES` + `release-manifest.json` |
| 新增 / 停用移动应用 | 移动构建自动扫描 `apps/*/mobile`（无注册表）；只需同步 `release-manifest.json`；机制差异读 §5.4 |
| 改跨端传输 / 认证 / 配对面 | §9.2；改完去 `../wasmnest-test/cross-end-tests` 跑真实互连（零 mock） |
| 改 Android 原生（Kotlin / manifest / gradle） | `wasmnest-mobile/src-tauri/gen/android/**`；改 Kotlin 必须 gradlew 验证；`tauri android init` 重建后手工恢复手写面 |
| 排查「改了没生效」/ 产物路径 | 桌面 `scripts/{dev-run,plugin-watch,plugin-build}.js`、移动 `scripts/plugin-build.js`、`scripts/app-paths.mjs`；先确认产物是否真写进 `src-tauri/resources/plugins/<end>/<id>/` |
| 发布 / 版本 | §2.3 清单 + `scripts/bump-version.mjs` + `scripts/package-sdks.mjs`；三仓 tag 规则见 §11 |
| 定位代码 | §12 代码查找纪律 |

## 5. 架构硬约束：宿主机机制、业务归应用

**一句话**：宿主只含「应用无关的通用引擎 + 安全闸门 + 装配机制」，一切产品概念（会话、终端、设备连接、文件传输、AI、Agent……）都是 wasm 应用。演进方向与裁决词汇见 §5.1；桌面两层四闸门四通道的实现落点见 §5.2。

### 5.1 宿主侧无业务代码（强制红线）

**判定：宿主只回答「机制怎么做」，不回答「这件事是什么、给谁用、怎么组织」。**

#### 5.1.1 口径：六条判据（命中任一即业务代码）

这是裁决词汇，报错信息与代码注释里直接用编号：

- **B1** 产品类型 / 字段：宿主以业务名词定义数据结构、枚举、状态、常量
- **B2** 业务编排 / 状态机：按产品语义推进的流程、队列、重试、封顶、状态迁移
- **B3** 业务真源：宿主持有产品事实的权威存储并对外读写
- **B4** 业务投影：把原语结果翻译成产品 wire 形状再对外消费
- **B5** 业务默认值 / 策略：宿主替插件决定「业务上该怎样」
- **B6** 业务生命周期挂钩：宿主解释产品事件并主动回调插件

#### 5.1.2 归属裁决（三问，顺序不可颠倒）

1. **离宿主能实现吗？** 能（插件已有 `host-*` 存储 / 总线 / 事件 / 任务原语自建）→ **放插件**。
2. **携带产品语义吗？** 命中 B1–B6 → **放插件**。
3. 都不命中 → **放宿主**，且必须满足：WIT 纯增量（或走 ABI bump 流程）、权限位有门禁落点、停用可回收。

「宿主已经能拿到这些数据」**不是**留在宿主的理由；判不准时从严判并停下问用户（§0 优先级 2）。

#### 5.1.3 宿主允许存在的四类薄壳

① **引擎实现** · ② **安全闸门**（权限判定、fail-safe 默认如「无应答 / 超时即拒」、配额仲裁）· ③ **通用注册表与寻址** · ④ **零解析窄转发**。四类之外的任何「顺手加的」业务逻辑都是越线。

#### 5.1.4 强制执行机制

- **防回接锁**：越线回接会直接测红（§2.2 清单）；新增退役面时同步补锁。
- **真源搬迁必配 fail-visible 三形态，缺一不可**：① 旧读路径删除或显性报错，**禁止**改成「查不到就返回空」② 旧 ABI 产物在实例化期点名缺失 interface 与重建版本 ③ 退役权限位 / 命令字眼加载即抛。
- **提交前自检**（改动落在宿主侧时逐条回答，答不出就停下问用户）：① 在宿主有第二个消费者吗？② 删掉它，第三方插件能用同一形状的既有原语自建吗？③ 是否新增了对产品事件的解释或回调（= B6）？
- **越线处理**：确需越线时停下向用户确认并记决策，禁止自行放松红线。
- **落地顺序**：ABI bump + 双端 WIT 副本同步 + 移动端影响评估（§2.4）。

### 5.2 桌面端宿主形态（壳 + 挂载槽，机制 B / ADR 0057）

- **宿主壳**（`wasmnest-desktop/src/`）：主屏 + 系统页（`/sys/:pageId`：设置 / 应用管理 / 权限与授权）+ 挂载槽。**宿主零业务状态**——不持有任何 app 内部状态（装载即建、卸载即销毁）。
- **应用是独立构建的挂载包**：宿主经 `plugin_get_asset_dir` 拿到产物根目录，`useAppMount` 动态 import `<id>/index.js`，入口契约 `mountApp(root, env): Promise<AppMountHandle>`（`AppMountEnv`：`appId` / `invoke` / `appInvoke` / `appStorage*` / `locale` / `theme` / `initialRoute` / `onEvent`）。**前端不拼产物路径**（resource 层级差一层就是 404 静默断裂，有锁）。
- **路由真源**：`src/shell/useShellApps.ts` 的 `SURFACE_ROUTES` + `src/router/index.ts` 逐条路由（应用路由全部指向 `AppMountSlot`；未匹配落显性 not-found，不白屏）。新增桌面应用必须同步（§4）。
- **热更新闭环**：改 app 源码 → vite rebuild → 复制进资源目录 → 宿主 watcher `plugin:dev-reload` 重载前端；`tauri:dev` 自带缺口预建（别在宿主冷构建期间手工往 `src-tauri/` 拷产物，会触发重启风暴，机制见 `scripts/dev-run.js` 头注释）。
- **壳标题栏常驻**：所有 app 页面共用壳标题栏，应用只占其下区域（`appChromeLock` 钉住）。

### 5.3 退役面纪律（fail-visible 与防回接）

- 已退役的宿主面（如 `host-session` / `host-terminal` 词汇、旧贡献面 `registerSidebarPanel`、旧 UI 路由 / 按钮）**连同权限位整体退役**，不得回接；回接由锁与 Rust 测试双重拦截（如 `capability_crates_no_product_ids.rs`、移动 `retiredHostUIRetirementLocks`）。
- 退役路径上的异常必须**显性**：旧插件调用退役扩展点 → 桩函数当场点名报错（如移动 `src/plugin/context.ts` 的四点抛错桩），不得 undefined 崩溃或静默忽略。
- 调试点名与「墓碑」注释是团队惯例：注释里保留的退役说明是**设计资产**，不要顺手删除。

### 5.4 双端差异与锁步（勿把桌面结论套到移动端）

- **单形态运行时（单一 crate · 一份壳）**：机制内核 = 能力仓 `packages/wasmnest-wasm-core`（**无 common/bare 形态之分**）。桌面开 `desktop-assembly` 装配面；移动 `default-features = false` 拿统一机制 + 运行时壳。**WIT 绑定、端事实与端 SDK 依赖全部在各端宿主**（`src-tauri/src/plugin/**`）：宿主各域实现经统一注册汇入 Linker，`AbiPolicy` 由宿主装配时注入（桌面要求组件形态 `abi-form`，移动不约束）。
- **双端契约各自演进（compose 组合，不做 union）**：核心 WIT + 能力域分片可被任意端组合；端独有功能的声明与实现都住端宿主（桌面端：`cap-desktop.wit` 等端 cap；移动端：`cap-mobile.wit`）。**移动不跟演**桌面部分 ABI 破坏性变更；但**跨端协议（HTTP / WS / QR / 认证）改动必须两端同步部署**（§9.2）。
- **WASI 面是共享机制**：双端默认全开，开 / 关走运行期配置，不要把它当形态差异轴。
- **双端单产物（file-transfer）**：移动宿主为桌面专属 interface 提供 **fail-visible 桩**（`desktop-compat`，`Err("unsupported on mobile: …")`）——桩只为 import 闭合，**不是「移动端实现桌面能力」**；真实调用 = 平台探测失效，错误当场点名。
- **共享模块形态不同**：桌面挂载包**自带全部依赖**（无 externals；宿主锁禁止 `__WASMNEST_SHARED__`）；移动共享 vue / vue-i18n / pinia 于宿主全局 `__WASMNEST_SHARED__`（经 SDK 代理访问，插件不直接操作全局）。
- wasmtime 双端同版本（§3.1）；升级先做双端影响评估。

### 5.5 权限与安全闸门总览（宿主侧的唯一入口）

- **权限**：无默认授予；生效权限 = manifest 声明 ∩ 用户批准（移动审批 = 内容 SHA-256 钉扎，批准后目录被替换 → 批准自动撤销，必须重新人工审批）；词汇真源 = 本端 SDK `permission.rs`（§7.2）。
- **egress（出站）**：三层判定（目标白名单 → 声明 `preauthUrls` → 记忆）+ 未命中一次授权弹窗；无 app_handle 的无头 / 测试上下文 fail-closed（收紧为「判定失败」而非放行）。
- **文件系统**：三层授权链（预授权目录 → 已授权前缀 → 弹窗授权，「记住」按目录落账）；`fs:pick` 与 `fs:read/write` 分域。
- **能力层（Tauri ACL）与 CSP**：引擎级封禁前端直连（§6.2 / §8），ACL 未写即运行期拒。
- **错误信封（ADR 0030）**：跨进程失败一律 `{ code, request_id, params? }`；`code` 即前端 i18n key，技术细节（错误原文 / 堆栈）不出产生方、只进宿主日志。

## 6. 代码规范

### 6.1 Rust

- 文件与模块命名：snake_case，模块入口文件与目录同名（`module.rs`），不用 `mod.rs`。
- 统一错误类型 `AppError`；错误构造 / 转换处必须带操作描述，**禁止裸 `?` 透传无上下文错误**；`tokio::spawn` 用 `spawn_with_error_boundary()` 包装；重要路径禁止 `let _ =` 静默忽略。
- panic hook 内只用 `eprintln!`，禁止 `tracing::error!`。
- Tauri Commands：`list_*` / `get_*` / `create_*` / `delete_*` / `start_*` / `stop_*` 命名，用 `// ====================` 分隔注释按领域分组；**注册面变更要跑命令注册锁**（如桌面 `lifecycle_command_registration_lock`、移动 `command_registration_completeness_lock`）。
- 调试专用命令面必须 `#[cfg(debug_assertions)]` 门控（如 bench channel），并有锁证明 release 不含。

### 6.2 前端（零资源访问红线，静态锁见根 `eslint.config.js`）

- 前端只做 UI：**禁止** `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `navigator.sendBeacon`，禁止 `window.open` / `location.href=` 等导航原语，禁止裸 `__TAURI__`，禁止 import `@tauri-apps/plugin-{http,fs,shell,updater,opener}`。
- 一切 HTTP / WS / 文件访问由 Rust 端发起并经权限仲裁：走 `invoke(...)` → 宿主命令 / `appInvoke(...)` → 插件命令面。允许 `convertFileSrc`（既定产物 / 图标加载路径）与 `invoke` / `listen`。
- **三层封锁**：源码 ESLint 静态锁 + Tauri ACL 运行期拒 + CSP 引擎级封（`connect-src 'none'`；`index.html` 不得内联 `<style>` / `<script>`，nonce 会令 `'unsafe-inline'` 失效——锁在 `src-tauri/tests/capabilities_lock.rs`）。**ACL 与 CSP 两层无豁免机制**：要开就改锁并写清理由。
- 唯一豁免路径：ESLint 层逐行 `eslint-disable-next-line` 并注明理由（豁免随 code review 可见，不静默放行）。
- 错误处理：统一 `logger`（真源 `src/utils/frontendLogger.ts`），禁止静默 `catch`；IPC 调用统一走 `src/utils/invoke.ts`（带超时，失败承载为错误信封）；用户可见文案一律走 i18n。
- 禁止用 viewport 宽度 / UA 字符串推断平台；平台判断统一走 Tauri API / `usePlatform`。

### 6.3 桌面挂载包 / 移动壳运行面纪律

- 桌面 app 前端：`build.lib` 单文件 `index.js`、CSS inline、**无 externals**；各 app 自持 tailwind 配置，类名自编译（宿主 Tailwind 不再扫 app）。
- 移动 app 前端：经 SDK `wasmnestPlugin()` 构建（共享模块外置），入口 `src/index.ts` 导出 `activate(context)` / `deactivate()`；贡献面收拢为运行面 + 少量注册点，退役方法调用即显性报错（fail-visible）。
- 双端 app 均**自足 i18n**；移动端样式经 `?inline` 注入（宿主不加载插件 CSS）。

### 6.4 移动宿主壳优先（强制）

- 移动宿主前端的新功能 / 重构 / 样式调整，默认落 `wasmnest-mobile/src/shell/**`（`/mobile/shell`）；既有旧页面目录（`src/{components,views,composables,stores}`）只接受**缺陷修复**，直到被彻底替换。
- 壳内自足：壳不得 import 旧目录（锁 L7 拦截）；壳内需要的组件 / 机制**复制进壳**再改造。
- **业务不落壳**：终端 / 文件 / 会话 / 设备 / AI 等业务页面归各 wasm 应用（`registerSurface` / `registerSlot`）；壳只提供挂载、生命周期与权限闸门。壳自持三类：运行面挂载与生命周期、平台机制与安全闸门、宿主公共组件。
- 迁移面不许缩水：壳内复制面文件清单被锁正面钉住，新增复制件同步登记锁内清单。

### 6.5 单元测试

- **两种形态，按体量选，别混用**：① 少量用例 → 同文件末尾 `#[cfg(test)] mod tests`；② 用例多 → 同目录 `<模块名>/tests/*.rs` 或 crate 根 `tests/*.rs`（**必须有 `mod` 声明**，否则用例静静躺着永不编译）。新增测试文件按 ②。
- **禁止交付**：无断言 / 恒真断言 / 只测 mock / 快照替代行为断言 / 只为覆盖率的用例。
- 运行位置：前端 vitest 在端目录（`src/__tests__/**`，happy-dom；移动 vitest 的 `@apps` 别名是跨仓读取专用，**不得进宿主构建代码**）；Rust 在 crate 根（宿主 = `src-tauri`；SDK = 各自 `rust/`）。测试数据走临时目录，禁止污染真实数据 / 日志目录。
- 迁移 / 拆分测试用 `scripts/audit-rust-tests.mjs` + `scripts/split-rust-tests.mjs` + `scripts/run-test-split.sh`（逐 crate 事务化，红了即回滚该文件）。
- 跨仓锁（§2.2）与注册表锁是**契约声明**：改动使其清单过期时同批更新；迁移锁后按 Seam 3 纪律**跑红一次**证明不空转。
- 部分桌面 Rust e2e（pty / ws / http）依赖 `resources/plugins/desktop` 随包产物，跑前先构建（见各测试头注释）。

### 6.6 注释、命名与 i18n

- 注释解释**为什么**（中文，技术术语保留英文）；禁止用 spec / 票号引用替代自解释；改代码必须同步修正相关注释（含路径 / 符号名 / 计数声明）。
- 组件 PascalCase、composable `use` 前缀 camelCase、文件名与导出一致；Vue 组件 / 目录结构跟随既有两端的同构惯例。
- i18n：桌面 `src/i18n/host-{zh-CN,en}.ts`（+ `index.ts`）、移动 `src/locales/{zh-CN,en}/`；**新增 / 修改 key 必须双语同步**；用户可见文案禁止硬编码。
- **宿主消息集与 bedcode 应用副本逐字一致**（`i18nDriftLock`）：改任一边必须同批改另一边（§2.2）。

## 7. 插件与 SDK 契约

### 7.1 plugin.json 与 manifest

- 必填字段：`name` / `version` / `platform` / `main` / `pluginType` / `permissions` / `contributes`（宿主反序列化无缺省，缺失即拒装）。
- `platform`：`desktop` / `mobile` / `both`，**必须覆盖本端**（两端宿主在扫描与 zip 安装两条入口 fail-visible 拒绝错端产物）；仅真正的双端单产物（file-transfer）写 `both`。
- `pluginType`：桌面内置应用 `rust-ts`（必须给 `rustLibrary`，与 Cargo 包名一致）；移动应用 `wasm`。
- `contributes` / `permissions` 可按源码自动填充（本端 SDK `bin/manifest-gen.js` 等）；**自动填充是便利不是真源**，声明仍须与实际调用一致。
- `wasmHash` 由桌面构建链注入**产物目录**的 `plugin.json`（按 `<rustLibrary>.wasm` 现算 SHA-256）；**源清单不写该键**。
- 移动端清单扩展：`preauthDirs`（预授权目录，支持 `${downloads}` 等占位）/ `preauthUrls`（出站 URL 白名单 glob），宿主在 preauthorize 阶段收齐后一次弹窗；桌面上这两个键无效。

### 7.2 权限

- **无默认授予**：权限位必须在 `plugin.json.permissions` 显式声明（`storage` 也一样），未声明即被拒。
- 词汇唯一真源 = 本端 SDK `rust/src/permission.rs`；打包 CLI 与宿主前端的列表都是**生成物**，禁止手抄。
- 高风险面按域拆分（`pty:spawn` / `pty:io`、`ws:client` / `ws:server`、`process:run` / `app:cli`、`task:run`、`crypto:*`、`fs:pick` vs `fs:read/write`……）：需要多少声明多少；文件走宿主授权链，**不要试图绕过**。
- 出站（egress）走三层判定 + 声明（§5.5 / §7.1 `preauthUrls`）；HTTPS 目标再校验收紧口径见能力仓 `wasmnest-server-http` 注释。

### 7.3 WIT / ABI 变更流程（改契约不在本仓生成物里改）

1. 改能力仓真源（`../wasmnest-lib`）：`wasmnest-wasm-core/wit/core.wit` 或能力域 `wit/<domain>.wit`；按 bump 政策改 `contracts/wasmnest-plugin-package.rs` 的 `PACKAGE_VERSION`。
2. 能力仓提交 + 打 tag；平台仓移动 submodule 指针（`git submodule update`）→ 同步 `release-manifest.json`（`repos.lib.tag` / `contract.version`）。
3. `node scripts/compose-wit.mjs --all` 重拼双端生成物 → `pnpm run check:wit`。
4. 受影响端更新 SDK 侧 Rust / TS 面（`packages/plugin-sdk-*/`），跑 SDK 测试。
5. 应用仓按当前 SDK **全量重建**受影响 app 产物（版本进入 import 名，旧产物实例化期被点名）。
6. `node scripts/check-release-manifest.mjs --print-hash` 更新 `contract.witSha256` → `pnpm run check:manifest` 全绿。
7. 涉及行为的改动补测试（含失败路径）；不留「兼容旧产物」的冗余路径（§0 项目阶段）。

### 7.4 SDK（端内包，随端走）

- 桌面：`@binblink/wasmnest-plugin-sdk-desktop`（bin `wasmnest-plugin-desktop`；crate `wasmnest-plugin-api` + 宏 crate）+ manifest / wasm-hash 工具面。
- 移动：`@binblink/wasmnest-plugin-sdk-mobile`（bin `wasmnest-plugin`；crate `wasmnest-plugin-api-mobile`；含 `UIRegistry` 类型真源与 dev-shell）。
- SDK 版本一致性：npm `package.json` 与 `Cargo.toml` 必须一致（`scripts/package-sdks.mjs` 校验）；发布产物 = npm tarball + crates + zip + SHA256 清单。
- **已知漂移（写明责任）**：桌面 SDK 的 `README.md` / `template/` / `dev-shell/` 仍是旧贡献面形态（`activate(context)` + `__WASMNEST_SHARED__` 外置），与 ADR 0057 后的挂载包形态不一致——写新代码以应用仓现有 app 为准；该漂移的修复在**平台仓侧**（§4）。

## 8. 安全与日志红线

### 8.1 安全

- **禁止提交密钥 / 凭据**（含 `.env` 里的 `TAURI_SIGNING_PRIVATE_KEY_FILE`、Android `key.properties` / keystore、任何 token）；禁止进日志、进文档；**凭据只记长度不落明文**。
- **认证一律 fail-closed**：未在册 / 调用失败 / 拒绝 → 一律拒绝；**没有「查不到就放行」「传输失败就放行」的降级路径**。设备入场密码学与设备侧凭证材料归认证中心（应用侧），**宿主不得持有**（有反回接锁）。
- **宿主加密引擎只暴露无业务语义的中性算法原语**（裁剪线约束）；认证编排 / 业务语义加密归插件。
- 输入校验与权限仲裁在 **Rust 端**，前端校验仅是 UX；WS / HTTP 接入必须过认证与过滤链。
- 高风险能力声明即信任但**最小声明**：`pty:spawn`（在宿主机执行任意命令）/ `process:run` / `app:cli` 同信任域，只发确有需求的应用；宿主全量审计。
- 前端资源访问三类封锁与豁免机制见 §6.2；不要为「临时调试」撤 capability——**撤 capability 与补宿主命令必须成对提交**。
- 调试面（bench channel、wdio 插件注册等）必须 `cfg(debug_assertions)` 门控，并有锁证明 release 不含。

### 8.2 日志

- 统一 `tracing`：运行细节 `debug!` / 关键生命周期 `info!` / 可恢复异常 `warn!` / 影响功能的失败 `error!`。
- 三条硬规则：① panic hook 内只用 `eprintln!` ② 热路径克制（PTY 输出 / WS 每帧不打逐帧日志）③ guest 自报的可处理错误不升 `error!`。
- **结构化字段强制**：`session_id` / `device_id` / `plugin_id` / `request_id` / `batch_id` / `node_id` 一律 `key = %value`，**禁止拼进消息字符串**；错误信息必须带操作上下文。
- 前端落盘差异：**桌面 release 侧 error / warn 仍批量转发落盘**；移动 release 侧整体空实现（差异机制见各自 `frontendLogger.ts` 头注释，勿强行统一）。

## 9. 数据、协议与产物

### 9.1 数据库

- 主库 schema 单一事实源在能力仓 `packages/wasmnest-wasm-core`（`db.rs` + `db/schema.sql`）；迁移**必须幂等**；禁止手改生产库；改 schema 必须补幂等测试。
- 插件存储隔离：插件 KV 走 `plugin_storage` 表（属主分区 / 前缀纵深 / 护栏）；系统空间 `__system__` 只用于宿主机制（如审批记录），不占插件命名空间。

### 9.2 跨端协议

- HTTP / WS / QR / 认证 / 文件传输协议的改动**必须两端同步部署**，遵循「老端忽略未知字段」的增量原则，禁止破坏性替换。
- 真实互连门禁在 `../wasmnest-test/cross-end-tests`（同进程 path 依赖两端 `src-tauri`，零 mock）——改传输 / 认证 / 配对面必去跑。
- wasmtime 升级必须两端同步（ADR 0019，§3.1）。

### 9.3 产物、锁文件与 gen

- 不入库：`node_modules/`、`dist/`、`**/target/`、`resources/plugins/**`、`*.local`、`gen/android/.../assets/_up_/`、宿主 `src-tauri/Cargo.lock`、生成物权限词汇文件（.gitignore / .prettierignore 已覆盖）。
- 入库但「生成物禁止手改」：`packages/plugin-sdk-*/rust/wit/**`、`src-tauri/gen/schemas/**`（§2.5）。
- `src-tauri/gen/android/**`：混装面——手写 Kotlin（各 Plugin / MainActivity / 通知 / SAF 等）是版本跟踪一部分，`tauri android init` 后手工恢复；改 Kotlin 必须 gradlew 验证。
- 锁文件只经包管理器变更；被跟踪的 Cargo.lock（SDK / 夹具）由 cargo 重生成，禁止手编。
- target 治理见 §3.5；发布签名材料本地持有（不入库）。

## 10. 完成定义与验证

**本仓（以及三仓）当前无 CI workflow**（未随迁；勿把「CI 会兜底」当依据）。门禁 = husky pre-commit + 本地命令 + 测试锁。**任何交付必须实际运行并贴出结果；无法运行要说明原因与风险。**

**当前迁移期口径（用户 2026-10-18）**：不逐项跑集成 / 全量回归，收口后统一跑；日常改动至少跑**针对性单测 + 所在端测试**。以下为收口后的标准清单，按改动类型执行：

- 改前端（任一宿主壳 / SDK UI）→ 该端 `pnpm run test:run` 全绿；根 `pnpm exec eslint .` 0 error；UI 改动至少在一个真实环境目验（桌面 `tauri:dev`；移动 dev-shell 或 Android dev）。
- 改 app 产物接线 / dev 脚本 → 根 `pnpm run test:run` + 该端相关脚本锁；确认产物真写进 `resources/plugins/<end>/<id>/`。
- 改宿主 Rust → 该端 `cd src-tauri && cargo test` 全绿（含锁测试）；需要随包产物的 e2e 先构建（§6.5）。
- 改 SDK → 该端 SDK `test:run`；涉及发布 → `package-sdks.mjs` 全链绿。
- 改 WIT / 契约 / 版本 → §7.3 全链：`check:wit` + 受影响 app 重建 + `check:manifest` 全绿。
- 改权限 / 清单 / 应用注册表 → `manifest-gen` / `manifest-validate` 通过；`check:manifest` 通过（涉及 id / rustLibrary / 端变化时）；相关边界锁同步更新并跑绿。
- 改移动壳 / Kotlin / gradle → 移动 `test:run` + gradlew 验证 + 真机 / 模拟器目验。
- 改跨端面 → `../wasmnest-test/cross-end-tests` 全量通过（写清「跑了 / 没跑」）。
- 宿主侧任何改动 → §5.1.4 自检三问通过（B1–B6 零命中；未在宿主新增业务类型 / 状态 / 存储 / 路由 / 默认值）。
- 迁移 / 新增锁 → Seam 3：锁**跑红一次**证明不空转；锁读文件失败必须显性失败（不静默跳过）。
- husky：提交前 `pnpm run check:wit` 与暂存前端 eslint 由钩子自动跑；钩子跳过（node 缺失等）不等于门禁通过——手工补跑。

## 11. 提交、回滚与 Git 规则

- Commit：conventional commits `<type>(<scope>): <subject>`；**禁止 AI 协作者标记**（Co-Authored-By 等）；分支 / 推送遵循各仓现有口径，**禁止 `--force` 覆盖远端**。
- 开工先 `git status`：非本任务的在途改动一律不碰、不回滚；远程分叉时立即停手问用户。
- **submodule 提交纪律**：能力仓改动先在 `../wasmnest-lib` 提交 / 打 tag，再在平台仓移动指针；**指针变更必须与 `release-manifest.json` 同步**（§2.3），不带着脏 submodule 提交。
- 只提交源码：产物 / 生成物禁令见 §9.3；新增生成物目录前先确认 .gitignore 覆盖。
- 三仓提交顺序（同一特性跨仓时）：能力仓（真源 + tag）→ 平台仓（指针 / 清单 / SDK 生成物）→ 应用仓（产物重建）；每一仓各自可回退。
- **文件回滚规范**：回滚前先 `git status <file>` + `git diff <file>` 确认不含本次会话之外的未提交改动；含他人在途改动的文件**禁止** `git checkout --` / `git restore` 整文件回滚——用编辑工具逐段逆向替换；误覆盖立即停手上报，不得猜测重建。

## 12. 代码查找纪律

- 探索定位**先读目录级头注释**：本文件 §1 树 → 目标目录（如 `src-tauri/src/plugin/` 每域一个文件，头注释写明职责与接线口径）→ 再 `ls` / `rg` 找文件；禁止未读头注释就全仓盲 grep。
- 两端同构文件（`frontendLogger` / `invoke` / `check-target-size` / `dev-run` / i18n 等）改动前先看另一端是否有同源副本——同构纪律要求同批修改或写明只改一端的原因。
- 生成物与源文件同名混淆高发（`rust/wit` vs `compose.json`；权限词汇 vs `permission.rs`）：改前确认自己在改「真源」还是「生成物」（§2.5）。
- 锁索引：分析「为什么这么写」时，优先找同名 `.test.ts` / `*_lock.rs`——本仓大量设计约束以锁形态存在，读锁最快。

## 13. 文档索引

| 需求 | 入口 |
| --- | --- |
| 跨仓版本 / 发布装配 | `release-manifest.json`、`scripts/check-release-manifest.mjs`、`scripts/bump-version.mjs` |
| WIT 拼装 / 契约版本 | `scripts/compose-wit.mjs`、`packages/contracts/wasmnest-plugin-package.rs`、双端 `compose.json` |
| 应用侧硬约束（业务主场） | `../wasmnest-apps/AGENTS.md` + 各 app `plugin.json` / `scripts/build.js` |
| 能力仓（引擎 / 契约真源） | `../wasmnest-lib/`（`wasmnest-wasm-core/wit/core.wit`、各域 `wit/<domain>.wit`、`contracts/`） |
| 跨端互连测试 | `../wasmnest-test/cross-end-tests/` |
| 旧仓（代码冻结 · 文档真源与回退点） | `../../BedCode/`：`docs/adr/`（含 ADR 0017/0019/0022/0030/0033/0051/0052/0056/0057 等）、`docs/knowledge/`（build-process / wasip3-toolchain / logging / plugin 清单等）、`docs/commands.md`、两端 `docs/code-map.md`——引用时注意旧仓代码与三仓现状有差异，机制以新仓代码为准 |
| 桌面 SDK | `wasmnest-desktop/packages/plugin-sdk-desktop/`（README 有已知漂移，见 §7.4） |
| 移动 SDK / 运行面类型 | `wasmnest-mobile/packages/plugin-sdk-mobile/`（`src/types.ts` = `UIRegistry` 真源） |
| 宿主构建 / dev 脚本 | 各端 `scripts/`（头注释自解释）+ 根 `scripts/{app-paths,app-script,adaptive-run}.mjs` |
| 沙箱 / 基准 | `wasmnest-desktop/bench/`、`e2e/specs/`、`tools/componentize/` |
| 编辑器 / 格式化 | `.editorconfig`、`.prettierrc.json`、根 `eslint.config.js`、两端 `tailwind.config.js` / `.stylelintrc.json` |
