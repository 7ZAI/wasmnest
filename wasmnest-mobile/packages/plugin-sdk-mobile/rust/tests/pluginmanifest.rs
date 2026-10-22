//! PluginManifest — 公共 API 集成测试（自 wasmnest-mobile/packages/plugin-sdk-mobile/rust/src/types.rs 迁出）

use wasmnest_plugin_api_mobile::types::*;

#[test]
fn test_manifest_parse_with_defaults() {
    // 缺省字段（description/author/main/pluginType/permissions/contributes/
    // icon/wasmHash/rustLibrary）全部走 default，宿主加载最小化 plugin.json 不应失败
    let json = serde_json::json!({
        "id": "com.wasmnest.demo",
        "name": "Demo",
        "version": "0.1.0",
        "platform": "both",
        "permissions": ["storage", "mdns"]
    });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    assert_eq!(m.id, "com.wasmnest.demo");
    assert_eq!(m.version, "0.1.0");
    assert_eq!(m.description, "");
    assert_eq!(m.author, "");
    assert_eq!(m.main, "");
    assert_eq!(m.plugin_type, PluginType::TsOnly);
    assert_eq!(m.permissions, vec!["storage", "mdns"]);
    assert_eq!(m.icon, None);
    assert_eq!(m.wasm_hash, "");
    assert_eq!(m.rust_library, "");
    assert_eq!(m.preauth_dirs, Vec::<String>::new());
    assert_eq!(m.preauth_urls, Vec::<String>::new());
    assert_eq!(m.kind, PluginKind::BusinessApp);
    assert_eq!(m.api, Vec::<String>::new());
}
#[test]
fn test_manifest_kind_parses_current_and_legacy_spellings() {
    for (raw, expected) in [
        ("internal-business", PluginKind::InternalBusiness),
        ("basic-service", PluginKind::BasicService),
        ("system", PluginKind::BasicService),
        ("application", PluginKind::BusinessApp),
        ("business-app", PluginKind::BusinessApp),
    ] {
        let json = serde_json::json!({
            "id": "com.wasmnest.kind",
            "name": "Kind",
            "version": "1.0.0",
            "platform": "mobile",
            "type": raw
        });
        let m: PluginManifest = serde_json::from_value(json).unwrap();
        assert_eq!(m.kind, expected, "type={raw}");
    }

    // 缺省 L3 不写入序列化输出（与 core 同 skip 语义）
    let m: PluginManifest = serde_json::from_value(serde_json::json!({
        "id": "com.wasmnest.kind-default",
        "name": "Kind Default",
        "version": "1.0.0",
        "platform": "mobile"
    }))
    .unwrap();
    let back = serde_json::to_value(&m).unwrap();
    assert!(back.get("type").is_none(), "缺省 business-app 不落 type 键");
}

#[test]
fn test_manifest_preauth_urls_parse() {
    // preauthUrls（Egress L2 声明，camelCase）解析 + 缺失默认空数组
    let json = serde_json::json!({
        "id": "com.wasmnest.ai-chatbox",
        "name": "AI Chatbox",
        "version": "1.0.0",
        "platform": "both",
        "preauthUrls": ["https://*.openai.com/*", "https://api.deepseek.com/*"]
    });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    assert_eq!(
        m.preauth_urls,
        vec!["https://*.openai.com/*".to_string(), "https://api.deepseek.com/*".to_string()]
    );
    // 序列化回写保持 camelCase
    let back = serde_json::to_value(&m).unwrap();
    assert_eq!(back["preauthUrls"], serde_json::json!(["https://*.openai.com/*", "https://api.deepseek.com/*"]));
}
#[test]
fn test_manifest_round_trip_fills_defaults() {
    // 宿主加载最小化 plugin.json 后序列化回写：缺省字段应已填充默认值
    let json = serde_json::json!({ "id": "com.wasmnest.x", "name": "X", "version": "1.0.0", "platform": "both" });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    let back = serde_json::to_value(&m).unwrap();
    assert_eq!(back["pluginType"], serde_json::json!("ts-only"));
    assert_eq!(back["wasmHash"], serde_json::json!(""));
    assert_eq!(
        back["platform"],
        serde_json::json!("both"),
        "platform 原样回写"
    );
    // contributes 序列化时带全部字段（serde(default) 只影响反序列化）
    assert_eq!(back["contributes"]["commands"], serde_json::json!([]));
    assert_eq!(back["contributes"]["navTab"], serde_json::Value::Null);
    assert_eq!(back["contributes"]["settings"], serde_json::Value::Null);
}
