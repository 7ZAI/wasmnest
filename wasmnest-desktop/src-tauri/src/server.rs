//! 桌面宿主 HTTP / WS 传输面壳：组合根、端口实现、边界锁与宿主交互
//!
//! Actix-web 服务器本体、HTTP / WebSocket 两个传输面与对等网络引擎住能力 crate；
//! 本目录只保留宿主壳职责（组合根 / 端口实现 / 边界锁 / 端口占用交互 / 命令壳）。
//!
//! 传输无关内核（生命周期 / 流量过滤链 / 链路加密 / 指标 / 组合装配）、两个传输面
//! （HTTP / WebSocket）与对等网络引擎域均已抽为独立 crate
//! （`../wasmnest-lib/wasmnest-server-core` / `-http` / `-websocket` / `-peer-net`），宿主侧不再有
//! `server::core` / `server::http` / `server::websocket` / `server::peer_net` 模块；
//! 本目录只剩宿主壳职责：组合根（`composition`：把两个面的 face 交给内核 `serve`、
//! 并持有全局端口注册表的**唯一**装配点）、端口实现（`ports_impl`）、crate 边界锁
//! （`crate_boundary_lock`：宿主侧才看得见六份清单的全图断言）、宿主端口占用交互
//! （`host_port`）与 peer-net 的 Tauri 命令壳（`peer_net_cmds`——引擎实现在
//! `wasmnest-server-peer-net`，只经 `PeerCtx` 通信）。

pub mod composition;
#[cfg(test)]
pub(crate) mod crate_boundary_lock;
pub mod host_port;
pub mod peer_net_cmds;
pub mod ports_impl;
