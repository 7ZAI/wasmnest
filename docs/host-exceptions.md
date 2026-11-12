# 移动宿主业务代码清单与薄壳例外表

> **本文件是 `AGENTS.md` §2 薄壳红线在移动端（`wasmnest-mobile/`）的落地盘点**（issue #17）：按「机制重复 / 宿主适配 / 平台缝 / 产品语义」分桶，逐项过归属三问并登记例外。
> 例外只收「为什么是机制」的正面论证（对齐 `docs/architecture.md` §1.3 四类薄壳）；「还没来得及迁」**不是**例外理由——凡需要动手的处置项一律带迁移票号与截止条件（§5 Q2 裁决）。
> 判据词汇：B1–B6 六判据与归属三问见 `AGENTS.md` §2 / `docs/architecture.md` §1；完整上下文见 spec `.scratch/2026-10-23-quality-hardening/spec.md` §7.1 / §13 Q2。
> 盘点基线：**2026-10-24，dev 分支**（移动已是「宿主壳运行面 registerSurface」现状，keepalive / 服务型应用口径均已落地）。行数会漂移——引用前先按 §1 命令重跑，**不要照抄本文数字**（`AGENTS.md` §0「文档字面 ≠ 事实」）。

## 1. 盘点口径

- **判据**：逐项过归属三问（① 离宿主能实现吗 → ② 携带产品语义吗（命中 B1–B6 即业务）→ ③ 都不命中才放宿主）；例外行额外回答「为什么是机制」（正面论证），并对照薄壳四类（引擎实现 / 安全闸门 / 通用注册表与寻址 / 零解析窄转发）。
- **行数实测**（本文件全部数字的口径，会随代码漂移）：

  ```bash
  # Rust 侧（wasmnest-mobile/src-tauri/ 下执行）
  find src -name '*.rs' | xargs wc -l              # 总量（基线 25,842）
  find src/connection -name '*.rs' | xargs wc -l   # 逐目录同法
  # 前端旧五目录（wasmnest-mobile/ 下执行）
  find src/components src/views src/composables src/stores src/services -type f \( -name '*.vue' -o -name '*.ts' \) | xargs wc -l
  ```

- **消费者双向核对**：① 谁用它——`rg 'crate::<模块>' src/`（排除自身）+ 前端 `import` 可达闭包（含相对导入，入口 = `main.ts` / `App.vue` / `views/` / `shell/` / `plugin/` / `router/`）+ **导航源核对**（vue-router 路由有没有真实跳转来源）；② 它用谁——读文件头注释与依赖，判断是「自研业务编排」还是「能力仓引擎的宿主适配」。

## 2. 分桶总览（2026-10-24 实测）

