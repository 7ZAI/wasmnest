# Rust / 后端规范

> **本文件是 `AGENTS.md` 的拆分文档（后端 / Rust 规范）**：Rust 命名与错误处理、Tauri Command 纪律、调试面门控、注释与命名（后端面）。
> 本文件与 `AGENTS.md` 的硬约束**同级别**。**通用注释 / 命名规范真源 = `docs/public/commenting.md`（四仓共享，不在此复制）**；测试规范见 `docs/testing.md`；安全 / 日志见 `docs/security.md`。

## 1. Rust

- 文件与模块命名：snake_case，模块入口文件与目录同名（`module.rs`），不用 `mod.rs`（通用命名规则另见 docs/public/commenting.md §2）。
- 统一错误类型 `AppError`；错误构造 / 转换处必须带操作描述，**禁止裸 `?` 透传无上下文错误**；`tokio::spawn` 用 `spawn_with_error_boundary()` 包装；重要路径禁止 `let _ =` 静默忽略。
- panic hook 内只用 `eprintln!`，禁止 `tracing::error!`（日志红线见 docs/security.md §2）。
- Tauri Commands：`list_*` / `get_*` / `create_*` / `delete_*` / `start_*` / `stop_*` 命名，用 `// ====================` 分隔注释按领域分组；**注册面变更要跑命令注册锁**（桌面 `lifecycle_command_registration_lock`、移动 `command_registration_completeness_lock`）。
- 调试专用命令面必须 `#[cfg(debug_assertions)]` 门控（如 desktop `bench_channel`、wdio 插件注册等），并有锁证明 release 不含（如 `bench_channel_surface_stays_debug_only`）。

## 2. 注释、命名与 i18n（后端面）

- **注释规则（解释为什么 / 中文 / 禁票号引用 / 同步修正）与命名规则的通用部分真源 = `docs/public/commenting.md`**——本端只补充平台特有增量：Vue 组件 / 目录结构跟随既有双端的同构惯例（前端面细则见 docs/frontend.md §5）。
- 结构化日志字段（`session_id` / `device_id` / `plugin_id` / `request_id` / `batch_id` / `node_id` 等）一律 `key = %value`，**禁止拼进消息字符串**；错误信息必须带操作上下文（docs/security.md §2）。