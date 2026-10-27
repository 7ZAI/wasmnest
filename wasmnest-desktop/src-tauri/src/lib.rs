//! WasmNest Desktop - Library Entry Point

// ==================== Domain Modules ====================

// 应用启动装配（run / run_with / 日志接线 / 托盘 / 右键菜单抑制）——私有项单测
// 随迁 bootstrap/（context_menu_test / run_with_test），crate 内私有项测试口径不变。
mod bootstrap;
pub mod commands;
// 第一方免弹窗归属清单（产品数据真源，票 08/P0-2；判定逻辑在 wasm-core）
pub mod first_party_dirs;
// 宿主侧插件能力面（能力域端口 adapter / 强制引用行 / 白名单条目同处）——
// 票 02 批次 02 起：域实现搬进 `packages/` 能力 crate 后，宿主侧的接线落这里
pub mod plugin;
pub mod server;
pub mod system;
pub mod utils;

// ==================== 整核抽出垫片（wasm-core-whole-crate） ====================
// wasm_core / db / pty 已迁入 `wasmnest-wasm-core` crate（.scratch/
// 2026-10-06-wasm-core-whole-crate/spec.md）；以下 `pub use` 垫片保持既有
// `crate::wasm_core::*` / `crate::db::*` 路径零改动编译通过（spec §4.3 D3）。
// 反双份锁见 tests/（整核抽出结构锁）。`enums` 垫片已随无消费者整体退役
// （2026-10-10：真源在 SDK `wasmnest-plugin-api::wire`）。
//
// **`pty` 不在再导出名单里**：host-pty 能力域（引擎 + WIT 接线 + 域机制）已整面迁到
// `wasmnest-pty-engine`（pty-capability-domain 票 D1/D3），内核不再有 PTY 面可垫；
// 调用点一律写显式路径 `wasmnest_pty_engine::plugin_binding::*`。宿主侧端口 adapter
// 自票 02 批次 02 起落 `crate::plugin::pty`（原 wasm-core `host_api/pty.rs`）。
pub use wasmnest_wasm_core as wasm_core;
pub use wasmnest_wasm_core::db;

// 桥接基准工程的 Channel 传输面（**仅 debug 构建**：release 产物不含本命令面，
// 闸门锁见本模块 tests::bench_channel_surface_stays_debug_only）
#[cfg(debug_assertions)]
mod bench_channel;

// ==================== Re-exports ====================

pub use bootstrap::{run, run_with, AppStartTime};
pub use system::{AppConfig, AppContext, AppError, Result};
