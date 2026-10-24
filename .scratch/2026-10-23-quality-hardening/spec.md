# 质量收口：CI 门禁、前端信任边界与测试策略 — 实施规格

> 状态：**建议已登记，未实施（2026-10-23）**。
> 修订：**2026-10-24 审核修订**——§2 证据表逐项复核（绝大多数精确吻合，多处行号 / 行数到个位一致），落六处修订：① 桌面套件 flaky 治理升为 CI 前置（§4.1 / §4.3 / §10）；② 平台 CI 能力仓检出口径改「跟 ref 不钉 tag」（§4.2）；③ ws-client-engine 归因修正——非「对齐桌面」（§7.1）；④ SDK README 实为**双死链**、真源在冻结旧仓（§2 / §9.2）；⑤ ADR 落点明确为本仓新开 `docs/adr/`（§5.4）；⑥ 验收数字去钉死、改「以实施时基线为准」（§4.3 / §10 / §11）。复核命令与结果见 §14 尾。
> 本文档只记录评估结论、建议方案与验收口径，**不等于已排期**；每条实施前需用户确认优先级与范围。
> 关系：不改 `docs/testing.md` §3 迁移期口径（用户 2026-10-18）的收口承诺，而是给「收口」补上门禁、安全与测试策略的落地路径。
> 阅读前提：`AGENTS.md` §0–§2（定位 / 薄壳红线）、`docs/testing.md` §3–§4（完成定义 / Seam 3）、`docs/security.md`（安全红线）。

## 1. 背景与结论

2026-10-23 对项目做了一次客观评估，结论一句话：**架构与工程治理水平高（四仓边界、WIT 契约钉版、宿主薄壳 B1–B6、锁纪律成体系），但验证与交付成熟度不足——没有测试类 CI 门禁、前端信任边界与文档承诺不一致、测试面偏「源码文本锁」、移动宿主仍装着业务面、Rust 安全路径有 panic 点、文档真源有漂移。**

本 spec 的范围边界：**只做工程收口（门禁 / 安全边界 / 测试策略 / 文档真源），不加任何产品功能。** 所有条目落到本仓 / 能力仓的具体文件、命令与测试名，不做泛泛的「最佳实践」。

## 2. 现状与证据（本次评估实测 + 静态阅读）

下表区分「实测（评估时实际运行过命令）」与「静态阅读（读代码 / 文档推断，未经执行验证）」。行号以评估当时工作区为准，实施前先 `ls` / `rg` 复核（AGENTS.md §0「文档字面 ≠ 事实」）。

| 检查项 | 结果 | 证据 | 类型 |
| --- | --- | --- | --- |
| 根 `pnpm run test:run` | 124/124 通过（2026-10-24 复核：绿） | 评估时执行 | 实测 |
| 桌面 `pnpm run test:run` | **714/716，2 个失败**（2026-10-24 复核：756 条中同 2 条稳定红——总数随 keepalive 增测漂移，验收以实施时基线为准） | `src/__tests__/scripts/pluginWatchCopy.test.ts` 的「接线」组 2 条用例红 | 实测 |
| 2 个红测试根因 | 实现已重构、锁没跟着走 | `199d1e8` 把预检抽到 `scripts/plugin-precheck.mjs`；`dev-run.js` 已改为 `import { runPluginPrecheck } from './plugin-precheck.mjs'`（开发期调用还在、且仍先于宿主 spawn），但测试仍在 `dev-run.js` 源码里 `indexOf('ensurePluginWasm()')` 等旧调用点（该测试文件 L202–L218 区域） | 实测（复跑 + 失败堆栈定位） |
| **桌面套件 flaky（2026-10-24 复核新增）** | 同一工作树两次全量结果漂移：3 红/754 条（`src/__tests__/shell/recentsLayout.test.ts`「网格轨道数与 RECENTS_GRID_TRACKS 一致」红）vs 2 红/756 条（仅 pluginWatchCopy 对）——红绿与**总条数**都不稳定 | 两次 `pnpm -C wasmnest-desktop run test:run` 实跑对比 | 实测（2026-10-24） |
| 移动 `pnpm run test:run` | 814/814 通过（2026-10-24 复核：816/816 绿） | 评估时执行 | 实测 |
| 桌面 `vue-tsc --noEmit` | exit 0 | 评估时执行 | 实测 |
| 根 ESLint（双端 `src`） | exit 0 | 评估时执行 | 实测 |
| 桌面 Rust `cargo test --test capability_crates_no_product_ids` | 6/6 通过 | 评估时执行 | 实测 |
| 测试类 CI | 平台 / 能力 / 跨端三仓 **均无** | 平台 `.github/workflows` 仅 `host-release.yml` + `sdk-publish.yml`；能力仓与跨端测试仓 `.github` 仅 ISSUE_TEMPLATE；应用仓有 `ci.yml`（lint + 单测）。旧仓 `../../BedCode` 曾有 `test.yml` / `lint.yml` / `wit-drift-lock.yml`，拆分后未随迁 | 静态阅读（文件清单） |
| 测试面体量 | 平台 ≈ 441 Rust + 1326 前端；能力仓 1234 Rust；应用仓 2017 Rust + 3585 前端 | `scripts/audit-rust-tests.mjs` / 各端 vitest 文件数汇总 | 实测 + 汇总 |
| 锁的形态比例 | 桌面 Rust 集成测试 44 个中 13 个 `*lock*`；移动 37 个中 25 个 `*lock*`；前端 ≈ 27/136 个测试文件是源码文本锁（关键字粗算） | 测试文件名 + 内容粗查 | 静态阅读 |
| 覆盖率门禁 | 无任何阈值 | 各端 vitest / cargo 配置无 coverage threshold | 静态阅读 |
| 移动宿主业务面 | 移动 Rust ≈ 25,842 行，仍含 `enums/session.rs`、`model/message.rs`、`connection/manager.rs`、`auth/manager.rs`、`peer/*`、`file_service/*` 等命中 B1–B6 的目录；移动旧前端目录（components/views/composables/stores/services）≈ 13,500 行 | 目录清单 + 行数统计 | 静态阅读 |
| 桌面宿主体量 | 桌面 Rust ≈ 14,323 行 | 行数统计 | 静态阅读 |
| 前端信任边界 | 双端 `withGlobalTauri: true`；`AppMountEnv.invoke` 是原始 `invoke` 透传（`useAppMount.ts` 头注释自述「无附加凭证」）；插件前端与宿主同 webview；`api_bridge.rs` 的 `plugin_uninstall` / `plugin_install_from_file` 无凭证参数（仅 `plugin_id` / `path` + State） | `tauri.conf.json:12`（双端）、`useAppMount.ts` L58–L60、`../wasmnest-lib/.../manager/host/api_bridge.rs` L679–L697 | 静态阅读 |
| 命令隔离现状 | Tauri `invoke_handler` 注册的命令对 webview 内所有 JS 一视同仁，不按应用隔离（Tauri 2 默认行为） | Tauri 2 机制 | 静态阅读 |
| Rust panic 面 | 宿主（双端 src）**行内测试区外** ≈ 121 处 `unwrap/expect/panic`（多为 `RwLock`；2026-10-24 复核：119，复现命令见 §14）；移动 `egress.rs` 1515 行 ≈ 30 处 `RwLock.unwrap()`（复核：测试区外 34）；`plugin/manager.rs` 2432 行 | 剔除行内 `#[cfg(test)]` 区后 `rg` 计数（裸 rg 会把行内测试一起算） | 静态阅读 |
| Rust 工具链门禁 | 无 `clippy -D warnings`、无 `cargo audit` / `cargo deny` | 各 crate 无对应配置 / CI 缺失（见上） | 静态阅读 |
| SSRF 判据 | `is_private_ip` 只判字面 IP，DNS 解析到私网 / 元数据地址不拦；URL 解析为自研 `parse_url_lite` | `wasmnest-mobile/src-tauri/src/egress.rs`、`commands/http_proxy.rs` | 静态阅读 |
| 文档漂移 1 | `README.md` L53「桌面应用离开应用面即被卸载，宿主不持有任何应用内部状态」与 `AGENTS.md` §2 / `docs/architecture.md` 的 2026-10-23 口径「切走只藏、停用才销毁」**直接矛盾**（keepalive 已实施） | README L53 实读 | 实测（文件核对） |
| 文档漂移 2 | 桌面 SDK README **双死链**：`../../wasm-app-dev-desktop.md`（解析为 `wasmnest-desktop/wasm-app-dev-desktop.md`）与 `../../../wasmnest-desktop/docs/knowledge/wasm-app-dev-guide.md` 目标**均**不存在；真源在冻结旧仓 `../../BedCode/`（`bedcode-desktop/wasm-app-dev-desktop.md`、`docs/knowledge/`），未随四仓拆分迁入 | `packages/plugin-sdk-desktop/README.md:7`、`ls wasmnest-desktop/docs` 404、三仓 `find -name 'wasm-app-dev*'` 为空、旧仓实存 | 实测（ls；2026-10-24 复核补全为双死链） |
| 发布面 | `release-manifest.json` 的 `hostRuntime.artifacts` 为空；产品版本 `0.0.1` alpha，无真实用户 | manifest 实读 | 实测 |
| 历史口径 | 平台仓 94 提交、初始提交 255,169 行；旧仓 BedCode 2026-05-02 → 2026-10-18、1927 提交。**定性：长期演进后的四仓拆分，不是「6 天写完」** | `git log` 统计 | 实测 |

