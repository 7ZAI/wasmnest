# Issues 管理（GitHub Issues = 跨会话存续 backlog 的真源）

> **四仓共享**。任何**跨会话存续**的工作（任务 / 缺陷 / 契约变更 / 待用户裁决项）一律以 **GitHub Issues** 为真源：
> 可寻址（`owner/repo#n`）、跨仓引用（`7ZAI/wasmnest-lib#n`）、随仓库走、agent 可经 `gh` CLI 直接读写。
> 会话内的临时事项**不进 issue**——那是 SCRATCHPAD / daily 日志的活。

## 1. 三层分工（先判断「这件事放哪层」）

| 层 | 载体 | 放什么 | 不放什么 |
| --- | --- | --- | --- |
| 会话内 | 本地 SCRATCHPAD / daily 日志 | 进行中的小 TODO、验证记录、运行注意事项、已解决的教训 | 跨会话存续的事 |
| 决策 | MEMORY / ADR / docs | 「为什么这么定」的结论 | 待办本身 |
| **存续 backlog** | **GitHub Issues** | 跨会话要做的事、缺陷、契约变更、待用户裁决项 | 会话内当天做完的事 |

**提升规则（进 issue 的判据，命中任一即提升）**：

- 跨会话存续（今天做不完、下周还要捡起来）；
- 跨仓联动（改动涉及 ≥2 仓 / 契约 / manifest tag 重钉）；
- 需要外部可寻址（issue 编号被 commit / 文档 / 另一个 agent 会话引用）。

**禁止进 issue**：会话内小事项、已解决的教训（留 daily 日志）、纯决策记录（留 ADR / MEMORY）。
**宁可少开**：开之前先问「这个值得一个编号吗？」；scratchpad 里的项一旦迁入 issue，原条目勾除并指向 issue 编号。

## 2. 落仓规则（issue 开在哪个仓？）

- **主体改动落哪个仓 → issue 开哪个仓**（按真源原则，与代码归属一致）；
- 跨仓契约（WIT / ABI / wire / 权限）→ 开在**真源仓**（能力仓 lib）；
- 需平台侧联动（manifest tag 重钉 / 治理锁）→ 平台仓开**协调 issue**，正文逐个点名涉及的仓与子任务，子仓 issue 用 `7ZAI/wasmnest-lib#n` 交叉引用；
- 测试门禁类（夹具 / `#[ignore]` 场景 / 锁标定）→ 测试仓。

## 3. 模板与字段（agent 可解析）

各仓 `<仓根>/.github/ISSUE_TEMPLATE/{bug,feature,contract-change}.yml`（GitHub Issue Forms）。关键字段必填（`validations.required`），暂缺内容写「待补」而不是删字段——agent 按字段干活。

- **bug**：现象 / 复现步骤 / 期望 vs 实际 / 平台与契约版本（`@wasmnest:plugin@x.y.z`、WIT tag）/ 相关锁与命令 / 已知线索；
- **feature**：需求 / **归属裁决**（平台仓：宿主薄壳 B1–B6 + 三问；能力仓：§3.5 三问；应用仓：app slug）/ 验收条件；
- **contract-change**：变更内容（WIT/ABI/wire/权限）/ 真源仓与版本 / 双端影响评估 / bump 与重拼核对项 / 需同步的锁。

## 4. 标签与里程碑

- 标签（四仓统一，**不新增**）：`kind:bug` / `kind:feature` / `kind:contract` / `kind:chore` / `cross-repo`——多标签 = 噪音。
- 里程碑 = **下一个发布 tag**（平台 `v0.1.0` / 能力 `lib-v0.1.0` / 应用 `apps-v0.1.0` / 测试 `test-v0.1.0`），与 `versioning.md` 联动：只有发布时才定里程碑 / bump，issue 里写的计划版本是显示语义，不构成 bump 承诺。

## 5. 关门纪律

- 提交用 `fixes #n` / `closes #n`，合并即自动关；做不到就手动关并留一句「如何验证」；
- **关闭 ≠ 删除上下文**：把「结论 / 为什么不做 / 验证结果」写进 issue 最后一条评论再关；
- 退役 / 不做（fail-visible）：写「不做 + 理由 + 出路」再关，禁止静默消失；
- 跨仓 issue 收口时，在协调 issue 上逐项点名各仓子任务完成情况。

## 6. agent 操作约定

- 开会话时先 `gh issue list -R 7ZAI/<repo>`（或按用户点名 issue）认领存续 backlog；
- 发现跨会话存续事项**主动提议**建 issue（不擅自批量建，先问用户）；
- issue 正文按模板字段写，保证另一个会话的 agent 不读原上下文也能接手；
- 已迁入 issue 的 scratchpad 条目勾除（[x]），不再双重维护。