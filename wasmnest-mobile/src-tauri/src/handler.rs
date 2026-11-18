//! 各消息类型的处理器实现

pub mod auth;
pub mod plugin_event;
pub mod system;

// 处理器再导出：调用方经 `crate::handler::*` 取用
pub use auth::AuthHandler;
pub use plugin_event::PluginEventRouter;
pub use system::SystemHandler;
