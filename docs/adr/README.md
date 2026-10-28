# ADR 索引（平台仓 `docs/adr/`）

> **定位**：平台仓拆分（四仓）后新立的 ADR 住本目录；编号自 0058 续。旧仓
> `../../BedCode/docs/adr/`（相对平台仓根；相对本文件为 `../../../BedCode/docs/adr/`）
> **冻结于 0054**，只读回退点，**不回写**。
> 命名沿用旧仓惯例：`NNNN-英文kebab-slug.md`，正文中文、标题格式
> `# ADR NNNN：中文标题`。新 ADR 与本索引的登记**同一提交**更新。

## 索引

| 编号 | 标题 | 状态 | 正文 |
| --- | --- | --- | --- |
| 0055 | 桌面 UI 宿主修正：i18n 下沉做法撤销（壳回到宿主） | 已裁决（2026-10-17，用户）；**正文未成文** | 出处见下节 |
| 0056 | 插件 id 家族改名 `com.bedcode.*` → `com.wasmnest.*` | 已实施（现行 id 家族）；**正文未成文** | 出处见下节 |
| 0057 | 桌面挂载形态「机制 B」：同窗口全屏挂载独立构建的应用包 | 已实施（现行形态）；**正文未成文** | 出处见下节 |
| 0058 | 前端信任边界与命令面威胁模型（后端按应用沙箱，前端同可信域） | 已裁决（2026-10-24，按 spec §13 Q1 推荐项） | [0058-frontend-trust-boundary-and-command-surface-threat-model.md](0058-frontend-trust-boundary-and-command-surface-threat-model.md) |
| 0059 | worker 机制管道语义（背压 / 事件直载 / 不复用 task 引擎） | 已裁决（2026-10-28，grill 设计定稿） | [0059-worker-pipeline-semantics.md](0059-worker-pipeline-semantics.md) |

## 0055–0057 出处登记（正文未成文，编号仅被引用）

**核实结论（2026-10-24）**：旧仓 `docs/adr/` 实存 0001–0054 共 48 篇；四仓内
rg（排除 Cargo.lock / node_modules / target / .scratch）**无 0055–0057 正文文件**
——这三条裁决只以「编号 + 一句裁决」散落在下列引用点的注释与文档文字里，
从未落过 ADR 正文。本节即编号与现有出处的对应真源；将来若需成文，在本目录
续写并把上表状态改掉。引用行号以 2026-10-24 工作区为准，行号会漂移，以 `rg`
为准。

### ADR 0055 · i18n 下沉撤销（2026-10-17 用户裁决）

「宿主前端整面下沉」做法撤销：壳 UI 回到宿主，宿主自持 i18n，不依赖 app 外置。

- `wasmnest-desktop/src/main.ts:4` —— 裁决原文要点（「新的…」口径接续在注释里）
- `wasmnest-desktop/src/i18n/index.ts:4` —— 壳回到宿主自持 i18n 的机制自述

### ADR 0056 · 插件 id 家族改名（`com.bedcode.*` → `com.wasmnest.*`）

全量插件 id 改 `com.wasmnest` 家族（bedcode 应用豁免仅显示名 / rust 文件名）；
改名遗留的退役产物目录由构建脚本清理。

- `wasmnest-desktop/src/shell/composables/useShellApps.ts:103`、`:123` —— id 家族真源与产物目录按 `PLUGIN_ID` 派生
- `wasmnest-desktop/scripts/plugin-build.js:92` —— 构建后清理退役产物目录（`com.bedcode.*` / 已删应用）
- `wasmnest-desktop/scripts/plugin-precheck.mjs:19`、`:138` —— 陈旧产物目录剪除的动机自述
- `wasmnest-desktop/src-tauri/tests/lifecycle_orchestration.rs:21` —— 测试 id 取自实际加载清单的口径
- `wasmnest-desktop/src/__tests__/scripts/pluginPrecheck.test.ts:367` —— 退役 id 样例（`com.bedcode.legacy`）
- `wasmnest-desktop/src/__tests__/shell/composables/useShellState.test.ts:68` —— 测试 id 与真源一致的口径

### ADR 0057 · 桌面挂载形态「机制 B」（同窗口全屏挂载独立构建的应用包）

桌面 app 前端是独立构建的挂载包（`mountApp(root, env)` 入口契约），宿主壳经
asset 协议取件动态 import 挂载，宿主不 import 任何 app 源码。机制现行描述的
**正文真源是 `docs/architecture.md` §2**（非旧仓）。

- `docs/architecture.md:43` —— §2「桌面端宿主形态（壳 + 挂载槽，机制 B / ADR 0057）」
- `docs/contracts.md:73` —— 桌面 SDK 旧贡献面形态与 0057 挂载包形态的已知漂移条
- `wasmnest-desktop/src/shell/ShellHost.vue:97` —— 壳装载挂载包、不 import app 源码
- `wasmnest-desktop/src/i18n/host-zh-CN.ts:296`、`host-en.ts:304` —— 应用整包挂载面两态文案注释
- `wasmnest-desktop/src-tauri/src/lib.rs:522`、`:751`、`:954` —— asset 协议同源取件与整包目录装配
- `wasmnest-desktop/src-tauri/src/plugin.rs:31`、`src-tauri/src/plugin/assets.rs:1` —— 挂载包目录宿主事实
- `wasmnest-desktop/src-tauri/tests/app_bundle_asset_scope_lock.rs:3` —— asset scope 锁背景
- `wasmnest-desktop/src-tauri/tests/retired_session_command_lock.rs:33` —— 宿主 shell 前端退役扫描口径

### 勘误登记

`docs/codemap.md` §9「旧仓」行曾把 0056 / 0057 列为旧仓 `docs/adr/` 存量——与
实际不符（旧仓冻结于 0054，无此二篇），已在本索引开立的同一提交中修正为指向
本节。
