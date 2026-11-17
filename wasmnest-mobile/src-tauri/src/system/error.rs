//! 错误类型：宿主经本模块 re-export 单一 wasm-core 的 `AppError` / `Result`
//!
//! 真源 = `wasmnest-wasm-core::error`（单形态，无 common/bare 之分；
//! `wasmnest-wasm-core-mobile` 只是历史 package rename 别名）。
//!
//! 宿主侧经本模块 re-export 保 `crate::system::error::AppError` /
//! `crate::AppError` 历史路径零改动。移动 `AppError` 形状与早期 fork 对齐；
//! 原 `Pty` 变体随迁移退役（全仓零构造点，死变体清理）。

pub use wasmnest_wasm_core::error::{AppError, Result};