> **2026-10-24 审核复核注**：上表逐项复核，绝大多数精确吻合（四仓 workflow 清单、双端 `withGlobalTauri: true`（`tauri.conf.json:12`）、`egress.rs` 1515 / `manager.rs` 2432 / 移动 Rust 25,842 / 桌面 14,323 行、桌面 Rust 测试 44 文件 13 lock / 移动 37 文件 25 lock、README L17/L32/L53、`api_bridge.rs` 两命令无凭证、移动旧前端五目录 13,516 行、`check:manifest` 判据 2/6 描述等均一致）。修正两处：§7.1 ws-client-engine 归因（桌面不依赖该引擎）、本表文档漂移 2 实为双死链。「前端 1326」为评估时汇总口径（非文件数——现 138；非现用例数——桌面 756 + 移动 816），实施时以 reporter 汇总为准。

## 3. 优先级总览

工作量均为**粗估**（人天），供排期参考，实施前按 Phase 里程碑再校准。

| # | 优先级 | 工作流 | 目标 | 收益 | 粗估 | 依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | P0 | 恢复测试 CI 门禁 | 平台 / 能力 / 跨端三仓新增 + 应用仓对齐；PR 必须过 lint / typecheck / 单测 / 锁 | 重构错误当场红，兜底四仓拆分后的验证债 | 3–5 天 | 依赖 §4.1（先修红测试 + flaky 治理） |
| 2 | P0 | 前端信任边界与命令隔离 | 插件前端拿不到宿主管理命令 | 补上评估发现的**最大安全缺口** | 5–10 天 | threat model 先裁决（§5） |
| 3 | P1 | 测试策略再平衡 | 源码文本锁 → 行为 / 契约测试 | 重构不再误红（`pluginWatchCopy` 即实证） | 5–8 天 | 1 之后见效 |
| 4 | P1 | 移动宿主瘦身 / 例外登记 | B1–B6 业务面迁出或登记例外 | 薄壳红线从文档落到代码 | 10–20 天 | 需应用仓同步 |
| 5 | P2 | Rust 健壮性与工具链 | 安全路径零 panic + clippy/audit 门禁 | 宿主进程不因 RwLock 中毒 panic 崩溃、依赖漏洞有门 | 5–10 天 | 1 之后才有 CI 承载 |
| 6 | P2 | 文档真源与维护性 | README 口径 / 死链 / 单一真源 | 文档与代码不互相打脸 | 2–3 天 | 无强依赖，可与 1 并行 |

另有 4 项**长期风险**（单一作者 / bus factor、自研协议与加密面未外部审计、性能只有测试没有基线、发布面未验证）登记在 §13.1，不列入本期工作量，需另立票。

## 4. P0-1 恢复测试 CI 门禁（三仓新增 + 应用仓对齐）

### 4.1 前置：修两个红测试 + flaky 治理

`wasmnest-desktop/src/__tests__/scripts/pluginWatchCopy.test.ts` 的「接线（dev 脚本必须真的用上内容感知复制）」组：当前在 `scripts/dev-run.js` 源码里找旧函数名调用点（`ensurePluginWasm()` / `ensurePluginFrontends()` / `ensurePluginManifests()` 的行首 / indexOf 断言）。重构后这些调用已收进 `plugin-precheck.mjs`（`dev-run.js` 只 `import { runPluginPrecheck }`，并在 `const host = start(` 之前同步调用 `runPluginPrecheck()`）——**行为没退化，锁过时了**。

