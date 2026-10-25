//! WebSocket Message Types
//!
//! 统一的业务消息类型，作为 WebSocket 客户端和服务端的业务传输类型
//!
//! # 票 04：信封协议退役（P3 / M3）
//!
//! 会话控制 / 终端输入 / 配置查询已迁桌面 HTTP 面，WS 上的业务 `Message`
//! 信封只剩**测试与协议级收尾**用途（`ws_protocol_integration` 的 legacy 场景
//! 驱动真实 WsClient→router→handler 链路）。本枚举裁剪为实际仍有消费者的
//! 变体：
//!
//! | 变体 | 保留理由 |
//! | --- | --- |
//! | `Auth` | `connect_and_pair` 等集成测试的 WS 首消息 JWT 认证（`AuthRequest`） |
//! | `SessionControl` | 集成测试的请求-响应匹配（`send_and_wait` + Ack 回包） |
//! | `Error` | codec 对 Close 帧 / 畸形帧的显性表达；`SystemHandler` 路由 |
//! | `ServerClosed` | 服务端主动断开通知（`SystemHandler`） |
//! | `Ack` | 请求-响应确认（`request_response` 按 `request_id` 匹配） |
//!
//! 已退役删除：`Terminal` / `SessionConfig` / `ClientDisconnected` /
//! `SessionEvent` / `SyncData`（WS 生产路径零使用；`rg Message::` 兜底见
//! `handler/plugin_event.rs` 结构锁）。

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::enums::auth::AuthPayload;
use crate::enums::control::{SessionControlAction, SessionControlPayload};

// ==================== Ack 响应代码常量 ====================

/// Ack 成功响应代码
pub const ACK_CODE_SUCCESS: u16 = 0;

/// Ack 失败响应代码 - 通用错误
pub const ACK_CODE_FAILURE: u16 = 1;

/// Ack 失败响应代码 - 认证失败
pub const ACK_CODE_AUTH_FAILED: u16 = 1001;

/// Ack 失败响应代码 - 会话不存在
pub const ACK_CODE_SESSION_NOT_FOUND: u16 = 1002;

/// Ack 失败响应代码 - 无效请求
pub const ACK_CODE_INVALID_REQUEST: u16 = 1003;

/// Ack 失败响应代码 - 操作超时
pub const ACK_CODE_TIMEOUT: u16 = 1004;

/// 生成唯一消息ID
pub(crate) fn generate_message_id() -> String {
    Uuid::new_v4().to_string()
}

/// 默认返回空字符串
fn default_token() -> String {
    String::new()
}

/// 统一的 WebSocket 消息类型
/// 作为 WebSocket 客户端和服务端的业务传输类型
/// 直接对应 JSON 序列化的结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum Message {
    // ==================== 业务消息类型 ====================
    /// 认证消息 (双向)
    #[serde(rename = "auth")]
    Auth {
        #[serde(default = "generate_message_id")]
        message_id: String,
        #[serde(default)]
        expect_response: bool,
        timestamp: i64,
        session_id: Option<String>,
        /// 认证令牌
        #[serde(default = "default_token")]
        token: String,
        payload: AuthPayload,
    },

    /// 会话控制消息 (双向)
    /// 会话生命周期管理：启动/停止/删除等
    #[serde(rename = "session_control")]
    SessionControl {
        #[serde(default = "generate_message_id")]
        message_id: String,
        #[serde(default)]
        expect_response: bool,
        timestamp: i64,
        session_id: Option<String>,
        /// 认证令牌
        #[serde(default = "default_token")]
        token: String,
        payload: SessionControlPayload,
    },

    /// 错误消息 (服务端 → 客户端)
    #[serde(rename = "error")]
    Error {
        /// 关联的消息ID（如果有）
        #[serde(skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        /// 是否需要服务端响应
        #[serde(default)]
        expect_response: bool,
        timestamp: i64,
        /// 认证令牌
        #[serde(default = "default_token")]
        token: String,
        code: String,
        message: String,
    },

    /// 服务端关闭通知 (服务端 → 客户端)
    /// 桌面端退出时通知所有移动端连接已断开
    #[serde(rename = "server_closed")]
    ServerClosed {
        /// 关闭原因
        reason: String,
        /// 是否会重连（目前桌面端退出后不会重连）
        will_reconnect: bool,
        /// 认证令牌
        #[serde(default = "default_token")]
        token: String,
    },

    /// 确认响应 (服务端 → 客户端)
    /// 当 expect_response=true 但 handler 无具体返回值时的默认响应
    /// 表示消息已收到并处理
    #[serde(rename = "ack")]
    Ack {
        /// 关联的请求消息ID
        request_id: String,
        /// 时间戳（毫秒）
        timestamp: i64,
        /// 响应代码：0 表示成功，非 0 表示失败
        /// 使用 ACK_CODE_* 常量
        code: u16,
        /// 可选的错误消息，失败时应提供
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        /// 认证令牌
        #[serde(default = "default_token")]
        token: String,
    },
}

