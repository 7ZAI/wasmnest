//! 应用启动装配：模块声明与对外入口再导出
//!
//! 模块入口按仓规用与目录同名的 `bootstrap.rs`（不用 `mod.rs`），且**只放声明与
//! 再导出**：实现分住 `bootstrap/` 下的 run（启动主流程）、logging（日志接线）、
//! tray（托盘）、frontend_channel（前端通道会话钩子）、context_menu（Linux 原生
//! 右键菜单抑制）及各自单测。`run` / `run_with` 经 lib.rs 再导出，外部路径
//! `wasmnest_desktop_lib::run{,_with}` 不变。

mod context_menu;
mod frontend_channel;
mod logging;
mod run;
mod tray;

// Linux 原生右键菜单抑制去重单测（私有项只能留 crate 内）
#[cfg(all(test, target_os = "linux"))]
mod context_menu_test;

// `run_with` 的插件目录注入单测（私有 fn 只能留 crate 内；不启动 Tauri）
#[cfg(test)]
mod run_with_test;

pub use run::{run, run_with, AppStartTime};
