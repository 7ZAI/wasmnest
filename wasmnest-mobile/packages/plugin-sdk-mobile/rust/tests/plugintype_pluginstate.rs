//! PluginType / PluginState — 公共 API 集成测试（自 wasmnest-mobile/packages/plugin-sdk-mobile/rust/src/types.rs 迁出）

use wasmnest_plugin_api_mobile::types::*;

#[test]
fn test_plugin_type_wire_lowercase() {
    // 线协议 lowercase（2026-10-26 形态三档重定义，wasmnest-apps#21）：宿主按
    // 字面量解析 plugin.json 的 pluginType 字段；词汇只表达形态，不表达语言
    assert_eq!(serde_json::to_value(PluginType::Frontend).unwrap(), serde_json::json!("frontend"));
    assert_eq!(serde_json::to_value(PluginType::Backend).unwrap(), serde_json::json!("backend"));
    assert_eq!(serde_json::to_value(PluginType::Full).unwrap(), serde_json::json!("full"));
    assert_eq!(
        serde_json::from_value::<PluginType>(serde_json::json!("full")).unwrap(),
        PluginType::Full
    );
    assert!(serde_json::from_value::<PluginType>(serde_json::json!("Full")).is_err());
}
#[test]
fn test_plugin_type_retired_values_rejected_with_migration_path() {
    // 退役值 fail-visible（含移动端原 wasm）：点名旧值 + 迁移出路
    for (old, expect_path) in [
        ("ts-only", "'frontend'"),
        ("rust", "'backend'"),
        ("rust-ts", "'full'"),
        ("wasm", "'full'"),
    ] {
        let err = serde_json::from_value::<PluginType>(serde_json::json!(old))
            .expect_err("retired value must be rejected");
        let msg = err.to_string();
        assert!(msg.contains(old), "须点名旧值 {old}: {msg}");
        assert!(msg.contains(expect_path), "须给出新值出路 {expect_path}: {msg}");
        assert!(msg.contains("已退役"), "须说明退役事实: {msg}");
    }
}
#[test]
fn test_plugin_type_default() {
    assert_eq!(PluginType::default(), PluginType::Frontend);
}
#[test]
fn test_plugin_state_camel_case_tag() {
    // state 内部标签 + camelCase 变体名（与桌面端 PascalCase 不同，移动端线协议如此）
    assert_eq!(
        serde_json::to_value(PluginState::Loaded).unwrap(),
        serde_json::json!({ "state": "loaded" })
    );
    assert_eq!(
        serde_json::to_value(PluginState::Activated).unwrap(),
        serde_json::json!({ "state": "activated" })
    );
    assert_eq!(
        serde_json::to_value(PluginState::Activating).unwrap(),
        serde_json::json!({ "state": "activating" })
    );
    assert_eq!(
        serde_json::to_value(PluginState::Degraded { error: "init fail".into() }).unwrap(),
        serde_json::json!({ "state": "degraded", "error": "init fail" })
    );
    assert_eq!(
        serde_json::to_value(PluginState::Error { error: "boom".into() }).unwrap(),
        serde_json::json!({ "state": "error", "error": "boom" })
    );
    let back: PluginState =
        serde_json::from_value(serde_json::json!({ "state": "error", "error": "x" })).unwrap();
    assert_eq!(back, PluginState::Error { error: "x".into() });
    let degraded_back: PluginState =
        serde_json::from_value(serde_json::json!({ "state": "degraded", "error": "d" })).unwrap();
    assert_eq!(degraded_back, PluginState::Degraded { error: "d".into() });
}
#[test]
fn test_plugin_state_default() {
    assert_eq!(PluginState::default(), PluginState::Loaded);
}