**推荐修法（行为断言 + 轻量接线，不回填旧函数名）**：

1. 行为面：`plugin-precheck.mjs` 已把四步收敛为单一导出 `runPluginPrecheck()`（内部 `ensurePluginWasm` / `ensurePluginFrontends` / `ensurePluginManifests` / `pruneStalePluginDirs` 未导出，且会真的触发构建）。为可测性，把四步改成可注入依赖的导出函数（或至少导出陈旧判定 `wasmStaleReason` / `frontendStaleReason`），在真实临时目录上补行为测试；`copyIfChanged` / `syncArtifactManifest` 的行为测试已存在且全绿，保持不动。
2. 接线面：把「dev-run 真的调用预检且先于宿主启动」改写为**一条**对 `dev-run.js` 源码的轻量断言：`runPluginPrecheck` 出现在 `scripts/dev-run.js` 中、且其调用位置先于 `start(` 宿主启动点（匹配现调用形态 `runPluginPrecheck()`）；或在 `dev-run.js` 保留一句显式注释 `// PRECHECK-WIRE` 并断言它——**接线锁允许存在，但不允许同时盯三个内部函数名**。
3. 删除对 `ensurePlugin*()` 三个旧调用点的逐个断言（这些内部顺序已由 `plugin-precheck.mjs` 的行为测试承载）。

**flaky 治理（2026-10-24 复核新增，required checks 的前置）**：同一工作树两次桌面全量结果漂移——第一次 3 红/754 条（`src/__tests__/shell/recentsLayout.test.ts`「网格轨道数与 RECENTS_GRID_TRACKS 一致」红），第二次 2 红/756 条（仅 pluginWatchCopy 对）；红绿与**总条数**（754 vs 756）都不稳定。required checks 上线前必须：① 查明 `recentsLayout` 非确定根因（样式同源断言疑似对执行顺序 / 并行收集敏感）并修复或隔离；② 查明总条数漂移来源（754 vs 756，疑有用例被随机跳过或收集不稳）；③ 落 flaky 策略（quarantine 清单 / 重试上限），保证 §4.3 的「Seam 3 跑红」验证不被随机红污染。

### 4.2 三仓 CI 编排（应用仓对齐）

| 仓 | workflow | 内容 | 触发 |
| --- | --- | --- | --- |
| 平台 `wasmnest` | 新增 `test.yml`（或按 job 拆分层） | ① 根 `pnpm run check:wit`（能力仓检出**跟 ref 不钉 tag**：默认 `dev`、可配 `WASMNEST_LIB_REF`，与应用仓 `ci.yml` 头注释的 ref 口径一致——CI 只做校验，按 manifest tag 钉住是发布流水线的事；开发期钉 tag 会让依赖未发 tag 的 lib 改动长期误红 `check:wit`）；② 双端 `vue-tsc --noEmit` + 根 eslint；③ 各端 `pnpm run test:run`；④ Rust 分层 job：单测 / 锁层全跑，需随包产物的 e2e（pty / ws / http / app-bundle 等）标记为收口手跑或单独 nightly（不进 PR 阻断） | PR + main 推送 |
| 能力 `wasmnest-lib` | 新增 `ci.yml` | **无根 workspace**，按 crate 遍历：`for d in */Cargo.toml; do cargo test --manifest-path "$d"; done`（`cargo fmt --check` 同样按 crate 遍历；P2-1 落地后追加 clippy / audit） | PR + main |
| 跨端 `wasmnest-test` | 新增 `ci.yml` | `cross-end-tests`（同进程 path 依赖两端 `src-tauri`）；需两端可构建，允许按目录过滤 | PR（允许 nightly 全量） |
| 应用 `wasmnest-apps` | 已有 `ci.yml` | 对齐即可：补 Rust `cargo test` job（若无），核对触发条件 | 核对 |

**`check:manifest` 不进日常 PR required check**：`scripts/check-release-manifest.mjs` 的判据 2 / 6 要求 `../wasmnest-lib` / `../wasmnest-apps` 的 HEAD **正好是 manifest 钉住的 tag 且工作树干净**——开发分支必然不满足，日常跑只会长期报红。它的正确位置是发布 / tag 流水线，或 CI 里显式按 `repos.lib.tag` / `repos.apps.tag` 做 detached checkout 后再跑。PR 阶段用 `check:wit`（WIT 产物漂移）+ `--print-hash` 提示代替。

平台仓时序建议：node 层 jobs（① ② ③）与 Rust cargo jobs 可并行；Rust job 用 sccache（docs/commands.md 通用约定已有 wasmtime 48 / sccache 口径）与分层 target 缓存控时长。跨仓检出（平台 → 能力仓、跨端仓 → 双端）是 CI 编排的前置条件，workflow 里必须写明 token / 权限与失败时的 fail-visible 报错。应用仓 `ci.yml` 已有跨仓装配样板（`scripts/ci/prepare-platform.mjs --ends all`），可直接借鉴其 checkout / 生成物准备顺序。

**阻断分层（建议）**：PR 上 required = 快检查（node 层 + `check:wit` + Rust `cargo check` / 快速锁测试）；全量 Rust 测试与 e2e 先在 main 推送 + nightly 阻断，等 p95 稳定在 20 分钟内再候选进 PR。这样既不把 30 分钟编译压在每次提交上，也不会让 Rust 面长期无人看。

### 4.3 验收

- [ ] 桌面 `pnpm run test:run` 全绿（2 个红例已按 §4.1 修；基线以实施时为准——2026-10-24 为 756 条）。
- [ ] flaky 治理落地：`recentsLayout` 类非确定红有根因结论与隔离 / 重试策略；required checks 上线前桌面连续多次全量跑，红绿与总条数均稳定。
- [ ] 三仓各有一个测试类 workflow 在 PR 上运行；平台仓 PR 的 required checks 至少含：`check:wit`、双端前端测试、Rust 分层 job。`check:manifest` 放在发布 / tag 流水线（或按钉住 tag 检出后运行），不作为日常 PR required check（见 §4.2 说明）。
- [ ] **Seam 3 跑红一次**：故意提交一个让锁红 / 让 `check:wit` 红的 PR，确认 CI 阻断（证明锁不空转），结果记录在本文或 PR 描述。
- [ ] 时长目标（粗）：平台 node 层 ≤ 10 分钟；Rust job 首跑不设上限、缓存后 ≤ 30 分钟；达不到就先拆 job 再谈优化。
- [ ] `docs/testing.md` §3 与 `AGENTS.md` §5 的「无 CI workflow」表述同步改写（同一提交）。

