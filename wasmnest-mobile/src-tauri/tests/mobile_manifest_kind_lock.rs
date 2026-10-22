//! 移动 manifest 统一到 wasm-core 的漂移锁。
//!
//! 真源 = `wasmnest_wasm_core::manifest`。移动 SDK 的 `PluginManifest` 只是
//! guest 面 wire 镜像（wasm32 不能依赖 wasm-core）；本文件钉住两件事：
//!
//! 1. 宿主解析 `plugin.json` 时能拿到 `type`（含历史别名 / 缺省）；
//! 2. SDK 镜像与 core 的 `PluginKind` serde 拼写一致，且 `MobilePluginInfo`
//!    把 `kind` 透出给前端（系统服务区 / 服务监控的唯一判据）。

use wasmnest_mobile_lib::plugin::types::{
    LoadedPlugin, MobilePluginInfo, PluginKind, PluginManifest, PluginSource, PluginState,
};

/// 移动宿主 loader 与 zip 安装器都走 `serde_json::from_str::<PluginManifest>`；
/// 这里用同一入口钉住 `type` 的解析语义。
fn parse(json: &str) -> PluginManifest {
    serde_json::from_str(json).expect("plugin.json 必须可解析为 core PluginManifest")
}

#[test]
fn manifest_type_parses_current_spelling() {
    let manifest = parse(
        r#"{
            "id": "com.wasmnest.test.service",
            "name": "Service",
            "version": "0.1.0",
            "platform": "mobile",
            "type": "internal-business"
        }"#,
    );
    assert_eq!(manifest.kind, PluginKind::InternalBusiness);
    assert!(manifest.kind.is_role_driven());
}

#[test]
fn manifest_type_accepts_legacy_aliases() {
    let system = parse(
        r#"{
            "id": "com.wasmnest.test.legacy-system",
            "name": "Legacy",
            "version": "0.1.0",
            "platform": "mobile",
            "type": "system"
        }"#,
    );
    assert_eq!(system.kind, PluginKind::BasicService);

    let application = parse(
        r#"{
            "id": "com.wasmnest.test.legacy-app",
            "name": "Legacy App",
            "version": "0.1.0",
            "platform": "mobile",
            "type": "application"
        }"#,
    );
    assert_eq!(application.kind, PluginKind::BusinessApp);
}

#[test]
fn manifest_type_defaults_to_business_app() {
    let manifest = parse(
        r#"{
            "id": "com.wasmnest.test.default",
            "name": "Default",
            "version": "0.1.0",
            "platform": "mobile"
        }"#,
    );
    assert_eq!(manifest.kind, PluginKind::BusinessApp);
    assert!(!manifest.kind.is_role_driven());
}

/// SDK 镜像与 core 的 kind wire 值逐字一致（防两边各自改拼写）。
#[test]
fn sdk_kind_wire_values_match_core() {
    let pairs = [
        (
            PluginKind::BasicService,
            wasmnest_plugin_api_mobile::types::PluginKind::BasicService,
        ),
        (
            PluginKind::InternalBusiness,
            wasmnest_plugin_api_mobile::types::PluginKind::InternalBusiness,
        ),
        (
            PluginKind::BusinessApp,
            wasmnest_plugin_api_mobile::types::PluginKind::BusinessApp,
        ),
    ];
    for (core, sdk) in pairs {
        assert_eq!(
            serde_json::to_string(&core).expect("core kind serializes"),
            serde_json::to_string(&sdk).expect("sdk kind serializes"),
            "core / SDK 的 kind 拼写漂移"
        );
    }
}

/// 自定义监控面板声明：core manifest 与 SDK 镜像都能解析同一份 `monitorPanels`。
#[test]
fn monitor_panels_contribution_parses_in_core_and_sdk_mirror() {
    let json = r#"{
        "id": "com.wasmnest.test.panels",
        "name": "Panels",
        "version": "0.1.0",
        "platform": "mobile",
        "contributes": {
            "monitorPanels": [
                { "id": "usage", "title": "Usage", "order": 10 },
                { "id": "health", "title": "Health" }
            ]
        }
    }"#;

    let core = parse(json);
    assert_eq!(core.contributes.monitor_panels.len(), 2);
    assert_eq!(core.contributes.monitor_panels[0].id, "usage");
    assert_eq!(core.contributes.monitor_panels[1].order, 0);

    let sdk: wasmnest_plugin_api_mobile::types::PluginManifest =
        serde_json::from_str(json).expect("SDK mirror parses monitorPanels");
    assert_eq!(sdk.contributes.monitor_panels.len(), 2);
    assert_eq!(sdk.contributes.monitor_panels[0].title, "Usage");
}

/// 前端消费面：`MobilePluginInfo` 必须带 `kind`（系统服务区分组 / 服务监控）。
#[test]
fn mobile_plugin_info_exposes_kind() {
    let manifest = parse(
        r#"{
            "id": "com.wasmnest.test.service",
            "name": "Service",
            "version": "0.1.0",
            "platform": "mobile",
            "type": "internal-business"
        }"#,
    );
    let loaded = LoadedPlugin {
        manifest,
        state: PluginState::Loaded,
        source: PluginSource::ApkAsset,
        extension_path: "/tmp/wasmnest-kind-lock".to_string(),
    };
    let info = MobilePluginInfo::from(&loaded);
    let value = serde_json::to_value(info).expect("MobilePluginInfo serializes");
    assert_eq!(value["kind"], "internal-business");
}
