# 03: 平台仓——submodule 指针前移 + 五处读者收敛 + 归桶登记 + 例外摘除

**What to build:**
平台仓一次性把消费侧切到 crate 真源（spec D6 第 2 步 + D4/D6 修订），同批原子提交（离了任何一件就是「仓坏」感官的半迁移）：

1. `packages/` submodule 指针前移到票 02 的精确 tag；`release-manifest.json` 的 `repos.lib.tag` 写同一 tag。
2. **五处读者**（spec D4 修订表）路径常量全部改指契约 crate 源文件：WIT 拼装脚本（拼 package 行）、发布清单锁脚本（`contract.version` 断言）、桌面 `tests/` 版本锁（WIT 源 package 行断言）、**桌面 `src/` 内联测试的 `package_source()`（compose.json ↔ 白名单面——二次审核补列的第六处读者）**、移动端组合锁。
3. `capability_crates_no_product_ids` 的 `SCANNED_CRATES` 登记 `wasmnest-contract`（零产品语义直接转正，参照 host-api-core 补登记先例——C-3 反向断言要求 `packages/` 下每个 `wasmnest-*` 目录归桶）。
4. **摘除票 01 登记的例外**——结构锁转入无例外绿（迁移完成的结构收口证据）。
5. 文档：`docs/contracts.md` 真源链与 bump 流程路径改为「`wasmnest-contract` crate」；`docs/codemap.md` 结构树与真源落点表同步。改后 `ls` / `rg` 核对。

门禁（全部实跑贴结果；docs/testing.md 完成定义）：

- `pnpm run check:wit` 全绿且生成物 sha256 与迁移前逐字节一致（spec D7 零变边界——本次唯一能证明「没顺手改产物」的检查）；
- 桌面端 `cargo test --test wit_package_version_lock` + 同 crate `cargo test --lib`（后者覆盖内联读者）全绿（Seam 3）;
- 移动端组合锁手工实跑全绿（Seam 3b；不为此引入移动 CI）；
- `pnpm run check:manifest` 除既存基线红（apps 仓 HEAD 无精确 tag——Seam 2 声明，Out of Scope 另办）外**无新增红**；
- SCANNED_CRATES 锁绿、结构锁（票 01）无例外状态绿。

**Blocked by:** 02（新 tag 在场才能前移指针）

**Status:** ready-for-agent

- [ ] 五处读者全部指向契约 crate 源文件；`rg "packages/contracts"` 平台仓零命中（注释如实更新或随上下文改写）
- [ ] `check:wit` 19/19 绿且产物 hash 不变；两脚本正则对新形状（`pub const <NAME>: &str = "…";`）零改动匹配
- [ ] 桌面版本锁 + `--lib`、移动组合锁、`check:manifest`（基线红已区分）、SCANNED_CRATES 各跑绿，命令与结果随票交付
- [ ] 票 01 的例外已删且锁绿；`release-manifest.json` tag 与 submodule 指针同 tag
- [ ] 平台仓提交按 docs/git.md 口径一票收口（submodule 指针 + 读者 + 登记 + docs 同批）
