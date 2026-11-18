//! 移动插件系统入口：机制面转发垫片 + 宿主自持面
//!
//! 机制面（运行时 / 总线 / 存储 / 权限）在能力仓 wasm-core；本模块只保留
//! 移动端自持的 android 桥、SAF、加载器、管理器与域 adapter。
//!
//! **机制面真源**：能力仓单一 wasm-core `../wasmnest-lib/wasmnest-wasm-core`
//! （单形态，无 common/bare 之分）的统一机制面
//! （manager::runtime / host_api / bus / storage / security::fs_auth /
//! manager::{types,validation,downloader} / terminal_stream_gateway；
//! `wasmnest-wasm-core-mobile` 只是 package rename 别名，fork crate 已退役）
//! ——本模块对 `crate::plugin::*` 的历史路径做
//! 转发垫片（宿主既有 `crate::plugin::*` 引用零改动）；宿主自持面（android_plugins / saf_io /
//! saf_path / commands / loader / manager / registry / approval /
//! types / host_ports / peer_ports / bindings / 移动独有域 adapter
//! （notify / fs_mobile / terminal_stream / connection / auth））仍在宿主。
//! `fs_auth` 宿主自实现已退役（fs 授权统一到桌面判定链）——判定链与闸门类型统一取
//! wasm-core `security::fs_auth`。

pub mod android_plugins;
pub mod approval;
// 移动独有域 adapter（自带 bindgen + host-kit 自报）
pub mod auth;
pub mod bindings;
pub mod commands;
pub mod connection;
// 桌面兼容面桩（file-transfer 双端单产物：host-api-call / host-platform-desktop
// 的 fail-visible unsupported 实现，绑桌面 wit 的 desktop-compat world）
pub mod desktop_compat;
pub mod downloader;
pub mod fs_mobile;
// guest 事件契约面（events 导出派发；内核只留机制）
pub mod guest_events;
// core 12 域 WIT 实现（自 wasm-core `bare/host_impl` 迁入，
// 宿主自报 `mobile-host-core` 模块）
pub mod host_domains;
pub mod host_ports;
pub mod loader;
pub mod manager;
pub mod notify;
pub mod peer_ports;
pub mod registry;
pub mod saf_io;
pub mod saf_path;
pub mod terminal_stream;
/// 内网穿透（`host-tunnel`，T06）：端口 adapter + 开机装配
pub mod tunnel_ports;
pub mod types;
// 应用版本更新链路（GitHub Release 检查 / 校验下载；应用管理页与 SDK 默认实现共用）
pub mod updates;

// ==================== 机制面垫片（真源 = wasmnest-wasm-core，单形态） ====================

// 终端输出流窄转发表：真源随 host-terminal-stream 域迁入
// 移动宿主 `plugin/terminal_stream.rs`（同一路径即 `crate::plugin::terminal_stream`）。

/// 插件 KV 存储（主库 plugin_storage 表；crate Database wrapper 形状）
pub use wasmnest_wasm_core::storage;

/// 插件间消息总线（dispatcher async 形状）
pub mod message_bus {
    pub use wasmnest_wasm_core::bus::*;
}

/// 插件身份校验（目录名与 manifest id 一致性，防冒名）
pub use wasmnest_wasm_core::manager::validation;

/// WASM 运行时与 16 域 host 原语（Engine/Store/组件绑定/host_impl）
pub use wasmnest_wasm_core::manager::runtime as wasm_runtime;

// `wasm_host` 垫片已删除：它只 re-export 内核
// `host_api::sql_guard`（单条 `column_to_json`），而该垫片两侧均无消费者——域实现
// 直连共享核 `wasmnest-host-api-core::database`。出站 HTTP 执行已上移能力域 crate
// `wasmnest-server-http`（宿主命令面直接调用）。

pub use android_plugins::{asset_extractor_plugin, foreground_service_plugin};
pub use registry::builtin_manifests;
