//! Connection Module - WebSocket Connection Management
//!
//! 职责：管理 WebSocket 连接建立、断开、重连逻辑
//! 与 IO 模块分离：只负责 TCP/TLS 握手，不处理消息收发

use crate::connection::lifecycle::{ConnectionStatus, LifecycleManager};
use crate::Result;
use std::sync::Arc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::protocol::Message as WsMsg;
use tracing::{debug, error, info, warn};
use wasmnest_link_crypto::{
    b64_decode, generate_ephemeral, parse_negotiation, ClientWsCrypto, NEGOTIATION_HEADER, PROTOCOL_VERSION,
    WS_PLUGIN_CHANNEL, WS_POLICY_HEADER, X25519_KEY_LEN,
};

use crate::system::constants::connection::{
    DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_HEARTBEAT_INTERVAL_SECS, DEFAULT_MESSAGE_QUEUE_SIZE, WS_DEFAULT_PATH,
};

/// WS 帧级链路加密握手产物（`None` = 明文会话）
pub(crate) type SharedWsCrypto = Arc<std::sync::Mutex<ClientWsCrypto>>;

/// 一次建连的升级期提案（临时私钥 + 已 pin 的桌面身份公钥）
struct WsCryptoOffer {
    ephemeral_private: [u8; X25519_KEY_LEN],
    ephemeral_public_b64: String,
    /// `None` = pin 损坏：提案照发（显性失败），不静默退回明文
    pinned_kd: Option<[u8; X25519_KEY_LEN]>,
    strict: bool,
}

impl WsCryptoOffer {
    /// 是否随升级提案：**只看是否已 pin**，不看移动端全局加密开关。
    ///
    /// 事件通道是宿主 ↔ 桌面的控制面，桌面对端应用的策略可能固定 `required`；
    /// 移动端全局开关（主要面向 HTTP 信封）若关着就不提案，会让这条通道在
    /// `required` 下必然 400。提案本身不改变安全下限：服务端策略 `off` 会回绝，
    /// 非 strict 模式继续明文；配对后已有 pin 时提案总是更安全的选择。
    fn from_context() -> Option<Self> {
        let ctx = crate::state::get_link_crypto_context();
        let Some(kd_raw) = ctx.kd_public_b64.as_deref() else {
            // 未配对（无信任锚）无法提案：required 服务端会在升级期拒绝，
            // 客户端拿到的是连接失败而不是静默明文。
            return None;
        };
        let pinned_kd = match b64_decode(kd_raw) {
            Ok(raw) => raw.try_into().ok(),
            Err(error) => {
                tracing::error!(%error, "event ws link crypto: pinned key is not valid base64");
                None
            }
        };
        if pinned_kd.is_none() {
            tracing::error!("event ws link crypto: pinned key has invalid length (expect 32 bytes)");
        }
        let (ephemeral_private, ephemeral_public) = generate_ephemeral();
        Some(Self {
            ephemeral_private,
            ephemeral_public_b64: wasmnest_link_crypto::b64_encode(&ephemeral_public),
            pinned_kd,
            strict: ctx.strict_mode,
        })
    }
}

