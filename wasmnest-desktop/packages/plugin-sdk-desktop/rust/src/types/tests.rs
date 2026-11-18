use super::*;

// ==================== PluginManifest ====================

/// 契约锁（会话引擎下沉票 14）：`PluginManifest::default()` 必须与「只写必填项的
/// plugin.json 解析结果」逐字段等价。测试夹具因此可以 `..Default::default()` 构造，
/// SDK 追加可选字段不再连带六处结构体字面量编译红。两侧任一失配都会让该锁红：
/// 新字段漏了 `#[serde(default)]`，或 Rust 侧默认值与解析缺省不是同一个值。
#[test]
fn default_manifest_equals_minimal_json_manifest() {
    let from_json = serde_json::from_value::<PluginManifest>(serde_json::json!({
        "id": "com.wasmnest.lock",
        "name": "Lock",
        "version": "0.0.0",
        "platform": "both",
    }))
    .expect("只写必填项的 manifest 必须可解析");
    let from_default = PluginManifest {
        id: "com.wasmnest.lock".to_string(),
        name: "Lock".to_string(),
        version: "0.0.0".to_string(),
        ..Default::default()
    };
    assert_eq!(
        serde_json::to_value(&from_json).unwrap(),
        serde_json::to_value(&from_default).unwrap(),
        "Default 与 serde 缺省失配：新字段要么补 #[serde(default)]，要么夹具必须显式列出它"
    );
}

#[test]
fn test_manifest_parse_with_defaults() {
    // 缺省字段（description/author/main/icon/contributes）全部走 default，
    // 宿主加载最小化 plugin.json 不应失败
    let json = serde_json::json!({
        "id": "com.wasmnest.demo",
        "name": "Demo",
        "version": "0.1.0",
        "platform": "both",
        "permissions": ["storage", "terminal:input"],
        "pluginType": "full",
        "contributes": {
            "commands": [{ "id": "run", "title": "Run", "icon": "run.svg" }],
            "subscribes": ["task:status-changed"]
        }
    });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    assert_eq!(m.id, "com.wasmnest.demo");
    assert_eq!(m.version, "0.1.0");
    assert_eq!(m.description, "");
    assert_eq!(m.plugin_type, PluginType::Full);
    assert_eq!(m.permissions, vec!["storage", "terminal:input"]);
    assert_eq!(m.contributes.commands.len(), 1);
    assert_eq!(m.contributes.commands[0].id, "run");
    assert_eq!(m.contributes.commands[0].title, "Run");
    assert_eq!(m.contributes.commands[0].icon.as_deref(), Some("run.svg"));
    assert_eq!(m.contributes.subscribes, vec!["task:status-changed"]);
}

#[test]
fn test_manifest_round_trip_fills_defaults() {
    // 宿主加载最小化 plugin.json 后序列化回写：缺省字段应已填充默认值
    // （serde default 在反序列化时生效，序列化反映内存中的实际值）
    let json = serde_json::json!({ "id": "com.wasmnest.x", "name": "X", "version": "1.0.0", "platform": "both" });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    let back = serde_json::to_value(&m).unwrap();
    assert_eq!(back["pluginType"], serde_json::json!("frontend"));
    assert_eq!(
        back["platform"],
        serde_json::json!("both"),
        "platform 原样回写"
    );
    assert_eq!(back["description"], serde_json::json!(""));
    // contributes 序列化时带全部字段（serde(default) 只影响反序列化）
    assert_eq!(back["contributes"]["commands"], serde_json::json!([]));
    assert_eq!(back["contributes"]["subscribes"], serde_json::json!([]));
}

/// 退役字段兼容（审计票 06 裁决 2）：`sandbox` 已从 manifest 退役（前端不做隔离，
/// 安全边界在 Rust 端与 WASM 端），旧 plugin.json 仍带该字段时必须照常解析，
/// 且不得再被序列化回产物（避免把退役字段继续传播给下游）
#[test]
fn test_manifest_ignores_retired_sandbox_field() {
    let json = serde_json::json!({
        "id": "com.wasmnest.legacy",
        "name": "Legacy",
        "version": "1.0.0",
        "platform": "both",
        "sandbox": "isolated"
    });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    assert_eq!(m.id, "com.wasmnest.legacy");
    let back = serde_json::to_value(&m).unwrap();
    assert!(
        back.get("sandbox").is_none(),
        "退役字段不得再出现在序列化输出: {back}"
    );
}