// ==================== 辅助方法 ====================

impl Message {
    /// 创建会话控制消息
    pub fn session_control(action: SessionControlAction, session_id: Option<&str>) -> Self {
        Message::SessionControl {
            message_id: generate_message_id(),
            expect_response: false,
            timestamp: Utc::now().timestamp_millis(),
            session_id: session_id.map(|s| s.to_string()),
            token: String::new(),
            payload: SessionControlPayload { action },
        }
    }

    /// 创建会话控制消息（带响应期望）
    pub fn session_control_with_response(action: SessionControlAction, session_id: Option<&str>) -> Self {
        Message::SessionControl {
            message_id: generate_message_id(),
            expect_response: true,
            timestamp: Utc::now().timestamp_millis(),
            session_id: session_id.map(|s| s.to_string()),
            token: String::new(),
            payload: SessionControlPayload { action },
        }
    }

    /// 创建认证消息
    pub fn auth(session_id: Option<String>, payload: AuthPayload) -> Self {
        Message::Auth {
            message_id: generate_message_id(),
            expect_response: false,
            timestamp: Utc::now().timestamp_millis(),
            session_id,
            token: String::new(),
            payload,
        }
    }

    /// 创建错误消息
    pub fn error(code: &str, message: &str) -> Self {
        Message::Error {
            message_id: None,
            expect_response: false,
            timestamp: Utc::now().timestamp_millis(),
            token: String::new(),
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    /// 创建错误消息（关联到特定消息ID）
    pub fn error_with_id(message_id: &str, code: &str, message: &str) -> Self {
        Message::Error {
            message_id: Some(message_id.to_string()),
            expect_response: false,
            timestamp: Utc::now().timestamp_millis(),
            token: String::new(),
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    /// 创建服务端关闭消息
    pub fn server_closed(reason: &str, will_reconnect: bool) -> Self {
        Message::ServerClosed {
            reason: reason.to_string(),
            will_reconnect,
            token: String::new(),
        }
    }

    /// 创建确认响应消息（成功）
    /// 当 expect_response=true 但 handler 无具体返回值时使用
    pub fn ack(request_id: &str) -> Self {
        Message::Ack {
            request_id: request_id.to_string(),
            timestamp: Utc::now().timestamp_millis(),
            code: ACK_CODE_SUCCESS,
            message: None,
            token: String::new(),
        }
    }

    /// 创建确认响应消息（失败）
    pub fn ack_failure(request_id: &str, code: u16, message: &str) -> Self {
        Message::Ack {
            request_id: request_id.to_string(),
            timestamp: Utc::now().timestamp_millis(),
            code,
            message: Some(message.to_string()),
            token: String::new(),
        }
    }

    /// 获取消息ID
    pub fn message_id(&self) -> Option<&str> {
        match self {
            Message::Auth { message_id, .. } => Some(message_id),
            Message::SessionControl { message_id, .. } => Some(message_id),
            Message::Error { message_id, .. } => message_id.as_deref(),
            Message::ServerClosed { .. } => None,
            Message::Ack { .. } => None,
        }
    }

    /// 获取消息类型名称（用于调试日志）
    pub fn message_type(&self) -> Option<&'static str> {
        match self {
            Message::Auth { .. } => Some("auth"),
            Message::SessionControl { .. } => Some("session_control"),
            Message::Error { .. } => Some("error"),
            Message::ServerClosed { .. } => Some("server_closed"),
            Message::Ack { .. } => Some("ack"),
        }
    }

    /// 获取 expect_response 标记
    pub fn expect_response(&self) -> bool {
        match self {
            Message::Auth { expect_response, .. } => *expect_response,
            Message::SessionControl { expect_response, .. } => *expect_response,
            Message::Error { expect_response, .. } => *expect_response,
            Message::ServerClosed { .. } => false,
            Message::Ack { .. } => false,
        }
    }

    /// 获取 token
    pub fn token(&self) -> &str {
        match self {
            Message::Auth { token, .. } => token,
            Message::SessionControl { token, .. } => token,
            Message::Error { token, .. } => token,
            Message::ServerClosed { token, .. } => token,
            Message::Ack { token, .. } => token,
        }
    }

    /// 设置响应消息的关联 ID（用于请求-响应跟踪）
    /// 仅对支持响应关联的消息类型有效
    pub fn with_request_id(self, request_id: &str) -> Self {
        match self {
            Message::Auth {
                message_id: _,
                expect_response,
                timestamp,
                session_id,
                token,
                payload,
            } => Message::Auth {
                message_id: request_id.to_string(),
                expect_response,
                timestamp,
                session_id,
                token,
                payload,
            },
            Message::SessionControl {
                message_id: _,
                expect_response,
                timestamp,
                session_id,
                token,
                payload,
            } => Message::SessionControl {
                message_id: request_id.to_string(),
                expect_response,
                timestamp,
                session_id,
                token,
                payload,
            },
            Message::Error {
                message_id: _,
                expect_response,
                timestamp,
                token,
                code,
                message,
            } => Message::Error {
                message_id: Some(request_id.to_string()),
                expect_response,
                timestamp,
                token,
                code,
                message,
            },
            // 其他类型不支持设置 request_id，直接返回
            other => other,
        }
    }

    /// 设置 token
    pub fn with_token(self, token: &str) -> Self {
        match self {
            Message::Auth {
                message_id,
                expect_response,
                timestamp,
                session_id,
                payload,
                ..
            } => Message::Auth {
                message_id,
                expect_response,
                timestamp,
                session_id,
                token: token.to_string(),
                payload,
            },
            Message::SessionControl {
                message_id,
                expect_response,
                timestamp,
                session_id,
                payload,
                ..
            } => Message::SessionControl {
                message_id,
                expect_response,
                timestamp,
                session_id,
                token: token.to_string(),
                payload,
            },
            Message::Error {
                message_id,
                expect_response,
                timestamp,
                code,
                message,
                ..
            } => Message::Error {
                message_id,
                expect_response,
                timestamp,
                token: token.to_string(),
                code,
                message,
            },
            Message::ServerClosed {
                reason, will_reconnect, ..
            } => Message::ServerClosed {
                reason,
                will_reconnect,
                token: token.to_string(),
            },
            Message::Ack {
                request_id,
                timestamp,
                code,
                message,
                ..
            } => Message::Ack {
                request_id,
                timestamp,
                code,
                message,
                token: token.to_string(),
            },
        }
    }

    /// 序列化为 JSON
    pub fn to_json(&self) -> crate::Result<String> {
        Ok(serde_json::to_string(self)?)
    }

    /// 从 JSON 反序列化
    pub fn from_json(json: &str) -> crate::Result<Self> {
        Ok(serde_json::from_str(json)?)
    }

    /// 转换为 WebSocket 原生消息
    pub fn to_ws_message(&self) -> crate::Result<tokio_tungstenite::tungstenite::Message> {
        let json = self.to_json()?;
        Ok(tokio_tungstenite::tungstenite::Message::Text(json))
    }

    /// 从 WebSocket 原生消息转换
    pub fn from_ws_message(msg: tokio_tungstenite::tungstenite::Message) -> crate::Result<Option<Self>> {
        match msg {
            tokio_tungstenite::tungstenite::Message::Text(text) => Ok(Some(serde_json::from_str(&text)?)),
            tokio_tungstenite::tungstenite::Message::Binary(data) => {
                let text = String::from_utf8_lossy(&data);
                Ok(Some(serde_json::from_str(&text)?))
            }
            tokio_tungstenite::tungstenite::Message::Ping(_) => Ok(None), // 协议层心跳由 tungstenite 自动处理
            tokio_tungstenite::tungstenite::Message::Pong(_) => Ok(None),
            tokio_tungstenite::tungstenite::Message::Close(reason) => {
                // 注意：tungstenite 的 CloseFrame Display 会追加关闭码（"reason (code)"），
                // 这里只取 reason 字段，避免关闭码混入错误消息
                Ok(Some(Message::error(
                    "close",
                    &reason.map(|r| r.reason.to_string()).unwrap_or_default(),
                )))
            }
            tokio_tungstenite::tungstenite::Message::Frame(_) => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests;
