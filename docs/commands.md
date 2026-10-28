# 命令全集（根 / 桌面 / 移动 / 应用 / 工具）

> **本文件是 `AGENTS.md` 的拆分文档（命令）**：双端与根工具的全部命令、通用约定、target 治理、测试门禁。
> **包管理器一律 pnpm（禁止 npm）**；根 `pnpm install` 只为根 lint / husky / 根脚本，**两端依赖各自目录安装**；Rust **无根 workspace**，命令在各自 crate 根跑（宿主 = `<end>/src-tauri`）。

## 1. 通用约定

| 项 | 要求 |
| --- | --- |
| Tauri | **2**（写 API 前确认是 v2） |
| wasmtime | **双端 48**，升级必须双端同步（ADR 0019）；桌面 `[patch.crates-io]` 把 `wasmnest-plugin-api` 指回工作树 SDK（平台仓根 `.cargo/config.toml`），**patch 目标版本必须与能力仓声明一致**（不一致 cargo 直接失败，别去放宽） |
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
| `pnpm run check:manifest` | `release-manifest.json` 一致性（判据见 docs/contracts.md §1；含 `hostRuntime` 段） |
| `pnpm run check:links` | markdown 死链锁（仓内跟踪 .md 的相对链接目标存在性；husky pre-commit 暂存含 .md 时自动跑；外链 / 锚点不探测——issue #14） |
| `node scripts/check-release-manifest.mjs --print-hash` | 打印当前双端 WIT 指纹（更新 manifest 用） |
| `node scripts/set-host-version.mjs <x.y.z>` | **发布时**同步宿主运行时版本三处（manifest `hostRuntime.version` / `tauri.conf.json` / `src-tauri/Cargo.toml`）；只写文件，不发布、不提交 |
| `node scripts/bump-version.mjs --patch\|--minor\|--major\|-v X.Y.Z [--desktop\|--mobile\|--both] [--commit] [--tag]` | 双端版本号（各 3 处） |
| `node scripts/package-sdks.mjs --list \| --target <desktop\|mobile\|all>` | 两端 SDK 构建 + 打包（npm tarball + crates + zip + SHA256 清单） |
| `node scripts/app-script.mjs <slug> <desktop\|mobile> <script>` | 转发到应用仓单 app 脚本（见 §5.3） |
| `node scripts/vendor-apps.mjs [--dest <目录>] [--end desktop] [--only <id,...>] [--dry-run]` | 把应用仓已发布的成品包（`<slug>-<end>-v<ver>.zip`）校验后铺进宿主随包目录（默认 `wasmnest-desktop/src-tauri/resources/plugins/desktop`）。三道校验：zip sha256 / 元数据 `source.libRef` == 清单 `repos.lib.tag` / 解出的 `plugin.json` 对齐清单；发布流水线用它内置应用（见 docs/contracts.md §7.1） |
| `node scripts/adaptive-run.mjs -- <cmd>` | 自适应构建包装 |
| `node scripts/audit-rust-tests.mjs` · `scripts/run-test-split.sh --crate <子串>` | Rust 测试体量审计 / 批量拆分（见 docs/testing.md §3） |

## 3. 桌面端（`wasmnest-desktop/`）