#[test]
fn test_manifest_parse_basic_service_kind_and_dependencies() {
    // L1 基础服务 manifest：声明 type + 能力依赖
    let json = serde_json::json!({
        "id": "com.wasmnest.sys-store",
        "name": "Sys Store",
        "version": "1.0.0",
        "platform": "both",
        "type": "basic-service",
        "dependencies": ["host-storage", "host-log"]
    });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    assert_eq!(m.kind, PluginKind::BasicService);
    assert!(m.kind.provides_host_capabilities());
    assert!(m.kind.is_role_driven());
    assert!(!m.kind.is_business_app());
    assert_eq!(m.dependencies, vec!["host-storage", "host-log"]);
    // 序列化回写：角色与依赖保留
    let back = serde_json::to_value(&m).unwrap();
    assert_eq!(back["type"], serde_json::json!("basic-service"));
    assert_eq!(
        back["dependencies"],
        serde_json::json!(["host-storage", "host-log"])
    );
}

/// 旧拼写兼容（ADR 0032 角色维度重构）：`system` / `application` 仍按新角色
/// 解析，但序列化统一写新拼写——旧产物零迁移，又不让历史拼写继续扩散
#[test]
fn test_manifest_legacy_kind_spellings_alias_into_new_roles() {
    for (legacy, expected) in [
        ("system", PluginKind::BasicService),
        ("application", PluginKind::BusinessApp),
    ] {
        let json = serde_json::json!({
            "id": "com.wasmnest.legacy-kind",
            "name": "Legacy Kind",
            "version": "1.0.0",
            "platform": "both",
            "type": legacy,
        });
        let m: PluginManifest = serde_json::from_value(json).unwrap();
        assert_eq!(
            m.kind, expected,
            "legacy spelling {legacy} must map to a role"
        );
        let back = serde_json::to_value(&m).unwrap();
        if expected.is_business_app() {
            assert!(
                back.get("type").is_none(),
                "L3 是缺省角色，不序列化: {back}"
            );
        } else {
            assert_eq!(
                back["type"],
                serde_json::json!(expected.as_str()),
                "旧拼写不得继续回写（wire 拼写唯一真源是 as_str）"
            );
        }
    }
}

/// 角色维度重构的**行为契约**（ADR 0032）：三层各就各位
///
/// - L1 提供 host-* 同形能力、是角色驱动层且排在 L2 之前；
/// - L2 是角色驱动层但**不**提供能力（裁决方 ≠ 提供方）；
/// - L3 是缺省业务应用，不进角色驱动序列（走持久化批量激活）。
///
/// 变异判据：把 `provides_host_capabilities` 放宽到含 L2、或把 L3 塞进
/// `ROLE_DRIVEN_LOAD_ORDER`，本条立即转红。
#[test]
fn plugin_kind_roles_keep_their_adrs_0032_contracts() {
    assert_eq!(
        PluginKind::ROLE_DRIVEN_LOAD_ORDER,
        [PluginKind::BasicService, PluginKind::InternalBusiness],
        "加载顺序真源固定 L1 → L2"
    );
    assert!(PluginKind::ROLE_DRIVEN_LOAD_ORDER[0].provides_host_capabilities());
    assert!(
        !PluginKind::InternalBusiness.provides_host_capabilities(),
        "L2 是裁决方不是能力提供方（误注册会让任意 basic-service 接管它）"
    );
    assert!(!PluginKind::BusinessApp.is_role_driven());
    assert!(
        PluginKind::default() == PluginKind::BusinessApp,
        "缺省 = L3"
    );
    assert!(!PluginKind::BusinessApp.provides_host_capabilities());
}

/// L2 反向依赖是**唯一**方向：它被宿主主动调、自身不提供能力也不进 L1 序位
#[test]
fn internal_business_is_the_only_reverse_dependency_role() {
    let l2 = PluginKind::InternalBusiness;
    assert!(l2.is_role_driven());
    assert!(!l2.provides_host_capabilities());
    assert!(!l2.is_business_app());
    assert_eq!(l2.label(), "L2 内部统一业务");
}

/// 非法角色拼写在**反序列化期**即拒（不静默回落缺省 L3——那会让
/// 「声明了基础服务却被当业务应用装配」这类错误一路活到运行期）
#[test]
fn test_manifest_rejects_unknown_kind_spelling() {
    let json = serde_json::json!({
        "id": "com.wasmnest.bad-kind",
        "name": "Bad Kind",
        "version": "1.0.0",
        "platform": "both",
        "type": "systemm",
    });
    assert!(
        serde_json::from_value::<PluginManifest>(json).is_err(),
        "未知角色取值必须加载期失败，不得静默回落缺省 L3"
    );
}

