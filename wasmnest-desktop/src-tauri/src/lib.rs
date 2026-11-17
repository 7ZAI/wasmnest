//! WasmNest 桌面宿主库入口：域模块声明 + 启动入口与历史路径的再导出
//!
//! 启动装配在 `bootstrap/`（run / 日志接线 / 托盘 / 前端通道钩子 / Linux 原生右键
//! 菜单抑制）与各域模块；本文件只做声明与再导出，保持
//! `wasmnest_desktop_lib::run{,_with}` 以及 `wasm_core` / `db` 等历史路径不变。
//! 下方的整核垫片让已迁入能力 crate 的内核面仍可按旧路径引用，**不构成**新的宿主
//! 依赖方向（真源在 `wasmnest-wasm-core`）。

// ==================== 域模块 ====================

// 应用启动装配（run / run_with / 日志接线 / 托盘 / 右键菜单抑制）——私有项单测
// 随迁 bootstrap/（context_menu_test / run_with_test），crate 内私有项测试口径不变。
// 模块入口 `bootstrap.rs` 只做声明 / 再导出，实现在 `bootstrap/` 各子模块。
mod bootstrap;
pub mod commands;
// 第一方免弹窗归属清单（产品数据真源；判定逻辑在 wasm-core）
pub mod first_party_dirs;
// 宿主侧插件能力面（能力域端口 adapter / 强制引用行 / 白名单条目同处）——
// 域实现搬进 `packages/` 能力 crate 后，宿主侧的接线落这里
pub mod plugin;
// 应用版本更新链路（GitHub Release 检查 / 校验下载；安装复用 api_bridge 升级模式）
pub mod plugin_updates;
pub mod server;
pub mod system;
pub mod utils;

// ==================== 整核抽出垫片 ====================
// wasm_core / db 已迁入 `wasmnest-wasm-core` crate；以下 `pub use` 垫片保持既有
// `crate::wasm_core::*` / `crate::db::*` 路径零改动编译通过。
// 反双份锁见 tests/（整核抽出结构锁）。`enums` 垫片已随无消费者整体退役
// （2026-10-10：真源在 SDK `wasmnest-plugin-api::wire`）。
//
// **`pty` 不在再导出名单里**：host-pty 能力域（引擎 + WIT 接线 + 域机制）已整面迁到
// `wasmnest-pty-engine`，内核不再有 PTY 面可垫；调用点一律写显式路径
// `wasmnest_pty_engine::plugin_binding::*`。宿主侧端口 adapter 落
// `crate::plugin::pty`（原 wasm-core `host_api/pty.rs`）。
pub use wasmnest_wasm_core as wasm_core;
pub use wasmnest_wasm_core::db;

// 桥接基准工程的 Channel 传输面（**仅 debug 构建**：release 产物不含本命令面，
// 闸门锁见本模块 tests::bench_channel_surface_stays_debug_only）
#[cfg(debug_assertions)]
mod bench_channel;

// ==================== Re-exports ====================

pub use bootstrap::{run, run_with, AppStartTime};
pub use system::{AppConfig, AppContext, AppError, Result};
