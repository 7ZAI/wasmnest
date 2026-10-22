//! 应用界面 → `net.transport` 租约薄壳（service-leases）
//!
//! 端点注册（`host-http-endpoint.register-endpoint` /
//! `host-websocket-server.register-endpoint`）只写宿主内存路由表，**不启动监听器**：
//! 路由表独立于 Actix 服务器，服务器启动后按请求查表。传输面的启动信号是
//! **应用界面打开**——外壳挂载应用整包时调用 `plugin_surface_open`，卸载时调用
//! `plugin_surface_close`。只有该插件已注册 HTTP/WS 端点时才 acquire，避免
//! 无网络面的应用制造无意义广播。
//!
//! 这样 boot 期注册路由的基础设施应用（认证中心等）不会仅因「注册了端点」就
//! 对外广播；用户真正打开应用界面时传输面才启动，关闭最后一个界面即停播。
//!
//! 无注册表（无头 / 测试装配）→ no-op + 首次 `warn`；生产 boot 有装配锁。

use std::sync::Arc;

use wasmnest_server_base::service::ServiceRegistry;
use wasmnest_server_core::service::TRANSPORT_SERVICE_KEY;

fn warn_no_lease_assembly(api: &str) {
    static WARNED: std::sync::Once = std::sync::Once::new();
    WARNED.call_once(|| {
        tracing::warn!(
            api = %api,
            "service lease registry not assembled (headless/test); \
             app surface open/close falls back to no-op without holder accounting"
        );
    });
}

/// 插件是否已注册传输面端点（HTTP 或 WS 任一）。
///
/// 以端点注册表为单一事实源：没有端点的应用不因界面打开而拉起传输面。
pub fn plugin_uses_transport(plugin_id: &str) -> bool {
    wasmnest_server_http::registry::count_by_owner(plugin_id) > 0
        || wasmnest_server_websocket::endpoint::count_by_owner(plugin_id) > 0
}

/// 应用界面打开：为该插件 acquire `net.transport`（幂等）。
pub async fn acquire_for_surface(
    registry: Option<Arc<ServiceRegistry>>,
    plugin_id: &str,
    api: &str,
) -> Result<(), String> {
    if !plugin_uses_transport(plugin_id) {
        return Ok(());
    }
    let Some(registry) = registry else {
        warn_no_lease_assembly(api);
        return Ok(());
    };
    registry
        .acquire(TRANSPORT_SERVICE_KEY, plugin_id)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 应用界面关闭：释放该插件的引用（未持有时幂等成功——可能已被插件生命周期回收）。
pub async fn release_for_surface(
    registry: Option<Arc<ServiceRegistry>>,
    plugin_id: &str,
    api: &str,
) -> Result<(), String> {
    let Some(registry) = registry else {
        warn_no_lease_assembly(api);
        return Ok(());
    };
    registry
        .release(TRANSPORT_SERVICE_KEY, plugin_id)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}
