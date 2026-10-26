// ==================== 状态机单元测试（spec §3.3 / issue 01 验证清单） ====================
//
// 设计依据：
// - 与桌面端 host.rs:test_activate_degraded_on_startup_failure_then_retry_recovers
//   同模式（真组件 + storage 开关）
// - 移动端 plugin-component-test 已有 `on-startup-fail` feature（L107-109），
//   `wasm_runtime/component.rs:745 build_test_component(features)` 编译产物
// - 行为覆盖：activate 失败→Degraded / Degraded 可重试→Activated /
//   Degraded 停用→Deactivated / dispatch_lifecycle 跳过 AppStartup 二次调用
//
// 锁约束：tests.rs 即 manager::tests 模块本体（manager 子模块），父模块私有项对其可见

use super::*;
use super::events::PluginManagerDispatcher;
use crate::plugin::wasm_runtime::LoadedWasmPlugin;
use crate::test_fixtures::build_test_component;
use std::sync::Arc as StdArc;
use tempfile::TempDir;
use wasmtime::component::Component;

const TEST_PID_DEGRADED: &str = "com.wasmnest.test.mgr-degraded";
const TEST_PID_RETRY: &str = "com.wasmnest.test.mgr-retry";
const TEST_PID_DEACTIVATE: &str = "com.wasmnest.test.mgr-deactivate";
const TEST_PID_DISPATCH: &str = "com.wasmnest.test.mgr-dispatch";

/// 构造最小可激活的 PluginManager
///
/// - app_handle = None（绕开 `app_handle.path()` 读 AOT cache dir 路径）
/// - 注入 WasmRuntime (no aot cache) + WasmHostContext（无 fs_auth app_handle 依赖）
/// - 注入 MessageDispatcher 桥
async fn setup_manager() -> (PluginManager, TempDir) {
    let tmp = TempDir::new().expect("tempdir");
    let app_data_dir = tmp.path().to_path_buf();
    let settings = StdArc::new(SettingsManager::new(&app_data_dir).expect("settings"));
    let plugin_db = StdArc::new(std::sync::Mutex::new(Database::from_connection(
        rusqlite::Connection::open_in_memory().expect("in-memory sqlite"),
    )));
    // 票 05b：镜像生产启动顺序——DB 开库后跑内核 schema 初始化
    // （单一真源 = wasm-core `db/schema.sql`；宿主不自持 DDL 副本）
    plugin_db
        .lock()
        .expect("schema lock")
        .init_schema()
        .expect("init plugin db schema");

    let manager = PluginManager::new(
        &app_data_dir,
        settings,
        plugin_db,
        None, // app_handle = None：测试不走 emit / path
    );

    // init_wasm_runtime_with(None) 走无 AOT cache 路径；
    // 内部 status_reporter 是 no-op 闭包，app_handle 缺失由
    // `self.app_handle.as_ref().cloned()` 产生 None host_ctx，与
    // build_host_ctx(tmp) 同形态
    manager.init_wasm_runtime_with(None).await.expect("init wasm runtime");

    // init_wasm_runtime 内部不 set_dispatcher，需手动补
    let dispatcher: StdArc<dyn crate::plugin::message_bus::MessageDispatcher> = StdArc::new(PluginManagerDispatcher {
        plugins: manager.plugins.clone(),
        wasm_plugins: manager.wasm_plugins.clone(),
    });
    manager.message_bus.set_dispatcher(dispatcher).await;

    (manager, tmp)
}

/// 在 manager.plugins map 内插入一条 LoadedPlugin 记录（state 由调用方定）
async fn seed_plugin(manager: &PluginManager, pid: &str, state: PluginState) {
    let manifest = crate::plugin::types::PluginManifest {
        id: pid.to_string(),
        name: pid.to_string(),
        version: "0.1.0".to_string(),
        platform: crate::plugin::types::PluginPlatform::Mobile,
        description: String::new(),
        author: String::new(),
        main: String::new(),
        plugin_type: crate::plugin::types::PluginType::Wasm,
        permissions: vec![],
        contributes: crate::plugin::types::PluginContributes {
            lifecycle: Some(crate::plugin::types::LifecycleContribution {
                on_auth_success: true,
                ..Default::default()
            }),
            ..Default::default()
        },
        icon: None,
        wasm_hash: String::new(),
        rust_library: String::new(),
        preauth_dirs: vec![],
        preauth_urls: vec![],
        ..Default::default()
    };
    let mut plugins = manager.plugins.write().await;
    plugins.insert(
        pid.to_string(),
        LoadedPlugin {
            manifest,
            state,
            source: PluginSource::ApkAsset, // 信任域放行审批门禁（manager.rs:514）
            extension_path: "/tmp/test".to_string(),
        },
    );
}

