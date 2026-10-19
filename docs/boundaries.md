# 边界与跨仓契约

> **本文件是 `AGENTS.md` 的拆分文档（边界）**：依赖方向（禁止反向引用）、跨仓锁、Agent 禁行清单。
> 本文件与 `AGENTS.md` 的硬约束**同级别**。改本仓结构 / 文案 / 引用前先看跨仓锁。

## 1. 依赖方向（禁止反向引用）

- **平台 → 能力**：只经 Cargo sibling path（`../../../wasmnest-lib/<crate>`）与 WIT / 契约真源。能力仓 `../wasmnest-lib` 是全部内部依赖 crate 的唯一真源，平台**不复制、不镜像**；能力仓改动一律去 `../wasmnest-lib` 提交、打 tag，平台只更新 `release-manifest.json` 的 `repos.lib.tag`（docs/git.md §1）。
- **平台 → 应用**：源码读取的唯一入口是 `scripts/app-paths.mjs`（`WASMNEST_APPS_ROOT` / R1 兄弟布局，缺仓显性抛错）与 `scripts/app-script.mjs`（转发单 app 脚本）；测试侧经 `support/appPaths.ts` / `@apps` 别名。**宿主构建期禁止 import 任何 app 源码**（桌面 `hostAppBoundaryLock` 会测红）——宿主与 app 只有「运行时装载产物」一条关系。
- **应用 / 能力 → 平台**：禁止反向引用平台源码（应用只认 SDK 发布版本 / WIT bundle / ABI）；能力仓在 L1 档位下仍有测试期读取平台源的既有锁（6 处，读 sibling 布局），**不得新增**这类反向边。

## 2. 跨仓锁（读对方仓源码的锁；改本仓结构 / 文案前先看它们）

| 锁 | 位置（本仓） | 钉住什么 |
| --- | --- | --- |
| `hostAppBoundaryLock.test.ts` | `wasmnest-desktop/src/__tests__/` | 宿主零 app 源码 import、零 `__WASMNEST_SHARED__`、零旧贡献面；逐字校验四个桌面 app `src/entry.ts` 的 `mountApp` 契约（**新增 / 改名桌面应用必须同步该清单**） |
| `i18nDriftLock.test.ts` | 同上 | 宿主 `src/i18n/host-{zh-CN,en}.ts` ↔ `apps/bedcode/desktop/src/i18n/host-{zh-CN,en}.ts` **逐字一致**（改任一边必须同改另一边） |
| `tailwindContentCoverage.test.ts` | 同上 | 宿主 Tailwind content 不得残留 app 路径（app 类各自编译） |
| `appBundlePathLock.test.ts` / `appChromeLock.test.ts` | 同上 | 挂载包路径单一来源（`resources/plugins/desktop` 层级）；壳标题栏常驻、应用不得自绘标题栏/窗口控制/拖拽区 |
| 移动壳系列锁（`shellConstraintLocks` / `retiredHostUIRetirementLocks` 等） | `wasmnest-mobile/src/__tests__/shell/` | 壳内自足（不依赖旧界面目录）、退役路由 / 符号不回接、壳迁移面不得缩水 |

**锁是契约清单，不是障碍**：你的合法改动若使某把锁的清单 / 白名单过期，必须**同一提交内同步更新该清单**（并在交付说明里点名）；禁止删锁、缩窄 glob、把断言改恒真来「变绿」。

## 3. Agent 禁行清单（速查）

- 不手改生成物（docs/contracts.md §6）；不把能力仓源码复制 / 镜像进平台（§1）。
- 不在宿主构建期 import app 源码；不复活旧贡献面（`registerSidebarPanel` 等）与 `__WASMNEST_SHARED__`（桌面）。
- 不由前端直接发起 HTTP / WS / 文件访问、不裸用 `__TAURI__`、不旁路授权弹窗（docs/frontend.md §1 / docs/security.md）。
- 不为「让测试变绿」删锁 / 缩 glob / 掏空断言（§2 / docs/testing.md §4）。
- 不提交密钥 / 凭据 / 产物；不手编锁文件；不 `cargo clean` 共享 target 目录（docs/commands.md §6）。
- 不开工就改：先 `git status`，**非本任务的在途改动一律不碰、不回滚**（docs/git.md §1）。
- 不自动 `--force` 覆盖远端；不在 commit message 里加 AI 协作者标记（docs/git.md §1）。
- 不跑 `pnpm run test`（vitest watch 不退出）——一律 `test:run`（docs/commands.md §7）。