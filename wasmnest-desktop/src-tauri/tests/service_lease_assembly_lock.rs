//! 应用作用域服务租约装配锁（service-leases §9.4 门禁）
//!
//! 无头 / rig 走「无租约兼容路径」是装配形态差异，不是静默降级——生产装配必须
//! 有锁钉住，否则漏注入会让 `host-http-endpoint.register-endpoint` 只注册路由却
//! 永不拉起传输面（设备不可见，且日志只有一条 warn）。
//!
//! 本锁只做**源码结构断言**：生产 boot 的装配点 / 顺序 / 退役命令面 / 应用界面租约
//! （挂载 → acquire、卸载 → release）/ 退出链。行为由 `service_lease_lifecycle.rs`
//! 集成测试验收。

use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn read(rel: &str) -> String {
    std::fs::read_to_string(root().join(rel)).unwrap_or_else(|e| panic!("读取 {rel} 失败：{e}"))
}

/// 首次出现位置（缺即红，避免拼写漂移让断言静默失效）
fn pos(haystack: &str, needle: &str, file: &str) -> usize {
    haystack
        .find(needle)
        .unwrap_or_else(|| panic!("{file} 缺少 `{needle}`（装配点漂移）"))
}

#[test]
fn boot_assembles_and_injects_service_registry_before_plugin_host() {
    let lib = read("src/lib.rs");
    let ports = pos(&lib, "install_server_ports_with", "lib.rs");
    let registry = pos(&lib, "ServiceRegistry::new()", "lib.rs");
    let transport = pos(&lib, "TransportService::register", "lib.rs");
    let peer = pos(&lib, "PeerNodeService::register", "lib.rs");
    // 注释里多次提到 `PluginHost::new` / `apply_autostart`，取**实际调用**形态
    let plugin_host = pos(&lib, "block_on(wasm_core::PluginHost::new(", "lib.rs");
    let autostart = pos(&lib, "block_on(lifecycle.apply_autostart())", "lib.rs");

    assert!(
        ports < plugin_host,
        "server 端口面必须先于 PluginHost::new 装配（L1/L2 激活期 acquire 需要）"
    );
    assert!(
        registry < plugin_host && transport < plugin_host && peer < plugin_host,
        "服务注册表与两个服务必须先于 PluginHost::new 注册（激活期 acquire）"
    );
    assert!(
        plugin_host < autostart,
        "L3 自启在注册表注入之后（apply_autostart 不得提前）"
    );

    // new 的末参必须是注入的注册表（Some(service_registry.clone())）
    let new_block = &lib[plugin_host..(plugin_host + 1600).min(lib.len())];
    assert!(
        new_block.contains("Some(service_registry.clone())"),
        "PluginHost::new 必须接收服务注册表（否则激活期 acquire 退化为无租约路径）"
    );
}

#[test]
fn endpoint_host_impls_only_preregister_without_starting_transport() {
    for (file, binding) in [
        ("src/plugin/http.rs", "http_register_endpoint"),
        ("src/plugin/ws.rs", "ws_register_endpoint"),
    ] {
        let src = read(file);
        let register = src
            .find("fn register_endpoint(")
            .unwrap_or_else(|| panic!("{file} 缺 register_endpoint"));
        let block = &src[register..(register + 1200).min(src.len())];
        assert!(
            block.contains(binding),
            "{file} 的 register_endpoint 必须只登记到能力域路由表"
        );
        assert!(
            !block.contains("acquire_transport_for") && !block.contains("acquire_for_surface"),
            "{file} 的 register_endpoint 不得启动/租用传输面——注册是预登记，\
             启动信号是应用界面打开（plugin/services.rs）"
        );
    }
}

#[test]
fn surface_commands_acquire_and_release_transport() {
    let commands = read("src/commands.rs");
    for needle in [
        "pub async fn plugin_surface_open(",
        "pub async fn plugin_surface_close(",
        "acquire_for_surface",
        "release_for_surface",
    ] {
        assert!(
            commands.contains(needle),
            "commands.rs 缺 `{needle}`（应用界面租约入口漂移）"
        );
    }

    let lib = read("src/lib.rs");
    for needle in ["commands::plugin_surface_open", "commands::plugin_surface_close"] {
        assert!(
            lib.contains(needle),
            "lib.rs 未注册 `{needle}`（壳 invoke 会 command not found）"
        );
    }

    let services = read("src/plugin/services.rs");
    for needle in ["plugin_uses_transport", "TRANSPORT_SERVICE_KEY"] {
        assert!(
            services.contains(needle),
            "services.rs 缺 `{needle}`（租约薄壳漂移）"
        );
    }
}

#[test]
fn shell_mount_drives_surface_lease_open_and_close() {
    let mount = read("../src/shell/mount/useAppMount.ts");
    assert!(
        mount.contains("plugin_surface_open"),
        "外壳挂载应用整包必须 acquire 传输面（plugin_surface_open）"
    );
    assert!(
        mount.contains("plugin_surface_close"),
        "外壳卸载应用整包必须 release 传输面（plugin_surface_close）"
    );
}

#[test]
fn desktop_peer_port_exposes_service_registry() {
    let peer = read("src/plugin/peer.rs");
    assert!(
        peer.contains("fn service_registry"),
        "桌面 HostPeerPorts 必须实现 service_registry()"
    );
    assert!(
        peer.contains("ctx().service_registry()"),
        "桌面 HostPeerPorts 必须从 WasmHostContext 取注册表（生产装配 Some）"
    );
}

#[test]
fn retired_unowned_service_commands_stay_retired() {
    let lib = read("src/lib.rs");
    for retired in [
        "commands::server_start",
        "commands::server_stop",
        "commands::server_restart",
        "commands::update_server_auto_start",
        "peer_net_cmds::start_peer_node",
        "peer_net_cmds::stop_peer_node",
    ] {
        assert!(
            !lib.contains(retired),
            "退役命令 {retired} 不得重新注册（会绕过引用记账，创建无属主服务）"
        );
    }

    let commands = read("src/commands.rs");
    for retired in [
        "pub async fn server_start(",
        "pub async fn server_stop(",
        "pub async fn server_restart(",
        "pub async fn update_server_auto_start(",
    ] {
        assert!(!commands.contains(retired), "退役命令 {retired} 不得复活");
    }

    let peer_cmds = read("src/server/peer_net_cmds.rs");
    for retired in ["pub async fn start_peer_node(", "pub async fn stop_peer_node("] {
        assert!(!peer_cmds.contains(retired), "退役 peer 节点命令 {retired} 不得复活");
    }
}

#[test]
fn shutdown_chain_runs_scoped_service_reclamation() {
    let lifecycle = read("src/system/lifecycle.rs");
    assert!(
        lifecycle.contains("service-leases"),
        "退出链必须注册 service-leases 钩子"
    );
    assert!(
        lifecycle.contains("shutdown_all()"),
        "退出链必须调用注册表 shutdown_all（兜住 Error 态 / stop 失败的 running 槽）"
    );
}

#[test]
fn service_lease_helpers_use_mechanism_key_constant() {
    let services = read("src/plugin/services.rs");
    assert!(
        services.contains("TRANSPORT_SERVICE_KEY"),
        "宿主 acquire 必须引用能力仓导出的服务键常量，不另写字符串"
    );
    assert!(
        services.contains("acquire_for_surface") && services.contains("release_for_surface"),
        "应用界面租约薄壳必须存在"
    );
}
