# AGENTS.md —— wasmnest（平台仓）开发导航与硬边界

> **本文件是 wasmnest（平台仓）——双端宿主 + 端内 SDK——的开发导航与硬边界，面向人类与 AI 协作者（含 vibe coding）。**
> 只给方向、判据与导航；机制细节、契约版本、历史与踩坑在各自真源里（代码头注释、SDK README、能力仓 WIT / `wasmnest-contract`、`release-manifest.json`），需要时按指针去读，不在本文件复制。
> **详细规范按主题拆分在 `docs/`（见 §4）**：代码文件导航 / 命令 / 架构 / 契约 / 前端 / 后端 / 安全 / 测试 / Git / 边界。本文件保留「动任何端都要过」的骨架。
> 机制描述与真源冲突时，以真源 + 平台仓锁为准，并回来修正本文档或对应 `docs/` 文档。

## 0. 定位与冲突裁决

**本仓定位**：四仓（平台 / 能力 / 应用 / 跨端测试）里唯一的**宿主与发布面**——桌面与移动两个宿主（`wasmnest-desktop/`、`wasmnest-mobile/`：`src-tauri` + 前端 + 端内 SDK）、根构建 / 发布工具（`scripts/`）、WIT 拼装与跨仓版本表达（`release-manifest.json`）都住这里。能力仓只提供应用无关的引擎与契约真源，应用仓只提供业务语义（wasm 应用）。**新增能力先问「这是机制还是产品语义」**，机制落能力仓、产品落应用仓，宿主只做装配与安全闸门（§2 红线）。

冲突按下述优先级裁决（高者胜）：

1. **用户当前明确指令**
2. **安全与架构红线**（§2 宿主薄壳、docs/security.md）——确需越线时停下向用户确认，禁止自行放松
3. **本文档与 `docs/` 下拆分文档的硬约束**（「必须 / 禁止」字样，与本文档同级别）
4. **跨仓真源**（能力仓 WIT / `wasmnest-contract` / `release-manifest.json` / SDK 生成物 / 代码自身）
5. **通用工程经验**

维护口径：

- **路径基准**：仓内路径相对平台仓根。跨仓按 R1 同场布局记为 `../wasmnest-lib`（能力仓，**全部内部依赖 crate 的真源**，平台经 Cargo path 直接消费）、`../wasmnest-apps`（应用仓）、`../wasmnest-test`（跨端测试仓 `cross-end-tests/`）；布局不标准时用显式环境变量 `WASMNEST_LIB_ROOT`（平台 → 能力仓，node / 测试侧 resolver = `scripts/lib-paths.mjs`）与 `WASMNEST_APPS_ROOT`（平台 → 应用，`scripts/app-paths.mjs`）；测试侧另有 `wasmnest-*/src/__tests__/support/appPaths.ts` 与移动 vitest 的 `@apps` 别名。
- **文档字面 ≠ 事实**：引用任何路径 / 命令 / 锁名 / 版本前先用 `ls` / `rg` 核对；与实际不符先修文档再继续。
- **最小改动**：只改任务必要文件；禁止顺手重构相邻代码、擅自升级依赖（wasmtime / SDK 升级先做双端影响评估）；设计取舍不猜，先问用户。
- **项目阶段（研发起步期）**：无真实用户、无对外 ABI 兼容义务——破坏性变更可直接进行，但跨仓契约按 tag 钉住（docs/contracts.md §1），退役面必须 **fail-visible**（点名缺失 + 给出路），禁止静默降级成「查不到就返回空」。
### 0.1 Agent 工作流（vibe coding 简则）