| 桶 | 实测行数 | 定性（判据） | 处置方向 |
| --- | --- | --- | --- |
| `src-tauri/src/connection/*`（17 文件） | 4,422 | 自研「设备 ↔ 桌面直连」WS 客户端栈：manager / ws_client / reconnect / heartbeat / codec / request_response，自述「业务层连接管理」（B2 业务编排 + 机制重复） | 用能力仓 `wasmnest-ws-client-engine` 替换收敛后删除 |
| `src-tauri/src/auth/*` | 1,082 | HTTP 认证编排（配对码 / QR / JWT reauth / 生物挑战）+ 设备身份文件持久化（B2/B3） | 能力仓引擎收敛（承接形态 §4 拆票时定） |
| 同闭包邻接：`handler/*` 670 · `router/*` 1,013 · `model/message.rs` 1,060 · `enums/{auth,control,plugin,sumary}.rs` 207 · `commands/{connection,auth}.rs` 310 · `state.rs` 连接/认证片段 | ≈3,260 | 旧直连栈的路由 / 事件 / 协议信封 / 命令面（`model/message.rs` 头注释自述信封协议已退役、「只剩测试与协议级收尾用途」） | 随直连栈替换一并退役 |
| `src-tauri/src/peer/*`（7 文件） | 1,139 | **宿主适配 + 平台缝**：能力仓 `wasmnest-server-peer-net` 的端口实现（`peer::ports` 五端口）+ 平台缝（`peer::seam`：SAF 共享访问 / 落点提升）+ 装配（`peer::net` 门面） | 保留 |
| `src-tauri/src/file_service/saf_tree.rs` | 516 | **平台缝**：Android SAF 目录树遍历，唯一消费者 = `peer/seam.rs` 的 android SAF 桥 | 保留（目录名有误导，见 §6） |
| `src-tauri/src/plugin/android_plugins/*`（12 文件） | 1,334 | **平台缝**：Kotlin 桥 Tauri 插件（SAF / 生物认证 / 设备信息 / 通知 / 多播锁 / 状态栏 / 下载目录 / 前台服务等），`lib.rs` 统一注册 | 保留 |
| `src-tauri/src/mdns/*` + `commands/mdns.rs` | 298 | **宿主适配**：`wasmnest-discovery-engine` + ADR 0054 类型中枢的订阅消费面 | 保留 |
| `src-tauri/src/enums/session.rs` | 83 | B1 产品类型，**死码**（`SessionStatus` / `TaskStatus` 仅被 `enums.rs` 再导出，零真实消费者） | 已删（issue #24，平台仓 24f6a7a） |
| 前端旧五目录（components 5,750 · views 1,459 · composables 5,806 · stores 239 · services 262） | 13,516 | 四类混杂，见 §4 逐项拆解：死码 339 + 死路由视图 ≈609 + 随直连栈退役的连接面 ≈2,145 + 宿主提供组件（跨应用契约）≈3,281 + 活过渡面（外观/关于设置页）+ 全局基础设施（主题 / 平台 / i18n / 链路加密 / 安全闸门对话框） | 逐项处置（§4） |

> 其余移动 Rust（`plugin/*` 其余 ≈8,632、`egress.rs` 1,515、`system/*` 1,820、`commands/*` 其余等）为机制面（插件运行时 / egress 安全闸门 / 系统装配），不在本表展开；`egress.rs` / `plugin/manager.rs` 的拆分是健壮性议题（spec §8.2），不是归属议题。

## 3. 例外表（保留项——为什么是机制）

正面论证口径：例外行必须说明「离宿主无法实现 / 不携带产品语义」，并对照三问给出否定回答。

