//! tokio 任务 panic 防护：捕获并记录后台任务的 panic，避免静默崩溃
//!
//! 真源已拆到 `wasmnest-server-base::error_boundary`；本文件只保留 shim 路径。
//! 重要后台任务必须用 `spawn_with_error_boundary` 启动（错误必须带操作上下文，
//! 禁止裸 `?` 透传无上下文错误）。

pub use wasmnest_server_base::error_boundary::{
    spawn_os_thread, spawn_with_error_boundary, spawn_with_error_boundary_on,
};
