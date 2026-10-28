# 单元测试与完成定义 / 验证

> **本文件是 `AGENTS.md` 的拆分文档（测试与验证）**：单元测试两种形态、运行位置、测试工具链、完成定义清单、验证质量标准。
> 本文件与 `AGENTS.md` 的硬约束**同级别**。命令与门禁见 `docs/commands.md`；代码查找与锁索引见 `docs/codemap.md`。

## 1. 单元测试

> **通用测试规范（两种形态 / 禁止交付 / 测试数据临时目录 / Seam 3 锁纪律 / 验证底线）真源 = `docs/public/testing.md`（四仓共享，不在此复制）**。本文件只保留平台仓特有增量。

- 运行位置（平台特有）：前端 vitest 在端目录（`src/__tests__/**`，happy-dom；桌面另含 SDK 契约测试 `packages/plugin-sdk-desktop/__tests__`；移动 vitest 的 `@apps` 别名是跨仓读取专用，**不得进宿主构建代码**）；Rust 在 crate 根（宿主 = `src-tauri`；SDK = 各自 `rust/`）。
- 部分桌面 Rust e2e（pty / ws / http）依赖 `resources/plugins/desktop` 随包产物，跑前先构建（见各测试头注释）。
- 跨仓锁（docs/codemap.md §8）与注册表锁是**契约声明**：改动使其清单过期时同批更新（Seam 3 细则见 docs/public/testing.md §4）。

## 2. 测试工具链

- `scripts/audit-rust-tests.mjs`：Rust 测试体量审计。
- `scripts/split-rust-tests.mjs` + `scripts/run-test-split.sh --crate <子串>`：迁移 / 拆分测试（逐 crate 事务化，红了即回滚该文件）。
- E2E：桌面 `pnpm run test:e2e`（WDIO：`e2e/specs/{smoke,bench}.spec.ts`）。
- 跨端真实互连：`../wasmnest-test/cross-end-tests`（同进程 path 依赖两端 `src-tauri`，零 mock）。
- 性能基准：`../wasmnest-test/perf-tests`（桥接模块 + 真实应用模块，只认 release 构建）。

## 3. 完成定义与验证

**本仓测试 CI = `.github/workflows/test.yml`**（PR + `main` 推送 + nightly + 手跑；
**`dev` 推送不触发**——用户 2026-10-28 定：四仓 dev 推送一律不跑 GitHub CI，dev 的验证
靠本地命令 + husky pre-commit + 显式 `workflow_dispatch`）：
- **PR required checks（node 层 + Rust 快检）**：`check-wit`（WIT 漂移锁）· `node-root`（根脚本自测 + 根 eslint + `check:links`）· `node-desktop` / `node-mobile`（`vue-tsc --noEmit` + vitest `test:run`）· `rust-check (desktop|mobile)`（`cargo check` + 不需要随包产物的快速锁测试，名单见 workflow 注释）。
- **全量层（不进 PR 阻断）**：`rust-full`（`main` 推送 + nightly + 手跑）= 先 `plugins:build` 重建随包产物，再双端全量 `cargo test`（pty / ws / http / app-bundle 等随包产物 e2e 在这一层）。
- **`check:manifest` 不在 CI**：判据 2/6 要求 HEAD 正好是 manifest 钉住的 tag——开发分支必红，属发布 / tag 流水线。
- **跨仓检出跟 ref 不钉 tag**：能力仓 / 应用仓默认 `dev`，`WASMNEST_LIB_REF` / `WASMNEST_APPS_REF` 可配（workflow_dispatch input 或仓库变量）——CI 只做校验，按 manifest tag 钉住是发布流水线的事。
- CI 与 husky pre-commit 重复是 **by design**（钩子可被跳过，CI 不可）。

门禁 = CI required checks + husky pre-commit + 本地命令 + 测试锁。**任何交付必须实际运行并贴出结果；无法运行要说明原因与风险。**