| 目录 / 文件 | 实测行数 | 疑似判据 | 三问结论 | 为什么是机制（正面论证） | 迁移票号 | 截止条件 |
| --- | --- | --- | --- | --- | --- | --- |
| `peer/net.rs` · `peer/ports.rs` · `peer/seam.rs` · `peer/migration.rs` | 1,139（全桶） | 无（未命中 B1–B6） | ① 离宿主不能实现（节点装配 / SAF 访问 / 落点 / 系统信息 / mDNS 都是宿主资源）；② 不携带产品语义（头注释：引擎控制面真源在能力仓 `wasmnest-server-peer-net`，本模块只保留端口实现与平台缝）；③ 落宿主合法 | 薄壳四类之「引擎适配」：`PeerEnginePorts` 五端口 + `PeerPlatformSeam` 是能力仓引擎定义的**注入面**，DTO 原始值过界、宿主类型不出宿主（`plugin/peer_ports.rs` 同构投影） | 无（例外登记即终态） | 随能力仓引擎演进重审；若 `transfer/receive/remote` 出现藏业务状态（spec §7.1 审计项）→ Phase 2 拆票（#19） |
| `file_service/saf_tree.rs` | 516 | 无（SAF 机制） | ① 离宿主不能实现（Android SAF 树遍历必须走宿主 SAF 桥）；② 不携带产品语义（纯目录 walk，无业务词汇）；③ 落宿主合法 | 平台缝：唯一消费者是 `peer/seam.rs` android SAF 桥（`#[cfg(target_os = "android")]`），把 SafIo（Kotlin 桥）同步化映射到引擎 `SharedSafAccess` 缝 | 无（例外登记即终态） | 若出现第二消费者再抽 host-kit（spec §7.1 同口径）；目录归属（file_service vs peer）在 Phase 2 拆票（#19）顺带裁决 |
| `plugin/android_plugins/*`（12 文件） + `gen/android/` 手写 Kotlin | 1,334 | 无（平台能力） | ① 离宿主不能实现（SAF / 生物认证 / 通知 / 多播锁 / 状态栏 / 前台服务全是 OS 能力）；② 不携带产品语义（各文件为单平台原语桥，无业务编排 / 默认值）；③ 落宿主合法 | 平台缝：Tauri plugin 形态的 OS 能力桥，`lib.rs` 统一注册、`peer/ports.rs` 与 `system/info.rs` 按需取用；权限闸门在 wasm-core / 宿主审批面，不在此层 | 无（例外登记即终态） | 随 Android 平台 API 演进重审 |
| `mdns/discovery.rs` · `mdns/types.rs` · `commands/mdns.rs` | 298 | 无 | ① 离宿主不能实现（进程级 mDNS 守护与 Tauri 事件桥）；② 不携带产品语义（ADR 0054 类型中枢：宿主零 `daemon.browse` 直调，只挂订阅 fan-out）；③ 落宿主合法 | 宿主适配：`wasmnest-discovery-engine` 的移动订阅消费面 + 前端事件桥，服务类型由中枢统一仲裁 | 无（例外登记即终态） | 随 discovery-engine 演进重审 |
| `model/data.rs`（`Setting`）+ `commands/mobile_commands.rs` + `system/settings.rs` | ≈197 | 表面 B1（宿主持有存储），实际不命中 | ① 能（插件有 host-* 存储原语）；② 不携带产品语义（`Setting` = `{key, value, updated_at}` 通用 KV 形状，无业务名词）；③ 落宿主合法 | 通用设置存储机制（JSON 文件 KV + 读写命令），词汇与产品无关；前端消费者是全局设置基础设施（`useMobileSettings`） | 无（例外登记即终态） | 若出现业务词汇字段（B1）→ 走 §7 登记或迁移 |
| 前端 `FsAuthDialog.vue` 185 · `EgressConsentDialog.vue` 235 | 420 | 表面 B4（业务投影），实际是安全闸门 UI | ① 离宿主不能实现（fs 授权 / egress L3 弹窗是宿主安全闸门的用户确认面）；② 不携带产品语义（授权对象是目录 / URL，无业务名词）；③ 落宿主合法 | `docs/architecture.md` §1.3 之「安全闸门」：`App.vue` 全局挂载，宿主审批流程的组成部件 | 无（例外登记即终态） | 随闸门形态演进重审 |
| 前端全局基础设施：`usePlatform` / `useTheme` / `useFontSize` / `useEdgeToEdge` / `useOrientation` / `useAppStartup` / `useLinkEncryption` 174 · `services/linkCrypto.ts` 262 · `stores/{settings,i18n}.ts` 132 | ≈2,500 | 无 | ① 离宿主不能实现（主题 / 安全区 / 启动打点 / 链路加密 pin 同步是宿主壳机制）；② 不携带产品语义（无业务类型）；③ 落宿主合法 | 宿主壳运行的基础设施层（`main.ts` / `App.vue` 装配），与 `src/shell/` 壳面同性质；`stores/codeViewer.ts` 107 随文件浏览器组件走（§4） | 无 | 随壳演进重审（与 `src/shell/` 重复的 composables 在壳接管时合并） |

## 4. 处置清单（删除 / 迁移 / 替换项）

截止条件统一 = **「下一个发布 tag 前」或 2026-12-19（自裁决日起 8 周），取早**（§5 Q2 裁决）。票号 Phase 2 待拆 = #19。

### 4.1 Rust 侧

