//! 运行监控（WIT `host-metrics`）：只读指标快照
//!
//! 快照是宿主 `MetricsRegistry::snapshot()` 的 JSON：顶层 `plugins` 段按
//! `plugin_id` 组织，其余段为系统维度（如 `task`）。插件侧拿到的是
//! `serde_json::Value`，不做类型化 DTO——**字段形状即宿主契约**，
//! SDK 不复制一遍（复制即第二真源，宿主加字段时 SDK 会静默丢字段）。
//!
//! 权限：`metrics:read`（manifest 必须声明；未声明宿主返回 `Err`）。

use crate::host::HostError;

/// 运行时指标快照读取
pub trait HostMetrics {
    /// 取全量指标快照（JSON）
    ///
    /// 返回值形状：`{ "plugins": { "<plugin_id>": { ... } }, "<source>": { ... } }`
    /// ——字段逐项见宿主 `PluginMetricsSnapshot`（内存 / 调用 / 耗时 /
    /// trap 原因 / 生命周期 / 授权决策 / 总线背压 / 配额）。
    fn metrics_snapshot(&self) -> Result<serde_json::Value, HostError>;
}
