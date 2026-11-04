//! 移动宿主 host-peer 端口（`PeerPorts` 实现 + 开机装配）
//!
//! host-peer 域的**全部**机制（19 条原语 + `Host` impl + 句柄表 / 属主仲裁 /
//! 自动重拨 / 载荷校验 + 能力模块自报）在共享能力域 `wasmnest-server-peer-net`
//! 的 `common-host` 绑定层；宿主经依赖导入获得该接口实现，**自身零 WIT 代码**。
//! 本文件是宿主侧仅剩的一半——注入 lib 定义的平台差异端口，lib 经
//! `plugin_binding::ports::ports()` 取用（桌面同构先例
//! `wasmnest-desktop/src-tauri/src/plugin/peer.rs`）。
//!
//! 三个端口方法即「离宿主无法实现」的三件事：
//!
//! - [`PeerPorts::check_permission`]：权限门（安全闸门不外出）——复用移动唯一
//!   权限判定 `PluginManager::has_permission`（真源 = 内核 `PermissionManager`，
//!   与桌面 `host_api::check_permission` 同一份）；manager 未初始化一律拒绝
//!   （fail-safe）。拒绝时宿主侧落 `warn`（结构化字段，AGENTS §8），能力域不重复落日志。
//! - [`PeerPorts::peer_ctx`]：引擎上下文装配（`crate::peer::net::peer_ctx` 是
//!   唯一认识 `AppHandle` 的引擎装配点）；无头（未持 AppHandle）返回能力域
//!   定义的 `HEADLESS_UNAVAILABLE` 文案，不做静默降级。
//! - [`PeerPorts::block_on_any`]：同步↔异步桥——复用 wasm-core 唯一那份
//!   `runtime_util::block_on_async`（block_in_place / 重入检测 / ambient
//!   runtime 语义是实测产物，能力域与宿主都不复制第二份）。
//!
//! 装配点：`PluginManager::init_wasm_runtime_with`（与既有 `HostPorts` 同处
//! 开机期）。crate 侧是进程级 `OnceLock`、首装胜出；未装配时 wasm-core 侧
//! 取端口即 panic（fail-visible，见 crate `ports::ports` 文档）。

use std::any::Any;
use std::sync::Arc;

use wasmnest_server_peer_net::plugin_binding::ports::{BoxedBlocked, PeerPorts, HEADLESS_UNAVAILABLE};
use wasmnest_server_peer_net::PeerCtx;

// 能力模块白名单条目与强制引用行**必须同处**（本文件），两者不漂移——漏引用 ⇒
// 该 crate 的 inventory 自报静态不进最终二进制（装载期 missing 方向点名）；漏白名单
// ⇒ unlisted 方向点名。判据与纪律见 `wasmnest_host_kit::assembly` 模块文档。
wasmnest_host_kit::expect_host_module!(wasmnest_server_peer_net::plugin_binding::MODULE_NAME);
use wasmnest_server_peer_net as _;

/// 端口的宿主实现（持 AppHandle；无头 / 测试为 `None`）
pub struct HostPeerPorts {
    app: Option<Arc<tauri::AppHandle>>,
    /// 应用作用域服务注册表（与桌面同机制；节点启停按插件 id 记账）
    service_registry: Arc<wasmnest_server_base::service::ServiceRegistry>,
}

impl HostPeerPorts {
    pub fn new(
        app: Option<Arc<tauri::AppHandle>>,
        service_registry: Arc<wasmnest_server_base::service::ServiceRegistry>,
    ) -> Self {
        Self { app, service_registry }
    }
}