/// `lifecycle`：缺省常驻（不序列化落盘）；`ephemeral` 可解析并保留
#[test]
fn test_manifest_lifecycle_default_and_ephemeral() {
    let json = serde_json::json!({ "id": "com.wasmnest.legacy", "name": "L", "version": "0.1.0", "platform": "both" });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    assert!(m.lifecycle.is_persistent());
    let back = serde_json::to_value(&m).unwrap();
    assert!(back.get("lifecycle").is_none(), "缺省常驻不序列化: {back}");

    let json = serde_json::json!({
        "id": "com.wasmnest.worker",
        "name": "Worker",
        "version": "1.0.0",
        "platform": "both",
        "pluginType": "backend",
        "lifecycle": "ephemeral",
    });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    assert_eq!(m.lifecycle, InstanceLifecycle::Ephemeral);
    assert!(!m.lifecycle.is_persistent());
    let back = serde_json::to_value(&m).unwrap();
    assert_eq!(back["lifecycle"], serde_json::json!("ephemeral"));
    assert_eq!(m.lifecycle.label(), "即用即弃");
}

/// 非法 lifecycle 取值不得回落常驻（serde 反序列化即拒，host 侧根本拿不到 manifest）
#[test]
fn test_manifest_rejects_unknown_lifecycle_spelling() {
    // 取值域只有 persistent / ephemeral：未经裁定的别名（如曾加过的 `worker`）
    // 不得被接受——它会与构建链 `manifest-validate.js` 的取值域漂移
    for bad in ["worker", "ephemeral-ish", "Persistent"] {
        let json = serde_json::json!({
            "id": "com.wasmnest.worker",
            "name": "W",
            "version": "1.0.0",
            "platform": "both",
            "lifecycle": bad,
        });
        assert!(
            serde_json::from_value::<PluginManifest>(json).is_err(),
            "非法 lifecycle 拼写 {bad} 必须加载期失败"
        );
    }
}

#[test]
fn test_manifest_kind_and_dependencies_default_for_legacy() {
    // 缺省兼容：旧插件 manifest 无 type/dependencies 字段 → L3 业务应用 + 空依赖，
    // 序列化回写时缺省值不落盘（skip_serializing_if）
    let json = serde_json::json!({ "id": "com.wasmnest.legacy", "name": "L", "version": "0.1.0", "platform": "both" });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    assert!(m.kind.is_business_app());
    assert!(m.dependencies.is_empty());
    let back = serde_json::to_value(&m).unwrap();
    assert!(back.get("type").is_none(), "L3 缺省角色不序列化");
    assert!(back.get("dependencies").is_none(), "空依赖不序列化");
}

// ==================== PluginType / PluginState ====================

/// core-config × core-security（票据 07）：manifest `resourceOverrides`
/// 解析 + 未声明字段为 None（继承内核配置）+ 序列化回写
#[test]
fn test_manifest_parse_resource_overrides() {
    let json = serde_json::json!({
        "id": "com.wasmnest.heavy",
        "name": "Heavy",
        "version": "1.0.0",
        "platform": "both",
        "resourceOverrides": {
            "fuelPerCall": 128_000_000_000u64,
            "maxMemoryBytes": 512 * 1024 * 1024
        }
    });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    let overrides = m
        .resource_overrides
        .expect("resourceOverrides must be parsed");
    assert_eq!(overrides.fuel_per_call, Some(128_000_000_000));
    assert_eq!(overrides.max_memory_bytes, Some(512 * 1024 * 1024));
    // 未声明字段为 None → 宿主侧继承内核配置
    assert_eq!(overrides.max_table_entries, None);
    // 序列化回写：camelCase 键名保留
    let back = serde_json::to_value(&m).unwrap();
    assert_eq!(
        back["resourceOverrides"]["fuelPerCall"],
        serde_json::json!(128_000_000_000u64)
    );
    assert_eq!(
        back["resourceOverrides"]["maxMemoryBytes"],
        serde_json::json!(512 * 1024 * 1024)
    );
}

/// 票据 07 缺省兼容：旧 manifest 无 resourceOverrides → None，且序列化不落盘
#[test]
fn test_manifest_resource_overrides_default_none_for_legacy() {
    let json = serde_json::json!({
        "id": "com.wasmnest.legacy",
        "name": "Legacy",
        "version": "1.0.0",
        "platform": "both"
    });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    assert!(
        m.resource_overrides.is_none(),
        "旧 manifest 无该字段 → None（继承内核配置，零迁移）"
    );
    let back = serde_json::to_value(&m).unwrap();
    assert!(
        back.get("resourceOverrides").is_none(),
        "缺省值不得写入序列化输出: {back}"
    );
}