### 4.4 风险

- **CI 成本**：wasmtime 编译时长是大头；缓解 = sccache、分层（先 node 后 Rust）、连续失败自动收窄 job。
- **私有仓权限**：sccache 远端 / caches 权限需确认；打不开就先 GitHub Actions cache。
- **误伤现有流程**：husky pre-commit 仍跑 WIT 锁 + eslint，CI 与它重复是 **by design**（钩子可被跳过，CI 不可）。
- 应用仓产物构建依赖能力仓 tag 钉版（docs/contracts.md §1），跨仓触发编排放 Phase 2 之后再接，本期只做仓内门禁。

## 5. P0-2 前端信任边界与插件命令隔离

### 5.1 Threat model（先写再动手，落 `docs/security.md` 或新增 ADR）

**事实（现状）**：

- wasm **后端**是强沙箱：wasmtime Component 实例 + 能力即权限（README「特性」表第 1 行的承诺成立）；
- **前端**不是：插件前端与宿主同 webview、共享 DOM 与全局 `__TAURI__`（双端 `withGlobalTauri: true`），`AppMountEnv.invoke` 是原始 `invoke` 透传（自述「无附加凭证」）；
- Tauri 命令层不按应用隔离：任一插件前端理论上可直接 `invoke('plugin_uninstall', { pluginId: '<别的应用>' })` 或 `invoke('plugin_install_from_file', { path })`——`api_bridge.rs` 对这两个命令没有凭证 / 来源校验；
- 同窗应用之间可通过共享 DOM / 全局对象互探（桌面机制 B 的固有代价）。

**威胁声明（诚实版本）**：当前真实边界是「**后端按应用沙箱，前端同可信域**」。把任意安装的应用前端当作**不深信主体**，则命令面必须收敛；把其当作**可信主体**，则必须把这条写进文档与安装审批提示。**两者只能选一个，语义现状（README 卖沙箱）与实现现状（前端全通）不一致——这本身就是要修的缺陷。**

### 5.2 三个方案

| 方案 | 内容 | 成本 | 推荐度 |
| --- | --- | --- | --- |
| **A：命令门禁 + app-scoped invoke 代理** | **主体是 Rust 侧门禁**：插件管理类命令（`plugin_uninstall` / `plugin_install_from_file` / `plugin_activate` / `plugin_deactivate`）要求 loader session 令牌 + 用户确认，无论调用来自 `env.invoke` 还是裸 IPC；前端 `env.invoke` 收窄为白名单代理，作为审计 / DX 面（不当作安全边界）。配合 `withGlobalTauri=false` spike 降低全局暴露 | 中（改 `useAppMount.ts` 的 env 构造 + Rust `api_bridge.rs` 门禁 + 盘点存量调用） | **推荐** |
| B：独立的 webview/iframe + postMessage | 插件前端彻底隔离 DOM 与 `__TAURI__`，跨窗只走受控消息桥 | 高（挂载契约重来、双端锁步重做） | 登记为远期方向，本期不实施 |
| C：明确接受「插件前端可信」 | 删 / 修正 README 沙箱措辞、threat model 写明、安装审批 UI 明示「本应用前端可访问宿主命令面」 | 低 | **必须做**（即使选 A/B 也要先把措辞改诚实） |

建议组合：**先做 C（措辞修正，半天）→ 再做 A（Rust 侧命令门禁）→ 并行做一个 1–2 天的 `withGlobalTauri=false` spike（证据见 §5.3）。** B 保留为「引入不可信第三方应用」的前置条件，不在本期承诺。

### 5.3 关键落点

- `withGlobalTauri`：**先做关闭 spike，不要默认保留。** 证据：第一方 `wasmnest-desktop/src` / `wasmnest-mobile/src` 没有裸读 `window.__TAURI__` 的业务代码（仅 `usePlatform` 探测），宿主与 SDK 均走 `@tauri-apps/api` 打包导入，双端 `withGlobalTauri: true` 可能只是历史遗留。做法：双端 `tauri.conf.json` 置 `false`，跑宿主前端构建 + 全部随包 app 构建 + 关键 e2e；绿则直接关闭并写入锁，某条链红则记录依赖点再回退。**注意：关闭 global 不等于安全边界**——插件仍可自带 `@tauri-apps/api` 或触达 `__TAURI_INTERNALS__`，所以 Rust 侧命令门禁（A）仍是主体，`env.invoke` 代理只作为白名单 / 审计面。
- Rust 门禁落点：`api_bridge.rs` 的 `plugin_uninstall` / `plugin_install_from_file`（L679–L697 一带）与激活 / 停用命令——从 `State` / 参数直达改为要求 loader session（沿用现有通道令牌机制，参考 `frontend_channel.rs` 的通道凭证设计）+ 一条用户确认路径；门禁失败 fail-visible。
- 白名单真源：与 `docs/frontend.md`「零资源访问三层封锁」对齐，白名单表落 Rust 侧常量（真源）+ 前端代理复用（经 SDK 生成物或契约锁钉住，生成物不手改，docs/contracts.md §6）。

### 5.4 验收

- [ ] threat model 文档落 `docs/security.md`（或 ADR。**ADR 落点（2026-10-24 复核明确）**：本仓 `docs/` 现无 adr 目录；旧仓 `../../BedCode/docs/adr/` 冻结于 0054；0055–0057 已被本仓 docs / 代码注释引用（0055 i18n 下沉撤销、0056 插件 id 改名、0057 机制 B 挂载包）但正文散落、无集中落点——新 ADR 落本仓**新开** `docs/adr/`，从现被引用最大编号续号；开目录时补一条索引把已引用编号与其正文出处对上，不回写冻结旧仓）；
- [ ] 恶意插件前端（测试中模拟）无法调用插件管理类命令：Rust 门禁单测（无 session / session 错 app → Err）+ 前端代理单测（白名单外命令被拒且 fail-visible）；
- [ ] README「wasmtime 沙箱」表述与实现一致（后端沙箱成立 / 前端边界如实）；
- [ ] `withGlobalTauri=false` spike 有结论：要么双端关闭并跑绿，要么记录逐条依赖点（不接受「默认保留」）；
- [ ] 盘点表：全部随包 app 对 `invoke` / `hostInvoke` 的实调清单（repo 内 rg 可得），白名单覆盖存量调用、无静默降级。

