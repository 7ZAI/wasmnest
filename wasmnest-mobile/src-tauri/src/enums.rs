//! 公共枚举类型：按鉴权 / 控制 / 插件 / 摘要分组
//!
//! `special_key`（KeyCode / KeyCombo 按键翻译）已随终端订阅协议客户端迁入
//! `com.wasmnest.bedcode` wasm app（等价移植进插件 `keys.rs`，语义逐字节一致；
//! 桌面侧同款实现 = `wasmnest-apps/apps/bedcode/desktop/rust/src/keys.rs`）——宿主
//! 不再消费按键组合，只收插件算好的裸字节。

pub mod auth;
pub mod control;
pub mod plugin;
pub mod sumary;

// 公开类型统一从本模块再导出
pub use auth::{AuthPayload, AuthStage};
pub use control::{SessionControlAction, SessionControlPayload};
pub use plugin::{PluginQuestion, PluginQuestionOption};
pub use sumary::{SessionConfigSummary, SessionSummary};
