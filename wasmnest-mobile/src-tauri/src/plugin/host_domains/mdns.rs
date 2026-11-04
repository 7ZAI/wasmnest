//! host-mdns 移动端平台缝（`DiscoveryPorts` 的宿主实现 + 进程级装配）
//!
//! `host-mdns` 的 WIT 实现与五条原语的机制（共享守护 / 双句柄表 / 属主仲裁 /
//! 事件定向投递 / re-announce / purge）全部在能力仓
//! [`wasmnest_discovery_engine`]：该 crate 的 `common-host` 绑定层自报
//! `DiscoveryModule` 并 `impl Host for WasmPluginState`，宿主**不再自持**
//! `impl host_mdns::Host` 与逐条薄转发（同一 interface 两份 `add_to_linker`
//! 注册 ⇒ 装配期 `defined twice`）。
//!
//! 本模块只剩能力域要求宿主注入的四个平台差异面：权限门 / 自播回显节点 ID /
//! 总线发布 / 运行时任务派生。
//!
//! ## 为什么是进程级 + 按 plugin_id 动态判权
//!
//! 能力域的 `Host` impl 取 `ports::ports()`（进程级一格），故端口必须自己按
//! 调用方 `plugin_id` 结算权限——与桌面 `HostDiscoveryPorts`（持宿主上下文、
//! 每次调用问 `PermissionManager`）和移动 `plugin/peer_ports.rs` 同形。
//! 旧形态在构造期把 `permitted` 快照进端口，只适用于「逐插件实例传参」的自持
//! adapter；脱绑后快照会让所有插件共用一格授权，故改为逐次查真源。
//!
//! 守护单例真源：统一指向引擎的 `DAEMON`（Android 多播锁经
//! `engine::set_daemon_init_hook` 平台钩子装配，宿主 src-tauri 初始化期注册）。
//! 防回接锁：**本 crate 零 `ServiceDaemon::new()`**——任何新建守护都会打破
//! 「单守护」红线（双守护同绑 5353 互抢多播包）。
//!
//! 浏览面第二层不变量（ADR 0054 / 票 04）：全进程对同一服务类型的
//! `daemon.browse` / `stop_browse` 只由引擎的**类型中枢**
//! （`wasmnest_discovery_engine::type_hub`）代持，宿主侧零 `daemon.browse`。
//! 中枢的泵任务经 `DiscoveryPorts::spawn` 派生，故进程级端口必须在任何
//! `subscribe_type` 之前装入（[`register_process_ports`]）——未装即 fail-visible panic。
//!
//! 行为契约（句柄表 / 属主隔离 / purge / topic 形状）由引擎自身单测覆盖，
//! 本模块只保平台缝语义断言。

use std::sync::Arc;
use wasmnest_discovery_engine::ports::{BoxedTask, DiscoveryPorts, DiscoveryTask};
use wasmnest_wasm_core::permission::PERMISSION_MDNS;

// 能力模块白名单条目与强制引用行**必须同处**（本文件），两者不漂移——漏引用 ⇒
// 该 crate 的 inventory 自报静态不进最终二进制（装载期 missing 方向点名）；漏白名单
// ⇒ unlisted 方向点名。判据与纪律见 `wasmnest_host_kit::assembly` 模块文档。
wasmnest_host_kit::expect_host_module!(wasmnest_discovery_engine::MODULE_NAME);
use wasmnest_discovery_engine as _;

// ==================== 移动端 DiscoveryPorts 适配器 ====================

/// 移动端平台缝：进程级单份，按调用方 `plugin_id` 逐次结算权限。
///
/// 事件线程 / 续期任务会克隆本端口并长期持有（`'static`），故字段只放
/// 可克隆宿主句柄；总线与权限真源都在调用期经 `state::try_get_plugin_manager()`
/// 取（装配早于插件管理器初始化，故不能在构造期快照）。
pub struct MobileDiscoveryPorts {
    /// 宿主 AppHandle（自播回显过滤读本机节点 ID）；无头 / 测试为 None
    app: Option<Arc<tauri::AppHandle>>,
}