### 5.5 风险

- 改动面大：`AppMountEnv.invoke` 形状变化是**挂载契约面破坏性变更**——研发起步期允许直接破坏（docs/contracts.md §1），但需双端锁步 + 受影响 app 全量重建验证；
- 存量 app（bedcode / ai-chatbox / file-transfer / agent-hub / monitor）可能依赖宿主面命令超出白名单——先盘点后收窄，白名单以**盘点结果**为起点而非拍脑袋；
- 用户确认路径（manager 类命令）牵出 UI / 文案 / i18n，可能超「工程收口」范围——若发生，砍到「日志 + fail-visible」，UI 交互另立票。

## 6. P1-1 测试策略再平衡（源码锁 → 行为 / 契约测试）

### 6.1 保留的高价值红线锁（不动）

WIT 漂移锁（`check:wit`）、能力 crate 无产品 id（`capability_crates_no_product_ids`，实测 6/6）、CSP / ACL 锁、退役面 fail-visible 锁。这些锁锁的是**边界契约**，不是实现顺序，性质正确。§7.2 新增的宿主侧 B1–B6 锁在上线后归入本清单。

### 6.2 改造方向

1. 对「断言源码字符串 / 函数调用顺序」的锁（前端 ≈ 27/136 个测试文件，如 `pluginWatchCopy` 旧接线组、各类 `*.test.ts` 里的 `readFileSync(src)` 源码比对），逐个问一遍：
   - 逻辑可提为共享模块纯函数 → 提出去做行为测试（`pluginWatchCopy` 的 copyIfChanged 组就是正确的样板）；
   - 流程有意义 → 组件行为测试 / 真实调用链 e2e（挂载 → surface 保活 → dispose 全链断言行为而非源码）；
   - 接线唯一 → 保留**一条**轻量接线断言（入口确实调用共享模块），禁止沿用「逐函数名逐调用点」的旧写法。
2. 锁新增门槛：新增任何源码锁必须注明「为什么不能用行为测试表达」；锁清单入 `docs/codemap.md` §8（现有锁索引扩展），标注 owner。
3. Seam 3 落实为新锁纪律的一部分：锁上线时跑红一次；锁清单过期与代码同批更新（docs/public/testing.md §4 已有真源，此处只是把「源码锁」纳入门槛）。

### 6.3 覆盖率策略

- **软阈值先行**：对前端核心模块设 `vitest coverage --include` + 阈值（desktop `useAppMount.ts` / mount registry、移动 egress 前端代理面、SDK 挂载契约）；阈值只报不阻断一个周期，稳定后转 required。
- 明确**不追求全仓数字**：全仓统一阈值会让低价值 UI 测试注水（与本次反「表面测试」方向背道而驰）。
- Rust 侧核心面（`wasm-core` 权限 / 生命周期、`frontend_channel`）需要 tarpaulin / llvm-cov 基建，本期不铺；先登记为另立票，前端软阈值跑通后再评估。

### 6.4 验收

- [ ] `pluginWatchCopy` 类「合法重构导致误红」不再出现：把该修法（§4.1）作为样例，后续锁改造验收以「重构 `dev-run.js` → 测试不红」为判据；
- [ ] 锁清单（含 owner + 「为何不能用行为测试」注释）入 `docs/codemap.md` §8；
- [ ] 覆盖率报告进 CI（软阈值期），核心模块覆盖率数字有基线。

## 7. P1-2 移动宿主瘦身 / 薄壳例外登记

### 7.1 盘点（登记表先行）

移动 Rust ≈ 25,842 行中，先按「机制重复 / 宿主适配 / 产品语义」分桶，**不要把所有命中词都当业务**（对照桌面宿主：桌面没有 `auth/`、`connection/` 顶层业务模块，等价机制已在能力仓）：

- **机制重复**：`connection/*`（4,422 行）、`auth/*`（1,082 行）与能力仓 `wasmnest-ws-client-engine` 已提供的机制重叠。**注意这不是「对齐桌面」**（2026-10-24 复核修正：桌面是服务端，`Cargo.toml` 不依赖 ws-client-engine，依赖的是 server-core / server-base / host-kit / pty-engine；移动端自己链接了该引擎（`Cargo.toml` L132）但只用于 `plugin/host_domains/ws.rs` 插件能力面，宿主 `connection/` 是另养的一套）——收敛到引擎是**新的替换动作**，优先替换后删除重复实现，而不是搬去应用仓；
- **宿主适配 / 平台缝**：`peer/*`（1,139 行）、`file_service/*`（516 行）、`plugin/android_plugins`、SAF 属「离宿主无法实现」的装配与平台能力，保留在宿主；
- **产品语义**：`enums/session.rs`、`model/message.rs`、旧前端业务视图（FileExplorer / CodeExplorer / 连接与认证设置页）——删除或迁应用仓。

再逐项过 §2 三问，产出登记表：

| 目录 / 文件 | 疑似判据 | 处置方向 |
| --- | --- | --- |
| `enums/session.rs`、`model/message.rs` | B1 产品类型 | 先查消费者：当前多为 legacy 测试 / 协议收尾 → 优先删；若被 WIT / 传输机制依赖则迁应用仓 |
| `connection/manager.rs` | B2 业务编排（机制重复） | 替换为能力仓 `wasmnest-ws-client-engine` 后删除重复实现（**新收敛动作，非对齐桌面**——桌面不依赖该引擎，见上） |
| `auth/manager.rs` | B2/B3 业务编排 + 真源 | 先评估能否抽成认证能力 crate（桌面/移动共用）；否则迁应用仓，不留在宿主 |
| `peer/*` | 宿主适配 + 平台缝 | 保留为 `wasmnest-server-peer-net` 的宿主适配面；审计 `transfer/receive/remote` 是否藏业务状态，有则迁 file-transfer 共享核 |
| `file_service/*` | Android SAF 机制 | 保留（平台缝）；若出现第二消费者再抽 host-kit |

