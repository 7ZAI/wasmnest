//! Mobile Auth Commands
//!
//! 认证与配对相关命令（票 14 阶段 B 收窄后的残余引擎面）
//!
//! 配对流程编排（请求配对 → 等码 → 验码 / QR / 生物挑战）已迁
//! `com.wasmnest.bedcode` 插件（经 WIT `host-auth` 触达引擎，凭据
//! 零过境）；本文件只剩三类**引擎事实 / 凭据面**（C4：凭据持有在宿主引擎，
//! 读取面也留在引擎侧，不经插件）：
//!
//! - `ws_authenticate`：重启 / 重连后的 JWT 换新（token 由前端 localStorage
//!   镜像交还宿主——重启后宿主内存态 global token 为空的恢复路径）
//! - `ws_get_auth_credentials`：凭据窄读（前端持久化镜像的唯一取数口）
//! - 生物凭证绑定 / 解绑 / 状态（Keystore 私钥与公钥注册留在宿主引擎）
//!
//! ## 宿主面身份门（安全审查 #42，2026-11-02）
//!
//! 本文件的命令都读 / 写**宿主机密事实**（JWT、设备凭据、生物密钥），移动运行面与
//! 宿主壳同 webview（ADR 0058 F2）⇒ 任一应用前端都能裸 invoke。因此全部归宿主门：
//! 调用方必须持前端 loader 会话凭证；插件面令牌（含目标是自己）一律拒绝——
//! 应用需要的「以宿主身份做受保护动作」由宿主壳经自己的命令代理（`mobileApi`），
//! 原始凭据永不出 Rust。

use tauri::AppHandle;

use crate::auth::AuthCredentials;
use crate::commands::host_gate::{channel_registry, require_host_surface};
use crate::router::event;
use crate::state::get_auth_manager;
use crate::Result;

/// 使用 JWT token 认证（重连时使用已存储的 session_token）
#[tauri::command]
pub async fn ws_authenticate(
    app_handle: AppHandle,
    webview: tauri::Webview,
    session_token: String,
    credential: String,
) -> Result<bool> {
    let channel = channel_registry(&app_handle)?;
    require_host_surface(
        &channel,
        webview.label(),
        "ws_authenticate",
        &credential,
        "authentication with a stored token must be requested by the host frontend",
    )?;
    tracing::info!("[ws_authenticate] called, token length={}", session_token.len());
    let auth = get_auth_manager();
    let result = auth.authenticate_with_token(&session_token).await?;

    if result {
        event::emit_auth_success(&app_handle);
        event::emit_paired(&app_handle);
    }

    Ok(result)
}

/// 读取宿主持有的认证凭据（窄读引擎事实）
///
/// 票 14 阶段 B：认证编排迁插件后，配对 / QR / 生物认证的成功路径不再向
/// 前端返回凭据（凭据零过境，插件不接触 token）；前端持久化镜像
/// （localStorage，重启后经 `ws_authenticate` 交还宿主）经本命令直接读引擎。
/// 未持有凭据 → `None`
///
/// 宿主面门（安全审查 #42）：读到凭据即等价取得已配对身份，应用前端不得触达。
#[tauri::command]
pub async fn ws_get_auth_credentials(
    app_handle: AppHandle,
    webview: tauri::Webview,
    credential: String,
) -> Result<Option<AuthCredentials>> {
    let channel = channel_registry(&app_handle)?;
    require_host_surface(
        &channel,
        webview.label(),
        "ws_get_auth_credentials",
        &credential,
        "auth credentials may only be read by the host frontend",
    )?;
    let auth = get_auth_manager();
    Ok(auth.get_credentials().await)
}

/// 绑定生物凭证：本地生成密钥对并注册公钥到桌面端（需已认证连接）
#[tauri::command]
pub async fn ws_bind_biometric_credential(
    app_handle: AppHandle,
    webview: tauri::Webview,
    credential: String,
) -> Result<bool> {
    let channel = channel_registry(&app_handle)?;
    require_host_surface(
        &channel,
        webview.label(),
        "ws_bind_biometric_credential",
        &credential,
        "biometric credential binding must be requested by the host frontend",
    )?;
    let auth = get_auth_manager();
    auth.bind_biometric_credential().await
}

/// 解绑生物凭证：删除本地密钥并通知桌面端清空公钥（需已认证连接）
#[tauri::command]
pub async fn ws_unbind_biometric_credential(
    app_handle: AppHandle,
    webview: tauri::Webview,
    credential: String,
) -> Result<bool> {
    let channel = channel_registry(&app_handle)?;
    require_host_surface(
        &channel,
        webview.label(),
        "ws_unbind_biometric_credential",
        &credential,
        "biometric credential unbinding must be requested by the host frontend",
    )?;
    let auth = get_auth_manager();
    auth.unbind_biometric_credential().await
}

/// 生物认证密钥状态（设备支持 + 本地密钥已生成）
///
/// camelCase 序列化与前端 TS 接口对齐（同 commands/session.rs 约定）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricKeyStatus {
    pub device_supported: bool,
    /// BiometricManager 结果码：0=SUCCESS 1=HW_UNAVAILABLE 11=NONE_ENROLLED 12=NO_HARDWARE；-1=未知/插件异常
    pub device_reason: i32,
    pub has_key: bool,
}

/// 查询生物认证密钥状态
///
/// 宿主面门（安全审查 #42）：`hasKey` + 设备结果码是凭据面的存在性投影，
/// 同样只对宿主壳开放。
#[tauri::command]
pub async fn ws_get_biometric_key_status(
    app_handle: AppHandle,
    webview: tauri::Webview,
    credential: String,
) -> Result<BiometricKeyStatus> {
    let channel = channel_registry(&app_handle)?;
    require_host_surface(
        &channel,
        webview.label(),
        "ws_get_biometric_key_status",
        &credential,
        "biometric key status may only be read by the host frontend",
    )?;
    let auth = get_auth_manager();
    let (device_supported, device_reason) = auth.is_biometric_supported().await?;
    let has_key = auth.has_biometric_key().await?;
    Ok(BiometricKeyStatus {
        device_supported,
        device_reason,
        has_key,
    })
}