1. **开工自检**：`git status` 认领改动来源；读相关模块头注释与 `docs/codemap.md` §6 任务路由表的「必读」；确认要改的是哪一端（桌面 / 移动 / SDK / 工具）。
2. **边界判定**：动宿主侧前先过 §2 三问（能离宿主实现吗 → 携带产品语义吗 → 才放宿主）；改跨仓面（WIT / 清单 / 应用注册表）先读 docs/contracts.md / docs/boundaries.md。判不准就停下问用户。
3. **小步实现**：最小 diff 完成一个可验证单元；不并行夹带无关改动；生成物不手改（docs/contracts.md §6）。
4. **针对性验证**：按 docs/testing.md §3 跑改动类型对应的最小测试集；改锁 / 改注册表 / 改 WIT 时必须跑对应锁。
5. **交付说明**：列出「改了什么 / 为什么 / 跑了什么命令与结果 / 没跑什么与风险」；凡按 docs/git.md §3 边界需要跨仓同步的（清单、子模块指针、应用注册表），逐项点名。

### 0.2 交流准则（格赖斯合作原则）

面向本仓人类与 AI 协作者（含 vibe coding）的沟通规则，以格赖斯（H. P. Grice）合作原则与四项会话准则为纲：**在不牺牲准确性与必要深度的前提下提高沟通效率**。任何回复、评审意见、任务汇报、交付说明均适用。

- **量的准则（信息充分而不冗余）**：提供接收方完成行动所需的信息量，不多不少——既不遗漏关键结论 / 依据 / 风险 / 未跑项，也不堆砌无关背景、重复已知结论、贴大段代码或日志凑篇幅。判据：接收方能据此行动且无需再追问。
- **质的准则（论述真实且有依据）**：不说无依据、无法核实或不信为真的话；凡论断必有依据（命令输出、源码引用、文档指针、可复现实验），并区分「事实 / 推断 / 猜测 / 待验证」，禁止把猜测包装成结论。数据、路径、版本、锁名引用前先核实（文档字面 ≠ 事实）。
- **关系准则（回应紧扣问题）**：回应与所问直接相关，被问什么就答什么；不答非所问、不借题发挥、不夹带与当前任务无关的改动或建议。
- **方式准则（表达清晰有序）**：避免晦涩、歧义与冗长；结论先行、要点编号、按逻辑顺序组织；术语一致，路径 / 命令 / 锁名 / 版本用可复制的准确字面；先给结论与证据，再给过程与细节。

**底线而非上限**：这些准则是沟通下限，不是压缩上限——涉及准确性、安全、契约、跨仓同步、必要深度时，不得以「简洁」为由省略；与本文档其他硬约束冲突时，以对应硬约束为准。

## 1. 仓速览（完整代码导航 → `docs/codemap.md`）

平台仓 = 双端宿主 + 端内 SDK + 根工具；Rust **无根 workspace**。能力仓 `../wasmnest-lib` 是全部内部依赖 crate 的真源，平台经 Cargo path（`../../../wasmnest-lib/<crate>`）直接消费，版本由 `release-manifest.json` 的 `repos.lib.tag` 钉住；平台仓不复制、不镜像能力仓源码。应用源码住应用仓、产物落本仓 `resources/plugins/**`（不入库）。**双端一句话**：桌面 = 同窗口全屏挂载独立构建的应用包（机制 B）；移动 = 宿主壳运行面（`registerSurface` 等运行时注册），每个运行面由宿主建成**独立 Vue 应用**（`surfaceAppRegistry` 容器注册表承载，2026-10-24），共享模块外置宿主全局与桌面不同。

**应用清单**（真源 = 各端构建注册表 + `release-manifest.json`）：`ai-chatbox`（双端）、`bedcode`（显示名 BedCode，双端）、`file-transfer`（双端单产物，移动经 `desktop-compat` 桩）、`monitor`（双端，只读运行指标）。

## 2. 强制红线：宿主薄壳（动宿主前必读）

**一句话**：宿主只含「应用无关的通用引擎 + 安全闸门 + 装配机制」，一切产品概念（会话、终端、设备连接、文件传输、AI、Agent……）都是 wasm 应用。宿主只回答「机制怎么做」，不回答「这件事是什么、给谁用、怎么组织」。

**六条判据（命中任一即业务代码）**——裁决词汇，报错信息与代码注释里直接用编号：

