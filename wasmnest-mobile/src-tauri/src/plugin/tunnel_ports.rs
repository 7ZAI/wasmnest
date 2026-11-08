//! 移动宿主 host-tunnel 端口（`TunnelPorts` 实现 + 开机装配，T06）
//!
//! 域机制（首帧 / 票据 / 准入 / 本地回环代理 / 单一引用计数 / WIT 绑定）在共享
//! 能力域 `wasmnest-server-peer-net::tunnel`；宿主只注入平台差异的四个端口。
//!
//! ## 移动端形态
//!
//! - **客户端为主**：`connect` / `close` 可用（本地代理只绑 `127.0.0.1`）；
//! - **没有对等 HTTP/WS 面**：`expose` / `issue-pairing-ticket` 由
//!   [`MobilePeerFaceStarter`] 返回能力域定义的 `tunnel-unavailable`（显性失败，
//!   不伪装成「暴露成功但没人能连」）；T09 若需要服务端能力再单独实现该面。
//!
//! 装配点：`lib.rs` setup（`PluginManager` 的服务注册表就绪之后、任何插件激活之前）。
//! 管理器是进程级单例：端口对象只读，重复装配被忽略（首装胜出）。

use std::any::Any;
use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use wasmnest_server_base::face::PeerFaceResolver;
use wasmnest_server_base::service::ServiceRegistry;
use wasmnest_server_peer_net::tunnel::plugin_binding::{BoxedBlocked, TunnelPorts};
use wasmnest_server_peer_net::tunnel::{
    PeerFaceListener, PeerFaceStarter, TunnelError, TunnelManager, CODE_TUNNEL_UNAVAILABLE,
};

// 能力模块白名单条目与强制引用行**必须同处**（本文件），两者不漂移。
wasmnest_host_kit::expect_host_module!(wasmnest_server_peer_net::tunnel::plugin_binding::MODULE_NAME);
use wasmnest_server_peer_net as _;

/// 进程级隧道管理器（boot 期装配；端口对象只读）
static MANAGER: OnceLock<Arc<TunnelManager>> = OnceLock::new();

/// boot 期装配管理器（任何插件激活之前；重复装配被忽略）
pub fn install_manager(manager: Arc<TunnelManager>) {
    let _ = MANAGER.set(manager);
}

fn manager() -> Option<Arc<TunnelManager>> {
    MANAGER.get().cloned()
}

/// 移动端对等面启动器：本端不提供宿主 HTTP/WS 暴露面，显性失败
pub struct MobilePeerFaceStarter;

#[async_trait]
impl PeerFaceStarter for MobilePeerFaceStarter {
    async fn start(&self, _resolver: PeerFaceResolver) -> wasmnest_server_peer_net::tunnel::Result<PeerFaceListener> {
        Err(TunnelError::new(
            CODE_TUNNEL_UNAVAILABLE,
            "移动端不提供对等 HTTP/WS 面（expose / issue-pairing-ticket 不可用；客户端 connect 不受影响）",
        ))
    }
}

/// 端口实现（持 AppHandle；无头 / 测试为 None）
pub struct HostTunnelPorts {
    /// 保留宿主句柄以与 peer 端口同形（权限门走全局 PluginManager；当前无第二消费者）
    #[allow(dead_code)]
    app: Option<Arc<tauri::AppHandle>>,
    service_registry: Arc<ServiceRegistry>,
}

impl HostTunnelPorts {
    pub fn new(app: Option<Arc<tauri::AppHandle>>, service_registry: Arc<ServiceRegistry>) -> Self {
        Self { app, service_registry }
    }

    fn check_permission_inner(&self, plugin_id: &str, permission: &str, api: &str) -> bool {
        let Some(pm) = crate::state::try_get_plugin_manager() else {
            tracing::warn!(
                plugin_id = %plugin_id,
                permission = %permission,
                api = %api,
                "tunnel permission denied (plugin manager not initialized)"
            );
            return false;
        };
        let allowed = wasmnest_wasm_core::runtime_util::block_on_async(pm.has_permission(plugin_id, permission));
        if !allowed {
            tracing::warn!(
                plugin_id = %plugin_id,
                permission = %permission,
                api = %api,
                "tunnel permission denied"
            );
        }
        allowed
    }
}

impl TunnelPorts for HostTunnelPorts {
    fn check_permission(&self, plugin_id: &str, permission: &str, api: &str) -> bool {
        self.check_permission_inner(plugin_id, permission, api)
    }

    fn tunnel_manager(&self) -> Option<Arc<TunnelManager>> {
        manager()
    }

    fn block_on_any(&self, fut: BoxedBlocked) -> Box<dyn Any + Send> {
        wasmnest_wasm_core::runtime_util::block_on_async(fut)
    }

    fn service_registry(&self) -> Option<Arc<ServiceRegistry>> {
        Some(Arc::clone(&self.service_registry))
    }
}

/// 装配进程级端口（开机期一次；crate 侧 OnceLock 幂等——首装胜出）
pub fn install(app: Option<Arc<tauri::AppHandle>>, service_registry: Arc<ServiceRegistry>) {
    wasmnest_server_peer_net::tunnel::plugin_binding::install_ports(Arc::new(HostTunnelPorts::new(
        app,
        service_registry,
    )));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_port_always_exposes_service_registry() {
        let registry = Arc::new(ServiceRegistry::new());
        let ports = HostTunnelPorts::new(None, registry);
        assert!(ports.service_registry().is_some(), "移动生产端口必须装配服务注册表");
        assert!(ports.app.is_none(), "无头装配不持 AppHandle（端口仍须可用）");
    }

    #[test]
    fn host_module_declaration_matches_capability_domain_desc() {
        let module_name = wasmnest_server_peer_net::tunnel::plugin_binding::MODULE_NAME;
        assert!(
            wasmnest_host_kit::expected_host_modules().contains(&module_name),
            "能力模块白名单缺 {module_name}（expect_host_module! 行被删 / 未收集）"
        );
        assert_eq!(module_name, "tunnel");
        assert_eq!(
            wasmnest_server_peer_net::tunnel::plugin_binding::MODULE_INTERFACES,
            &["wasmnest:tunnel@0.0.1/host-tunnel"]
        );
        assert_eq!(
            wasmnest_server_peer_net::tunnel::plugin_binding::MODULE_PERMISSIONS,
            &["tunnel:serve", "tunnel:connect"]
        );
        assert!(
            !crate::plugin::host_domains::MODULE_INTERFACES.contains(&"wasmnest:tunnel@0.0.1/host-tunnel"),
            "host-tunnel 已由能力 lib 自报，宿主 mobile-host-core 不得重复声明"
        );
    }
}