/// 用真组件实例化一个 LoadedWasmPlugin 并塞入 manager.wasm_plugins
async fn attach_wasm(manager: &PluginManager, pid: &str, features: &[&str]) {
    // 与生产同形：实例共享宿主唯一上下文（权限真源 = 管理器，2026-10-14 收口）
    let host_ctx = manager.wasm_host_ctx.get().expect("host ctx initialized").clone();
    let runtime = manager.wasm_runtime.get().expect("wasm runtime initialized");
    let component = Component::from_binary(
        wasmnest_wasm_core::test_support::runtime_engine(runtime),
        &build_test_component(features),
    )
    .expect("compile test component");
    let loaded: LoadedWasmPlugin = runtime
        .instantiate_component(&component, pid, host_ctx, &[], None)
        .expect("instantiate component");
    let mut wasm_plugins = manager.wasm_plugins.write().await;
    wasm_plugins.insert(pid.to_string(), StdArc::new(tokio::sync::Mutex::new(loaded)));
}

#[tokio::test(flavor = "multi_thread")]
async fn test_activate_on_startup_failure_enters_degraded() {
    let (manager, tmp) = setup_manager().await;
    seed_plugin(&manager, TEST_PID_DEGRADED, PluginState::Loaded).await;
    attach_wasm(&manager, TEST_PID_DEGRADED, &["on-startup-fail"]).await;

    // phase 1: activate() 自身 Ok → 继续 phase 1b on_startup
    // phase 1b: on_startup 返回 Err("startup init failed (test)")
    // → 终态 Degraded { error 含 "startup init failed" }
    let result = manager.activate(TEST_PID_DEGRADED).await;
    assert!(
        result.is_ok(),
        "activate 调用本身应成功（phase 1a Ok），实际: {:?}",
        result
    );

    let info = manager.get_info(TEST_PID_DEGRADED).await.expect("plugin info");
    match info.state {
        PluginState::Degraded { error } => {
            assert!(
                error.contains("startup init failed"),
                "Degraded 错误信息应含 guest 自报原因，实际: {}",
                error
            );
        }
        other => panic!("期望 Degraded 终态，实际: {:?}", other),
    }

    // is_activated() 严格 Activated 语义保持（manager.rs:761-767）
    assert!(
        !manager.is_activated(TEST_PID_DEGRADED).await,
        "Degraded 不应通过 is_activated() 严格门禁"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn test_activate_degraded_retry_to_activated() {
    let (manager, tmp) = setup_manager().await;
    seed_plugin(&manager, TEST_PID_RETRY, PluginState::Loaded).await;
    attach_wasm(&manager, TEST_PID_RETRY, &["on-startup-fail"]).await;

    // 首次激活：on_startup 失败 → Degraded
    manager.activate(TEST_PID_RETRY).await.expect("first activate");
    let info = manager.get_info(TEST_PID_RETRY).await.expect("info");
    assert!(
        matches!(info.state, PluginState::Degraded { .. }),
        "首次激活应入 Degraded"
    );

    // manager.rs:586 守卫：Activated | Degraded 重入早返回 Ok，**不重试 on_startup**
    // — spec §3.3 「Degraded 可重试激活但重入无副作用」明确走幂等路径
    // 要重试必须先 deactivate 干净回落，再换 Ok 形态组件 activate
    manager.deactivate(TEST_PID_RETRY).await.expect("deactivate to reset");
    // 替换 wasm 实例为 Ok 形态（不破坏 Deactivated 终态约束，仅换实例）
    attach_wasm(&manager, TEST_PID_RETRY, &[]).await;

    // 把状态显式置 Loaded（deactivate 已落 Deactivated，activate 仍会从
    // Deactivated 走完整 phase 1b——manager.rs:586 仅守卫 Activated|Degraded）
    {
        let mut plugins = manager.plugins.write().await;
        if let Some(p) = plugins.get_mut(TEST_PID_RETRY) {
            p.state = PluginState::Loaded;
        }
    }
    manager.activate(TEST_PID_RETRY).await.expect("retry activate");
    let info = manager.get_info(TEST_PID_RETRY).await.expect("info after retry");
    assert_eq!(
        info.state,
        PluginState::Activated,
        "替换 Ok 形态组件后重试激活应入 Activated"
    );
}

/// 移动端引擎配置：生产装配路径必须**关掉信号式 trap**
///
/// Android 上 ART 经 `libsigchain` 接管应用注册的信号处理器 ⇒ wasmtime 的信号式
/// trap 被判成「非 wasm 故障」并交回上一个处理器（WebView/crashpad）⇒ **任何 guest
/// trap（插件 panic / 越界 / 栈溢出 / 燃料耗尽）都变成宿主进程 SIGILL 退出**
/// （2026-10-15 ai-chatbox 崩溃即此路径）。关掉后 trap 由生成代码经显式 libcall 抛出，
/// 不再经过信号链。
///
/// 本用例走**生产装配路径**（`init_wasm_runtime_with` → `mobile_core_config`）：
/// 只断言配置面值不得漏接（漏接 = 崩溃照旧且无任何报错）。
#[tokio::test(flavor = "multi_thread")]
async fn test_mobile_engine_disables_signals_based_traps() {
    let (manager, _tmp) = setup_manager().await;
    let engine = wasmnest_wasm_core::test_support::runtime_engine(manager.wasm_runtime());
    assert!(
        !engine.get_signals_based_traps(),
        "移动端必须关掉信号式 trap：否则任何 guest trap 都会 delegate 成进程 SIGILL"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn test_deactivate_degraded_falls_back_to_deactivated() {
    let (manager, tmp) = setup_manager().await;
    seed_plugin(&manager, TEST_PID_DEACTIVATE, PluginState::Loaded).await;
    attach_wasm(&manager, TEST_PID_DEACTIVATE, &["on-startup-fail"]).await;

    manager
        .activate(TEST_PID_DEACTIVATE)
        .await
        .expect("activate to degraded");
    let info = manager.get_info(TEST_PID_DEACTIVATE).await.expect("info");
    assert!(matches!(info.state, PluginState::Degraded { .. }), "应先入 Degraded");

    // manager.rs:696 守卫：Activated | Degraded 都允许 deactivate
    manager
        .deactivate(TEST_PID_DEACTIVATE)
        .await
        .expect("deactivate from degraded");
    let info = manager
        .get_info(TEST_PID_DEACTIVATE)
        .await
        .expect("info after deactivate");
    assert_eq!(
        info.state,
        PluginState::Deactivated,
        "Degraded 停用应干净回落 Deactivated"
    );
}

/// 命令面状态门禁：guest activate 未成功（Loaded / Error / Deactivated）时不得进 guest
///
/// 真机实证（2026-10-15 ai-chatbox SIGILL）：activate 失败后插件前端照常发命令，
/// 命令进 guest 就是「拿未初始化状态做 expect」→ panic → wasm trap → 进程退出。
/// 与桌面 `PluginHost::invoke_rust_command` 同一道闸；判据取「实例活着」
/// （Activated | Degraded），与 `dispatch_lifecycle_event` 同口径。
#[tokio::test(flavor = "multi_thread")]
async fn test_invoke_command_rejected_before_activate() {
    let (manager, _tmp) = setup_manager().await;
    let pid = "com.wasmnest.test.mgr-command-gate";
    seed_plugin(&manager, pid, PluginState::Loaded).await;
    attach_wasm(&manager, pid, &[]).await;

    let err = manager
        .invoke_command(pid, "test.echo", "{}")
        .await
        .expect_err("未激活时命令必须被拒");
    assert!(
        err.to_string().contains("not running"),
        "错误需点名未运行态，实际: {err}"
    );

    // 反向：激活成功后同一命令放行（门禁不能把正常路径一并拒掉）
    manager.activate(pid).await.expect("activate");
    let out = manager
        .invoke_command(pid, "test.echo", r#"{"hello":"gate"}"#)
        .await
        .expect("激活后命令应放行");
    assert!(out.contains("test.echo"), "放行后应拿到 guest 返回值: {out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn test_dispatch_lifecycle_app_startup_skips_wasm_side() {
    let (manager, tmp) = setup_manager().await;
    seed_plugin(&manager, TEST_PID_DISPATCH, PluginState::Loaded).await;
    attach_wasm(&manager, TEST_PID_DISPATCH, &[]).await;

    manager.activate(TEST_PID_DISPATCH).await.expect("activate");
    let info = manager.get_info(TEST_PID_DISPATCH).await.expect("info");
    assert_eq!(info.state, PluginState::Activated, "前置：先入 Activated");

    // AppStartup 事件不调 WASM on_startup（manager.rs:911-915 守卫）；
    // 行为回归断言 = 不 panic + state 不变
    manager.dispatch_lifecycle_event(PluginLifecycleEvent::AppStartup).await;
    let info = manager
        .get_info(TEST_PID_DISPATCH)
        .await
        .expect("info after app startup");
    assert_eq!(info.state, PluginState::Activated, "AppStartup 不应改变已激活插件状态");

    // AuthSuccess 事件对声明 onAuthSuccess 的插件正常分发（不 panic 即代表
    // dispatch 路径在 Degraded 守卫（manager.rs:922-925 扩为 Activated|Degraded）
    // 之外仍正确路由到 WASM call_lifecycle_event）
    manager
        .dispatch_lifecycle_event(PluginLifecycleEvent::AuthSuccess)
        .await;
    let info = manager
        .get_info(TEST_PID_DISPATCH)
        .await
        .expect("info after auth success");
    assert_eq!(
        info.state,
        PluginState::Activated,
        "AuthSuccess 不应改变已激活插件状态（仅回调）"
    );
}

// ==================== 审计 P0：init 失败 / 权限闸门 / uninstall 副作用 ====================

/// 构造非信任源（RemoteDownload）插件记录：approval 闸门对这类插件生效
async fn seed_user_plugin(
    manager: &PluginManager,
    pid: &str,
    ext_dir: &std::path::Path,
    permissions: Vec<String>,
    plugin_type: crate::plugin::types::PluginType,
) {
    let manifest = crate::plugin::types::PluginManifest {
        id: pid.to_string(),
        name: pid.to_string(),
        version: "0.1.0".to_string(),
        platform: crate::plugin::types::PluginPlatform::Mobile,
        description: String::new(),
        author: String::new(),
        main: String::new(),
        plugin_type,
        permissions,
        contributes: crate::plugin::types::PluginContributes {
            lifecycle: None,
            ..Default::default()
        },
        icon: None,
        wasm_hash: String::new(),
        rust_library: String::new(),
        preauth_dirs: vec![],
        preauth_urls: vec![],
        ..Default::default()
    };
    let mut plugins = manager.plugins.write().await;
    plugins.insert(
        pid.to_string(),
        LoadedPlugin {
            manifest,
            state: PluginState::Loaded,
            source: PluginSource::RemoteDownload,
            extension_path: ext_dir.to_string_lossy().to_string(),
        },
    );
}

#[tokio::test]
async fn test_init_wasm_runtime_without_app_handle_errors() {
    // app_handle=None 时公共入口（读 AOT cache 目录）必须快速失败，
    // 而不是静默继续（变异：删除 ok_or_else 守卫 → 本测试失败）
    let tmp = TempDir::new().expect("tempdir");
    let settings = StdArc::new(SettingsManager::new(&tmp.path().to_path_buf()).expect("settings"));
    let plugin_db = StdArc::new(std::sync::Mutex::new(Database::from_connection(
        rusqlite::Connection::open_in_memory().expect("in-memory sqlite"),
    )));
    let manager = PluginManager::new(&tmp.path().to_path_buf(), settings, plugin_db, None);
    let err = manager.init_wasm_runtime().await.expect_err("app_handle=None 必须 Err");
    assert!(err.to_string().contains("app_handle missing"), "err: {err}");
}

#[tokio::test]
async fn test_activate_user_plugin_without_approval_rejected() {
    // 权限闸门：未人工批准的 RemoteDownload 插件不得激活（防越权）
    let (manager, _tmp) = setup_manager().await;
    let pid = "com.wasmnest.test.mgr-gate";
    // 真实插件目录：verify_approval 需要 compute_dir_hash
    let ext_dir = manager.plugins_dir().join(pid);
    std::fs::create_dir_all(&ext_dir).expect("create plugin dir");
    std::fs::write(ext_dir.join("plugin.json"), r#"{"id":"x"}"#).expect("write manifest");

    seed_user_plugin(
        &manager,
        pid,
        &ext_dir,
        vec![],
        crate::plugin::types::PluginType::TsOnly,
    )
    .await;

    let err = manager.activate(pid).await.expect_err("未批准必须拒绝激活");
    assert!(err.to_string().contains("requires user approval"), "err: {err}");
    let info = manager.get_info(pid).await.expect("info after gate reject");
    assert_eq!(info.state, PluginState::NeedsApproval);
}

/// 构造信任源（ApkAsset）插件记录：审批门禁直接放行（内置插件路径）
async fn seed_trusted_plugin(
    manager: &PluginManager,
    pid: &str,
    permissions: Vec<String>,
    plugin_type: crate::plugin::types::PluginType,
) {
    let manifest = crate::plugin::types::PluginManifest {
        id: pid.to_string(),
        name: pid.to_string(),
        version: "0.1.0".to_string(),
        platform: crate::plugin::types::PluginPlatform::Mobile,
        description: String::new(),
        author: String::new(),
        main: String::new(),
        plugin_type,
        permissions,
        contributes: crate::plugin::types::PluginContributes {
            lifecycle: None,
            ..Default::default()
        },
        icon: None,
        wasm_hash: String::new(),
        rust_library: String::new(),
        preauth_dirs: vec![],
        preauth_urls: vec![],
        ..Default::default()
    };
    let mut plugins = manager.plugins.write().await;
    plugins.insert(
        pid.to_string(),
        LoadedPlugin {
            manifest,
            state: PluginState::Loaded,
            source: PluginSource::ApkAsset,
            extension_path: "/tmp/test".to_string(),
        },
    );
}

#[tokio::test]
async fn test_activate_approved_plugin_grants_effective_permissions() {
    // 闸门正例：批准 ∩ manifest 请求 = 生效权限（唯一真源 = 内核 PermissionManager）
    let (manager, _tmp) = setup_manager().await;
    let pid = "com.wasmnest.test.mgr-approve";
    let ext_dir = manager.plugins_dir().join(pid);
    std::fs::create_dir_all(&ext_dir).expect("create plugin dir");
    std::fs::write(ext_dir.join("plugin.json"), r#"{"id":"x"}"#).expect("write manifest");
    let hash = crate::plugin::approval::compute_dir_hash(&ext_dir).expect("dir hash");

    // 用户批准 storage + session:read；manifest 额外请求 terminal:output（未批准）
    manager
        .approvals
        .approve(
            pid,
            &["storage".to_string(), "session:read".to_string()],
            &hash,
            "0.1.0",
        )
        .await
        .expect("approve");
    seed_user_plugin(
        &manager,
        pid,
        &ext_dir,
        vec![
            "storage".to_string(),
            "session:read".to_string(),
            "terminal:output".to_string(),
        ],
        crate::plugin::types::PluginType::TsOnly,
    )
    .await;

    manager.activate(pid).await.expect("approved 应激活成功");
    let info = manager.get_info(pid).await.expect("info");
    assert_eq!(info.state, PluginState::Activated);
    // 生效权限集直接读权限真源（内核 PermissionManager），不再经 LoadedPlugin 镜像
    assert!(manager.has_permission(pid, "storage").await, "批准且声明 → 生效");
    assert!(manager.has_permission(pid, "session:read").await, "批准权限应生效");
    assert!(
        !manager.has_permission(pid, "terminal:output").await,
        "未批准权限不得生效（生效 = 批准 ∩ 请求）"
    );
}

#[tokio::test]
async fn test_activate_trusted_plugin_grants_manifest_permissions() {
    // 内置（ApkAsset）插件：无需审批，激活后持有 manifest 声明权限（词表外声明被过滤）。
    // 回归：修复前内建插件从不授予 PermissionManager，host_storage_get 恒拒
    // （真机日志 file-transfer permission=storage api=host_storage_get）。
    let (manager, _tmp) = setup_manager().await;
    let pid = "com.wasmnest.test.mgr-trusted";
    seed_trusted_plugin(
        &manager,
        pid,
        vec![
            "storage".to_string(),
            "fs:read".to_string(),
            "not-a-permission".to_string(),
        ],
        crate::plugin::types::PluginType::TsOnly,
    )
    .await;

    manager.activate(pid).await.expect("内置插件激活成功");

    assert!(
        manager.has_permission(pid, "storage").await,
        "manifest 声明即生效（内置插件）"
    );
    assert!(manager.has_permission(pid, "fs:read").await);
    assert!(
        !manager.has_permission(pid, "not-a-permission").await,
        "词表外声明在授权时被过滤"
    );
    assert!(
        !manager.has_permission(pid, "terminal:output").await,
        "未声明即无（无默认授予）"
    );
}

#[tokio::test]
async fn test_deactivate_revokes_all_permissions() {
    // 停用撤销（桌面 `revoke_all` 同款）：未撤销的授权会活到下一轮激活之前
    let (manager, _tmp) = setup_manager().await;
    let pid = "com.wasmnest.test.mgr-revoke";
    seed_trusted_plugin(
        &manager,
        pid,
        vec!["storage".to_string()],
        crate::plugin::types::PluginType::TsOnly,
    )
    .await;
    manager.activate(pid).await.expect("activate");
    assert!(manager.has_permission(pid, "storage").await, "激活期已授权");

    manager.deactivate(pid).await.expect("deactivate");

    assert!(!manager.has_permission(pid, "storage").await, "停用后权限全部撤销");
}

#[tokio::test]
async fn test_mark_error_keeps_needs_approval_state() {
    // 待审批是需用户动作的事实：前端 loader 在 plugin_activate 失败后固定调
    // mark_error，若被覆盖成 Error，壳的审批入口（详情页 / 权限总览）会消失
    let (manager, _tmp) = setup_manager().await;
    let pid = "com.wasmnest.test.mgr-needs-approval";
    seed_plugin(&manager, pid, PluginState::NeedsApproval).await;

    manager.mark_error(pid, "activation failed".to_string()).await;

    let info = manager.get_info(pid).await.expect("info");
    assert_eq!(info.state, PluginState::NeedsApproval);
}

#[tokio::test]
async fn test_mark_error_sets_error_for_other_states() {
    let (manager, _tmp) = setup_manager().await;
    let pid = "com.wasmnest.test.mgr-mark-error";
    seed_plugin(&manager, pid, PluginState::Loaded).await;

    manager.mark_error(pid, "frontend load failed".to_string()).await;

    match manager.get_info(pid).await.expect("info").state {
        PluginState::Error { error } => {
            assert!(error.contains("frontend load failed"), "err: {error}")
        }
        other => panic!("期望 Error 终态，实际: {other:?}"),
    }
}

#[tokio::test]
async fn test_uninstall_builtin_rejected() {
    // 内置插件（ApkAsset）不可卸载：拒绝且记录保留
    let (manager, _tmp) = setup_manager().await;
    let pid = "com.wasmnest.test.mgr-builtin";
    seed_plugin(&manager, pid, PluginState::Activated).await;

    let err = manager.uninstall(pid).await.expect_err("内置插件不可卸载");
    assert!(err.to_string().contains("cannot be uninstalled"), "err: {err}");
    assert!(manager.get_info(pid).await.is_some(), "内置插件记录保留");
}

/// 系统服务（L1/L2）不可卸载：判据 = manifest kind，不依赖来源标记。
#[tokio::test]
async fn test_uninstall_system_service_rejected_by_kind() {
    let (manager, _tmp) = setup_manager().await;
    let pid = "com.wasmnest.test.service-uninstall";
    seed_plugin(&manager, pid, PluginState::Loaded).await;
    {
        let mut plugins = manager.plugins.write().await;
        let plugin = plugins.get_mut(pid).expect("seeded");
        plugin.manifest.kind = PluginKind::InternalBusiness;
        // 来源改为用户安装，确保命中的是 kind 硬门而非内置来源门
        plugin.source = PluginSource::RemoteDownload;
    }

    let err = manager.uninstall(pid).await.expect_err("系统服务不可卸载");
    assert!(
        err.to_string().contains("System service cannot be uninstalled"),
        "err: {err}"
    );
    assert!(manager.get_info(pid).await.is_some(), "拒绝后记录必须保留");
}

#[tokio::test]
async fn test_uninstall_removes_records_and_dir() {
    // 非内置插件卸载副作用：审批撤销 + 记录清除 + 插件目录删除
    let (manager, _tmp) = setup_manager().await;
    let pid = "com.wasmnest.test.mgr-uninstall";
    let ext_dir = manager.plugins_dir().join(pid);
    std::fs::create_dir_all(&ext_dir).expect("create plugin dir");
    std::fs::write(ext_dir.join("plugin.json"), r#"{"id":"x"}"#).expect("write manifest");
    let hash = crate::plugin::approval::compute_dir_hash(&ext_dir).expect("dir hash");
    manager
        .approvals
        .approve(pid, &[], &hash, "0.1.0")
        .await
        .expect("approve");
    seed_user_plugin(
        &manager,
        pid,
        &ext_dir,
        vec![],
        crate::plugin::types::PluginType::TsOnly,
    )
    .await;

    manager.uninstall(pid).await.expect("uninstall");
    assert!(manager.get_info(pid).await.is_none(), "插件记录已清除");
    assert!(
        manager.approvals.get(pid).await.expect("get approval").is_none(),
        "审批记录已撤销"
    );
    assert!(!ext_dir.exists(), "插件目录已删除");
}

// ==================== 启用 / 自启动解耦（plugin.autostart） ====================
//
// 行为契约：启动时自动激活只由 `plugin.autostart.{id}` 决定（缺省关），
// 与 `plugin.enabled.{id}`（应用已启用 / 可用偏好）无关。

/// 正例 + 反例：同为「已启用」，只有开了自启动的进入候选
#[tokio::test]
async fn test_auto_start_candidates_honors_autostart_not_enabled() {
    let (manager, _tmp) = setup_manager().await;
    seed_plugin(&manager, "com.wasmnest.test.as-on", PluginState::Loaded).await;
    seed_plugin(&manager, "com.wasmnest.test.as-off", PluginState::Loaded).await;

    // 两者都应「已启用」（可用性偏好），但只有 as-on 开了自启动
    manager
        .set_enabled("com.wasmnest.test.as-on", true)
        .await
        .expect("enable on");
    manager
        .set_enabled("com.wasmnest.test.as-off", true)
        .await
        .expect("enable off");
    manager
        .set_autostart("com.wasmnest.test.as-on", true)
        .await
        .expect("autostart on");

    assert_eq!(
        manager.auto_start_candidates().await,
        vec!["com.wasmnest.test.as-on".to_string()],
        "启用偏好不得进入自启动候选（持久化 ≠ 自启动）"
    );
}

/// 边界：缺省（未设置自启动）→ 零候选
#[tokio::test]
async fn test_auto_start_candidates_default_off() {
    let (manager, _tmp) = setup_manager().await;
    seed_plugin(&manager, "com.wasmnest.test.as-default", PluginState::Loaded).await;
    manager
        .set_enabled("com.wasmnest.test.as-default", true)
        .await
        .expect("enable");

    assert!(
        manager.auto_start_candidates().await.is_empty(),
        "未设置自启动的应用默认不启动"
    );
}

/// 系统服务（L1/L2）缺省自启：未写偏好 = true；显式 false 优先。
#[tokio::test]
async fn test_auto_start_defaults_on_for_role_driven_services() {
    let (manager, _tmp) = setup_manager().await;
    let service = "com.wasmnest.test.as-service";
    let app = "com.wasmnest.test.as-business";

    seed_plugin(&manager, service, PluginState::Loaded).await;
    seed_plugin(&manager, app, PluginState::Loaded).await;
    {
        let mut plugins = manager.plugins.write().await;
        plugins.get_mut(service).expect("service seeded").manifest.kind = PluginKind::InternalBusiness;
    }

    assert!(manager.is_autostart(service).await, "L2 缺省自启");
    assert!(!manager.is_autostart(app).await, "L3 缺省不自启");
    assert_eq!(
        manager.auto_start_candidates().await,
        vec![service.to_string()],
        "只有缺省自启的系统服务进入候选"
    );

    manager.set_autostart(service, false).await.expect("set false");
    assert!(!manager.is_autostart(service).await, "显式 false 优先于角色缺省");
    assert!(manager.auto_start_candidates().await.is_empty());
}

/// 监控元数据：`sync_plugin_meta` 把 name / kind / monitorPanels 写进快照
/// （移动端 monitor 的服务分类与自定义面板列表来源）。
#[tokio::test(flavor = "multi_thread")]
async fn test_sync_plugin_meta_exposes_kind_and_panels() {
    let (manager, _tmp) = setup_manager().await;
    let service = "com.wasmnest.test.meta-service";
    seed_plugin(&manager, service, PluginState::Loaded).await;
    {
        let mut plugins = manager.plugins.write().await;
        let manifest = &mut plugins.get_mut(service).expect("seeded").manifest;
        manifest.name = "Meta Service".to_string();
        manifest.kind = PluginKind::InternalBusiness;
        manifest.contributes.monitor_panels = vec![wasmnest_wasm_core::manifest::MonitorPanelContribution {
            id: "health".to_string(),
            title: "Health".to_string(),
            order: 100,
        }];
    }

    manager.sync_plugin_meta().await;

    let runtime = manager.wasm_runtime.get().expect("wasm runtime initialized");
    let snapshot = runtime.monitor().snapshot();
    let meta = &snapshot["plugin_meta"][service];
    assert_eq!(meta["name"], "Meta Service");
    assert_eq!(meta["kind"], "internal-business");
    assert_eq!(meta["monitorPanels"][0]["id"], "health");
    assert_eq!(meta["monitorPanels"][0]["order"], 100);
    assert!(
        snapshot["plugins"].is_object(),
        "元数据不得替换插件指标段（monitor 仍按全量指标展开）"
    );
}

/// 正例 + 反例 + 副作用：自启动偏好持久化（缺省 false → true → false）
#[tokio::test]
async fn test_autostart_preference_persists_and_defaults_off() {
    let (manager, _tmp) = setup_manager().await;
    let pid = "com.wasmnest.test.as-persist";

    assert!(!manager.is_autostart(pid).await, "缺省 = 不自动启动");

    manager.set_autostart(pid, true).await.expect("set true");
    assert!(manager.is_autostart(pid).await, "置 true 后生效");

    manager.set_autostart(pid, false).await.expect("set false");
    assert!(!manager.is_autostart(pid).await, "置 false 后回退");
}

/// 错误回退：上报错误撤销自启动（坏插件下次 boot 不再重试）且置 Error
#[tokio::test(flavor = "multi_thread")]
async fn test_reported_error_clears_autostart_and_marks_error() {
    let (manager, _tmp) = setup_manager().await;
    let pid = "com.wasmnest.test.as-error";
    seed_plugin(&manager, pid, PluginState::Activated).await;
    manager.set_autostart(pid, true).await.expect("autostart");

    let ctx = manager.wasm_host_ctx.get().expect("host ctx");
    (ctx.status_reporter)(pid, "boom");

    assert!(
        !manager.is_autostart(pid).await,
        "错误回退必须撤销自启动，否则坏插件每次 boot 重试报错"
    );
    match manager.get_info(pid).await.expect("info").state {
        PluginState::Error { error } => assert!(error.contains("boom"), "err: {error}"),
        other => panic!("期望 Error 终态，实际: {other:?}"),
    }
}

/// 副作用：卸载清掉自启动偏好（重装即全新，不继承旧开关）
#[tokio::test]
async fn test_uninstall_removes_autostart_preference() {
    let (manager, _tmp) = setup_manager().await;
    let pid = "com.wasmnest.test.mgr-uninstall-autostart";
    let ext_dir = manager.plugins_dir().join(pid);
    std::fs::create_dir_all(&ext_dir).expect("create plugin dir");
    std::fs::write(ext_dir.join("plugin.json"), r#"{"id":"x"}"#).expect("write manifest");
    let hash = crate::plugin::approval::compute_dir_hash(&ext_dir).expect("dir hash");
    manager
        .approvals
        .approve(pid, &[], &hash, "0.1.0")
        .await
        .expect("approve");
    seed_user_plugin(
        &manager,
        pid,
        &ext_dir,
        vec![],
        crate::plugin::types::PluginType::TsOnly,
    )
    .await;
    manager.set_autostart(pid, true).await.expect("set autostart");

    manager.uninstall(pid).await.expect("uninstall");

    assert!(!manager.is_autostart(pid).await, "卸载后自启动偏好已清除");
}

// ==================== 应用作用域服务租约的生命周期回收 ====================

use std::sync::atomic::{AtomicUsize, Ordering};

/// 租约测试替身：只记录启停次数，不触网络
struct LeaseProbe {
    starts: AtomicUsize,
    stops: AtomicUsize,
}

#[async_trait::async_trait]
impl wasmnest_server_base::service::ScopedService for LeaseProbe {
    fn key(&self) -> &'static str {
        "test.mobile.lease"
    }

    async fn start(&self) -> std::result::Result<(), String> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn stop(&self) -> std::result::Result<(), String> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

/// 三条离开运行态的路径都必须调用 `release_all_for`：
/// 停用成功 / 激活失败 / 进入 Error 态。
#[tokio::test]
async fn test_service_leases_released_on_deactivate_activation_failure_and_error() {
    use wasmnest_server_base::service::ScopedService;

    let (manager, _tmp) = setup_manager().await;
    let registry = manager.service_registry();
    let probe = StdArc::new(LeaseProbe {
        starts: AtomicUsize::new(0),
        stops: AtomicUsize::new(0),
    });
    registry.register(probe.clone() as StdArc<dyn ScopedService>).unwrap();

    let pid = "com.wasmnest.test.mgr-lease";
    seed_trusted_plugin(
        &manager,
        pid,
        vec!["storage".to_string()],
        crate::plugin::types::PluginType::TsOnly,
    )
    .await;
    manager.activate(pid).await.expect("activate");

    // ① 停用成功 → 释放并关停
    registry.acquire("test.mobile.lease", pid).await.unwrap();
    assert_eq!(probe.starts.load(Ordering::SeqCst), 1);
    manager.deactivate(pid).await.expect("deactivate");
    let snapshot = registry.snapshot().await;
    assert!(snapshot[0].holders.is_empty(), "停用后 holder 必须清空");
    assert!(!snapshot[0].running, "最后一个引用释放后服务必须关停");
    assert_eq!(probe.stops.load(Ordering::SeqCst), 1);

    // ② 激活失败 → 外层补偿释放半程租约
    registry
        .acquire("test.mobile.lease", "com.wasmnest.missing")
        .await
        .unwrap();
    assert!(manager.activate("com.wasmnest.missing").await.is_err());
    assert!(
        registry.snapshot().await[0].holders.is_empty(),
        "激活失败后不得残留 holder"
    );

    // ③ Error 态 → 活实例已不可服务，必须释放并停播
    registry.acquire("test.mobile.lease", pid).await.unwrap();
    manager.mark_error(pid, "trap".to_string()).await;
    let snapshot = registry.snapshot().await;
    assert!(snapshot[0].holders.is_empty(), "Error 态必须释放租约");
    assert!(!snapshot[0].running, "Error 态不得继续对外提供服务");
}
