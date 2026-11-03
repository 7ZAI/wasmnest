//! 宿主面身份门（安全审查 #42 / #43，2026-11-02）
//!
//! 移动运行面与宿主壳**同 webview**（ADR 0058 F2）：任何随包 / 用户安装应用的前端
//! 都能裸 invoke 宿主命令。因此「宿主机密面」必须自带凭证判定，不能靠命令名或
//! 参数里的 `plugin_id` 推断调用方。
//!
//! 判据真源 = wasm-core `security::frontend_channel`（与桌面 `api_bridge` /
//! `plugin::lifecycle` 同一份裁决，有单测）：
//!
//! - [`require_host_surface`]：只认宿主前端凭证（loader 会话）。用于**宿主职权**面
//!   ——凭据读写、token 改写、链路加密开关、HTTP 代理出站。
//! - [`resolve_caller`]：宿主 / 插件令牌都解析，供「宿主与插件语义不同」的命令分流
//!   （如 `http_request`：宿主出站可按宿主记账并注入 JWT，插件出站按应用记账且不注入）。
//!
//! 两者都 **fail-closed**：凭证缺失 / 无效 / 跨窗口一律拒绝，错误文案点名命令与缺口。

use std::sync::Arc;

use tauri::Manager;
use wasmnest_wasm_core::security::frontend_channel::{ChannelIdentity, FrontendChannelRegistry};

use crate::Result;

/// 调用方身份（宿主壳 vs 某个应用）
///
/// 公开供集成测试显式构造（`execute_proxy` 的第三个参数）；**没有** `Default`
/// ——默认为宿主正是安全审查 #43 的原始缺陷形态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallerIdentity {
    /// 宿主前端（loader 会话密钥）
    Host,
    /// 应用前端（该应用自己的通道令牌）
    Plugin(String),
}

/// 取当前 app 托管的通道凭证注册表
///
/// 注册表由 `lib.rs` setup 托管；取不到即装配错误——按 fail-closed 报错，
/// 不降级成「无凭证放行」。
pub(crate) fn channel_registry(app_handle: &tauri::AppHandle) -> Result<Arc<FrontendChannelRegistry>> {
    app_handle
        .try_state::<Arc<FrontendChannelRegistry>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| crate::AppError::Plugin("frontend channel registry is not managed".to_string()))
}

/// 宿主面命令的身份门：只认宿主前端凭证
///
/// `denial` 是该命令自己的拒绝文案（既有调用点的错误字面保持稳定）。
pub(crate) fn require_host_surface(
    channel: &FrontendChannelRegistry,
    webview_label: &str,
    command: &str,
    credential: &str,
    denial: &str,
) -> Result<()> {
    channel
        .require_host_identity(webview_label, credential, command)
        .map_err(|_| crate::AppError::Plugin(denial.to_string()))
}

/// 解析调用方身份（宿主 / 应用），无法解析即拒绝
///
/// 与 [`require_host_surface`] 的差别：插件令牌是**合法身份**，只是与宿主待遇不同。
pub(crate) fn resolve_caller(
    channel: &FrontendChannelRegistry,
    webview_label: &str,
    command: &str,
    credential: &str,
) -> Result<CallerIdentity> {
    match channel.resolve(webview_label, credential) {
        Some(ChannelIdentity::Host) => Ok(CallerIdentity::Host),
        Some(ChannelIdentity::Plugin(plugin_id)) => Ok(CallerIdentity::Plugin(plugin_id)),
        None => {
            tracing::warn!(
                webview = %webview_label,
                command = %command,
                "[HostGate] 缺少有效通道凭证，命令被拒绝"
            );
            Err(crate::AppError::Plugin(format!(
                "command '{command}' requires a frontend channel credential (host loader session or app channel token)"
            )))
        }
    }
}