| 命令 | 说明 |
| --- | --- |
| `pnpm install` | 本端依赖（独立 workspace，`packages/*`） |
| `pnpm run tauri:dev` | 宿主 dev（`scripts/dev-run.js`：端口预检 → 插件产物预检 → tauri dev → 前端 watch；**bedcode 前端不参与 watch**，改了它单独重建 §5.2）。宿主启动的 file watch 覆盖整个 `src-tauri/`——**别在宿主冷构建期间手工往 `src-tauri/` 拷产物**，会触发重启风暴（机制见 `scripts/dev-run.js` 头注释） |
| 裸 `tauri dev` | 等价地保证插件产物最新：`tauri.conf.json` 的 `beforeDevCommand` 串入 `node scripts/plugin-precheck.mjs`（与 dev-run 共用同一预检模块，幂等），宿主 cargo build 前完成 6 个插件（4 apps + 2 servers）的 wasm / 前端陈旧补建与直写 resources；**但不带前端 watch**——改插件前端请用 `tauri:dev` 或手动 §5.2 |
| `pnpm run tauri:build` | 生产构建（`scripts/tauri-build.js` 解析 updater 签名；无密钥时自动关闭更新包产物；成功后把安装包重命名为 `<name>-<version>-release-<arch>[-setup].exe/.deb` —— **本地与 CI 同名**，命名规则在脚本头注释固定） |
| `pnpm run host:pack` | 产出「可直接运行的宿主产物**目录**」（`scripts/package-host.mjs`；产物契约 = 应用仓 `.scratch/2026-10-21-host-runtime-distribution/CONTRACT.md` §1）。默认写 `dist-host/host-desktop/`（**不在 `dist/` 下**，避免被 `vite build` 清空）；`host-version.json` 的版本事实来自 `release-manifest.json` 的 `hostRuntime`。**不再产出 tar.gz / sha256**（2026-10-28 裁决：平台仓不发布任何压缩包，分发走安装包）。`--skip-build` 复用 `src-tauri/target/debug/<bin>` 重铺产物；`--out` 覆盖落点；`--via-cargo` 绕开 tauri CLI 版本一致性检查。应用侧以 env `WASMNEST_PLUGINS_DIR` 指定 plugins 目录 |
| `pnpm run plugins:build` | 全量应用构建（`scripts/plugin-build.js --all`，注册表 = 5 个应用名单单一真源，见 §5.1） |
| `pnpm run plugins:dev` | 单插件 dev 构建（`scripts/plugin-dev.js`，见 §5.2） |
| `pnpm run test:run` | vitest（宿主 `src/__tests__` + **桌面 SDK 契约测试** `packages/plugin-sdk-desktop/__tests__`） |
| `pnpm run test:e2e` | WDIO E2E（需 debug 二进制 + 已构建前端；`e2e/specs/{smoke,bench}.spec.ts`） |
| `pnpm run bench:zip` | 基准数据打包（宿主侧基准驱动已迁至 `../wasmnest-test/perf-tests`） |
| `cd src-tauri && cargo test` | 宿主 Rust 全量（含能力层 / CSP 锁、生命周期注册锁、e2e；**部分用例要求先构建随包插件产物** `resources/plugins/desktop`，见各测试头注释） |
| `pnpm run target:size` | target 治理（§6；`prebuild` 钩子自动跑） |

### 3.1 通用宿主 runtime crate（L2，可选增强）

`src-tauri` 的 lib 角色同时是**唯一**可发布的通用 runtime crate（票据
`wasmnest-apps/.scratch/2026-10-21-host-runtime-distribution/` D4 / CONTRACT §5）：

| 项 | 值 / 命令 |
| --- | --- |
| crate 名 | `wasmnest-desktop-runtime`（`[package].name`；`[lib].name` 仍 `wasmnest_desktop_lib`） |
| 二进制名 | `wasmnest-desktop`（显式 `[[bin]]`，`host:pack` / E2E / 安装入口名不变） |
| 壳随包 | `src-tauri/shell-dist/`（**签入**），`tauri.conf.json` 的 `frontendDist` 指它 |
| 壳同步 / 漂移锁 | `node scripts/sync-shell-dist.mjs` / `node scripts/sync-shell-dist.mjs --check`（源 `dist/` 缺失时 fail-visible） |
| 发布门禁 | `node scripts/check-runtime-crate.mjs`（`cargo package --list` 必备条目 + crate 身份 + `cargo metadata --no-deps` + 壳漂移） |
| 本地安装 | `cargo install --path wasmnest-desktop/src-tauri --root <dir>` |
| 发布安装 | `cargo install wasmnest-desktop-runtime --version =0.0.1 --root <dir>`（SDK `wasmnest-plugin-api =0.0.1` 必须已上 crates.io） |

