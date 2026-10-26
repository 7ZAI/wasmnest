//! 应用作用域服务租约薄壳（service-leases）
//!
//! 端点注册（`host-http-endpoint.register-endpoint` /
//! `host-websocket-server.register-endpoint`）只写宿主内存路由表，**不启动监听器**：
//! 路由表独立于 Actix 服务器，服务器启动后按请求查表。传输面（`net.transport`：
//! WS + HTTP 同端口 + mDNS 广播）由**应用作用域租约**驱动，本模块是宿主侧的
//! **界面租约**薄壳：
//!
//! - **界面租约**（未声明 `backgroundTransport` 的应用）：界面打开
//!   （`plugin_surface_open`）acquire，关闭最后一个界面（`plugin_surface_close`）
//!   release。boot 期注册路由的基础设施应用不会仅因「注册了端点」就对外广播；
//!   用户真正打开应用界面时传输面才启动，关闭最后一个界面即停播。
//! - **运行期租约**（manifest `backgroundTransport: true` 的服务端型应用）由
//!   内核在**启动成功后**建（`wasm-core` activation：端点事实 + manifest 声明 +
//!   本端装配检查），停用 / 启动失败 / Error 由内核 `release_all_for` 回收；
//!   界面开关不参与（命令层拦截，见 `commands.rs`）。**不在本模块重复实现**。
//!
//! 两种租约都只对**已注册 HTTP/WS 端点**的应用生效（`plugin_uses_transport`），
//! 避免无网络面的应用制造无意义广播；同一插件的租约按 holder 幂等记账，
//! 多作用域重叠不会重复启动服务。
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

/// 为该插件 acquire `net.transport`（幂等；调用方已确认端点存在）。
async fn acquire_lease(registry: Option<Arc<ServiceRegistry>>, plugin_id: &str, api: &str) -> Result<(), String> {
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

/// 应用界面打开：为该插件 acquire `net.transport`（幂等）。
///
/// 仅用于**未声明** `backgroundTransport` 的应用；声明了运行期租约的应用由内核
/// 在启动成功后持有，界面开关不再参与（宿主命令层拦截）。
pub async fn acquire_for_surface(
    registry: Option<Arc<ServiceRegistry>>,
    plugin_id: &str,
    api: &str,
) -> Result<(), String> {
    if !plugin_uses_transport(plugin_id) {
        return Ok(());
    }
    acquire_lease(registry, plugin_id, api).await
}

/// 应用界面关闭：释放该插件的引用（未持有时幂等成功——可能已被插件生命周期回收）。
///
/// 仅用于**未声明** `backgroundTransport` 的应用；声明了运行期租约的应用在界面
/// 卸载时仍处于运行期，宿主命令层拦截，不得在这里释放（否则服务端属性随界面
/// 一起消失，回到「挂载决定 8775 生死」的旧病）。
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
