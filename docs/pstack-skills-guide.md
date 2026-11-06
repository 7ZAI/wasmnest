# pstack 技能使用教程

> pstack 是 Poteto（Cursor / React core）开源的一套工程技能集，核心哲学：**先深后快，写更少但更高质量的代码**。
> 本教程按「场景 → 用哪个技能」组织，附触发方式与组合建议。
> 安装位置：`~/.agents/skills/<name>/SKILL.md`（软链进 `~/.pi/agent/skills/`）。
> 已装 18 个（精选核心集）+ 既有 `tdd`。完整 61 个见 https://github.com/backnotprop/pstack

---

## 一、理解代码 / 决策（动手前）

| 场景 | 技能 | 触发方式 |
|---|---|---|
| 「X 是怎么工作的？」改代码前先摸清运行流程、分层归属 | **how** | `/how 这个 session 调度是怎么跑的` |
| 「为什么当初这么设计？」设计取舍、回归、复盘、要数据支撑的阈值 | **why** | `/why 为什么用 path 依赖而不是 workspace` |

- **how** = 讲运行时行为、架构心智模型（横向：它怎么运作）
- **why** = 讲动机与证据，会并行查 git / issue / 文档 / chat / 可观测性并给引用（纵向：为什么这样）
- 两者常配对：`why` 依赖 `how`。先 `how` 摸清现状，再 `why` 挖决策。

## 二、设计与规划（写代码前定形状）

| 场景 | 技能 | 触发方式 |
|---|---|---|
| 非平凡任务，直接写代码会锁死错误形状 → 先画类型 / 签名 / 模块结构 | **architect** | `/architect 设计这个缓存层` |
| 任务方向对但要**更深不要更大** → 重写 prompt | **sharpen** | `/sharpen` |
| 一个方案容易锁死 → 并行生成 N 个候选，取最优再嫁接败者的精华 | **arena** | `/arena 这个解析器设计` |
| 没有现成 playbook 的大工程（大迁移、多阶段、人要离开后 review）→ 设计可审计的作战手册 | **figure-it-out** | `/figure-it-out 把 x 从 A 迁到 B` |

- **architect** 是日常主力；**arena** 用在「一次尝试会锁死形状」的高风险设计上（依赖 arena/how）。
- **sharpen** 不是扩大范围，是把任务**做深**——适合需求偏表面时。
- **figure-it-out** 是大工程兜底 playbook，自带假设循环和决策日志。

## 三、实现（写代码）

| 场景 | 技能 | 触发方式 |
|---|---|---|
| 测试先行建功能 / 修 bug，red-green-refactor | **tdd** | `/tdd 给这个函数补测试再实现` |
| 读 / 改任何 `.ts` / `.tsx` 文件 | **typescript-best-practices** | 自动（编辑 TS 时） |

## 四、验证与风险（交付前）

| 场景 | 技能 | 触发方式 |
|---|---|---|
| 一个小 diff 你不放心 → 找出 diff 之外可能被打破的地方，并用**跑真代码**证明安全 | **blast-radius** | `/blast-radius 这个改动` |
| 对抗式评审，找盲点，只有跑通的发现才算数 | **interrogate** | `/interrogate 这段并发逻辑` |
| 状态流转的系统（协议 / 产品流 / 服务）→ 建 TLA+ 模型，画 Mermaid 状态图，给违反规则的最短路径 | **statechart** | `/statechart 这个连接状态机` |

- **blast-radius** = 「这改动会波及哪」（防御性、局部）
- **interrogate** = 「派对手 try 弄坏它」（进攻性、找盲点）
- **statechart** = 状态机 / 协议正确性，能直接指出哪个状态违反不变量

## 五、并行与规模化

| 场景 | 技能 | 触发方式 |
|---|---|---|
| 扇出 N 个并行 worker 干同类活（覆盖、压测、探索），汇总成一份报告 | **swarm** | `/swarm 给这 20 个模块各写单测` |

- **swarm** = 并行覆盖 / 竞速 / 探索，返回一份报告
- **arena** = 并行**同一任务**的 N 个候选，选优嫁接（设计阶段）
- 区别：swarm 是「分头干不同子任务」，arena 是「分头干同一个任务比谁好」

## 六、写作与沟通

| 场景 | 技能 | 触发方式 |
|---|---|---|
| 去掉 AI 腔，让文字像人写的 | **unslop** | `/unslop 这段 README` |
| 把上一条消息用大白话复述，去掉行话 | **bro** | `/bro` |
| 写 / 审文档、RFC、README、PR 描述、commit message（Diátaxis + Google 风格 + STE + 全球英语） | **technical-writing** | `/technical-writing 写个 PR 描述` |

- **unslop** 是 `technical-writing` 的依赖，专治 AI 味。
- **bro** 最轻，随时喊一句让你把复杂结论讲成人话。

## 七、元技能（改进 pstack 自身 / 长任务留痕）

| 场景 | 技能 | 触发方式 |
|---|---|---|
| 长任务 / 无人值守跑，留一条可 review 的决策轨迹（每行：做了啥/为啥/证据/结果） | **show-me-your-work** | `/show-me-your-work` |
| 从当前会话沉淀经验，路由成对现有技能的具体修改 | **reflect** | `/reflect` |
| 找出 agent 在本仓反复犯的错，从架构→类型→lint→测试逐层让它「不可能再犯」 | **correct** | `/correct` |
| 不知道用哪个技能 / 怎么配 pstack | **poteto-help** | `/poteto-help 我该用哪个` |

---

## 推荐组合（按任务类型）

- **改陌生代码**：`how` →（必要时）`why` → `architect` → `tdd` → `blast-radius`
- **高风险设计**：`sharpen` → `arena` → `architect` → `interrogate`
- **大迁移 / 多阶段**：`figure-it-out` + `show-me-your-work` → `swarm` 并行 → `interrogate` 收口
- **状态机 / 协议**：`statechart` → `interrogate`
- **写对外文档**：`technical-writing`（自带 unslop）→ `bro` 复核可读性
- **修完一个反复犯的错**：`correct`

---

## 备注

1. **新技能需重启 pi 会话**才会进可加载列表（技能在会话启动时扫描）。
2. 这些技能**以完整 agent 权限运行**，首次用某个前建议扫一眼它的 `SKILL.md` 确认行为符合预期——尤其 `swarm` / `arena` / `interrogate` 会派子 agent、消耗较多 token。
3. 想补装重型编排那套（`poteto-mode` + 23 个 playbook + 全部 `principle-*`）或单个技能（如 `teach`、`ketchup`）：
   `npx skills add backnotprop/pstack --skill <name> --agent pi -g -y`