**安装通道偏离 CONTRACT §5.4（owner 裁决留档）**：CONTRACT 默认写「git tag 安装」，
但平台仓**刻意没有根 workspace**（30+ 独立 Cargo.toml / 8 个 target 落点，见根
`.cargo/config.toml` 头注），`cargo install --git <平台仓> wasmnest-desktop-runtime`
无法定位 crate。故 L2 的安装通道取 **crates.io**；能力仓依赖仍用 git tag
（`lib-v0.0.1`）固定编译期版本。**不要**为 cargo git 安装新增根 workspace（会改变
平台仓全部 target / lock 布局）。

依赖图与本地开发：11 条 `wasmnest-lib` 依赖 = git tag（tag 真源 =
`release-manifest.json` 的 `repos.lib.tag`）；桌面 SDK 已不是宿主直接依赖（批 2 /
issue #36），只作为能力仓 `wasmnest-wasm-core` 的 `desktop-assembly` 传递依赖走
crates.io 精确版本；同场开发由平台仓根 `.cargo/config.toml` 的
`[patch."https://github.com/7ZAI/wasmnest-lib"]`
与 `[patch.crates-io]` 指回兄弟目录 / 工作树 SDK（patch 不进发布包，`Cargo.toml`
内不得出现 `[patch]`——门禁脚本会转红）。

### 3.2 发布产物（唯一出口 = 终端用户安装包）

平台仓**不再发布任何 tar.gz**（2026-10-28 裁决）。发布链只有一条：

| 项 | 值 |
| --- | --- |
| 触发 | tag `v<product>`（平台仓 tag 规则 `vX.Y.Z`，**不带 host 前缀**） |
| workflow | `.github/workflows/product-release.yml`（`vendor` → `build` + `android` → `publish`） |
| 产物 | Windows `WasmNest-<ver>-release-x64-setup.exe`（NSIS perMachine）、Linux `WasmNest-<ver>-release-amd64.deb` + `WasmNest_<ver>_amd64.AppImage`、Android `WasmNest-<ver>-release-arm64.apk`、`latest.json`、各产物 `.sha256` |

- **桌面随包应用不本地构建**：`vendor` job 跑 `node scripts/vendor-apps.mjs`，下载应用仓成品包并按清单 sha256 / libRef / plugin.json 三道校验后铺进 `resources/plugins/desktop/`（`resources/plugins/**` 只入库 `.gitkeep`，漏了就发空壳安装包）。
- **移动端随包应用必须现场构建**：应用仓只发布 desktop zip（`apps.<id>.ends.mobile` 无 `package`），`android` job 按清单 `repos.apps.tag` 检出应用仓源码，由 APK 的 `beforeBuildCommand`（`pnpm run build:all` → `plugins:build`）构建移动插件（wasm32-unknown-unknown + componentize）后打进 APK assets；空壳判据 = APK 内至少一个 `assets/resources/plugins/**/plugin.json`。
- 缺签名密钥（`TAURI_SIGNING_PRIVATE_KEY` / `WINDOWS_CERTIFICATE_*` / `ANDROID_KEYSTORE_*`）时构建**显性失败**，不产出未签名安装包；验证流水线用 `workflow_dispatch` 的 `unsigned=true`（Android 用一次性临时 keystore）。契约与密钥清单见 docs/contracts.md §7。

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

### 4.1 Android 真机无线调试（adb，联调 / 手工验收）

> 用途：不接 USB，在同一局域网内对真机做 dev 安装、日志抓取与 UI 操作（双端联调默认走这条）。
> adb 用移动端工程同一份 platform-tools（`ANDROID_HOME` / `ANDROID_SDK_ROOT` 下），不另装一套。

**首次配对（Android 11+）**