/// 升级响应 → 会话密码（纯函数，便于单测锁定拒绝语义）
///
/// - 服务端回执了临时公钥：按双 ECDH 派生；
/// - 无回执：`required`（非环回）或 strict 模式 = 显性失败；否则明文续跑。
///   环回目标不失败：服务端对本地环回豁免（不注册会话密码），经隧道代理时
///   对端是 peer 面，会正常回执。
fn complete_ws_crypto(
    offer: &WsCryptoOffer,
    headers: &[(String, String)],
    target_is_loopback: bool,
) -> std::result::Result<Option<SharedWsCrypto>, String> {
    let header = |name: &str| {
        headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    };
    let accepted = header(NEGOTIATION_HEADER).and_then(parse_negotiation);
    let server_policy = header(WS_POLICY_HEADER).unwrap_or("");

    let Some(server_ek_b64) = accepted else {
        if target_is_loopback {
            tracing::debug!(
                server_policy,
                "event ws link crypto: loopback target declined offer (local exemption); plaintext continuation"
            );
            return Ok(None);
        }
        if server_policy == "required" {
            return Err(
                "link encryption required by the server but the WS upgrade response carries no session key".to_string(),
            );
        }
        if offer.strict {
            return Err(format!(
                "link encryption downgrade: server app policy is '{}' (client strict mode)",
                if server_policy.is_empty() {
                    "unknown/unsupported"
                } else {
                    server_policy
                }
            ));
        }
        tracing::warn!(
            server_policy,
            "event ws link crypto: server declined the offer; continuing plaintext"
        );
        return Ok(None);
    };

    let Some(pinned_kd) = offer.pinned_kd else {
        return Err("link encryption is on but the pinned host key is invalid".to_string());
    };
    let ciphers = ClientWsCrypto::derive(
        &offer.ephemeral_private,
        &offer.ephemeral_public_b64,
        server_ek_b64,
        &pinned_kd,
    )
    .map_err(|error| format!("event ws link crypto handshake failed: {error}"))?;
    tracing::info!(server_policy, "event ws link crypto: session key negotiated");
    Ok(Some(Arc::new(std::sync::Mutex::new(ciphers))))
}

#[derive(Debug, Clone)]
pub struct WsClientConfig {
    /// 服务器地址
    pub address: String,
    /// 服务器端口
    pub port: u16,
    /// WebSocket 路径（默认 "/"）
    pub path: String,
    /// 心跳间隔（秒）
    pub heartbeat_interval_secs: u64,
    /// 消息队列大小
    pub message_queue_size: usize,
    /// 连接超时（毫秒）
    pub connect_timeout_ms: u64,
}

impl WsClientConfig {
    /// 创建新配置
    pub fn new(address: impl Into<String>, port: u16) -> Self {
        Self {
            address: address.into(),
            port,
            path: WS_DEFAULT_PATH.to_string(),
            heartbeat_interval_secs: DEFAULT_HEARTBEAT_INTERVAL_SECS,
            message_queue_size: DEFAULT_MESSAGE_QUEUE_SIZE,
            connect_timeout_ms: DEFAULT_CONNECT_TIMEOUT_MS,
        }
    }

    /// 设置 WS 路径
    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = path.into();
        self
    }

    /// 获取 WebSocket URL
    pub fn url(&self) -> String {
        format!("ws://{}:{}{}", self.address, self.port, self.path)
    }
}

impl Default for WsClientConfig {
    fn default() -> Self {
        Self {
            address: "127.0.0.1".to_string(),
            port: 8765,
            path: WS_DEFAULT_PATH.to_string(),
            heartbeat_interval_secs: DEFAULT_HEARTBEAT_INTERVAL_SECS,
            message_queue_size: DEFAULT_MESSAGE_QUEUE_SIZE,
            connect_timeout_ms: DEFAULT_CONNECT_TIMEOUT_MS,
        }
    }
}

/// WS 层连接管理器 - 负责底层连接的建立和断开
///
/// 内部类型，仅由 WsClient 使用
pub struct WsConnectionManager {
    /// 配置
    config: WsClientConfig,
    /// 生命周期管理器
    lifecycle: Arc<LifecycleManager>,
    /// 运行中标记（原子操作，确保只有一个连接任务）
    running: Arc<std::sync::atomic::AtomicBool>,
}

