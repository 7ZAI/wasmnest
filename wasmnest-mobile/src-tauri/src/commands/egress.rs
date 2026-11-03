//! Egress 授权命令面：弹窗回执 + 桌面端目标声明（设置页管理面已随死路由退役，
//! 引擎侧 list/revoke/purge 由 egress::policy 直接承载）
//!
//! ## 宿主面身份门（安全审查 #42 / #43，2026-11-02）
//!
//! 这两条命令都是**安全决策面**，移动运行面与宿主壳同 webview（ADR 0058 F2）：
//!
//! - `egress_declare_desktop_target`：声明即把 host:port 放进 L1 免判定集合——
//!   应用前端可借此把任意 `http://` 目标变成「已声明桌面端」，再经 `kind=desktop`
//!   的 `http_request` 绕过 egress 全层判定（SSRF / 内网横向）；
//! - `egress_consent_resolve`：回执即替用户「同意/拒绝」外网授权——监听事件后
//!   自答等于自批网络权限（与 `plugin_fs_auth_respond` 同判据）。
//!
//! 两者都只对宿主壳开放：宿主弹窗（`EgressConsentDialog`）与宿主连接域是唯一调用方。

use std::sync::Arc;

use wasmnest_wasm_core::security::frontend_channel::FrontendChannelRegistry;

use crate::commands::host_gate::{channel_registry, require_host_surface};
use crate::Result;

// ==================== 弹窗回执 ====================

/// 前端声明/更新桌面端目标（setApiBaseUrl 时调用；L1 放行的 host:port 集合）
///
/// httpProbe 在 ws_connect 前执行，此时 ConnectionManager.target 尚未设置——
/// 前端在 setApiBaseUrl(address, port) 时即声明目标，probe/会话内请求经 L1 放行。
#[tauri::command]
pub fn egress_declare_desktop_target(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    address: String,
    port: u16,
    credential: String,
) -> Result<()> {
    require_egress_host(&app_handle, webview.label(), "egress_declare_desktop_target", &credential)?;
    crate::egress::policy().add_desktop_target(&address, port);
    Ok(())
}

/// 前端授权弹窗回执（EgressConsentDialog 确认/拒绝时调用）
///
/// `persist` = 用户勾选「不再询问」→ 持久记忆落盘；`deny` = 用户勾选「以后都拒绝」
/// → 落 deny 记录（fail-safe：显式拒绝优先于一切放行路径）。
/// request_id 不存在（超时已清）时静默成功——弹窗超时兜底在前端也可展示失败。
#[tauri::command]
pub async fn egress_consent_resolve(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    request_id: String,
    allow: bool,
    persist: bool,
    deny: bool,
    credential: String,
) -> Result<()> {
    require_egress_host(&app_handle, webview.label(), "egress_consent_resolve", &credential)?;
    let handled = crate::egress::policy()
        .resolve_consent(&request_id, allow, persist, deny)
        .await;
    if !handled {
        tracing::warn!(request_id = %request_id, "egress: consent resolve for unknown request_id");
    }
    Ok(())
}

/// egress 决策面的宿主门（拒绝文案点名命令与缺口）
fn require_egress_host(
    app_handle: &tauri::AppHandle,
    webview_label: &str,
    command: &str,
    credential: &str,
) -> Result<()> {
    let channel: Arc<FrontendChannelRegistry> = channel_registry(app_handle)?;
    require_host_surface(
        &channel,
        webview_label,
        command,
        credential,
        "egress policy decisions (desktop-target declaration / consent resolution) must be made by the host frontend",
    )
}
