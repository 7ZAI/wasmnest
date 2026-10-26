//! host-websocket 客户端/服务端/隔离端到端（ABI v14）
//!
//! **wasm-core 纯净性收口票 05c（2026-10-06）迁入宿主侧**：原
//! `manager/runtime/tests/ws_e2e.rs`。脚手架经 `wasmnest_wasm_core::test_support`；
//! HTTP 服务器起生产 `wasmnest_desktop_lib::server::composition::start_http_server`
//! （wasm-core 内 `cfg(test)` 的 `host_harness` 是同一薄壳，lib 侧用生产入口）。

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

#[path = "../support/mod.rs"]
mod support;
use support::*;

use wasmnest_desktop_lib::wasm_core::test_support::{
    lock_auth_center_desk, plugin_db_root, session_plugin_db_guard, TestInstanceDispatcher,
};
// 夹具产物读取面与会话 api 清单（票 08 批次三：住宿主测试 support，不再经内核 re-export）
use support::{sdk_fixture_artifact_bytes, session_apis};
// `setup_wasm_runtime` 由 `support::*` 提供（宿主包装：注入 DesktopGuestEvents +
// DesktopHostFacts）；内核 test_support 的同名入口不注入派发器，误用会让
// `events` 投递走 UnwiredGuestEvents 而失败——勿把内核同名项加回上面的显式列表。
use wasmnest_desktop_lib::wasm_core::host_api::topics::{
    ws_event_topic, WS_CLIENT_CONNECT, WS_CLIENT_DISCONNECT, WS_CLOSE, WS_OPEN,
};

/// 读下一条**非事件广播**帧（2026-09-26：session-control 端点现承载 WS 事件广播
/// ——session:created / stopped / removed 事件帧会抢在动作回显前到达，收动作回包
/// 必须跳过 `{"type":"event",...}` 广播帧；心跳帧照旧跳过），超时返回 `None`
async fn ws_client_recv_action(
    client: &mut WsTestClient,
    timeout: std::time::Duration,
) -> Option<tokio_tungstenite::tungstenite::Message> {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match tokio::time::timeout(remaining, client.next()).await {
            Ok(Some(Ok(msg))) => match msg {
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
                Message::Text(text) => {
                    // 事件广播帧：跳过（动作回显/响应帧的 `type` 是动作名，非 event）
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        if v.get("type").and_then(|t| t.as_str()) == Some("event") {
                            continue;
                        }
                    }
                    return Some(Message::Text(text));
                }
                other => return Some(other),
            },
            _ => return None,
        }
    }
}

mod client_server;
mod endpoints;