#[test]
fn test_plugin_type_wire_lowercase() {
    // 线协议 lowercase（2026-10-26 形态三档重定义，wasmnest-apps#21）：宿主按
    // 字面量解析 plugin.json 的 pluginType 字段
    assert_eq!(
        serde_json::to_value(PluginType::Frontend).unwrap(),
        serde_json::json!("frontend")
    );
    assert_eq!(
        serde_json::to_value(PluginType::Backend).unwrap(),
        serde_json::json!("backend")
    );
    assert_eq!(
        serde_json::to_value(PluginType::Full).unwrap(),
        serde_json::json!("full")
    );
    assert_eq!(
        serde_json::from_value::<PluginType>(serde_json::json!("full")).unwrap(),
        PluginType::Full
    );
    assert!(serde_json::from_value::<PluginType>(serde_json::json!("Full")).is_err());
}

#[test]
fn test_plugin_type_retired_values_rejected_with_migration_path() {
    // 退役值 fail-visible：逐一点名拒绝，错误文案含迁移出路——不静默降级、
    // 不笼统「unknown variant」
    for (old, expect_path) in [("ts-only", "'frontend'"), ("rust", "'backend'"), ("rust-ts", "'full'")] {
        let err =
            serde_json::from_value::<PluginType>(serde_json::json!(old)).expect_err("retired value must be rejected");
        let msg = err.to_string();
        assert!(msg.contains(old), "须点名旧值 {old}: {msg}");
        assert!(msg.contains(expect_path), "须给出新值出路 {expect_path}: {msg}");
        assert!(msg.contains("已退役"), "须说明退役事实: {msg}");
    }
    // 完全未知的值：点名值本身并列出合法集
    let err =
        serde_json::from_value::<PluginType>(serde_json::json!("gopher")).expect_err("unknown value must be rejected");
    assert!(err.to_string().contains("'gopher'"));
    assert!(err.to_string().contains("frontend / backend / full"));
}

#[test]
fn test_plugin_type_has_backend() {
    // 「有 wasm 后端」判据（授权读模型 / guest 生命周期共用）
    assert!(!PluginType::Frontend.has_backend());
    assert!(PluginType::Backend.has_backend());
    assert!(PluginType::Full.has_backend());
}

#[test]
fn test_plugin_state_adjacent_tagging() {
    // state/error 相邻标签：unit 变体无 error 字段，Error 携带消息
    assert_eq!(
        serde_json::to_value(PluginState::Activated).unwrap(),
        serde_json::json!({ "state": "Activated" })
    );
    assert_eq!(
        serde_json::to_value(PluginState::Error("boom".into())).unwrap(),
        serde_json::json!({ "state": "Error", "error": "boom" })
    );
    let back: PluginState =
        serde_json::from_value(serde_json::json!({ "state": "Error", "error": "x" })).unwrap();
    assert_eq!(back, PluginState::Error("x".into()));
}

#[test]
fn test_plugin_state_activating_and_degraded() {
    // v8 契约新增变体：Activating 瞬时中间态 + Degraded 携带降级原因，
    // serde 形状与 Error 一致（tag=state / content=error）
    assert_eq!(
        serde_json::to_value(PluginState::Activating).unwrap(),
        serde_json::json!({ "state": "Activating" })
    );
    assert_eq!(
        serde_json::to_value(PluginState::Degraded("init failed".into())).unwrap(),
        serde_json::json!({ "state": "Degraded", "error": "init failed" })
    );
    let back: PluginState = serde_json::from_value(
        serde_json::json!({ "state": "Degraded", "error": "hooks install failed" }),
    )
    .unwrap();
    assert_eq!(back, PluginState::Degraded("hooks install failed".into()));
}

// ==================== 扩展点声明 ====================

#[test]
fn test_view_contribution_type_field() {
    // view_type 序列化为 "type"（与前端 vscode 风格扩展点一致）
    let v = ViewContribution {
        id: "v1".into(),
        view_type: "sidebar".into(),
        title: "Side".into(),
        component: "SidePanel".into(),
    };
    assert_eq!(
        serde_json::to_value(&v).unwrap(),
        serde_json::json!({
            "id": "v1",
            "type": "sidebar",
            "title": "Side",
            "component": "SidePanel"
        })
    );
}

#[test]
fn test_view_contribution_statusbar_optional_fields() {
    // statusbar 项由 manifest-gen 扫描 registerStatusBarItem 生成，无静态 title/component；
    // 反序列化必须放行，否则整个插件加载失败（missing field `title`）
    let v: ViewContribution =
        serde_json::from_value(serde_json::json!({ "id": "v1", "type": "statusbar" })).unwrap();
    assert_eq!(v.id, "v1");
    assert_eq!(v.view_type, "statusbar");
    assert_eq!(v.title, "");
    assert_eq!(v.component, "");
}