impl PeerPorts for HostPeerPorts {
    fn check_permission(&self, plugin_id: &str, permission: &str, api: &str) -> bool {
        let Some(pm) = crate::state::try_get_plugin_manager() else {
            tracing::warn!(
                plugin_id = %plugin_id,
                permission = %permission,
                api = %api,
                "peer permission denied (plugin manager not initialized)"
            );
            return false;
        };
        // `has_permission` 是 async（plugins 为 tokio RwLock）——经 wasm-core 唯一
        // 那份同步桥驱动；host fn 线程可能是 worker / 已让出 / 纯 std 线程，
        // 桥内已按 runtime flavor 分流（见 runtime_util 模块文档）
        let allowed = wasmnest_wasm_core::runtime_util::block_on_async(pm.has_permission(plugin_id, permission));
        if !allowed {
            tracing::warn!(
                plugin_id = %plugin_id,
                permission = %permission,
                api = %api,
                "peer permission denied"
            );
        }
        allowed
    }

    fn peer_ctx(&self) -> Result<Arc<PeerCtx>, String> {
        // 引擎装配动作留宿主；无头口径与文案由能力域定义（HEADLESS_UNAVAILABLE），
        // 宿主只汇报「取不到」
        let app = self.app.as_ref().ok_or_else(|| HEADLESS_UNAVAILABLE.to_string())?;
        Ok(crate::peer::net::peer_ctx(app))
    }

    fn block_on_any(&self, fut: BoxedBlocked) -> Box<dyn Any + Send> {
        // 复用 wasm-core 唯一那份同步桥（见模块头注第 3 条）
        wasmnest_wasm_core::runtime_util::block_on_async(fut)
    }

    fn service_registry(&self) -> Option<Arc<wasmnest_server_base::service::ServiceRegistry>> {
        // 生产装配恒为 Some：host-peer.start-node / stop-node 按插件引用记账
        Some(Arc::clone(&self.service_registry))
    }
}

/// 装配进程级端口（开机期调用一次；crate 侧 OnceLock 幂等——首装胜出）
pub fn install(
    app: Option<Arc<tauri::AppHandle>>,
    service_registry: Arc<wasmnest_server_base::service::ServiceRegistry>,
) {
    wasmnest_server_peer_net::plugin_binding::install_ports(Arc::new(HostPeerPorts::new(app, service_registry)));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 生产装配锁：移动 host-peer 端口必须暴露服务注册表（节点启停按引用记账，
    /// 不走「无租约兼容路径」）。
    #[test]
    fn production_port_always_exposes_service_registry() {
        let registry = Arc::new(wasmnest_server_base::service::ServiceRegistry::new());
        let ports = HostPeerPorts::new(None, registry);
        assert!(ports.service_registry().is_some(), "移动生产端口必须装配服务注册表");
    }

    /// 脱绑装配锁：白名单声明 + 接口路径 + 权限位三件与能力域描述符逐字一致。
    /// 漏 `expect_host_module!` / 强制引用行即装载期点名，本用例在单测期先红。
    #[test]
    fn host_module_declaration_matches_capability_domain_desc() {
        let module_name = wasmnest_server_peer_net::plugin_binding::MODULE_NAME;
        assert!(
            wasmnest_host_kit::expected_host_modules().contains(&module_name),
            "能力模块白名单缺 {module_name}（expect_host_module! 行被删 / 未收集）"
        );
        assert_eq!(module_name, "peer-net", "白名单键即装载期日志与错误文案里的模块名");
        assert_eq!(
            wasmnest_server_peer_net::plugin_binding::MODULE_INTERFACES,
            &["wasmnest:plugin@0.0.2/host-peer"],
            "接口路径必须与 WIT 契约逐字一致（改错即 guest import 失配）"
        );
        assert_eq!(
            wasmnest_server_peer_net::plugin_binding::MODULE_PERMISSIONS,
            &["peer"],
            "权限位必须与 SDK 权限表逐字一致"
        );
        // 宿主自身不得再声明该接口（两份 add_to_linker ⇒ 装配期 defined twice）
        assert!(
            !crate::plugin::host_domains::MODULE_INTERFACES.contains(&"wasmnest:plugin@0.0.2/host-peer"),
            "host-peer 已由能力 lib 自报，宿主 mobile-host-core 不得重复声明"
        );
    }
}