impl MobileDiscoveryPorts {
    /// 生产装配（boot 期传入 app 句柄）
    pub fn new(app: Option<Arc<tauri::AppHandle>>) -> Self {
        Self { app }
    }

    fn manager() -> Option<Arc<crate::plugin::manager::PluginManager>> {
        crate::state::try_get_plugin_manager()
    }
}

/// 进程级端口装配（宿主开机期一次，幂等：`install_ports` 首装胜出）
///
/// 无头探针（`tests/shared_artifact_probe`）走同一入口传 `None`——装的是生产
/// 适配器的无头形态，不是自造替身。
pub fn register_process_ports(app: Option<Arc<tauri::AppHandle>>) {
    wasmnest_discovery_engine::ports::install_ports(Arc::new(MobileDiscoveryPorts::new(app)));
}

/// 宿主运行时任务包装（tauri async_runtime JoinHandle → `DiscoveryTask`）
struct TauriSpawnedTask(tauri::async_runtime::JoinHandle<()>);

impl DiscoveryTask for TauriSpawnedTask {
    fn cancel(&self) {
        self.0.abort();
    }
}

impl DiscoveryPorts for MobileDiscoveryPorts {
    fn check_permission(&self, plugin_id: &str, api: &str) -> bool {
        // 权限门留宿主（AGENTS §5.1.3 安全闸门不可插拔）：真源 = 内核
        // PermissionManager，与移动 peer 端口同一条判定与 warn 路径。
        // 拿不到管理器（无头 / 未初始化）一律 false（fail-safe）。
        let Some(pm) = Self::manager() else {
            tracing::warn!(
                plugin_id = %plugin_id,
                permission = %PERMISSION_MDNS,
                api = %api,
                "mdns permission denied (plugin manager not initialized)"
            );
            return false;
        };
        // `has_permission` 是 async（plugins 为 tokio RwLock）——经 wasm-core 唯一
        // 那份同步桥驱动（host fn 线程可能是 worker / 已让出 / 纯 std 线程）
        let allowed = wasmnest_wasm_core::runtime_util::block_on_async(pm.has_permission(plugin_id, PERMISSION_MDNS));
        if !allowed {
            tracing::warn!(
                plugin_id = %plugin_id,
                permission = %PERMISSION_MDNS,
                api = %api,
                "mdns permission denied"
            );
        }
        allowed
    }

    fn local_node_id(&self) -> Option<String> {
        // 自播回显过滤：browse 会收到本机自己的广播（TXT `id` == 节点 ID）。
        // 无 app 句柄（无头 / 测试）或节点未启动时返回 None ⇒ 引擎不拦截
        let app = self.app.as_ref()?;
        crate::peer::net::current_node_id(app.as_ref())
    }

    fn publish(&self, topic: &str, payload: serde_json::Value) {
        // 总线订阅方隔离属宿主门禁；sender 恒 "host"（总线过滤「发布者==订阅者」，
        // 用插件 id 会把自己的事件一起滤掉，与历史 publish_mdns 语义一致）
        if let Some(pm) = Self::manager() {
            pm.message_bus().publish(topic, "host", payload);
        }
    }

    fn spawn(&self, task: BoxedTask) -> Arc<dyn DiscoveryTask> {
        Arc::new(TauriSpawnedTask(tauri::async_runtime::spawn(task)))
    }

    // 能力路由：移动端无 core-plugin-manager → 恒 None（契约保留，语义 =
    // 无提供者走引擎，逐字与桌面「无提供者落引擎」一致）
    fn forward_mdns_browse(&self, _plugin_id: &str, _service_type: &str) -> Option<Result<String, String>> {
        None
    }

    fn forward_mdns_stop_browse(&self, _plugin_id: &str, _browser_id: &str) -> Option<Result<bool, String>> {
        None
    }

    fn forward_mdns_advertise(&self, _plugin_id: &str, _config_json: &str) -> Option<Result<String, String>> {
        None
    }

    fn forward_mdns_stop_advertise(&self, _plugin_id: &str, _advertise_id: &str) -> Option<Result<bool, String>> {
        None
    }

    fn forward_mdns_is_advertising(&self, _plugin_id: &str, _advertise_id: &str) -> Option<Result<bool, String>> {
        None
    }
}