#[test]
fn test_config_property_type_field() {
    // 属性类型字段序列化为 "type"，缺省字段（description/default/enumValues）为 null
    let p = ConfigProperty {
        prop_type: "string".into(),
        title: "API Key".into(),
        description: None,
        default: None,
        enum_values: None,
    };
    assert_eq!(
        serde_json::to_value(&p).unwrap(),
        serde_json::json!({
            "type": "string",
            "title": "API Key",
            "description": null,
            "default": null,
            "enumValues": null
        })
    );
}

#[test]
fn test_contributes_defaults_and_full_parse() {
    // 全量贡献点解析：terminal/toolProviders/httpEndpoints/fileHandlers/
    // configuration/lifecycle
    let json = serde_json::json!({
        "commands": [{ "id": "c1", "title": "C1" }],
        "views": [{ "id": "v1", "type": "toolbox", "title": "V1", "component": "C" }],
        "terminal": {
            "inputHandlers": ["in1"],
            "outputParsers": ["out1"]
        },
        "toolProviders": [{ "id": "tp1", "name": "N", "endpoint": "http://x" }],
        "httpEndpoints": ["task-status", "task-queue/add"],
        "fileHandlers": [{ "id": "fh1", "extensions": ["md"], "viewer": "V" }],
        "configuration": {
            "title": "Config",
            "properties": {
                "key": { "type": "string", "title": "Key" }
            }
        },
        "lifecycle": { "onStartup": true, "onShutdown": false },
        "provides": ["topic:a"],
        "subscribes": ["topic:b"]
    });
    let c: PluginContributes = serde_json::from_value(json).unwrap();
    assert_eq!(c.terminal.as_ref().unwrap().input_handlers, vec!["in1"]);
    assert_eq!(c.tool_providers[0].endpoint, "http://x");
    assert_eq!(
        c.http_endpoints,
        vec![
            HttpEndpointContribution::Path("task-status".into()),
            HttpEndpointContribution::Path("task-queue/add".into()),
        ],
        "纯字符串条目解析为 Path 形态（未声明档位）"
    );
    assert_eq!(c.file_handlers[0].extensions, vec!["md"]);
    assert_eq!(c.configuration.as_ref().unwrap().properties.len(), 1);
    assert!(c.lifecycle.as_ref().unwrap().on_startup);
    assert!(!c.lifecycle.as_ref().unwrap().on_shutdown);
    assert_eq!(c.provides, vec!["topic:a"]);
}

/// `httpEndpoints` 缺省即空清单 = 未声明（宿主路由保持票据 03 的前缀 ANY 放行轨，
/// 既有插件零迁移）。缺省语义被固化在此，避免后续把它改成 Option 引发歧义。
#[test]
fn test_http_endpoints_default_is_undeclared() {
    let c: PluginContributes = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(
        c.http_endpoints.is_empty(),
        "未声明 httpEndpoints 必须解析为空清单（未声明判据）"
    );
}

/// 票 08：`httpEndpoints` 两形态并存——`string` 与 `{path, auth}` 必须都能解析，
/// 否则既有插件的 manifest 会在解析期整表丢掉端点声明（表现为全部 404）。
#[test]
fn test_http_endpoints_parse_both_forms() {
    let c: PluginContributes = serde_json::from_value(serde_json::json!({
        "httpEndpoints": [
            "configs",
            { "path": "task-status", "auth": "none" },
            { "path": "task-queue/add", "auth": "jwt" },
            { "path": "session-mode" }
        ]
    }))
    .unwrap();
    assert_eq!(c.http_endpoints.len(), 4);
    assert_eq!(c.http_endpoints[0].path(), "configs");
    assert_eq!(
        c.http_endpoints[0].auth_raw(),
        None,
        "纯字符串条目 = 未声明档位"
    );
    assert_eq!(c.http_endpoints[1].path(), "task-status");
    assert_eq!(c.http_endpoints[1].auth_raw(), Some("none"));
    assert_eq!(c.http_endpoints[2].auth_raw(), Some("jwt"));
    // 对象条目缺 auth 键 → 同样落「未声明」，由宿主按最严默认档仲裁
    assert_eq!(c.http_endpoints[3].path(), "session-mode");
    assert_eq!(
        c.http_endpoints[3].auth_raw(),
        None,
        "对象条目不带 auth = 未声明档位"
    );
}

