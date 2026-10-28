# ADR 0059：worker 机制管道语义（背压 / 事件直载 / 不复用 task 引擎）

worker 是插件内嵌的即用即弃纯计算 wasm 子资源（wasip2、零宿主 import、一线程
一 Store、用完即弃），双端机制，2026-10-28 grill 设计定稿（真源
`wasmnest-lib/.scratch/2026-10-28-worker-mechanism/spec.md`；实施票
`7ZAI/wasmnest-lib#10` / `#11` / `#12`）。以下三条管道语义是**刻意偏离 task
引擎现状**的决策，在此记录防「顺手统一」：

1. **调度器不复用 task 引擎，在 wasm-core 双端机制层新立。** task 域（v20）是
   桌面独有（能力仓 `permission.rs` 登记 + `manager/task.rs` 整在
   `desktop-assembly` 下），而 worker 双端都要；且 task 引擎「不接触
   WASM / Store」的边界声明因此**保持不变**。替代方案「把 task 引擎升格双端」
   被拒——把桌面独有域升为双端契约的连带面（词汇 / 权限 / 治理锁）远大于新立
   一个形状相似的小模块。

2. **回调队列满载走背压阻塞，不走 task 式丢弃。** task 引擎终态事件满载可丢，
   其权威兜底是 status 快照（「回调是尽力投递，status 是权威快照」）；worker
   事件**直载输出**（无结果暂存仓库，避免结果 GC），丢弃 = 结果永久丢失且无
   处找回。背压的阻塞上界 = 全局并发 8 条 worker 线程，guest 调用受燃料约束必
   终结 ⇒ 无死锁；代价仅是 Store 交付前不 drop（用完即关的延迟换正确性）。
   替代方案「结果暂存 + 回取 API」被拒——引入结果仓库生命周期与 GC 问题，
   恰是 task 有 status 快照、worker 没有的那块机器。

3. **取消不承诺强杀。** 内核看门狗只用 fuel（epoch 中断在 `engine.rs` 构建期被
   显性拒绝），一期 worker 零宿主 import、无阻塞 IO，标记取消 + 燃料自然终结
   即覆盖全部场景，与 task 审计票 09 裁决 B（不提供单元级抢占）同立场。
   preopen（文件 IO worker）落地时**必须重开墙钟超时议题**（epoch deadline 或
   WASI 层超时）——本条届时失效重评。