产出：**移动宿主业务代码清单 + 例外表**（例外必须带：为什么是机制、迁移票号、截止条件——例如「应用仓具备同形状 WIT 原语前保留」）。放 `docs/architecture.md` 或独立 `docs/host-exceptions.md`。

### 7.2 B1–B6 扫描扩展到宿主

现有锁把扫描范围设在能力 crate（实测 `capability_crates_no_product_ids` 只扫能力 crate 面）。**至少新增一条 host 侧产品词汇锁**，但先做两步防噪音（§6.2 的同一原则）：

1. 判据只针对 **B1–B6**（宿主据以定义结构 / 状态 / 真源 / 默认策略），不扫机制词（如 loader session、transport session）；
2. 例外表先行：`wasmnest-mobile/src-tauri/src/**/*.rs` 的已知命中按 §7.1 例外表白名单过滤，锁跑绿依赖「显式登记」而不是扩大排除面。

新增命中必须走例外登记或迁移票——避免文档说一套、代码另一套。

### 7.3 旧前端目录清理

移动旧前端目录（components / views / composables / stores / services ≈ 13,500 行）逐项查消费者（`imports` / `grep` 双向核对）：无消费者 → 删；有消费者 → 在清单中登记迁移票与去向。

### 7.4 验收

- [ ] 移动宿主业务代码清单 + 例外表成文（含票据与截止条件）；
- [ ] 新增 host 锁跑绿（基于例外表，Seam 3 跑红一次）；
- [ ] 旧前端业务视图（FileExplorer / CodeExplorer / 连接与认证设置页）清零，或清单中 100% 有迁移票与去向；总行数下降只作参考，不作为主判据；
- [ ] 移动宿主 `connection/*` / `auth/*` 的机制重复清零（替换为能力仓引擎）或登记例外；
- [ ] `docs/codemap.md` 移动模块导览同步更新。

## 8. P2-1 Rust 健壮性与安全工具链

### 8.1 安全路径零 panic

- 安全路径（权限检查、`egress.rs`、`frontend_channel.rs`、命令门禁）的 `RwLock.unwrap()`（移动 `egress.rs` ≈ 30 处，全宿主 ≈ 121 处 unwrap/expect/panic——双端 src 行内测试区外口径，2026-10-24 复核 119 / `egress.rs` 34，复现命令见 §14）改为 `unwrap_or_else(|e| { log; e.into_inner() })`（毒锁放行 + 结构化日志，与 docs/security.md「tracing 分级 / 结构化字段」一致）或显式错误返回；**锁中毒后是放行进读 / 收敛为 Err，逐处按该数据的角色裁决，不机械替换**。
- 新增一条锁：安全路径目录清单内禁止 `unwrap()/expect()/panic!`（文本锁，但此处红线性质、不允许「用行为测试表达」——锁新增理由按 §6.2 格式写明）。

### 8.2 超大文件拆分（行为不变）

- `wasmnest-mobile/src-tauri/src/egress.rs`（1515 行）→ 按 egress 域拆模块（URL 解析 / 声明匹配 / 策略引擎 / 授权记录 / 弹窗桥）；
- `wasmnest-mobile/src-tauri/src/plugin/manager.rs`（2432 行）→ 按 manager 职责拆；
- 拆分 PR 要求全量 cargo test 通过且测试文件不改断言语义（可改路径）。

### 8.3 工具链门禁

| 项 | 路径 | 收紧方式 |
| --- | --- | --- |
| `cargo fmt --check` | 各 Rust 仓 CI | 直接 required；存量格式不一致先补一个格式化提交 |
| `cargo clippy -- -D warnings` | 各 Rust 仓 CI（能力仓按 crate 遍历） | **allow 存量**：现有 crate 全宽 `#[allow]` 登记，逐 crate 打开（每关一个 crate 都要全绿）；允许列表放 `Cargo.toml` / `lib.rs` 注释并写清清理票 |
| `cargo audit` / `cargo deny` | 能力仓 + 平台 CI | 只阻断高危 RUSTSEC advisories，低危进周报 |

收紧次序建议按**风险**而不是按仓：① 平台 / 移动安全路径（`egress` / `frontend_channel` / 命令门禁）→ ② `wasm-core` 权限 / 生命周期 / `fs_auth` → ③ 传输引擎（`server-peer-net` / `ws-client-engine` / `pty-engine` / `crypto`）→ ④ 宿主适配与 UI → ⑤ tests / examples。`cargo fmt` 单独一个格式化提交先落地，避免和逻辑改动混在一起。

### 8.4 SSRF / URL 解析

- 自研 `parse_url_lite`（`egress.rs`、`commands/http_proxy.rs`）补 property / fuzz 测试（corner：userinfo、回环十进制 / 十六进制 IP 变形、非法 scheme、IDN 边界——**先摸清 parse_url_lite 现支持面再定用例，避免超出意图的失败**）；
- `is_private_ip` 只判字面 IP 的事实写进 threat model；**本期新增判据：发请求前对 DNS 解析结果（或连接目标 socket addr）判私网 / 元数据（169.254.169.254 等）**。当前 egress 没有独立 DNS 面，落点需按实际 HTTP 客户端能力选（自定义 resolver / 连接层校验），实施时核实。

### 8.5 验收

- [ ] 安全路径目录清单内 `unwrap/expect/panic` 为 0（锁绿）；
- [ ] clippy / fmt / audit 门禁在 CI（存量 allow 有登记与清理票）；
- [ ] `parse_url_lite` fuzz / property 用例进 CI（节流跑或 nightly）；
- [ ] `egress.rs` 与 `plugin/manager.rs` 单文件行数明显下降（目标 ≥ 50% 单文件，粗估）。

## 9. P2-2 文档真源与维护性