/// 票 08：产物 manifest 与源逐字一致（构建链既有口径）——序列化必须原样保持
/// 两形态，不得把 `"configs"` 改写成对象或反向（那会让 manifest-gen 的逐字节
/// 比对每次构建即红）。
#[test]
fn test_http_endpoints_round_trip_preserves_form() {
    let src = serde_json::json!([
        "configs",
        { "path": "task-status", "auth": "none" },
        { "path": "session-mode" }
    ]);
    let parsed: Vec<HttpEndpointContribution> = serde_json::from_value(src.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), src);
}

/// 票 08：形态错误的条目不会「降级成未声明」——整表解析失败（宿主拒绝激活），
/// 而不是静默收下少一项的清单（少一项即一个端点 404，静默失效最难查）。
#[test]
fn test_http_endpoints_reject_malformed_entries() {
    let parse = |raw: serde_json::Value| {
        serde_json::from_value::<Vec<HttpEndpointContribution>>(raw).is_err()
    };
    // path 非字符串 → 两形态都不匹配
    assert!(parse(serde_json::json!([{ "path": 1 }])));
    // 数字条目 → 解析失败（不得静默当成「未声明该端点」少收一项）
    assert!(parse(serde_json::json!([42])));
    // 数组条目 → 同上
    assert!(parse(serde_json::json!([["task-status"]])));
}

/// 票 08：认证档位词汇——两档之外的取值一律 Err（绝不静默降级为较宽档位）。
/// 缺省档由调用方给：WS = none（历史行为）、HTTP = jwt（未声明即最严）。
#[test]
fn test_endpoint_auth_parse_with_default_and_unknown() {
    assert_eq!(
        EndpointAuth::parse_with(None, EndpointAuth::Jwt),
        Ok(EndpointAuth::Jwt)
    );
    assert_eq!(
        EndpointAuth::parse_with(Some(""), EndpointAuth::None),
        Ok(EndpointAuth::None),
        "空串 = 缺省档（WS 既有行为）"
    );
    assert_eq!(
        EndpointAuth::parse_with(Some("  none  "), EndpointAuth::Jwt),
        Ok(EndpointAuth::None),
        "前后空白容忍，档位取值仍须逐字匹配"
    );
    assert_eq!(
        EndpointAuth::parse_with(Some("jwt"), EndpointAuth::None),
        Ok(EndpointAuth::Jwt)
    );
    // 大小写敏感：JWT / Bearer / token 这些拼写都算未知取值（WS 既有口径）
    for bad in ["JWT", "token", "bearer", "local-only", "pairing-scope"] {
        let err = EndpointAuth::parse_with(Some(bad), EndpointAuth::Jwt)
            .expect_err("未知档位必须报错，不得回落到默认档");
        assert!(
            err.contains(bad) && err.contains("none") && err.contains("jwt"),
            "错误文案须点明非法取值与合法档位: {err}"
        );
    }
    assert_eq!(EndpointAuth::None.as_str(), "none");
    assert_eq!(EndpointAuth::Jwt.as_str(), "jwt");
}

/// 既有测试的补位：`From<&str>` 让老写法 `vec!["x".into()]` 继续可用，
/// 但产出的是「未声明档位」条目——不能顺手把 auth 填成任何一档。
#[test]
fn test_http_endpoint_from_str_is_path_form() {
    let e = HttpEndpointContribution::from("task-status");
    assert_eq!(e, HttpEndpointContribution::Path("task-status".to_string()));
    assert_eq!(e.auth_raw(), None);
}

// ==================== WsEndpointContribution（contributes.wsEndpoints，票 09a） ====================

/// `wsEndpoints` 缺省即空清单 = 未声明（与 httpEndpoints 同判据）：
/// 未声明清单的插件 WS 端点整体不可达，宿主按「未声明即不解释」处理。
#[test]
fn test_ws_endpoints_default_is_undeclared() {
    let c: PluginContributes = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(
        c.ws_endpoints.is_empty(),
        "未声明 wsEndpoints 必须解析为空清单"
    );
}

