//! 认证与配对入口：认证管理器、认证状态与凭据类型
//!
//! 本地配对码的生成 / 持有 / 校验面已退役：移动端不是配对码颁发方（配对码由
//! 桌面端生成），本端只做提交与凭据落地。

pub mod http;
pub mod manager;

use serde::{Deserialize, Serialize};

// 公开类型再导出：调用方经 `crate::auth::*` 取用，不直接依赖子模块路径
pub use manager::AuthManager;

/// 认证凭据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCredentials {
    /// 设备配对 ID
    pub pairing_id: String,
    /// 设备指纹
    pub fingerprint: String,
    /// 会话令牌
    pub session_token: String,
}

/// 认证状态
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthStatus {
    /// 未认证
    Unauthenticated,
    /// 正在认证
    Authenticating,
    /// 等待配对码输入
    WaitingPairingCode,
    /// 已认证
    Authenticated,
    /// 认证失败
    Failed(String),
}