1. 设备与电脑接同一 Wi-Fi（关闭访客网络 / AP 隔离）；开发者选项 → 打开「无线调试」。
2. 设备「无线调试」页 → 「使用配对码配对设备」：记下屏幕上的 `IP:配对端口` 与 6 位配对码（配对端口与调试端口不同，每次开关都会变）。
3. 电脑执行（platform-tools ≥ 30）：
   ```bash
   adb pair <设备IP>:<配对端口>     # 按提示输入设备屏幕上的 6 位配对码
   adb connect <设备IP>:<调试端口>
   adb devices -l                   # 状态 device 即可用
   ```
4. 同网段且 mDNS 可用时，Android 11+ 常会**自动发现并连接**——`adb devices -l` 直接出现
   `adb-<id>-<code>._adb-tls-connect._tcp` 串口（本仓测试平板即此形态），可跳过手动 `pair/connect`；
   发现异常用 `adb mdns services` 排查。

**Android 10 及以下（USB 过渡）**：先用 USB 连上并授权，`adb tcpip 5555`，拔线后 `adb connect <设备IP>:5555`。

**多设备**：所有 adb 命令加 `-s <serial>`（serial 取 `adb devices -l` 第一列，mDNS 串口需整串引号）；
跑 `pnpm run tauri:android:dev` 前先 `adb disconnect` 掉多余设备，避免 Tauri CLI 选错设备。

**本仓联调闭环（命令在 `wasmnest-mobile/` 跑）**

| 目的 | 命令 |
| --- | --- |
| dev 启动（无线即可；自带插件 watch、adb fd0 shim 自愈、`adb reverse` 隧道预检） | `pnpm run tauri:android:dev` |
| dev 启动 + 日志落盘（推荐） | `pnpm run tauri:android:dev:log` → `.dev-logs/android-dev.YYYY-MM-DD.log`；`WASMNEST_DEV_VERBOSE=1` 含 Debug 级，`WASMNEST_LOG_NO_FILTER=1` 关过滤 |
| 只重装现成 debug 包（不重建） | `adb -s <serial> install -r src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk`（arm64 真机；通用包 `.../universal/debug/app-universal-debug.apk`） |
| 实时看本方日志 | `adb -s <serial> logcat -v time \| grep WasmNest`（tag 族为 `WasmNest*`，含 Kotlin 侧 `WasmNest-*`；仓库脚本另有噪音过滤） |
| 重启应用 | `adb -s <serial> shell am force-stop com.wasmnest.mobile`，再从桌面/启动器打开（或 `adb -s <serial> shell monkey -p com.wasmnest.mobile -c android.intent.category.LAUNCHER 1`） |
| 截图（无界面验收 / 留证） | `adb -s <serial> exec-out screencap -p > /tmp/mobile.png` |
| 点按 / 输入 / 返回 | `adb -s <serial> shell input tap <x> <y>` · `adb shell input text <ascii>` · `adb shell input keyevent KEYCODE_BACK` |
| 热更失效时查反向隧道 | `adb -s <serial> reverse --list`；dev-run 启动日志会打印需要补建的 `adb reverse tcp:<port> tcp:<port>`（devUrl 与 HMR 两个端口），按它手工补即可 |

**坐标换算**：`input tap` 用设备物理像素（`adb shell wm size` 查看）。截图被查看器缩放时先按比例换算
（例：1600×2560 设备缩到 1200×1920 查看，展示坐标 ×4/3）；设备旋转后重新截图取点。

**断线与排障**

- 无线调试端口每次开关 / 重启都会变 → 重新 `pair` / `connect`；`adb devices` 出现 `offline` 先
  `adb disconnect <serial>` 再重连，仍不行就关开一次设备端「无线调试」。
- `adb kill-server` 会清掉 `adb reverse` 隧道（表现为改代码不热更、页面静默加载失败）——重跑
  `pnpm run tauri:android:dev` 会自动重建，或按上表手工补。