/// 票 09a：`wsEndpoints` 两形态并存——`string` 与 `{path, auth}` 都能解析，
/// 与 `httpEndpoints` 同构，避免 WS 端点在解析期整表丢掉声明。
#[test]
fn test_ws_endpoints_parse_both_forms() {
    let c: PluginContributes = serde_json::from_value(serde_json::json!({
        "wsEndpoints": [
            "echo",
            { "path": "chat", "auth": "jwt" },
            { "path": "status" }
        ]
    }))
    .unwrap();
    assert_eq!(c.ws_endpoints.len(), 3);
    assert_eq!(c.ws_endpoints[0].path(), "echo");
    assert_eq!(
        c.ws_endpoints[0].auth_raw(),
        None,
        "纯字符串条目 = 未声明档位"
    );
    assert_eq!(c.ws_endpoints[1].path(), "chat");
    assert_eq!(c.ws_endpoints[1].auth_raw(), Some("jwt"));
    // 对象条目缺 auth 键 → 未声明档位（由宿主按 WS 默认档 none 仲裁）
    assert_eq!(c.ws_endpoints[2].path(), "status");
    assert_eq!(c.ws_endpoints[2].auth_raw(), None);
}

/// 票 09a：序列化必须原样保持两形态（产物与源逐字一致，票 14 口径），
/// 不得把 `"echo"` 改写成对象或反向。
#[test]
fn test_ws_endpoints_round_trip_preserves_form() {
    let src = serde_json::json!([
        "echo",
        { "path": "chat", "auth": "none" },
        { "path": "status" }
    ]);
    let parsed: Vec<WsEndpointContribution> = serde_json::from_value(src.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), src);
}

/// 票 09a：形态错误的条目不会「降级成未声明」——整表解析失败（宿主拒绝激活），
/// 而不是静默收下少一项的清单。
#[test]
fn test_ws_endpoints_reject_malformed_entries() {
    let parse = |raw: serde_json::Value| {
        serde_json::from_value::<Vec<WsEndpointContribution>>(raw).is_err()
    };
    assert!(parse(serde_json::json!([{ "path": 1 }])));
    assert!(parse(serde_json::json!([42])));
    assert!(parse(serde_json::json!([["echo"]])));
}

/// `From<&str>` 让老写法 `vec!["x".into()]` 继续可用，产出「未声明档位」条目。
#[test]
fn test_ws_endpoint_from_str_is_path_form() {
    let e = WsEndpointContribution::from("echo");
    assert_eq!(e, WsEndpointContribution::Path("echo".to_string()));
    assert_eq!(e.auth_raw(), None);
}

// ==================== WasiPreopenDir（manifest wasiPreopenDirs，票 07 只读档） ====================