- **B1** 产品类型 / 字段：宿主以业务名词定义数据结构、枚举、状态、常量
- **B2** 业务编排 / 状态机：按产品语义推进的流程、队列、重试、封顶、状态迁移
- **B3** 业务真源：宿主持有产品事实的权威存储并对外读写
- **B4** 业务投影：把原语结果翻译成产品 wire 形状再对外消费
- **B5** 业务默认值 / 策略：宿主替插件决定「业务上该怎样」
- **B6** 业务生命周期挂钩：宿主解释产品事件并主动回调插件

**归属裁决三问**（顺序不可颠倒）：① 离宿主能实现吗？能 → 放插件；② 携带产品语义吗？命中 B1–B6 → 放插件；③ 都不命中 → 放宿主，且必须满足：WIT 纯增量（或走 ABI bump）、权限位有门禁落点、停用可回收。「宿主已经能拿到这些数据」**不是**留在宿主的理由；判不准从严判并停下问用户。

**提交前自检**（改动落在宿主侧时逐条回答）：① 在宿主有第二个消费者吗？② 删掉它，第三方插件能用同一形状的既有原语自建吗？③ 是否新增了对产品事件的解释或回调（= B6）？答不出就停下问用户。

**表面生命周期（双端同一口径，2026-10-23；移动承载 2026-10-24）**：应用没被停用就继续运行——切走只是藏起来（DOM / 组件实例保留、容器脱文档不渲染），停用 / 卸载才是唯一销毁点；后台渲染 / 动画不做。双端同为 `detach` 不得退化成卸载；移动停用路径显式「先 dispose UI 再拆插件上下文」。

**服务型应用不进多任务（双端同一口径，2026-10-23）**：装配角色为 `basic-service` / `internal-business`（`isServiceKind`）的应用不产多任务卡——桌面 `openApp` / `syncFromRoute` 走服务面（进全屏但不入 `cards`）、右键菜单隐藏「停用」；移动多任务两个来源（运行中 / 最近使用）都过滤。关闭唯一入口 = 应用管理页（桌面）/ 应用详情页（移动）的「停用」。

宿主允许存在的四类薄壳、fail-visible 三形态、桌面挂载形态、双端差异、权限与安全闸门总览 → `docs/architecture.md`；安全红线 → `docs/security.md`；禁行清单速查 → `docs/boundaries.md` §3。

## 3. 常用命令速查（完整命令集 → `docs/commands.md`）

> **包管理器一律 pnpm（禁止 npm）**；两端依赖各自目录安装；Rust 命令在各自 crate 根跑（宿主 = `<end>/src-tauri`）。**禁止跑 `pnpm run test`（vitest watch 不退出）——一律 `test:run`。**

| 场景 | 命令 |
| --- | --- |
| WIT 漂移锁 / 重拼 | 根 `pnpm run check:wit` / `node scripts/compose-wit.mjs --all` |
| 清单一致性 / 打印 WIT 指纹 | 根 `pnpm run check:manifest` / `node scripts/check-release-manifest.mjs --print-hash` |
| 应用产物构建 | 桌面 `pnpm run plugins:build`（全量）· 移动 `pnpm run plugins:build` |
| 宿主产物分发 | 桌面 `pnpm run host:pack`（`scripts/package-host.mjs`；`WASMNEST_PLUGINS_DIR` 可覆盖插件目录） |
| 前端测试 | 端目录 `pnpm run test:run`（桌面含 SDK 契约测试） |
| Rust 全量测试 | `cd src-tauri && cargo test`（部分用例需先构建随包插件产物） |
| 单应用调试 | 桌面 `pnpm run plugins:dev -- --plugin <id>`（详见 commands.md §5.2） |

## 4. docs 体系（本文档的拆分文档，硬约束同级）

