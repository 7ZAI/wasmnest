//! 应用作用域服务租约装配锁（移动端 · service-leases §6.2 / §9.3）
//!
//! 移动宿主不经桌面 `PluginHost`，注册表由 `PluginManager` 持有并注入 wasm 宿主
//! 上下文。锁住三件事：
//! 1. boot 注册 `net.peer-node` 并显式预热平台资源（过去由节点启动顺手完成）；
//! 2. 激活失败 / 停用 / Error 三条路径走通用 `release_all_for`；
//! 3. 无产品 id 硬编码 / 无旧属主模型残留。

use std::path::{Path, PathBuf};

/// 移动 `PluginManager` 已按职责拆成 `plugin/manager/` 模块目录（`mod.rs` 装配 /
/// `lifecycle.rs` 生命周期 / `loading.rs` 装载），锁按**模块树**读取而不是单文件
/// `plugin/manager.rs`：拆分后旧单文件路径直接 `ENOENT` 让整条锁 panic——路径与拆
/// 分形态必须一起对账，不得靠「读不到就跳过」静默失效。
const MANAGER_MODULES: &[&str] = &[
    "src/plugin/manager/mod.rs",
    "src/plugin/manager/lifecycle.rs",
    "src/plugin/manager/loading.rs",
];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn read(rel: &str) -> String {
    std::fs::read_to_string(root().join(rel)).unwrap_or_else(|e| panic!("读取 {rel} 失败：{e}"))
}

/// 模块树拼接（每段带文件名头，报错时能定位到具体模块）
fn manager_source() -> String {
    MANAGER_MODULES
        .iter()
        .map(|rel| format!("// ===== {rel} =====\n{}", read(rel)))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn boot_registers_peer_node_service_and_prewarms_platform() {
    let lib = read("src/lib.rs");
    for needle in [
        "PeerNodeService::register",
        "plugin_manager.service_registry()",
        "prewarm_platform",
        "shutdown_all",
    ] {
        assert!(
            lib.contains(needle),
            "移动 boot 缺少 `{needle}`（服务租约装配 / 退出兜底漂移）"
        );
    }
}

#[test]
fn manager_injects_registry_and_releases_on_all_exit_paths() {
    let manager = manager_source();
    for needle in [
        "set_service_registry",
        "release_services_for",
        "release_all_for",
        "service_registry: Arc<wasmnest_server_base::service::ServiceRegistry>",
    ] {
        assert!(
            manager.contains(needle),
            "PluginManager 模块树缺少 `{needle}`（注册表注入或生命周期回收漂移）"
        );
    }
}

#[test]
fn peer_ports_expose_service_registry_in_production() {
    let ports = read("src/plugin/peer_ports.rs");
    assert!(
        ports.contains("fn service_registry"),
        "移动 host-peer 端口必须实现 service_registry()"
    );
    assert!(
        ports.contains("Some(Arc::clone(&self.service_registry))"),
        "生产端口必须恒返回 Some(注册表)，不得走无租约兼容路径"
    );
}

#[test]
fn old_host_driven_peer_owner_model_stays_retired() {
    // 源码级防回接（注释行豁免：解释「为什么删」的记账不算回接）
    let scanned: Vec<&str> = MANAGER_MODULES
        .iter()
        .copied()
        .chain(["src/peer/net.rs", "src/plugin/host_ports.rs"])
        .collect();
    for rel in scanned {
        let src = read(rel);
        for (idx, raw) in src.lines().enumerate() {
            let line = raw.trim_start();
            if line.starts_with("//") {
                continue;
            }
            for forbidden in [
                "FILE_TRANSFER_PLUGIN_ID",
                "ensure_node_started",
                "stop_node_for_plugin",
                "sync_node_with_plugin_state",
                "node_owner",
                "start_node_owned",
                "stop_node_owned",
                "release_node_for",
            ] {
                assert!(
                    !line.contains(forbidden),
                    "{rel}:{} 旧属主模型词汇回接：{forbidden}",
                    idx + 1
                );
            }
        }
    }
}
