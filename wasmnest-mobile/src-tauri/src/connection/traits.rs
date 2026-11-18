//! 消息处理契约：移动端**真正在用**的 trait 与消息类型
//!
//! 服务端框架那套泛型契约（客户端表 / 鉴权态 / 重试 / 拦截器）已清理——移动端是
//! 纯 WS 客户端，那些 trait 没有实现方。
//!
//! 历史背景（2026-10-11 清理）：本文件曾携带一整套泛型服务端框架
//! ——`ClientInfoTrait` / `MessageHandlerWithClientInfo` / `ClientMessageHandler`
//! / `SendStrategy`（含重试策略）/ `SendInterceptor`（含日志与指标拦截器）/
//! `ResponseHandler`。这些是为「本端作为 WS 服务端、持有客户端表与鉴权态」设计的。
//! 移动端是纯 WS 客户端（客户端与服务端契约各自独立演进，移动端不
//! 持有入站连接表、不做服务端鉴权），故该框架按设计即无实现方——其中
//! `MessageHandlerWithClientInfo` 甚至自带 `#[allow(dead_code)]` 与「此 trait
//! 目前未使用」的注释。它们唯一的引用是 `connection.rs` 的 re-export 行本身，
//! 即零消费者。
//!
//! 一并删净的理由：死代码在本仓库会漂移。带 `#[allow(dead_code)]` 的抽象看起来
//! 「留着以后会用」，实际每次读它的人都要重新判断它是否可用，而判断结果恒为
//! 不可用。需要服务端能力时从 `../wasmnest-lib/wasmnest-wasm-core` 或桌面端取，而非
//! 在客户端 crate 里养一份无实现的骨架。

use std::net::SocketAddr;

use crate::model::message::Message;
use crate::Result;

/// 消息处理结果类型
pub type HandlerResult = Result<Option<Message>>;

/// 简化的消息处理器 trait（用于 default_handler）
/// 不需要泛型 ClientInfo，直接处理原始 WebSocket 消息
pub trait MessageHandler: Send + Sync {
    /// 处理接收到的 WebSocket 消息
    ///
    /// `raw_message` 是原始帧（Text / Binary）；`addr` 是对端地址（移动端恒为
    /// 桌面端）；`client_id` 只在已认证时存在；`sender` 用于异步回包。
    fn handle(
        &self,
        raw_message: tokio_tungstenite::tungstenite::protocol::Message,
        addr: SocketAddr,
        client_id: Option<&str>,
        sender: Option<tokio::sync::mpsc::Sender<tokio_tungstenite::tungstenite::protocol::Message>>,
    );
}