**当前迁移期口径（用户 2026-10-18）**：不逐项跑集成 / 全量回归，收口后统一跑；日常改动至少跑**针对性单测 + 所在端测试**。以下为收口后的标准清单，按改动类型执行：

- 改前端（任一宿主壳 / SDK UI）→ 该端 `pnpm run test:run` 全绿；根 `pnpm exec eslint .` 0 error；UI 改动至少在一个真实环境目验（桌面 `tauri:dev`；移动 dev-shell 或 Android dev）。**涉及 UI 设计决策的，先过 docs/frontend.md §4 的两个强制 skill 再下手。**
- 改 app 产物接线 / dev 脚本 → 根 `pnpm run test:run` + 该端相关脚本锁；确认产物真写进 `src-tauri/resources/plugins/<end>/<id>/`。
- 改宿主 Rust → 该端 `cd src-tauri && cargo test` 全绿（含锁测试）；需要随包产物的 e2e 先构建。
- 改 SDK → 该端 SDK `test:run`；涉及发布 → `scripts/package-sdks.mjs` 全链绿。
- 改 WIT / 契约 / 版本 → docs/contracts.md §3 全链：`check:wit` + 受影响 app 重建 + `check:manifest` 全绿。
- 改权限 / 清单 / 应用注册表 → `manifest-gen` / `manifest-validate` 通过；`check:manifest` 通过（涉及 id / rustLibrary / 端变化时）；相关边界锁同步更新并跑绿。
- 改移动壳 / Kotlin / gradle → 移动 `test:run` + gradlew 验证 + 真机 / 模拟器目验。
- 改跨端面 → `../wasmnest-test/cross-end-tests` 全量通过（写清「跑了 / 没跑」）。
- 宿主侧任何改动 → docs/architecture.md §1.4 自检三问通过（B1–B6 零命中；未在宿主新增业务类型 / 状态 / 存储 / 路由 / 默认值）。
- 迁移 / 新增锁 → Seam 3（§4）。

## 4. 锁纪律（Seam 3）

> 通用锁纪律真源 = `docs/public/testing.md` §4（跑红一次 / 显性失败 / 禁删锁缩 glob 恒真 / 清单过期同批更新）。本端另有锁索引见 docs/codemap.md §8。

**新增源码文本锁门槛（issue #18，2026-10-24）**：此后新增任何「读仓内源码 / 配置 / 清单文本做断言」的锁（前端 `.test.ts` 扫源码、Rust `*_lock.rs` 扫源文件同口径），三条同时满足才准收：

1. **注明豁免理由**：锁文件头注释写清「为什么不能用行为测试表达」。有效理由只有边界契约类——跨构建单元 / 跨仓 / 双真源同步（无编译期约束）、发布面清单契约、退役面 fail-visible 防回接、安全红线禁区、happy-dom / 组件测试不可达的渲染事实（CSS 变量、SVG 几何、静态首屏）。「锁实现顺序 / 逐函数名逐调用点枚举」**不是**理由——接线唯一时只保留**一条**轻量接线断言（样板：`pluginWatchCopy.test.ts` 的 dev-run 预检锁，issue #12；行为化样板：`pluginPrecheck.test.ts`）。
2. **Seam 3 跑红一次**：新锁上线时至少看到一次真实失败再修绿（真源 docs/public/testing.md §4）。
3. **登记入清单**：入 docs/codemap.md §8.1 源码文本锁盘点清单，标注 owner 与豁免理由；锁清单过期与代码同批更新。

存量源码文本锁的逐个处置（保留 / 收敛 / 待改造与 Phase 2 首批）见 docs/codemap.md §8.1。

按上述门槛登记的新锁：`with-global-tauri-lock.test.mjs`（根 `scripts/`，`pnpm run test:run`，issue #22 / #16 / ADR 0058，2026-10-24）——钉双端 `tauri.conf.json` 的 `app.withGlobalTauri === false`，owner=binblink（平台仓）；豁免理由（纯配置项无行为面）与 Seam 3 跑红记录见锁头注释，盘点行在 docs/codemap.md §8 / §8.1。