- 安装 / 调试被 MIUI 拦截：保持设备解锁并按屏幕提示允许安装；仍失败先用 USB 完成一次授权再切无线。
- 安全：无线调试只在可信局域网临时开启，用完关闭；配对码一次性，**禁止**把 adb 端口暴露到公网（见 `docs/security.md`）。

## 5. wasm 应用与插件

### 5.1 构建注册表与工具链

- **桌面**：应用名单单一真源 = `scripts/plugin-build.js` 的 `PLUGINS`（4 个：ai-chatbox / bedcode / file-transfer / monitor）；`pnpm run plugins:build`（= `--all`，CI/release 走这条）遍历它。
- **移动**：无宿主侧注册表，`scripts/plugin-build.js` 自动扫描 `apps/*/mobile`。
- 桌面一般应用走 `wasm32-wasip3`（cdylib 直出 Component）；**file-transfer 例外**：双端单产物，走 `wasm32-unknown-unknown` + 桌面 SDK 的 `tools/componentize`（随 npm 包发布；产物落应用仓共享 target `<appsRoot>/target/wasm-apps/…`）。

### 5.2 单应用（单插件）调试命令

| 命令（在 `wasmnest-desktop/` 或 `wasmnest-mobile/` 跑） | 说明 |
| --- | --- |
| `pnpm run plugins:dev -- --plugin <id>` | 单插件 dev 构建（桌面 `scripts/plugin-dev.js`；可用 id 见 §5.1 PLUGINS 键，如 `com.wasmnest.ai-chatbox`） |
| `node scripts/plugin-build.js --plugin <id>` | 单插件全量（前端 + rust）构建 |
| `node scripts/plugin-build.js` | 无参数默认构建 `com.wasmnest.bedcode`（bedcode） |
| `pnpm run plugins:build:frontend` / `plugins:build:rust` | 桌面便捷转发（ai-chatbox 单 app，走 `app-script.mjs`） |
| `node ../scripts/app-script.mjs <slug> <desktop\|mobile> <script>` | 转发应用仓单 app 脚本（见 §5.3） |

**bedcode 前端 dev 口径**：不参与 `tauri:dev` 的 watch（整包构建最重且每次写入都触发宿主重启）；改它的 UI 请单独重建：`pnpm run plugins:build` 或应用目录 `node scripts/build.js --frontend-only`。

### 5.3 app-script 转发（`scripts/app-script.mjs`）

平台仓直接调应用仓脚本的唯一入口（源码读取同理只能经 `scripts/app-paths.mjs`）：`node scripts/app-script.mjs <slug> <end> <script>`，例如 `build:frontend` / `build:rust`。**宿主构建期禁止 import 任何 app 源码**（桌面 `hostAppBoundaryLock` 会测红）；宿主与 app 只有「运行时装载产物」一条关系。

### 5.4 产物落点与排查

- 产物目录：`<end>/src-tauri/resources/plugins/<end>/<id>/`（`resources/plugins/**` **不入库**，只由构建 / watch 脚本写入，勿手工拷）。
- **dev 产物保新闭环**（`scripts/plugin-precheck.mjs`，dev-run 与裸 `tauri dev` 的 beforeDevCommand 共用）：补建/重建一律 `--out` **直写 resources**——apps 仓 `build.js` 默认只写仓内 `.build/plugins`（G2 设计），不经 `--out` 时 resources 不更新（watch 只复制前端、不碰 wasm，宿主加载的仍是旧产物）。
- 桌面 dev 运行时的资源副本在 `target/debug/resources/plugins/desktop/`——源目录删除后副本**不会**自动同步（幽灵目录只在那里活着）；排查「改了没生效」先查这条，再看 `scripts/{dev-run,plugin-build,plugin-precheck}.js`、`packages/plugin-sdk-desktop/bin/plugin-watch.js` 与根 `scripts/app-paths.mjs`。
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