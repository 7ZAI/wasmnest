//! Egress 授权命令面：弹窗回执 + 桌面端目标声明（设置页管理面已随死路由退役，
//! 引擎侧 list/revoke/purge 由 egress::policy 直接承载）

use crate::Result;

// ==================== 弹窗回执 ====================

/// 前端声明/更新桌面端目标（setApiBaseUrl 时调用；L1 放行的 host:port 集合）
///
/// httpProbe 在 ws_connect 前执行，此时 ConnectionManager.target 尚未设置——
/// 前端在 setApiBaseUrl(address, port) 时即声明目标，probe/会话内请求经 L1 放行。
#[tauri::command]
pub fn egress_declare_desktop_target(address: String, port: u16) -> Result<()> {
    crate::egress::policy().add_desktop_target(&address, port);
    Ok(())
}

/// 前端授权弹窗回执（EgressConsentDialog 确认/拒绝时调用）
///
/// `persist` = 用户勾选「不再询问」→ 持久记忆落盘；`deny` = 用户勾选「以后都拒绝」
/// → 落 deny 记录（fail-safe：显式拒绝优先于一切放行路径）。
/// request_id 不存在（超时已清）时静默成功——弹窗超时兜底在前端也可展示失败。
#[tauri::command]
pub async fn egress_consent_resolve(request_id: String, allow: bool, persist: bool, deny: bool) -> Result<()> {
    let handled = crate::egress::policy()
        .resolve_consent(&request_id, allow, persist, deny)
        .await;
    if !handled {
        tracing::warn!(request_id = %request_id, "egress: consent resolve for unknown request_id");
    }
    Ok(())
}