1. **修 README L53**：改为与 `AGENTS.md` §2 / keepalive spec 一致的口径：「应用不被停用就继续运行——切走只是藏起来，停用 / 卸载才是唯一销毁点」。同时复核 README 全文与 keepalive 实施后的其他表述（「离开即卸载」出现在 L17 与 L32 的特性表）。
2. **修桌面 SDK README 双死链**（`packages/plugin-sdk-desktop/README.md:7`）：两个链接的目标**均**不存在——`../../wasm-app-dev-desktop.md`（解析为 `wasmnest-desktop/wasm-app-dev-desktop.md`）与 `../../../wasmnest-desktop/docs/knowledge/wasm-app-dev-guide.md`（整个 `wasmnest-desktop/docs/` 不存在）。2026-10-24 已核实真源在冻结旧仓 `../../BedCode/`（`bedcode-desktop/wasm-app-dev-desktop.md`、`docs/knowledge/`），未随四仓拆分迁入。修法二选一：把开发指南迁入本仓（推荐——SDK 文档不应依赖冻结仓），或改指旧仓并注明冻结口径。
3. **加 markdown link check**（CI 或本地脚本入 husky）：四仓统一脚本即可，不引第三方重型工具。
4. **单一真源口径**：README 只做入口与概括，机制细节链 docs；同一口径禁止在 README / docs / AGENTS 多处复制（现状反例即 keepalive 口径两处不一致）。
5. **文档分级**：常青文档住 `docs/`；决策住 ADR；一次性住 `.scratch/`（本期本 spec 即一次性——收口完成后本文件应归档或删除）；`.scratch` 过期项定期清理。
6. **README_en.md 同步**：建议**中文 README 为唯一真源**，`README_en.md` 标注 “translation may lag behind the Chinese README”，只保证快速开始 / 特性表 / 链接不漂移，不做逐句同步；合并双源不在本期。
7. **git 历史不重写**：94 个提交 / 初始 255k 行是四仓拆分的导入结果，重写历史风险高、收益低；改为在 `README` 或 `docs/history.md` 写一段「历史口径」说明旧仓 BedCode 的演进（2026-05-02 → 2026-10-18、1927 提交），避免被误读成「6 天写完」。

验收：[ ] link check 0 死链；[ ] README 与 architecture.md 无矛盾表述（keepalive 口径逐句对齐）；[ ] `docs/codemap.md` 文档索引更新（本 spec 收口后归档记录）。

## 10. 实施顺序与里程碑

| Phase | 时间 | 内容 | 出口条件（可独立验收） |
| --- | --- | --- | --- |
| **Phase 0** | 0–3 天 | §4.1 修 2 个红测试 + flaky 治理；平台 / 能力 / 跨端 CI 上线（§4.2，应用仓对齐）；README L53 + SDK README 双死链修复（§9.1–9.2） | 桌面全绿且多次全量结果稳定（基线以实施时为准——2026-10-24 为 756 条）；三仓（+应用仓对齐）PR 有 required checks 且跑红验证过一次（Seam 3）；link check 上线 |
| **Phase 1** | 1–2 周 | threat model 成文 + **用户裁决 A/B/C**（§5.2）；app-scoped invoke 设计（§5.3）；测试锁盘点成清单（§6.2）；移动 B1–B6 盘点 + 例外表（§7.1）；应用仓 ci.yml 对齐 | threat model 有裁决结论；锁清单与例外表进入 `docs/`；设计评审通过（用户点头） |
| **Phase 2** | 2–6 周 | 前端边界落地（§5.3–§5.4，含 Rust 门禁）；源码锁改造首批（§6.2，含 `pluginWatchCopy` 修法推广）；移动旧前端清理（§7.3）+ host 锁（§7.2）；clippy / fmt / audit（§8.3）；覆盖率软阈值（§6.3）；开始按例外表迁业务面 | 总验收清单 §11 逐项可通过或标注「另立票并说明原因」 |

依赖链：Phase 0 → Phase 1（threat model 是边界实施的前置）；Phase 2 内 §5 与 §7 / §8 可并行推进但共享 CI 容量。

## 11. 总验收清单（Definition of Done）

- [ ] 平台仓：双端 `pnpm run test:run` 全绿（桌面基线以实施时为准——2026-10-24 为 756 条）+ 根 `pnpm exec eslint .` 0 error + 双端 `vue-tsc --noEmit` exit 0。
- [ ] 根 `pnpm run check:wit` 全绿（CI 有对应 required check）；`pnpm run check:manifest` 在发布 / tag 流水线全绿（或 CI 按钉住 tag 检出后运行），不作为日常 PR 门禁。
- [ ] 平台 Rust：`cd wasmnest-desktop/src-tauri && cargo test` 全绿 + `wasmnest-mobile/src-tauri` 同（收口整个清单时补跑全量）。部分桌面 Rust e2e（pty / ws / http / app-bundle 等）需先 `pnpm run plugins:build` 准备随包插件产物；纯锁层与单测不需要。
- [ ] 三仓新增 CI + 应用仓对齐，PR 阻断生效（含 Seam 3 跑红记录各一次；required checks 上线前桌面套件多次全量跑结果稳定——红绿与总条数都不漂移）。
- [ ] §5 威胁边界：恶意前端调 `plugin_uninstall` / `plugin_install_from_file` 等管理命令被拒（有测试）；threat model 落 `docs/security.md`。
- [ ] 安全路径零 panic 锁绿；clippy / fmt / audit 门禁在 CI（存量 allow 有登记）。
- [ ] `parse_url_lite` property 测试 + SSRF 判据补齐。
- [ ] 锁清单（owner + 新锁门槛）入 `docs/codemap.md` §8；覆盖率软阈值上报 CI。
- [ ] 移动宿主例外表成文 + host 侧产品词汇锁绿 + 旧前端目录清理达标。
- [ ] README L53 / SDK 双死链修复 + link check 0 死链。
- [ ] `docs/testing.md` §3 与 `AGENTS.md` §5 中「无 CI workflow」表述更新。

## 12. 非目标

- **不加产品功能**；任何新能力不借收口进程夹带。
- **不重写全部锁**：只改造「源码文本 / 调用顺序」性质的错误锁；契约锁（WIT / 清单 / 权限 / 薄壳）原样保留。
- **不做大爆炸重构**：每条改动按最小 diff 落地（AGENTS.md §0.1）。
- **不 bump ABI**，除非 §5 边界方案不得不改 WIT 面（届时走 docs/contracts.md §3 七步流程）。
- **不追求 100% 覆盖率 / 全仓统一阈值**。
- **不在本期处理 OS 级保活 / 性能优化**（与 keepalive spec §5 的口径一致）。
- wasmtime 缓存优化、跨仓 tag 联动自动化——登记后另立票。

## 13. 风险与开放问题（需用户裁决）

