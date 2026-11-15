//! 桌面宿主错误类型与跨进程错误信封（真源已拆到 `wasmnest-server-base::error`）
//!
//! 本文件只保留模块路径与全部公开名字，宿主其余代码经 `crate::system::error::*`
//! 引用不受影响；`AppError` / `Result` / 事件信封的共享语义由
//! `wasmnest-server-base::error` 定义。
//!
//! 桌面专属：错误信封 `{ code, request_id, params? }`——跨进程失败只暴露结构化
//! 字段，技术详情（原文 / anyhow 链 / 堆栈）**永不出产生方进程**；移动端走自己
//! 的 `wasmnest-wasm-core::error`，两端形状各自演进，不共用同一份实现。

pub use wasmnest_server_base::error::{new_request_id, AppError, EventEnvelope, Result, DEFAULT_ERROR_CODE};
