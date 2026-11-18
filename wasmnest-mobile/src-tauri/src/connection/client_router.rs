//! 消息路由器 trait：双端共用的消息分发契约

use crate::model::message::Message;
use crate::Result;
use async_trait::async_trait;

/// 消息路由器 trait
/// 业务层实现此 trait 来定义消息路由逻辑
///
/// 桌面端 `BusinessRouter`、移动端 `ClientBusinessRouter` 各有一份实现。
#[async_trait]
pub trait MessageRouter: Send + Sync {
    /// 路由消息到具体处理器
    ///
    /// 返回 `Ok(Some(..))` 表示需要回包，`Ok(None)` 表示无需响应，`Err` 表示处理失败。
    async fn route(&self, message: Message) -> Result<Option<Message>>;

    /// 路由器名称
    fn name(&self) -> &str;
}