// ==================== 双表回收 ====================

/// 回收指定插件的全部浏览 + 广播句柄（插件停用/卸载时经宿主聚合入口调用）。
/// 只回收本人句柄；其余插件与宿主（owner=host）登记不受影响。
///
/// 移动宿主不遍历 host-kit `DomainHooksRegistry`（桌面走该钩子），故停用回收
/// 由本入口显式承担；端口取进程级那一格，与 `Host` impl 同源。
pub(crate) fn purge_for_plugin(plugin_id: &str) -> usize {
    wasmnest_discovery_engine::engine::purge_for_plugin(plugin_id, &wasmnest_discovery_engine::ports::ports())
}

// ==================== Tests（平台缝语义，零运行时 / 零真实守护依赖） ====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 平台缝端口（无头形态：无 app、无插件管理器）
    fn headless_ports() -> Arc<dyn DiscoveryPorts> {
        Arc::new(MobileDiscoveryPorts::new(None))
    }

    /// 权限门 fail-closed：拿不到权限真源时全部浏览/广播原语在引擎权限门处
    /// 直接拒绝——零守护触网。脱绑后这条判定是宿主唯一保留的安全面。
    #[tokio::test]
    async fn mdns_denied_without_permission_short_circuits_before_daemon() {
        let ports = headless_ports();
        let engine = wasmnest_discovery_engine::engine::browse;
        assert_eq!(
            engine(&ports, "deny-a", "_test._tcp.local."),
            Err("permission denied: mdns".to_string())
        );
        assert_eq!(
            wasmnest_discovery_engine::engine::advertise(
                &ports,
                "deny-a",
                r#"{"serviceType":"_t._cp.local.","port":1}"#
            ),
            Err("permission denied: mdns".to_string())
        );
        assert_eq!(
            wasmnest_discovery_engine::engine::stop_advertise(&ports, "deny-a", "mdnsad-x"),
            Err("permission denied: mdns".to_string())
        );
        assert_eq!(
            wasmnest_discovery_engine::engine::is_advertising(&ports, "deny-a", "mdnsad-x"),
            Err("permission denied: mdns".to_string())
        );
    }

    /// 无头形态不拦自播回显（无 app 句柄 ⇒ 节点 ID 不可知 ⇒ None）
    #[test]
    fn headless_ports_do_not_filter_self_broadcast() {
        assert_eq!(headless_ports().local_node_id(), None);
    }

    /// purge 空表零副作用（进程级端口未装时本用例自带一格，不触守护）
    #[tokio::test]
    async fn purge_empty_table_is_noop() {
        let ports = headless_ports();
        assert_eq!(
            wasmnest_discovery_engine::engine::purge_for_plugin("ghost-plugin", &ports),
            0
        );
    }

    /// 脱绑装配锁：白名单声明 + 接口路径 + 权限位三件与能力域描述符逐字一致。
    /// 漏 `expect_host_module!` / 强制引用行即装载期点名，本用例在单测期先红。
    #[test]
    fn host_module_declaration_matches_capability_domain_desc() {
        let module_name = wasmnest_discovery_engine::MODULE_NAME;
        assert!(
            wasmnest_host_kit::expected_host_modules().contains(&module_name),
            "能力模块白名单缺 {module_name}（expect_host_module! 行被删 / 未收集）"
        );
        assert_eq!(
            wasmnest_discovery_engine::MODULE_INTERFACES,
            &["wasmnest:plugin@0.0.2/host-mdns"],
            "接口路径必须与 WIT 契约逐字一致（改错即 guest import 失配）"
        );
        assert_eq!(
            wasmnest_discovery_engine::MODULE_PERMISSIONS,
            &["network:mdns"],
            "权限位必须与 SDK 权限表逐字一致"
        );
        // 宿主自身不得再声明该接口（两份 add_to_linker ⇒ 装配期 defined twice）
        assert!(
            !super::super::MODULE_INTERFACES.contains(&"wasmnest:plugin@0.0.2/host-mdns"),
            "host-mdns 已由能力 lib 自报，宿主 mobile-host-core 不得重复声明"
        );
    }
}
