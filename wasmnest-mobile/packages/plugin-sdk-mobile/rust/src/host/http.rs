//! 宿主能力：HTTP 代理

use super::HostError;

/// HTTP 代理（宿主代为发起请求，插件不直接接触网络）
///
/// 需要 `network:http` 权限。请求格式：
/// ```json
/// { "method": "POST", "url": "https://...", "headers": { ... }, "body": "..." }
/// ```
/// 返回完整响应 `{ status, body, headers }`。
pub trait HostHttp {
    /// 发起 HTTP 请求
    fn http_fetch(
        &self,
        request: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, HostError>;

    /// 出站批量授权提前询问（只询问、不发请求）
    ///
    /// 移动端 v1 没有批量弹窗面，宿主的批量端口默认实现返回「本端不支持」，
    /// 本方法会显性返回 `consent.unsupported`；调用方应回退到逐个
    /// [`HostHttp::http_fetch`]，不得把失败伪装成已授权。需要 `network:http` 权限。
    fn request_egress_consent(&self, request_json: &str) -> Result<String, HostError>;
}