| 项 | 实测行数 | 判据 | 消费者核对结论 | 处置方向 | 迁移票号 | 截止条件 |
| --- | --- | --- | --- | --- | --- | --- |
| `connection/*`（17 文件，含 `ws_client/tests` 351 行） | 4,422 | B2（自述「业务层连接管理」：设备级 status 状态机 / 重试封顶 / 重连策略）+ 机制重复 | **非死码，三重活消费**：① `plugin/host_ports.rs` 把 `ConnectionManager` / `ReconnectManager` 投影为 wasm-core `ConnectionEnginePort` / `WsReconnectPolicyPort`（插件机制面的「主连接事实」）；② 前端事件面 `plugin/host-events.ts → useMobileConnection.ts`（1,268 行）经 `commands/connection.rs` 调用；③ `auth/*` 依赖其 `ConnectionManager` | 用能力仓 `wasmnest-ws-client-engine` 替换收敛：宿主设备直连改走引擎，`host_ports.rs` 投影改指引擎适配器；**这是新收敛动作，不是对齐桌面**（桌面是服务端、不依赖该引擎；移动目前只在 `plugin/host_domains/ws.rs` 插件能力面链接了它） | Phase 2 拆票（#19） | 发布 tag 前或 2026-12-19 取早 |
| `auth/*`（`manager.rs` 691 · `http.rs` 391） | 1,082 | B2/B3（配对 / QR / reauth / 生物挑战编排 + 设备身份文件真源） | 活消费：`plugin/host_ports.rs` 的 `AuthEnginePort` 投影（C4 凭据零过境）+ `plugin/auth.rs` 适配 + `commands/auth.rs` | 能力仓引擎收敛（配对 / 认证是跨端协议机制，承接形态——引擎扩展 or host-kit 新增认证能力 crate——拆票时定；跨端协议改动必须双端同步，`docs/architecture.md` §6） | Phase 2 拆票（#19） | 同上 |
| 同闭包邻接：`handler/*` 670 · `router/*` 1,013 · `model/message.rs` 1,060 · `enums/auth.rs` 100 · `enums/control.rs` 37 · `enums/sumary.rs` 38 · `enums/plugin.rs` 32 · `commands/{connection,auth}.rs` 310 · `state.rs` 连接/认证片段 | ≈3,260 | 随栈定性（`model/message.rs` 自述信封协议已退役、只剩测试与协议级收尾；`MobileEvent` 前向事件面随 `useMobileConnection` 迁移后退役） | 消费闭环全部落在直连栈内部（`connection/manager.rs` ← `handler::PluginEventRouter` / `router::MessageRouter`；前端侧仅 `host-events.ts` 链） | 随直连栈替换一并退役（engine 事件 → 宿主事件桥按新形状重建） | Phase 2 拆票（#19） | 同上 |
| `enums/session.rs` | 83 | B1 + 死码 | `SessionStatus` / `TaskStatus` 全仓零消费者（仅 `enums.rs:20` 再导出悬空；`router/event.rs` 的 `SyncSessionStatusChanged` 是自有枚举，与它无关） | **已删（issue #24，平台仓 24f6a7a）**——连同 `enums.rs` 再导出行与文件内自测；词汇锁 `host_product_vocabulary_lock.rs` 对 `SessionStatus` / `TaskStatus` 零容忍（白名单无行） | Phase 2 拆票（#19） | 同上 |

### 4.2 前端旧五目录（13,516 行）

