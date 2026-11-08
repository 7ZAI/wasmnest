//! 内网穿透通道（WIT `host-tunnel`，T06）
//!
//! 应用只描述「要暴露什么 / 要连谁」与自己的网络设置（`allowWan` / relay 地址）；
//! 引用计数、reservation、对等面生命周期、模式判定全部在宿主隧道管理器里。
//! 未声明 `tunnel:serve` / `tunnel:connect` 的应用永远 lan-only。
//!
//! **加密不可关闭**：本域没有「关闭加密」原语；`allowWan=false` 只关闭外网通道，
//! 不改变链路加密（加密永久强制）。

use crate::host::HostError;

/// 通道配置（WIT `tunnel-config` 的 Rust 映射）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TunnelConfig {
    /// 允许外网中继（关闭 ≠ 关闭加密）
    pub allow_wan: bool,
    /// multiaddr 字符串数组（空 = 未配置中继）
    pub relay_addrs: Vec<String>,
}

/// 暴露规则（WIT `expose-config` 的 Rust 映射）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TunnelExposeConfig {
    /// 逻辑端口：`kind=http` 时后端恒为对等 HTTP/WS 面；`kind=tcp` 时是回环端口
    pub port: u16,
    /// `http` | `tcp`
    pub kind: String,
    /// 人类可读标签（仅展示）
    pub label: String,
    /// 空 = 所有已匹配 peer；非空 = 仅列出的已验证 node id
    pub allowed_peers: Vec<String>,
}

/// 内网穿透能力 trait —— 函数签名与 WIT `host-tunnel` 一一对应
pub trait HostTunnel {
    /// 写入本应用的通道配置（幂等全量替换；只改宿主的引用计数）
    fn tunnel_configure(&self, config: &TunnelConfig) -> Result<bool, HostError>;
    /// 登记暴露规则（返回规则 id；幂等）
    fn tunnel_expose(&self, config: &TunnelExposeConfig) -> Result<String, HostError>;
    /// 撤销暴露规则（返回是否命中）
    fn tunnel_unexpose(&self, rule_id: &str) -> Result<bool, HostError>;
    /// 建立本地回环代理（返回 `{ handle, address, port }`）；`pairingTicket` 仅首次配对传
    fn tunnel_connect(
        &self,
        node_id: &str,
        port: u16,
        kind: &str,
        addrs: &[String],
        pairing_ticket: Option<String>,
    ) -> Result<serde_json::Value, HostError>;
    /// 关闭句柄（listener + 在飞流）
    fn tunnel_close(&self, handle: &str) -> Result<bool, HostError>;
    /// 签发一次性配对票据（TTL ≤ 120s；明文不落日志）
    fn tunnel_issue_pairing_ticket(&self, port: u16, ttl_secs: u32) -> Result<String, HostError>;
    /// 只读状态投影（节点 / 对等面 / relay / 本应用计数）
    fn tunnel_status(&self) -> Result<serde_json::Value, HostError>;
}
