# 04: 跨端测试仓——读契约真源锁的路径唯一更新点

**What to build:**
测试容器仓（`cross-end-tests`）读取契约真源的那把接线锁（file-transfer 绑定词汇，`file_transfer_wiring_lock`）——它持有跨仓复制的 `packages/contracts/*.rs` 路径——改为指**契约 crate 的源文件**（平台仓挂载点 `packages/<契约 crate>/src/`），跑绿（spec D6 第 3 步、User Story 11）。这是迁移链末张：完成后「同一个事实、六处读者」的路径收敛在三家仓各自成立。

注意（实施说明要点名）：03 与 04 之间这把锁处于预期红窗（spec D6 fail-visible 半迁移态；报错形态是 `expect()` / 文件不存在，易误判为「仓坏」）；本票完成后红窗闭合并做一次三仓收口复核。

**Blocked by:** 03（指针已前移、新路径在挂载点存在）

**Status:** ready-for-agent

- [ ] 锁路径指向契约 crate 源文件；`rg "packages/contracts"` 测试仓零命中
- [ ] 该锁在平台装配布局（R1 同场 / `repo_paths.rs` 路径解析口径）下 `cargo test` 全绿
- [ ] 收口复核：票 03 的五处读者、本票一处、能力仓源文件——六处一致；02→04 全链红窗已闭