impl WsConnectionManager {
    /// 创建新的连接管理器
    pub fn new(config: WsClientConfig, lifecycle: Arc<LifecycleManager>) -> Arc<Self> {
        Arc::new(Self {
            config,
            lifecycle,
            running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    /// 获取配置
    pub fn config(&self) -> &WsClientConfig {
        &self.config
    }

    /// 获取生命周期管理器
    pub fn lifecycle(&self) -> &Arc<LifecycleManager> {
        &self.lifecycle
    }

    /// 检查是否正在运行
    pub fn is_running(&self) -> bool {
        self.running.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 建立 WebSocket 连接
    pub async fn connect(
        self: &Arc<Self>,
    ) -> Result<(
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        tokio::sync::mpsc::Sender<WsMsg>,
        Option<SharedWsCrypto>,
    )> {
        // 使用原子操作确保只有一个连接任务在运行
        if self
            .running
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_err()
        {
            warn!("Already connected or connecting");
            return Err(crate::AppError::WebSocket(
                "Already connected or connecting".to_string(),
            ));
        }

        // 检查当前状态
        {
            let status = self.lifecycle.get_status().await;
            if status == ConnectionStatus::Connected || status == ConnectionStatus::Paired {
                self.running.store(false, std::sync::atomic::Ordering::SeqCst);
                warn!("Already connected");
                return Err(crate::AppError::WebSocket("Already connected".to_string()));
            }
        }

        let url = self.config.url();
        info!("[WsConnectionManager] Connecting to {}", url);

        // 升级期链路加密协商（T07/C2）：移动端开启加密且已 pin 桌面身份公钥时
        // 必须在升级请求里带提案；否则桌面应用策略为 `required` 时会以 400
        // 拒绝事件通道升级（旧实现只 connect_async(url)，没有任何协商头）。
        let crypto_offer = WsCryptoOffer::from_context();
        let mut request = url
            .clone()
            .into_client_request()
            .map_err(|e| crate::AppError::WebSocket(format!("invalid ws request: {e}")))?;
        if let Some(offer) = &crypto_offer {
            let name = HeaderName::try_from(NEGOTIATION_HEADER)
                .map_err(|e| crate::AppError::WebSocket(format!("invalid negotiation header: {e}")))?;
            let value = HeaderValue::from_str(&format!("v{PROTOCOL_VERSION} {}", offer.ephemeral_public_b64))
                .map_err(|e| crate::AppError::WebSocket(format!("invalid negotiation value: {e}")))?;
            request.headers_mut().insert(name, value);
        }

        // 设置为连接中状态
        self.lifecycle.set_status(ConnectionStatus::Connecting).await;

        // 建立 WebSocket 连接（带超时）
        let connect_start = std::time::Instant::now();

        let ws_result = tokio::time::timeout(
            std::time::Duration::from_millis(self.config.connect_timeout_ms),
            tokio_tungstenite::connect_async(request),
        )
        .await;

        // 在 async 上下文中处理连接错误，避免 map_err 闭包中调用 blocking 方法导致 panic
        let ws_stream = match ws_result {
            Ok(Ok(stream)) => stream,
            Ok(Err(e)) => {
                self.running.store(false, std::sync::atomic::Ordering::SeqCst);
                let error_msg = format!("Failed to connect: {}", e);
                self.lifecycle
                    .set_status(ConnectionStatus::Error(error_msg.clone()))
                    .await;
                error!("[WsConnectionManager] Failed to connect to {}: {:#}", url, e);
                return Err(crate::AppError::WebSocket(error_msg));
            }
            Err(_) => {
                self.running.store(false, std::sync::atomic::Ordering::SeqCst);
                self.lifecycle
                    .set_status(ConnectionStatus::Error("Connection timeout".to_string()))
                    .await;
                error!(
                    "[WsConnectionManager] Connection timeout after {}ms",
                    self.config.connect_timeout_ms
                );
                return Err(crate::AppError::WebSocket("Connection timeout".to_string()));
            }
        };

        let connect_duration = connect_start.elapsed();
        tracing::info!("WebSocket handshake completed in {}ms", connect_duration.as_millis());

        // 获取读写流与升级响应头（协商回执/策略头都在这里）
        let (ws_stream, response) = ws_stream;
        let response_headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(name, value)| (name.as_str().to_string(), value.to_str().unwrap_or("").to_string()))
            .collect();
        let crypto = match &crypto_offer {
            Some(offer) => {
                let target_is_loopback = crate::egress::is_loopback_host(&self.config.address);
                match complete_ws_crypto(offer, &response_headers, target_is_loopback) {
                    Ok(crypto) => crypto,
                    Err(message) => {
                        self.running.store(false, std::sync::atomic::Ordering::SeqCst);
                        self.lifecycle
                            .set_status(ConnectionStatus::Error(message.clone()))
                            .await;
                        error!("[WsConnectionManager] Link crypto negotiation failed: {}", message);
                        return Err(crate::AppError::WebSocket(message));
                    }
                }
            }
            None => None,
        };

        // 创建消息通道（用于发送）
        let (tx, _rx) = tokio::sync::mpsc::channel::<WsMsg>(self.config.message_queue_size);

        // 更新连接状态为已连接
        self.lifecycle.set_status(ConnectionStatus::Connected).await;

        debug!("[WsConnectionManager] Connection established successfully");

        Ok((ws_stream, tx, crypto))
    }

    /// 断开连接
    pub async fn disconnect(&self) {
        info!("[WsConnectionManager] Disconnecting...");

        // 停止运行标记
        self.running.store(false, std::sync::atomic::Ordering::SeqCst);

        // 更新状态
        self.lifecycle.set_status(ConnectionStatus::Disconnected).await;

        info!("[WsConnectionManager] Disconnected");
    }

    /// 重置运行标记（用于允许重新连接）
    pub fn reset_running(&self) {
        self.running.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;
    use wasmnest_link_crypto::derive_server_handshake;
    use x25519_dalek::{PublicKey, StaticSecret};

    fn offer(kd_public: [u8; X25519_KEY_LEN]) -> WsCryptoOffer {
        let (ephemeral_private, ephemeral_public) = generate_ephemeral();
        WsCryptoOffer {
            ephemeral_private,
            ephemeral_public_b64: wasmnest_link_crypto::b64_encode(&ephemeral_public),
            pinned_kd: Some(kd_public),
            strict: false,
        }
    }

    fn server_headers(offer: &WsCryptoOffer, kd_private: &[u8; X25519_KEY_LEN], policy: &str) -> Vec<(String, String)> {
        let (server_ephemeral_private, _) = generate_ephemeral();
        let handshake = derive_server_handshake(&offer.ephemeral_public_b64, kd_private, &server_ephemeral_private)
            .expect("server handshake");
        vec![
            (
                NEGOTIATION_HEADER.to_string(),
                format!("v{PROTOCOL_VERSION} {}", handshake.server_ek_b64),
            ),
            (WS_POLICY_HEADER.to_string(), policy.to_string()),
        ]
    }

    /// C2 核心：`required` + 服务端回执 → 会话密码就位，出站帧为信封
    #[test]
    fn required_server_handshake_derives_session_crypto() {
        let kd_secret = StaticSecret::random_from_rng(OsRng);
        let kd_public = PublicKey::from(&kd_secret).to_bytes();
        let offer = offer(kd_public);
        let headers = server_headers(&offer, kd_secret.as_bytes(), "required");

        let crypto = complete_ws_crypto(&offer, &headers, false)
            .expect("handshake must succeed")
            .expect("session cipher expected");
        let sealed = crypto
            .lock()
            .unwrap()
            .seal_text(WS_PLUGIN_CHANNEL, "{\"type\":\"ping\"}")
            .expect("seal");
        assert!(sealed.contains("\"v\":1"), "信封版本: {sealed}");
        assert!(sealed.contains("\"seq\":0"), "首帧序号: {sealed}");
        assert!(!sealed.contains("\"type\""), "明文不得直接上线: {sealed}");
    }

    /// `required` 但回执无密钥（非环回）→ 显性失败，不静默降级明文
    #[test]
    fn required_without_session_key_fails_closed() {
        let offer = offer([7u8; X25519_KEY_LEN]);
        let headers = vec![(WS_POLICY_HEADER.to_string(), "required".to_string())];
        let err = match complete_ws_crypto(&offer, &headers, false) {
            Ok(_) => panic!("required without session key must fail"),
            Err(err) => err,
        };
        assert!(err.contains("carries no session key"), "{err}");
    }

    /// 环回目标被服务端本地豁免（无回执）→ 明文续跑；策略 off 同理
    #[test]
    fn loopback_and_off_policy_continue_plaintext() {
        let offer = offer([7u8; X25519_KEY_LEN]);
        let required = vec![(WS_POLICY_HEADER.to_string(), "required".to_string())];
        assert!(complete_ws_crypto(&offer, &required, true).unwrap().is_none());

        let off = vec![(WS_POLICY_HEADER.to_string(), "off".to_string())];
        assert!(complete_ws_crypto(&offer, &off, false).unwrap().is_none());
    }
}
