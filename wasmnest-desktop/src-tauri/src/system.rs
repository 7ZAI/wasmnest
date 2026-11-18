//! 桌面宿主系统基础设施：全局上下文、常量、错误类型、电源与生命周期钩子
//!
//! `constants` / `error` / `error_boundary` 是迁移后的路径 shim（真源在
//! `wasmnest-server-base`）；保留 `crate::system::*` 让宿主其余引用零改动。
//!
//! **整核抽出**：`config`（AppConfig，引擎级配置）、`opener`（文件定位）已迁入
//! `wasmnest-wasm-core` crate（`process` 垫片已随无消费者退役，2026-10-10，真源
//! `wasmnest-server-base::process` 由
//! `system/wsl.rs` 与 pty-engine 直连）；本文件保留 `crate::system::*` 路径
//! （`pub use` 垫片）。
//! 组合根（`app_context`）与 lib 侧 shim（`constants` / `error` /
//! `error_boundary`）原样保留。

pub mod app_context;
pub mod appearance;
pub mod constants;
pub mod error;
pub mod error_boundary;
pub mod info;
pub mod lifecycle;
pub mod logging;
pub mod power;
pub mod power_wake;
// 退出协调器：优雅关闭（有界）→ 正常退出 → 超时强制退出（2026-11-05）
pub mod shutdown;
// 宿主进程 / WebView 进程指标（`host-metrics.snapshot` 的 `process` 段）——
// 「整个 wasmnest 占多少内存 / CPU」只能按 OS 进程树算（按父子链归属，不靠进程名猜）
pub mod process_metrics;
// WSL 发行版列举（host-platform-desktop.wsl-distros 的支撑；v36 交集接口切片自
// wasm-core `system/wsl.rs` 迁入——桌面平台语义，内核不再持有）
pub mod wsl;

// 迁入 crate 的引擎面：经垫片保留 `crate::system::{config,opener}::*` 路径
pub use wasmnest_wasm_core::system::{config, opener};

pub use app_context::AppContext;
pub use config::AppConfig;
pub use error::{AppError, Result};
pub use error_boundary::spawn_with_error_boundary;
pub use info::SystemInfo;
pub use lifecycle::lifecycle_registry;
pub use power::power_manager;
pub use power_wake::spawn_wake_monitor;
