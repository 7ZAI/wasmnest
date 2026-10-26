//! 监控元数据段（`plugin_meta`）锁：移动端 monitor 的服务 / 应用分类来源。
//!
//! 快照 `plugins` 段仍是全量指标；`plugin_meta` 只附带宿主已知的只读展示字段
//! （name / kind），目标插件不参与、也不能拒绝。卸载时元数据必须随指标一起清掉，
//! 否则会出现「服务已卸载但监控页仍显示」的幽灵条目。

use wasmnest_wasm_core::monitor::MetricsRegistry;

#[test]
fn plugin_meta_is_attached_to_snapshot_and_cleared_on_remove() {
    let registry = MetricsRegistry::new();
    registry.plugin("com.wasmnest.monitor");
    registry.plugin("com.wasmnest.ai-chatbox");
    registry.set_plugin_meta(
        "com.wasmnest.monitor",
        serde_json::json!({ "name": "Monitor", "kind": "internal-business" }),
    );
    registry.set_plugin_meta(
        "com.wasmnest.ai-chatbox",
        serde_json::json!({ "name": "AI Chatbox", "kind": "business-app" }),
    );

    let snapshot = registry.snapshot();
    assert_eq!(
        snapshot["plugin_meta"]["com.wasmnest.monitor"]["kind"],
        "internal-business"
    );
    assert_eq!(
        snapshot["plugin_meta"]["com.wasmnest.ai-chatbox"]["kind"],
        "business-app"
    );
    assert!(
        snapshot["plugins"]["com.wasmnest.monitor"].is_object(),
        "元数据段不得替换插件指标段"
    );

    registry.remove("com.wasmnest.monitor");
    let snapshot = registry.snapshot();
    assert!(
        snapshot["plugin_meta"].get("com.wasmnest.monitor").is_none(),
        "卸载后元数据不得残留: {snapshot}"
    );
    assert!(
        snapshot["plugin_meta"]["com.wasmnest.ai-chatbox"].is_object(),
        "其他插件的元数据不得被连带清理"
    );
}

#[test]
fn empty_plugin_meta_keeps_legacy_snapshot_shape() {
    let registry = MetricsRegistry::new();
    registry.plugin("com.wasmnest.a");
    let snapshot = registry.snapshot();
    assert!(
        snapshot.get("plugin_meta").is_none(),
        "未写元数据时不新增段，旧消费方零迁移: {snapshot}"
    );
}
