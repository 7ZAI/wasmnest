//! monitor 系统服务 / 强制监控锁
//!
//! 用户裁决（2026-10-22）：monitor 是 L2 系统服务，随包分发、不可卸载、默认自启；
//! 同时它必须继续监控**所有** wasm 应用（目标应用不能拒绝）。本锁钉住：
//! - 双端 manifest 的 `type` = internal-business、`metrics:read` 仍在；
//! - 工程位于 `servers/monitor`（不再是 apps 产品应用）；
//! - 桌面挂载面仍提供监控面板装载器（host-mediated，monitor 不直接 import 他人 bundle）。

mod support;

use std::fs;

use serde_json::Value;

fn monitor_dir(end: &str) -> std::path::PathBuf {
    let dir = support::app_paths::apps_root()
        .join("servers")
        .join("monitor")
        .join(end);
    assert!(dir.is_dir(), "monitor 工程应住 servers/monitor/{end}: {}", dir.display());
    dir
}

fn manifest(end: &str) -> Value {
    let path = monitor_dir(end).join("plugin.json");
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读取 {} 失败: {e}", path.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("解析 {} 失败: {e}", path.display()))
}

#[test]
fn monitor_is_internal_business_system_service_on_both_ends() {
    for end in ["desktop", "mobile"] {
        let m = manifest(end);
        assert_eq!(
            m["id"], "com.wasmnest.monitor",
            "{end} 的插件 id 不得随目录迁移变化"
        );
        assert_eq!(
            m["type"], "internal-business",
            "{end} manifest 必须声明 L2 系统服务角色"
        );
        let permissions = m["permissions"]
            .as_array()
            .unwrap_or_else(|| panic!("{end} 缺 permissions"));
        assert!(
            permissions.iter().any(|p| p == "metrics:read"),
            "{end} 必须声明 metrics:read（全量监控的唯一权限位）"
        );
    }
}

#[test]
fn desktop_host_exposes_monitor_panel_mount_contract() {
    let src = fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/shell/mount/useAppMount.ts"),
    )
    .expect("read useAppMount.ts");
    for needle in [
        "export interface MonitorPanelEnv",
        "export interface MonitorPanelHandle",
        "export type MountMonitorPanel",
        "export async function mountAppMonitorPanel(",
        "mountMonitorPanel?:",
    ] {
        assert!(src.contains(needle), "面板契约缺 {needle}");
    }

    let slot = fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/shell/mount/AppMountSlot.vue"),
    )
    .expect("read AppMountSlot.vue");
    assert!(
        slot.contains("MONITOR_PLUGIN_ID") && slot.contains("mountAppMonitorPanel"),
        "宿主只应向 monitor 注入面板装载器"
    );
}
