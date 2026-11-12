//! Connection & Token Commands
//!
//! WebSocket 连接管理和全局 Token 命令

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands::host_gate::{channel_registry, require_host_surface};
use crate::connection::event_ws;
use crate::router::event;
use crate::state::{clear_global_token, get_auth_manager, get_connection_manager, get_global_token, set_global_token};
use crate::Result;

/// 连接信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub address: String,
    pub port: u16,
    pub status: String,
}

/// 连接到桌面端
///
/// 宿主面门（安全审查 #42）：连接目标与凭据是宿主机密面的另一半——应用前端同 webview
/// 可直接 invoke，把宿主连到攻击者指定的对端（中间人）。应用发起的连接走宿主壳的
/// `mobileApi.connectDevice`，凭证由宿主侧补。
#[tauri::command]
pub async fn ws_connect(
    app_handle: AppHandle,
    webview: tauri::Webview,
    address: String,
    port: u16,
    name: Option<String>,
    credential: String,
) -> Result<ConnectionInfo> {
    require_host_connection_surface(&app_handle, webview.label(), "ws_connect", &credential)?;
    tracing::info!("WebSocket connecting to {}:{}", address, port);

    // 初始化设备身份（首次调用时从文件加载或生成新身份）
    {
        let auth = get_auth_manager();
        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| crate::AppError::Config(format!("Failed to get app data dir: {}", e)))?;
        auth.init_identity(&app_handle, app_data_dir).await;
    }

    // 发射连接开始事件
    event::emit_connecting(&app_handle, &address, port);

    // 启动事件转发任务（仅一次）
    event::start_event_forwarding(app_handle.clone());

    // 启动常驻事件 WS 监督任务（HTTP 认证成功后自动建连/自愈，单例）；
    // 先订阅再等首次认证，不漏 AuthSuccess
    event_ws::start_event_ws_supervisor(Some(app_handle.clone()));

    let conn = get_connection_manager();
    tracing::info!("Calling conn.connect()...");

    match conn.connect(app_handle.clone(), address.clone(), port, name).await {
        Ok(_) => {
            tracing::info!("conn.connect() returned Ok");
        }
        Err(e) => {
            tracing::error!("conn.connect() returned error: {}", e);
            event::emit_error(&app_handle, &format!("Connection failed: {}", e));
            return Err(e);
        }
    }

    let status = conn.get_status().await;
    tracing::info!("Connection status: {:?}", status);

    Ok(ConnectionInfo {
        address,
        port,
        status: format!("{:?}", status),
    })
}

/// 断开连接
///
/// 宿主面门（安全审查 #42）同 `ws_connect`。
#[tauri::command]
pub async fn ws_disconnect(app_handle: AppHandle, webview: tauri::Webview, credential: String) -> Result<()> {
    require_host_connection_surface(&app_handle, webview.label(), "ws_disconnect", &credential)?;
    tracing::info!("WebSocket disconnecting");

    let conn = get_connection_manager();
    conn.disconnect().await;

    // 发射断开连接事件
    event::emit_disconnected(&app_handle, "User initiated disconnect");

    // 会话状态清理已随票 13 退役：SessionManager 簿记零实际消费者（活跃会话
    // 只在已删的 ws_start_session 死命令路径写入 ⇒ 原分支恒 None）；会话真源在
    // 桌面端 HTTP + 同步事件，设备断开时的会话处置归插件编排

    Ok(())
}

/// 获取连接状态
#[tauri::command]
pub async fn ws_get_status() -> Result<String> {
    let conn = get_connection_manager();
    let status = conn.get_status().await;
    Ok(format!("{:?}", status))
}

/// 检查是否已连接
#[tauri::command]
pub async fn ws_is_connected() -> Result<bool> {
    let conn = get_connection_manager();
    Ok(conn.is_connected().await)
}

/// 同步「自动重连」设置项到连接层
///
/// 自动重连的执行者是 Rust 侧的 `EventWsSupervisor`（唯一自愈入口），退避
/// 节奏由 `ConnectionManager` 的 `ReconnectManager` 策略决定。前端不持有重连
/// 循环，只把用户的开关意图同步过来。
///
/// 关闭后：断开仍会照常上报 `ws_unexpected_disconnect`（断开是事实），但监督
/// 任务不自愈，需用户手动连接或重新认证。
///
/// 宿主面门（安全审查 #42）：重连策略是宿主连接域行为，应用改它等于关掉自愈。
#[tauri::command]
pub async fn set_auto_reconnect(
    app_handle: AppHandle,
    webview: tauri::Webview,
    enabled: bool,
    credential: String,
) -> Result<()> {
    require_host_connection_surface(&app_handle, webview.label(), "set_auto_reconnect", &credential)?;
    let manager = get_connection_manager();
    manager.set_auto_reconnect(enabled);
    Ok(())
}

/// 重新连接（断线重连）
///
/// 宿主面门（安全审查 #42）：`session_token` 参数本身就能改写认证身份，不得由应用提供。
#[tauri::command]
pub async fn ws_reconnect(
    app_handle: AppHandle,
    webview: tauri::Webview,
    session_token: Option<String>,
    credential: String,
) -> Result<()> {
    require_host_connection_surface(&app_handle, webview.label(), "ws_reconnect", &credential)?;
    tracing::info!(
        "[ws_reconnect] session_token: {:?}",
        session_token.as_ref().map(|t| format!("len={}", t.len()))
    );

    let manager = get_connection_manager();

    // 检查是否已连接
    if manager.is_connected().await {
        tracing::info!("Already connected, skipping reconnect");
        return Ok(());
    }

    // 调用重连（command 层始终带 AppHandle：前端需收到 reconnecting / reconnected / reconnect_failed 事件）
    manager.reconnect(Some(app_handle), session_token).await
}

