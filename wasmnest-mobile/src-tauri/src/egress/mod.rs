//! Egress Policy：外网访问声明与授权（fail-closed）
//!
//! 三层校验（借鉴 fs_auth 三层：白名单 → 声明 → 弹窗授权，docs/architecture.md §5）：
//! - **L1 桌面端目标**：目标 host:port = 连接模块当前/最近目标（配对/会话内，
//!   无需声明；host:port 由连接模块注入，见 `add_desktop_target`）
//! - **L2 静态声明**：宿主内置（GitHub API，`system::constants::egress`）+ 插件
//!   manifest `preauthUrls`（插件加载时 `register_plugin_urls` 注册）
//! - **L3 授权弹窗**：未命中声明 → 首次请求弹窗，用户确认后放行（会话级默认
//!   + 可选持久「不再询问」，spec §9 D7）
//! - **拒绝**：以上均未通过 → fail-closed，请求不发，返回
//!   `EXTERNAL_URL_NOT_DECLARED` / `EXTERNAL_URL_DENIED`。
//!
//! 裁决与记忆在 Rust 端（§8 安全红线）：授权记忆存 Rust 持久层
//! （`egress_grants.json`，app_data_dir），不落 localStorage（spec §5.6 机制要点 1）。
//! 弹窗桥：Rust emit `egress_consent_request` → 前端渲染 → `egress_consent_resolve`
//! 回 Rust 裁决（oneshot 通道 + 超时兜底，超时视为拒绝）。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock as StdRwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::system::constants::egress::HOST_BUILTIN_URL_PATTERNS;
use crate::AppError;
use crate::Result;

// ==================== 常量与错误码 ====================

/// Egress 拒绝错误码：URL 未声明（fail-closed）
pub const ERROR_URL_NOT_DECLARED: &str = "EXTERNAL_URL_NOT_DECLARED";
/// Egress 拒绝错误码：用户拒绝（弹窗 deny）
pub const ERROR_URL_DENIED: &str = "EXTERNAL_URL_DENIED";

/// 弹窗桥等待前端响应的超时（超时视为拒绝，fail-closed）
pub const CONSENT_TIMEOUT: Duration = Duration::from_secs(30);

/// 授权记忆持久文件（app_data_dir 下）
const GRANTS_FILE: &str = "egress_grants.json";

/// 三档策略持久文件（app_data_dir 下；`{ plugin_id: 档位 }`）
const STRATEGY_FILE: &str = "egress_policy.json";

mod policy;
mod url;

#[cfg(test)]
mod tests;

pub use policy::*;
pub use url::*;

// ==================== 跳转（redirect）重校验 ====================

/// 跳转目标是否为私网/回环/链路本地 IP（字面量判定）。
///
/// 主机名无法解析为 IP 时按公网处理：首跳已过 L1/L2/L3，DNS 内网不在本
/// 策略面（阻断面聚焦「302 → 内网 IP / 云元数据 169.254.x.x」的经典 SSRF）。
fn is_private_ip(host: &str) -> bool {
    host.parse::<std::net::IpAddr>()
        .map(|ip| match ip {
            std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
            std::net::IpAddr::V6(v6) => v6.is_loopback() || v6.is_unicast_link_local(),
        })
        .unwrap_or(false)
}

/// 跳转裁决（纯函数，供 `redirect_policy` 与单测共用）：
///
/// reqwest 默认跟随 10 跳且不重过 egress L1/L2/L3——外部 API 302 到内网/
/// 云元数据即直连（SSRF 面）。同步策略上下文无法弹窗，故私有目标跳转按
/// 白名单 fail-closed：
/// - 公网目标：跟随（首跳已过 L1/L2/L3 校验，公网→公网无新增面）；
/// - 已声明桌面端目标（L1）：跟随（本机 LAN 服务站内跳转）；
/// - 与链上前序 URL 同源：跟随（同 host:port 跳转不变更目标面）；
/// - 其余私有目标：Stop（调用方拿到 3xx 自行处理）。
pub fn redirect_decision(next_url: &str, previous: &[&str]) -> bool {
    let Some(parsed) = parse_url_lite(next_url) else {
        return false; // 非法跳转目标 fail-closed
    };
    if !is_private_ip(&parsed.host) {
        return true;
    }
    if policy().is_desktop_target(&parsed.host, parsed.port) {
        return true;
    }
    let prev: Vec<LiteUrl> = previous.iter().filter_map(|u| parse_url_lite(u)).collect();
    if prev.iter().any(|p| p.host == parsed.host && p.port == parsed.port) {
        return true; // 同源跳转
    }
    // 前序全为私有地址：私网→私网链路（如 NAS 服务跳转），维持跟随
    !prev.is_empty() && prev.iter().all(|p| is_private_ip(&p.host))
}

/// reqwest 跳转策略：`redirect_decision` 的适配层（同步裁决，见其文档）
pub fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let prev: Vec<&str> = attempt.previous().iter().map(|u| u.as_str()).collect();
        if redirect_decision(attempt.url().as_str(), &prev) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}