| # | 问题 | 备选与倾向 |
| --- | --- | --- |
| Q1 | **前端信任模型**：§5.2 的 A / B / C 哪条进本期？ | 建议：**C（措辞诚实）+ A（Rust 侧命令门禁）+ `withGlobalTauri=false` spike**；B 只在引入不可信第三方应用时做。若产品定位就是「个人本地小程序、默认只装自己写的应用」，C + A-lite 也自洽——但不能继续卖「前端沙箱」 |
| Q2 | **移动瘦身范围**：§7.1 清单里哪些可以迁应用仓？例外表的截止条件由用户定（若应用仓侧 WIT 原语尚未配套，会牵动能力仓） | 建议：不做「整体迁应用仓」。先做 2–3 天盘点分桶：`connection/*` / `auth/*` 用能力仓引擎替换；`peer/*` / `file_service/*` 保留为宿主适配 / 平台缝；`enums/session.rs` / `model/message.rs` / 旧前端业务视图删除或迁应用。例外截止条件建议「下一个发布 tag 前」或 8 周，二者取早 |
| Q3 | **CI 是否阻断 dev 分支 / 主分支**？还是先只报告不阻断一个过渡期？ | 建议：**分层阻断**——PR required = node 层 + `check:wit` + Rust `cargo check` / 快速锁；全量 Rust 与 e2e 先在 main + nightly 阻断，p95 稳定 <20 分钟后再进 PR。不要全量 report-only（无人看），也不要第一天就把 30 分钟 Rust 压在每次提交上 |
| Q4 | **是否接受 clippy 存量 allow**？逐 crate 收紧的次序（先安全 crate 还是先能力仓） | 建议：接受，但只允许「带票据与截止日期的模块级 allow」，禁止 `-A clippy::all` 一把梭。次序按风险：安全路径 → wasm-core 权限/生命周期 → 传输引擎 → 宿主适配/UI → tests。`cargo fmt` 先单独提交；`cargo audit` 只挡高危 |
| Q5 | 中英双 README（README.md / README_en.md）双源维护是否合并？git 历史 / 初始提交体量（255k 行）是否做后续工程？ | 建议：中文 README 为唯一真源，英文标注「可能滞后」；不合并、不重写 git 历史，只补一段四仓拆分的历史说明 |

### 13.1 长期风险（登记，不设本期里程碑）

| 风险 | 现状依据 | 建议动作（另立票） |
| --- | --- | --- |
| **单一作者 / bus factor** | 四仓均无 `CODEOWNERS`；平台仓 94 提交、初始提交 255,169 行，历史集中在旧仓 BedCode（1927 提交） | 至少给 `docs/`、契约 / WIT、`scripts/`、安全路径配 review owner；关键决策补 ADR，降低「只有一个人知道为什么」 |
| **自研协议 / 加密面未外部审计** | `link-crypto`、`wasmnest-crypto-engine`、`wasmnest-server-peer-net` 为自研实现；当前无第三方审计记录 | 发布前做一次定向审计（密钥派生 / 握手 / 重放 / 证书校验），或明确将其标为 alpha 实验面并在文档写清威胁边界 |
| **性能只有测试、没有基线** | 已有 `ws_output_perf.rs`、`auth_center_perf.rs`、`terminal_output_perf.rs` 与 `wasmnest-desktop/bench`，但无跨版本基线 / 回归阈值 / 对外数据 | 先选 2–3 个关键指标（启动、WS 吞吐、终端输出）建基线并进 nightly，再谈优化目标 |
| **发布面未验证** | `release-manifest.json` 的 `hostRuntime.artifacts` 为空，产品 `0.0.1` alpha；`docs/` 中未见安装 / 升级 / 回滚演练 checklist | 发布前做一次端到端 dry-run（构建 → 校验 sha256 → 安装 → 升级 → 卸载回滚），把步骤写进 `docs/commands.md` 或发布 checklist |

## 14. 附：本次评估的实测命令与结果

```text
# 根
pnpm run test:run                      # 124/124 通过

# 桌面
pnpm run test:run                      # 714/716，2 失败 @ src/__tests__/scripts/pluginWatchCopy.test.ts（接线组）
pnpm exec vue-tsc --noEmit             # exit 0
pnpm exec eslint src                    # exit 0（根执行亦 0 error）
cd src-tauri && cargo test --test capability_crates_no_product_ids   # 6/6

# 移动
pnpm run test:run                      # 814/814

# 静态核对
rg "unwrap|expect|panic"               # 安全路径计数与位置（§2 表）
rg "plugin_uninstall|plugin_install_from_file" ../wasmnest-lib/wasmnest-wasm-core/src/manager/host/api_bridge.rs
grep "withGlobalTauri" */src-tauri/tauri.conf.json           # 双端 true（L12）
sed -n '53p' README.md                   # 「离开应用面即被卸载」（与 keepalive 口径矛盾）
ls wasmnest-desktop/docs/knowledge      # 不存在（SDK README 死链）
find ../*/.github -type f               # 平台/能力/跨端无测试类 workflow；应用仓有 ci.yml
```

**2026-10-24 审核复核**（修订依据，全部实跑 / 实查）：

```text
# 三端测试基线（含未提交 keepalive 改动的工作树）
pnpm -C wasmnest-desktop run test:run   # 第一次：3 红/754 条（recentsLayout 红）；第二次：2 红/756 条
                                        # —— 红绿与总条数漂移（flaky，见 §2 新行与 §4.1）
pnpm -C wasmnest-mobile run test:run    # 816/816 绿
pnpm run test:run                       # 绿（exit 0）

# 「≈121 处 unwrap/expect/panic（测试区外）」复现口径：剔除各文件首个 #[cfg(...test...)] 之后的
# 行内测试区再计数（裸 rg 会连行内测试一起算，远大于 121；剔除后实测 119）
find wasmnest-desktop/src-tauri/src wasmnest-mobile/src-tauri/src -name '*.rs' \
  -exec awk 'FNR==1{t=0} /#\[cfg\(.*test/{t=1} !t' {} + | rg -c 'unwrap\(\)|\.expect\(|panic!'

# SDK README 双死链核实：本仓 + 应用仓 + 能力仓 find -name 'wasm-app-dev*' 为空；
# 真源在冻结旧仓 ../../BedCode/（bedcode-desktop/wasm-app-dev-desktop.md、docs/knowledge/）
# ADR 序列：../../BedCode/docs/adr/ 实存 48 个文件、最新 0054；本仓引用 0055–0057 但无集中正文
```