/// 获取当前持有的 JWT
///
/// D3：JWT 由 Rust 持有，前端经此 invoke 获取；禁止落前端存储。
/// 04 事件 WS 建连时前端需分批请求 token 与 URL 后再建连。
///
/// 宿主面门（安全审查 #42）：JWT 等价已配对身份，应用前端不得触达——
/// 应用需要的受保护请求走宿主 HTTP 代理（`http_request`）。
#[tauri::command]
pub async fn get_ws_token(app_handle: AppHandle, webview: tauri::Webview, credential: String) -> Result<String> {
    require_host_token_surface(&app_handle, webview.label(), "get_ws_token", &credential)?;
    Ok(get_global_token())
}

/// 获取常驻事件 WS 的完整 URL（`ws://{address}:{port}/ws/plugin/com.wasmnest.bedcode/session-control`）
///
/// 事件通道建连地址（票 03 自 `/ws/event` 迁往桌面插件端点）：目标设备未保存（未 connect）时报错。
#[tauri::command]
pub async fn get_ws_url() -> Result<String> {
    let conn = get_connection_manager();
    let target = conn
        .get_target()
        .await
        .ok_or_else(|| crate::AppError::Auth("No target device".to_string()))?;
    Ok(format!(
        "ws://{}:{}{}",
        target.address,
        target.port,
        crate::system::constants::connection::WS_PLUGIN_SESSION_CONTROL_PATH
    ))
}

// ==================== Token Commands ====================

/// 设置全局 Token（前端启动时从 localStorage 读取并调用）
///
/// 宿主面门（安全审查 #42）：改写 token = 把宿主连接到攻击者指定的凭据（中间人面），
/// 只允许宿主壳调用。
#[tauri::command]
pub fn ws_set_token(app_handle: AppHandle, webview: tauri::Webview, token: String, credential: String) -> Result<()> {
    require_host_token_surface(&app_handle, webview.label(), "ws_set_token", &credential)?;
    set_global_token(&token);
    Ok(())
}

// ==================== 链路加密上下文（issue 09） ====================

/// 推送链路加密运行期状态到 Rust 侧（前端设置变更/配对刷新/启动时调用）
///
/// HTTP 信封加密裁决在 Rust 侧（http_proxy），而开关与 pin 存于 WebView
/// localStorage——本命令是两侧的桥。缺省全关：未推送前 HTTP 载荷保持明文。
/// `encrypt_http` 为可选参数：旧前端（HTTP 代理收束前）不推送，默认 true
/// （主开关关着时无效）；新前端显式推送。WS 通道加密已随桌面端插件端点
/// 帧加密退役，命令不再接收 ws 开关。
#[tauri::command]
pub fn set_link_crypto_context(
    app_handle: AppHandle,
    webview: tauri::Webview,
    enabled: bool,
    strict_mode: bool,
    encrypt_http: Option<bool>,
    kd_public_b64: Option<String>,
    credential: String,
) -> Result<()> {
    // 宿主面门（安全审查 #42 / 与桌面 #45 同判据）：关闭链路加密是**安全降级**，
    // 应用前端同 webview 可直接 invoke ⇒ 不带凭证时必须拒绝，不能惧默降级。
    require_host_token_surface(&app_handle, webview.label(), "set_link_crypto_context", &credential)?;
    crate::state::set_link_crypto_context(crate::state::LinkCryptoContext {
        enabled,
        strict_mode,
        encrypt_http: encrypt_http.unwrap_or(true),
        kd_public_b64,
    });
    Ok(())
}

/// 获取当前全局 Token
///
/// 宿主面门（安全审查 #42）同 `get_ws_token`。
#[tauri::command]
pub fn ws_get_token(app_handle: AppHandle, webview: tauri::Webview, credential: String) -> Result<String> {
    require_host_token_surface(&app_handle, webview.label(), "ws_get_token", &credential)?;
    Ok(get_global_token())
}

/// 清除全局 Token（登出/解配时调用）
///
/// 同时关停文件服务并吊销 Bearer Token（规格 4.5：配对解除即失效）；
/// 连接已断时 shutdown 内部不发 Withdraw
///
/// 宿主面门（安全审查 #42）：清 token = 断开会话身份，不得由应用前端触发。
#[tauri::command]
pub fn ws_clear_token(app_handle: AppHandle, webview: tauri::Webview, credential: String) -> Result<()> {
    require_host_token_surface(&app_handle, webview.label(), "ws_clear_token", &credential)?;
    clear_global_token();
    Ok(())
}

/// 连接控制命令的宿主面门（安全审查 #42）
///
/// 与 token 面同一威胁模型：应用前端可把连接重定向到自建对端（中间人）、
/// 掐断会话或改掉重连策略。凭据判定委托 wasm-core（有单测）。
fn require_host_connection_surface(
    app_handle: &AppHandle,
    webview_label: &str,
    command: &str,
    credential: &str,
) -> Result<()> {
    let channel = channel_registry(app_handle)?;
    require_host_surface(
        &channel,
        webview_label,
        command,
        credential,
        "connection control must be requested by the host frontend",
    )
}

/// Token / 加密上下文命令的宿主面门（安全审查 #42）
///
/// 本组命令共享同一威胁模型：JWT 读写与链路加密开关都是**宿主机密事实**，
/// 应用前端（同 webview）不得触达。
fn require_host_token_surface(
    app_handle: &AppHandle,
    webview_label: &str,
    command: &str,
    credential: &str,
) -> Result<()> {
    let channel = channel_registry(app_handle)?;
    require_host_surface(
        &channel,
        webview_label,
        command,
        credential,
        "global token and link-encryption context may only be changed by the host frontend",
    )
}