| 项 | 实测行数 | 判据 | 消费者核对结论 | 处置方向 | 迁移票号 | 截止条件 |
| --- | --- | --- | --- | --- | --- | --- |
| `components/FileExplorer.vue` 793 · `FileSidebar.vue` 1,195 · `FileViewerModal.vue` 711 · `CodeViewerSettingsModal.vue` 582 · `stores/codeViewer.ts` 107 | 3,388 | B1/B4（文件浏览器 / 代码查看器是业务视图） | **跨应用活契约**：`App.vue:149` `provide('wasmnestHostComponents', { FileExplorer, FileSidebar })`，应用仓 bedcode 移动面三处 `inject`（`TerminalView.vue` / `PresetTasksTab.vue` / `TaskEditDialog.vue`）——不是死码 | **已迁（issue #24，平台仓 d3f46a9 → 应用仓 4f14958）**——五件套连自闭包（`FileTreeItem` + 3 个文件域 icon / `useFileTree` / `useCodeHighlight` / `useSwipeTabs` / `clipboard` / `themeLabel`，宿主侧均零其他消费者）与两份自测落 `apps/bedcode/mobile/src/fileExplorer/`（新域，activate 注册文案）；三处 inject 改直接 import，`provide` 面整面退役；HTTP 消费面（file/git 8 端点）改走 SDK `mobileApi.httpRequest`（同一宿主通道），深色判定改 SDK `isDark`，ui 原语复用 bedcode 既有 `host/components/ui/` 同形副本，i18n 子树 `mobile.file.*` / `mobile.codeViewer.*` 随迁为域内 `file.*` / `codeViewer.*`；宿主 locales 同步删两子树；防回接钉 `retiredHostUIRetirementLocks.test.ts` R7（文件不在场 + 契约符号不回接） | Phase 2 拆票（#19） | 同上 |
| `views/CodeExplorerView.vue` | 137 | B4 | 死路由：`/mobile/files/:id` 无任何导航源（全仓零 `router.push`，壳不识别该路径） | **已删（issue #24，平台仓 24f6a7a）**（路由 + 视图） | Phase 2 拆票（#19） | 同上 |
| `views/settings/AuthenticationSettingsView.vue` 190 · `EgressSettingsView.vue` 293 | 483 | B1（连接与认证业务设置） | 死路由：两个 route name 全仓零导航源（壳设置屏只推 appearance / about；业务设置真源已按票 2026-10-10 C4 下沉 bedcode 应用） | **已删（issue #24，平台仓 24f6a7a）**（路由 + 视图） | Phase 2 拆票（#19） | 同上 |
| `views/settings/ConnectionSettingsView.vue` | 126 | B1 | 传递性死路由：唯一跳转源是死路由 `CodeExplorerView.vue:81` | **已删（issue #24，平台仓 24f6a7a）**（随 CodeExplorerView 一并） | Phase 2 拆票（#19） | 同上 |
| 直连栈前端面：`composables/useMobileConnection.ts` 1,268 · `useMobileCommands.ts` 518 · `usePresetTasks.ts` 227 · `useMdnsDiscovery.ts` 135 | 2,148 | B2/B4（连接状态编排 / 事件投影） | 活消费但属替换桶：`plugin/host-events.ts` / `plugin/index.ts`（插件系统初始化于 `main.ts:10`）消费——插件运行面的事件与命令桥 | 随 Rust 直连栈替换退役，插件面事件桥按引擎事件形状重建 | Phase 2 拆票（#19） | 同上 |
| 活过渡面：`views/settings/AppearanceSettingsView.vue` 451 · `AboutSettingsView.vue` 262（含 `useUpdateChecker` / `useClearAllData` / `useForegroundService` / `useNotification` 依赖链） | ≈713+ | 无（外观 / 版本 / 清数据是平台机制设置） | 活：壳设置屏 `ShellSettingsScreen.vue:155/:169` 直接 `router.push` | **保留**至壳承接（router 注释自述「设置子页与文件浏览器沿用——壳/插件尚未承接的过渡面」）；承接后迁 `src/shell/` 并退役旧路由 | Phase 2 拆票（#19，壳承接子项） | 同上 |
| 死码组件：`components/{BottomSheet,CollapseSection,LetterAvatar,LoadingDialog,QuickActionButton}.vue` + `components/index.ts` | 339 | B1（无消费者即无存在理由） | import 可达闭包零命中（含相对导入核对；`index.ts` 自身零 import，且引用三个早已不存在的 Terminal 组件） | **已删（issue #24，平台仓 24f6a7a）**；防回接钉在 `retiredHostUIRetirementLocks.test.ts` R6（孤儿组件为壳同名活组件计，只做路径级不在场断言，不做符号扫描） | Phase 2 拆票（#19） | 同上 |
| `components/{SettingsSubPage,Toggle,ConfirmDialog}.vue` 等过渡面支撑组件 | ≈1,000 | 无（通用 UI 原语） | 活：设置过渡面 + `plugin/components/PluginRouteView.vue` 消费 | 随过渡面承接一并迁壳 / 退役 | Phase 2 拆票（#19，壳承接子项） | 同上 |

> 五目录实测 13,516 行的构成核对（2026-10-24）：活过渡面 + 全局基础设施 + 宿主提供组件 + 直连栈前端面 + 死码 ≈ 全量；「≈13,500 全是待删业务」的旧印象不成立——**大头是活的基础设施与跨应用契约**，逐项处置见上表。

## 5. Q2 裁决记录（spec §13 Q2）

**裁决：按 spec §13 Q2 推荐项执行（用户 2026-10-24 授权），记录如下，作为 Phase 2 拆票（#19）输入。**

