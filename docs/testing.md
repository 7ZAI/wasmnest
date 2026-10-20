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

**本仓（以及三仓）当前无 CI workflow**（未随迁；勿把「CI 会兜底」当依据）。门禁 = husky pre-commit + 本地命令 + 测试锁。**任何交付必须实际运行并贴出结果；无法运行要说明原因与风险。**

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