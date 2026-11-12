# 代码注释与命名规范（四仓共享）

> **本文件是 `docs/public/`（四仓通用规范）的组成部分**；各仓 AGENTS.md 引用本文件，不复制。
> 与各仓 AGENTS.md 的硬约束同级别。语言侧细则（Rust 命令面 / 前端组件 / i18n）见各仓对应文档。

## 1. 注释

- 注释解释**为什么**（动机 / 取舍 / 坑），中文书写（技术术语保留英文）。
- 禁止用 spec / 票号 / issue 引用替代自解释——注释本身要能独立读懂。
- 改代码必须同步修正相关注释（含路径 / 符号名 / 计数声明 / 版本字面量）。
- 退役面 / 迁移的「墓碑」注释是**设计资产**：说明为什么退役的注释保留，不顺手删除。

## 2. 命名

- 组件 / 类：PascalCase；可组合逻辑：`use` 前缀 camelCase（composable）；普通函数与变量：camelCase / snake_case 随语言惯例。
- 文件名与导出一致；Rust 用 snake_case，模块入口文件与目录同名（`module.rs`），不用 `mod.rs`。
- 命名表达意图，不缩写到不可读；禁止用「临时 / tmp / _copy」等作交付名。

## 3. 语言侧细则指针

| 语言 / 面 | 细则真源 |
| --- | --- |
| Rust（后端） | 各仓后端文档（平台仓：`docs/backend.md`） |
| 前端（Vue / TS） | 各仓前端文档（平台仓：`docs/frontend.md` §5；应用仓：`docs/FRONTEND.md`） |
| 日志 / 结构化字段 | 平台仓 `docs/security.md` §2（`key = %value`，不拼消息字符串） |

## 4. 仓特有补充（各仓 AGENTS.md 覆盖本文件）

- 能力仓：注释 / 文档里**禁止写平台仓目录名与跨仓读取路径**（见 `wasmnest-lib/AGENTS.md` §6.5）；rustfmt 列宽以 crate 根 `rustfmt.toml` 为准，不跨 crate 统一重排。