| 文档 | 内容 |
| --- | --- |
| `docs/codemap.md` | ★ 代码文件导航：仓结构树 / 端内模块导览 / 任务路由表（改 X 先读 Y）/ 代码查找纪律 / 锁索引 / 文档索引 |
| `docs/commands.md` | 命令全集：通用约定（wasmtime 48 / wasip3 / sccache / 自适应构建）/ 根 / 桌面（含 host:pack）/ 移动 / 应用与插件（§5.2 单应用调试）/ target 治理 / husky |
| `docs/architecture.md` | 架构硬约束：宿主薄壳六判据与三问全量 / 桌面挂载形态 / 退役面纪律 / 双端差异与锁步 / 权限与安全闸门总览 / 跨端协议 / 数据库 |
| `docs/contracts.md` | 契约：release-manifest 判据 / WIT 真源链与 bump 政策 / WIT-ABI 变更 7 步流程 / 权限声明 / plugin.json / SDK / 生成物清单 |
| `docs/frontend.md` | 前端规范：零资源访问三层封锁 / 挂载包与运行面形态 / 移动壳优先 / **UI 设计强制前置技能（`ui-ux-pro-max` + `design-taste-frontend`）** / 注释命名 i18n |
| `docs/brand.md` | 对外品牌文案真源：主标（中/英）/ 副标句 / 技术意象句 / 备选池 / 使用规则 / 落地位置与现状（视觉 token 另见两端 `src` 下的 CSS 变量） |
| `docs/backend.md` | Rust 规范：命名 / AppError / Command 纪律 / 调试面门控 / 注释命名（后端面） |
| `docs/security.md` | 安全与日志红线：密钥禁令 / fail-closed / 加密引擎中性原语 / tracing 分级 / 结构化字段 |
| `docs/testing.md` | 单元测试形态 / 测试工具链 / 完成定义与验证清单（迁移期口径 2026-10-18）/ 锁纪律（Seam 3） |
| `docs/git.md` | 提交规范 / 能力仓 sibling 钉版纪律 / 三仓提交顺序与 tag 规则 / 文件回滚规范 |
| `docs/boundaries.md` | 依赖方向（禁止反向引用）/ 跨仓锁 / Agent 禁行清单 |
| `docs/docker.md` | 本机 Docker 部署事实：版本与 API / data-root / docker 组 / 镜像源 / 清理 |
| `docs/public/` ★ | **四仓共享通用规范真源**（其他仓经 `../wasmnest/docs/public/` 引用）：`git.md`（git 提交）/ `commenting.md`（注释与命名）/ `testing.md`（测试与验证底线）/ `versioning.md`（版本号管理：只有发布时 bump，dev 不 bump）/ `issues.md`（GitHub Issues = 跨会话存续 backlog 真源）——通用部分单一真源，本仓 docs 不复制 |

**文档字面 ≠ 事实**：任何文档（含 `docs/`）都只是导航与判据，改结构 / 文案前先 `ls` / `rg` 核对；引用旧仓（`../../BedCode/`）内容时注意它与三仓现状的差异，机制以新仓代码为准。

## 5. 完成定义速查（完整清单 → `docs/testing.md` §3）

本仓测试 CI = `.github/workflows/test.yml`：node 层 PR required（`check-wit` / `node-root` / `node-desktop` / `node-mobile`）+ Rust 分层（`rust-check (desktop|mobile)` 进 PR；`rust-full` 全量 cargo test 与随包产物 e2e 在 `main` 推送 + nightly，不进 PR 阻断）；`check:manifest` 属发布 / tag 流水线，不做日常 PR check。**`dev` 推送不触发 GitHub CI**（四仓同口径，用户 2026-10-28 定）——dev 验证靠本地命令 + husky + 显式 `workflow_dispatch`。门禁 = CI required checks + husky pre-commit + 本地命令 + 测试锁。**任何交付必须实际运行并贴出结果；无法运行要说明原因与风险。**

- **当前迁移期口径（用户 2026-10-18）**：不逐项跑集成 / 全量回归，收口后统一跑；日常改动至少跑**针对性单测 + 所在端测试**（改动类型 → 最小测试集映射见 docs/testing.md §3）。
- 改锁 / 改注册表 / 改 WIT：必须跑对应锁；锁清单过期**同一提交内同步更新**，禁止删锁、缩窄 glob、掏空断言（Seam 3：锁跑红一次证明不空转）。
- husky pre-commit 自动跑：WIT 漂移锁 + 暂存前端 eslint；钩子跳过**不等于门禁通过**——手工补跑。