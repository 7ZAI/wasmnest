# 02: 契约真源迁入 `wasmnest-contract` crate（能力仓，tag 收口）

**What to build:**
能力仓（lib 仓，`packages/` submodule 的真身）**新建零依赖契约 crate**，让包名/版本真源第一次拥有 crate 边界（spec Solution/D1/D3/D8）。

- 位置：能力仓根，与 host-kit 同级；包名 `wasmnest-contract`；无 `build.rs`、无 `links`、**不设** `publish = false`；`Cargo.lock` 随票提交（只经 cargo 变更）。
- 内容：现 `contracts/wasmnest-plugin-package.rs` 的三个常量与注释**整体迁移**，注释含：bump 政策全文（唯一写下的版本纪律）；「跨语言文本契约」（spec D4 修订：常量保持 `pub const <NAME>: &str = "<值>";` 精确形状——macro化/`env!` 化 = 两 node 脚本正则的破坏性变更，须同批改）；**两处旧描述修正，不得逐字搬运**（spec D1 修订条目）：① 删掉「能力域 crate 各自 include! 本文件」的错误描述，改为「能力域 crate 写死字面量、由锁断言」；② 「字面量无法跨文件派生」精确化为「纯拷贝跨 crate 可行；版本嵌串组合串无 const 插值机制（concat! 只收字面量、format! 非 const）」。
- 内核 crate：删除内联 `mod package { include!(...) }` 与 `pub use package::*`，改为 `pub use wasmnest_contract::{PACKAGE, PACKAGE_NAME, PACKAGE_VERSION}`（Cargo.toml 增 path 依赖）；对外派生函数签名零变化。
- 删除 `contracts/` 目录；能力域 crate 的导出名字面量**原地不动**（不引新依赖边，锁继续钉）。
- 能力仓 `AGENTS.md` 同步：§0 定位（契约真源表述）、§1 结构树与 crate 表、§2.2 真源链与三条使用路径（① include! → use；③ 脚本读 crate 源文件）、§5 任务路由、新增 **D8 说明**：本 crate **不进** `SPLIT_CRATES`（登记会触发「宿主清单声明全部拆分产物」对偶断言、迫宿主直接依赖 → 误红；其非拆分产物，谱系不同）。迁完用 `ls` / `rg` 核对档位（文档字面 ≠ 事实）。
- 收口：提交 + 打精确 tag（`lib-vX.Y.Z`，patch 位；遵循 docs/git.md 三仓顺序与 docs/public/versioning.md「发布才 bump」口径）。crate 自身 version 与契约 `PACKAGE_VERSION` **不强制相等**（spec D1）。
- **半迁移声明**：本票落地后至票 03 完成前，平台侧读者处于 spec D6 的 fail-visible 红窗（读不到真源即报错、不静默跳过）——属预期，不得为「先保绿」而临时改读者。

**Blocked by:** 01（结构锁已以例外登记落绿——迁移期间它是唯一看着这门面改动的新锁）

**Status:** ready-for-agent

- [ ] crate 零依赖；在 crate 目录 `cargo package --list --allow-dirty` 成功且归档含常量文件（本 crate 不受 plugin-api 未发布的解析阻塞，spec Problem 1 归因已校准）
- [ ] 内核 crate 按能力仓 AGENTS §4.2 两条合法路径之一跑 `cargo test` 全绿——契约派生函数与自洽断言零改动通过（Seam 4）
- [ ] 无头探针门禁依旧绿（无新增 wasmtime/wit-bindgen/inventory/host-kit 依赖边）；crate 边界锁生态全绿（本 crate 未登记 SPLIT_CRATES，D8 生效）
- [ ] `rg include!` 全能力仓不再出现跨目录逃逸形态；`contracts/` 目录已删
- [ ] 新 `Cargo.lock` 随票提交；提交信息 conventional（`refactor(lib):` 形态），禁止 AI 协作者标记
- [ ] 精确 tag 已打并推送（如推送属本流程）；AGENTS.md 与 crate 注释已在**同一提交**完成
