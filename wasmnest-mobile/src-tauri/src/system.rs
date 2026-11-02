//! System Module
//!
//! 系统级功能 - 错误处理、配置管理、设置存储、共享命令

pub mod commands;
pub mod config;
pub mod constants;
pub mod error;
pub mod error_boundary;
pub mod info;
pub mod logging;
// 宿主进程指标（`host-metrics.snapshot` 的 `process` 段）：移动端只覆盖本进程
// （WebView 渲染进程在 webview_zygote 下、跨 uid 不可读），见文件头
pub mod process_metrics;
pub mod settings;
pub mod shell_ui;

pub use config::AppConfig;
pub use error::{AppError, Result};