/// 裸路径 = 既有条目形态，必须原样解析且档位在可写侧
#[test]
fn test_wasi_preopen_bare_string_is_writable_tier() {
    let d: WasiPreopenDir = serde_json::from_str(r#""${home}/.wasmnest/ai-chatbox""#).unwrap();
    assert_eq!(
        d,
        WasiPreopenDir::Path("${home}/.wasmnest/ai-chatbox".to_string())
    );
    assert_eq!(d.path(), "${home}/.wasmnest/ai-chatbox");
    assert!(!d.readonly(), "裸路径档 = 可写（改造前的唯一形态）");
}

/// 对象形态但没写 readonly：同样落到可写档（缺省档 = 改造前行为，
/// 收紧只作用在显式写 readonly 的条目上）
#[test]
fn test_wasi_preopen_object_without_readonly_defaults_to_writable() {
    let d: WasiPreopenDir = serde_json::from_str(r#"{"path":"/data/x"}"#).unwrap();
    assert_eq!(d.path(), "/data/x");
    assert!(!d.readonly());
}

/// 显式 readonly: true / false 各自生效（false 不得被当成「未声明」以外的东西）
#[test]
fn test_wasi_preopen_readonly_flag_both_values() {
    let ro: WasiPreopenDir = serde_json::from_str(r#"{"path":"/data/x","readonly":true}"#).unwrap();
    assert_eq!(ro.path(), "/data/x");
    assert!(ro.readonly(), "readonly:true 必须挂只读档");

    let rw: WasiPreopenDir =
        serde_json::from_str(r#"{"path":"/data/x","readonly":false}"#).unwrap();
    assert!(!rw.readonly(), "readonly:false 是可写档");
}

/// 未知键必须报错：`read_only` 这种拼写若被静默忽略，条目会退化成可写挂载
/// ——插件的自我收紧声明被吞掉且无人报错（与 EndpointAuth「未知档位一律 Err，
/// 绝不静默降级为较宽档位」同一条口径）
#[test]
fn test_wasi_preopen_rejects_unknown_key_in_object_entry() {
    let err = serde_json::from_str::<WasiPreopenDir>(r#"{"path":"/x","read_only":true}"#)
        .expect_err("read_only 是拼错的未知键，静默忽略等于把只读声明降级成可写")
        .to_string();
    assert!(
        err.contains("read_only") && err.contains("path") && err.contains("readonly"),
        "错误文案须点名未知键并给出允许字段: {err}"
    );
}

/// 非法形态与非法取值逐个拒绝，且错误文案点名到键——这条是第三方 zip 绕开
/// 构建 CLI 时唯一能给出可定位信息的地方
#[test]
fn test_wasi_preopen_rejects_malformed_entries() {
    for (raw, needle) in [
        (r#"{"path":"/x","readonly":"true"}"#, "readonly 必须是布尔"),
        (r#"{"path":"/x","readonly":1}"#, "readonly 必须是布尔"),
        (r#"{"readonly":true}"#, "缺 path"),
        (r#"{"path":42}"#, "缺 path"),
        (r#"42"#, "条目形态非法"),
        (r#"[{"path":"/x"}]"#, "条目形态非法"),
        (r#"null"#, "条目形态非法"),
    ] {
        let err = serde_json::from_str::<WasiPreopenDir>(raw)
            .expect_err(&format!("非法声明必须解析失败: {raw}"))
            .to_string();
        assert!(
            err.contains(needle),
            "错误文案须点名问题（期望含「{needle}」）: {err}"
        );
    }
}

/// 序列化回到声明形态（未写 readonly 的对象条目不得被回填 `"readonly":false`）——
/// 产物与源清单逐字一致的口径（票 14）依赖这一条
#[test]
fn test_wasi_preopen_serializes_back_to_declared_form() {
    assert_eq!(
        serde_json::to_string(&WasiPreopenDir::Path("/x".to_string())).unwrap(),
        r#""/x""#
    );
    assert_eq!(
        serde_json::to_string(&WasiPreopenDir::writable("/x")).unwrap(),
        r#""/x""#
    );
    assert_eq!(
        serde_json::to_string(&WasiPreopenDir::read_only("/x")).unwrap(),
        r#"{"path":"/x","readonly":true}"#
    );
    // 只写了 path 的对象条目不得被回写成 `"readonly":false`
    assert_eq!(
        serde_json::to_string(&WasiPreopenDir::Declared {
            path: "/x".to_string(),
            readonly: None
        })
        .unwrap(),
        r#"{"path":"/x"}"#
    );
}

/// 空数组整键省略（既有 manifest 零迁移：不声明就不出现在产物里）
#[test]
fn test_wasi_preopen_dirs_omitted_when_empty() {
    let json = serde_json::json!({
        "id": "com.wasmnest.demo",
        "name": "Demo",
        "version": "0.1.0",
        "platform": "both",
        "pluginType": "full",
        "wasiPreopenDirs": []
    });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    assert!(m.wasi_preopen_dirs.is_empty());
    let back = serde_json::to_value(&m).unwrap();
    assert!(
        back.get("wasiPreopenDirs").is_none(),
        "空声明不得回写成键: {back}"
    );
}

/// 两形态混列：档位逐条独立，顺序即 guest 挂载顺序（/data、/data1…）
#[test]
fn test_wasi_preopen_dirs_mixed_forms_parse_in_order() {
    let json = serde_json::json!({
        "id": "com.wasmnest.demo",
        "name": "Demo",
        "version": "0.1.0",
        "platform": "both",
        "pluginType": "full",
        "wasiPreopenDirs": [
            "${home}/.wasmnest/ai-chatbox",
            { "path": "${home}/.ssh", "readonly": true },
            { "path": "${home}/write-me" }
        ]
    });
    let m: PluginManifest = serde_json::from_value(json).unwrap();
    assert_eq!(m.wasi_preopen_dirs.len(), 3);
    let tiers: Vec<(&str, bool)> = m
        .wasi_preopen_dirs
        .iter()
        .map(|d| (d.path(), d.readonly()))
        .collect();
    assert_eq!(
        tiers,
        vec![
            ("${home}/.wasmnest/ai-chatbox", false),
            ("${home}/.ssh", true),
            ("${home}/write-me", false),
        ]
    );
}

/// with_path 只换路径、不换档位：宿主展开 `${home}` 靠它，
/// 若实现改成重建条目而丢掉档位，只读声明会在到达 preopen 前退化成可写
#[test]
fn test_wasi_preopen_with_path_keeps_tier() {
    let ro = WasiPreopenDir::read_only("${home}/.ssh").with_path("/home/u/.ssh");
    assert_eq!(ro.path(), "/home/u/.ssh");
    assert!(ro.readonly(), "展开后仍须是只读档");

    let rw = WasiPreopenDir::writable("${home}/x").with_path("/home/u/x");
    assert_eq!(rw.path(), "/home/u/x");
    assert!(!rw.readonly(), "可写档展开后不得被串成只读");
}