1. **不做「整体迁应用仓」**——移动瘦身以「替换引擎 / 保留平台缝 / 删 / 按契约迁应用」分桶处置，不做大搬家。
2. **`connection/*` / `auth/*`**：用能力仓 `wasmnest-ws-client-engine` 替换收敛。**这是新收敛动作，不是对齐桌面**（2026-10-24 复核修正：桌面是服务端、不依赖该引擎；移动只在 `plugin/host_domains/ws.rs` 插件能力面链接了它）。`auth/*` 的承接形态（引擎扩展 or host-kit 新增认证能力 crate）在拆票时定，跨端协议改动双端同步。
3. **`peer/*` / `file_service/*` / `plugin/android_plugins` / SAF**：保留为宿主适配 / 平台缝（例外登记见 §3）。
4. **`enums/session.rs` / `model/message.rs` / 旧前端业务视图（FileExplorer / CodeExplorer / 连接与认证设置页）**：先查消费者再删或迁应用（核对结论见 §4：session.rs 死码可删；message.rs 随栈退役；FileExplorer 是 bedcode 活契约 → 迁应用；连接 / 认证 / egress 设置页为死路由 → 删）。
5. **例外截止条件 = 「下一个发布 tag 前」或 8 周（自 2026-10-24 起算至 2026-12-19），二者取早**。到期未处置的处置项逐项在 #19 下点名顺延理由，禁止静默过期。

## 6. 盘点中的意外发现（2026-10-24 消费者核对）

1. **`connection/*` 不是可整删的死码**：它同时是 (a) 插件机制面的引擎实现（`plugin/host_ports.rs` 端口投影）与 (b) 插件前端事件桥的数据源（`plugin/host-events.ts → useMobileConnection`）。替换必须先接后断，`host_ports.rs` 投影改指引擎适配器是关键中间态。
2. **FileExplorer / FileSidebar 是跨应用活契约**：spec 旧印象按「产品语义、优先删」处理，实测是 bedcode 移动面经 `wasmnestHostComponents` 注入消费的宿主提供组件——只能迁、不能删。
3. **疑似业务实为机制**：`model/data.rs` 的 `Setting`（通用 KV 形状）、`FsAuthDialog` / `EgressConsentDialog`（安全闸门确认面）、`mdns/*`（discovery-engine 订阅面）初看命中 B1/B3/B4，核对后均不携带产品语义。
4. **死码比预期少但更准**：Rust 侧仅 `enums/session.rs`（83 行）整文件死码；前端死码 = 6 个孤儿组件（339 行）+ 3 条死路由视图（CodeExplorerView / Authentication / Egress / Connection 设置页 ≈736 行，其中 connection 页是传递性死路由）。`enums/sumary.rs` 看似死码，实为 `handler/plugin_event.rs` 消费的旧同步事件闭包（随栈退役，不单独删）。**以上死码已全部随 issue #24 删除（2026-10-24，提交号见 §4 标记），防回接分别钉在词汇锁 `host_product_vocabulary_lock.rs` 与 `retiredHostUIRetirementLocks.test.ts` R6。**
5. **`file_service/` 目录名有误导**：整目录只有 `saf_tree.rs` 一个文件、唯一消费者是 `peer/seam.rs`——它实际是 peer 平台缝的组成件，不是独立「文件服务」。
6. **`src/shell/` 与旧目录存在 composables 同名重复**（`usePlatform` / `useOrientation` / `useSwipeTabs` / `useToast`）：壳 L7 锁已禁止壳内 import 旧目录，合并方向 = 壳承接过渡面时统一到 `src/shell/`（§4.2 保留行）。

## 7. 维护口径

- 本表是移动侧 B1–B6 host 锁的**白名单输入**（spec §7.2）：锁命中须先查本表——已登记例外放行，未登记命中走例外登记或迁移票，禁止扩大排除面。锁落点 = `wasmnest-mobile/src-tauri/tests/host_product_vocabulary_lock.rs`（issue #24，逐文件×逐词白名单，标注来源 §3/§4；#25 直连栈收敛后 §4.1 白名单行随之删除，锁红即催办）。
- 新增任何宿主侧「疑似业务」代码：先过三问；确属机制的，在本表 §3 补行并给出正面论证；属业务的，直接进应用仓或开迁移票。
- 处置项完成后在 §4 表格标记完成与提交号；全部清零后本文件收缩为纯例外表（§3），处置清单归档。
