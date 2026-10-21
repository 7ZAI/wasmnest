# 01: 结构防复发锁——跨目录 `include!` 逃逸与 WIT 组合路径边界（平台仓铺垫件）

**What to build:**
平台根测试链（`pnpm run test:run`）新增一条**纯文件系统**的 node 测试锁，作为契约真源迁移票组（本目录 01→04）的第一件铺垫——它是唯一必须在**改造前**落地的件：迁移完成后「先红」证据无法复现。

锁的三类断言（判据细节见同目录 `spec.md` D5）：

1. 扫描面 = 平台仓 `packages/**/*.rs`（能力仓全部 crate，经 submodule 挂载读取）：凡 `include!` / `include_str!` 以相对路径引用、解析后**逃出该文件所属 crate 根目录** → 失败并点名文件；（crate 根判定 = 从该 `.rs` 向上找最近 `Cargo.toml`；无 crate 归属的散置 `.rs` 跳过）
2. `bindgen!` 的 `path:` 值解析后必须仍在所属 crate 内（spec D2 边界）；
3. 双端 `compose.json` 声明的每个 WIT 路径真实存在。

实施纪律（spec D5 + 本仓锁纪律）：

- **先红后绿**：开发期在**改造前**的树上先跑一次——未挂例外时必须红，且红点必须点名 `packages/wasmnest-wasm-core/src/contract.rs` 的那条跨目录 `include!`（当前**唯一**逃逸，其他 scan 面文件不得误伤）；输出摘录作为「锁跑红一次证明不空转」的证据记进本票交付说明。
- 随后以**显式登记例外**落绿：例外条目点名上述唯一既有逃逸，理由写「契约真源迁移在办（本票组 02→03），迁移完成时删除本例外」。
- **扫描面显性限定**：不扫平台宿主侧源码——桌面/移动宿主的 `bindgen!` 按设计绑端 SDK 生成物目录、本就逃出自身 crate，属合法形态，归 compose.json 路径校验管（spec D5 修订条目 7）。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 锁文件按 `scripts/*.test.mjs` 既有形态落地并纳入根 `pnpm run test:run`
- [ ] 改造前树上：未挂例外时锁红且点名 wasm-core 契约模块的唯一逃逸（输出摘录留票）；无其他文件被误点名
- [ ] 显式例外登记后锁绿——红绿双向 = 「锁跑红一次证明不空转」纪律达成
- [ ] `bindgen!` path 检查在能力仓当前 6 处绑定全过；双端 compose.json WIT 路径存在性全过
- [ ] 例外登记含「迁移完成后将由票 03 摘除」的明确措辞
