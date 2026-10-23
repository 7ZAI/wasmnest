//! 应用作用域服务租约（`net.transport`）集成测试（service-leases §9.2）
//!
//! 真组件验收：真实 `ServiceRegistry` + `ServerSupervisor` / `TransportService`
//! + 真实 mDNS advertiser + 真实 `PluginHost` 加载 http fixture 插件。
//!
//! 断言链：
//! 1. 零 holder → server 未运行、未广播；
//! 2. 无传输端点的应用界面不拉起传输面；
//! 3. 首个界面 acquire → 服务器 running、广播登记、端口可连；
//! 4. 第二个 holder → 只挂引用（服务不重启）；
//! 5. 释放非最后引用 → 仍 running / 仍广播；
//! 6. 释放最后引用 → 停服 + 注销广播 + 新连接被拒；
//! 7. 再次 acquire → 可复用重新启动；
//! 8. 插件路径：activate 注册端点**只预登记**（不启动）；界面打开 acquire →
//!    服务启动；界面关闭 release → 服务停；deactivate 回收 holder；
//! 9. 运行期租约（manifest `backgroundTransport: true`）：启动成功即持有传输面，
//!    界面打开 / 关闭均为宿主侧 no-op（不再决定 8775 生死），停用由
//!    `release_all_for` 回收。
//!
//! 串行化：本文件只含一个 `#[tokio::test]`（tests/ 下每文件独立进程，AppContext /
//! server ports / WebSocketManager 等进程级单例天然隔离）。
//!
//! 夹具产物：http fixture 需先跑 `cargo test --test fixture_keeper`
//! （产物落点 `target/fixtures/wasm32-wasip3/...`，见 support 模块文档）。

mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use support::sdk_fixture_artifact_bytes;
use wasmnest_desktop_lib::db::Database;
use wasmnest_desktop_lib::plugin::services::{acquire_for_surface, plugin_uses_transport, release_for_surface};
use wasmnest_desktop_lib::server::composition::install_server_ports;
use wasmnest_desktop_lib::system::app_context::AppContextBuilder;
use wasmnest_desktop_lib::system::info::SystemInfo;
use wasmnest_desktop_lib::wasm_core::PluginHost;
use wasmnest_desktop_lib::AppConfig;
use wasmnest_discovery_engine::advertiser::MdnsAdvertiser;
use wasmnest_server_base::service::{AcquireOutcome, ReleaseOutcome, ServiceRegistry};
use wasmnest_server_core::service::{TransportService, TRANSPORT_SERVICE_KEY};
use wasmnest_server_core::supervisor::ServerSupervisor;
use wasmnest_server_websocket::WebSocketManager;

const HTTP_PLUGIN_ID: &str = "com.wasmnest.http-test";
/// 同一 wasm 产物的「运行期传输租约」变体（manifest `backgroundTransport: true`）
const BG_HTTP_PLUGIN_ID: &str = "com.wasmnest.http-bg-test";
const HTTP_PLUGIN_LIB: &str = "wasmnest_plugin_http_test";
const HTTP_FIXTURE_MANIFEST: &str = include_str!("../../packages/plugin-sdk-fixtures/http.json");

fn pick_free_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("probe free port failed");
    listener.local_addr().expect("read probed port failed").port()
}

/// 写入 http fixture 插件包（manifest 复用夹具真源；wasm 产物只读 keeper 输出）
///
/// `background` = 生成「运行期持有传输租约」变体：同一 wasm、只改 id 与
/// `backgroundTransport` 声明，覆盖「服务端属性跟应用启动走」的验收。
fn write_http_fixture_package(plugins_dir: &Path, plugin_id: &str, background: bool) {
    let dir = plugins_dir.join(plugin_id);
    std::fs::create_dir_all(&dir).expect("create fixture plugin dir");
    let mut manifest: serde_json::Value =
        serde_json::from_str(HTTP_FIXTURE_MANIFEST).expect("fixture manifest must be valid json");
    manifest["id"] = serde_json::Value::String(plugin_id.to_string());
    if background {
        manifest["backgroundTransport"] = serde_json::Value::Bool(true);
    }
    std::fs::write(
        dir.join("plugin.json"),
        serde_json::to_string_pretty(&manifest).expect("serialize fixture manifest"),
    )
    .expect("write fixture manifest");
    std::fs::write(
        dir.join(format!("{HTTP_PLUGIN_LIB}.wasm")),
        sdk_fixture_artifact_bytes("http"),
    )
    .expect("write fixture wasm");
}

async fn tcp_connectable(port: u16) -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_millis(500),
            tokio::net::TcpStream::connect(("127.0.0.1", port))
        )
        .await,
        Ok(Ok(_))
    )
}

/// 停机后轮询到「连接被拒 / 不再可连」（Windows TCP 栈收敛可能需数秒）
async fn wait_until_unreachable(port: u16) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if !tcp_connectable(port).await {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn service_lease_lifecycle_flow() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_test_writer()
        .try_init();

    static CONFIG_INIT: std::sync::Once = std::sync::Once::new();
    CONFIG_INIT.call_once(|| {
        let mut config = AppConfig::default();
        config.network.port = pick_free_port();
        AppConfig::init(config);
    });

    let tmp = tempfile::TempDir::new().expect("tempdir");
    let plugins_dir = tmp.path().join("plugins");
    let user_plugins_dir = tmp.path().join("user-plugins");
    std::fs::create_dir_all(&plugins_dir).expect("create plugins dir");
    std::fs::create_dir_all(&user_plugins_dir).expect("create user plugins dir");
    write_http_fixture_package(&plugins_dir, HTTP_PLUGIN_ID, false);
    write_http_fixture_package(&plugins_dir, BG_HTTP_PLUGIN_ID, true);

    let db = Arc::new(std::sync::Mutex::new(
        Database::new(Path::new(":memory:")).expect("create in-memory db"),
    ));
    db.lock().expect("db lock").init_schema().expect("init db schema");

    let registry = Arc::new(ServiceRegistry::new());
    let plugin_host = PluginHost::new(
        db.clone(),
        &plugins_dir,
        &user_plugins_dir,
        None,
        None,
        Vec::new(),
        wasmnest_desktop_lib::wasm_core::manager::runtime::AbiPolicy {
            form: Some(wasmnest_plugin_api::form::FORM_COMPONENT),
        },
        Arc::new(wasmnest_desktop_lib::plugin::host_facts::DesktopHostFacts),
        None,
        Some(registry.clone()),
    )
    .await;
    plugin_host.init_message_bus().await;
    plugin_host
        .wasm_host_ctx()
        .set_plugin_db_root(Some(tmp.path().join("plugin-db")));

    let mdns_advertiser = Arc::new(tokio::sync::RwLock::new(MdnsAdvertiser::new()));
    let system_info = Arc::new(SystemInfo::collect());
    AppContextBuilder::new()
        .db(db.clone())
        .plugin_host(plugin_host.clone())
        .mdns_advertiser(mdns_advertiser.clone())
        .app_handle(None)
        .resource_dir(Arc::new(PathBuf::from(".")))
        .system_info(system_info)
        .build_and_init();

    install_server_ports();
    WebSocketManager::global().init().await.expect("init WebSocketManager");

    let port = pick_free_port();
    let supervisor = ServerSupervisor::global();
    supervisor.init_config(port).await;
    TransportService::register(&registry).expect("register net.transport");

    // ==================== 1. 零 holder：零监听 / 零广播 ====================
    assert!(!supervisor.is_running().await, "零应用时 transport 不得运行");
    assert!(!mdns_advertiser.read().await.is_advertising().await, "零应用时不得广播");

    // ==================== 1b. 无传输端点的应用界面不拉起传输面 ====================
    assert!(!plugin_uses_transport("com.example.no-endpoints"));
    acquire_for_surface(Some(registry.clone()), "com.example.no-endpoints", "test")
        .await
        .expect("无端点应用的界面租用是 no-op");
    assert!(!supervisor.is_running().await, "无端点应用不得拉起传输面");
    assert!(registry.snapshot().await[0].holders.is_empty());

    // ==================== 2. 首个 acquire：启动 + 广播 + 可连 ====================
    assert_eq!(
        registry.acquire(TRANSPORT_SERVICE_KEY, "app.a").await.unwrap(),
        AcquireOutcome::Started
    );
    assert!(supervisor.is_running().await, "首个引用必须拉起 transport");
    assert!(
        mdns_advertiser.read().await.is_advertising().await,
        "transport start 返回时广播必须已登记"
    );
    assert!(tcp_connectable(port).await, "端口必须可连接");

    // ==================== 3. 第二个 holder：只挂引用 ====================
    assert_eq!(
        registry.acquire(TRANSPORT_SERVICE_KEY, "app.b").await.unwrap(),
        AcquireOutcome::Attached
    );
    assert_eq!(
        registry.snapshot().await[0].holders,
        vec!["app.a".to_string(), "app.b".to_string()]
    );

    // ==================== 4. 释放非最后引用：服务不断 ====================
    assert_eq!(
        registry.release(TRANSPORT_SERVICE_KEY, "app.a").await.unwrap(),
        ReleaseOutcome::Released
    );
    assert!(supervisor.is_running().await);
    assert!(mdns_advertiser.read().await.is_advertising().await);

    // ==================== 5. 释放最后引用：停服 + 停播 + 连接被拒 ====================
    assert_eq!(
        registry.release(TRANSPORT_SERVICE_KEY, "app.b").await.unwrap(),
        ReleaseOutcome::Stopped
    );
    assert!(!supervisor.is_running().await, "最后一个引用释放后必须停服");
    assert!(
        !mdns_advertiser.read().await.is_advertising().await,
        "停服返回时广播必须已注销"
    );
    assert!(wait_until_unreachable(port).await, "停服后新连接必须被拒");

    // ==================== 6. 再次 acquire：可复用 ====================
    assert_eq!(
        registry.acquire(TRANSPORT_SERVICE_KEY, "app.a").await.unwrap(),
        AcquireOutcome::Started
    );
    assert!(supervisor.is_running().await);
    assert_eq!(
        registry.release(TRANSPORT_SERVICE_KEY, "app.a").await.unwrap(),
        ReleaseOutcome::Stopped
    );

    // ==================== 7. 插件路径：注册只预登记，界面打开才 acquire ====================
    plugin_host
        .activate_plugin(HTTP_PLUGIN_ID, false)
        .await
        .expect("activate http fixture");
    assert!(
        plugin_uses_transport(HTTP_PLUGIN_ID),
        "fixture activate 必须注册 HTTP 端点"
    );
    let snapshot = registry.snapshot().await;
    assert!(
        snapshot[0].holders.is_empty(),
        "注册端点只写路由表，不得 acquire 传输面"
    );
    assert!(!supervisor.is_running().await, "仅注册端点不得启动传输面");
    assert!(!mdns_advertiser.read().await.is_advertising().await);

    // 应用界面打开 → 该插件持有传输面：服务启动 + 广播
    acquire_for_surface(Some(registry.clone()), HTTP_PLUGIN_ID, "test")
        .await
        .expect("surface open acquires transport");
    let snapshot = registry.snapshot().await;
    assert_eq!(
        snapshot[0].holders,
        vec![HTTP_PLUGIN_ID.to_string()],
        "界面打开必须落 holder"
    );
    assert!(supervisor.is_running().await, "界面持有引用时 transport 运行");
    assert!(mdns_advertiser.read().await.is_advertising().await);

    // 应用界面关闭 → 最后一个引用释放：停服 + 停播
    release_for_surface(Some(registry.clone()), HTTP_PLUGIN_ID, "test")
        .await
        .expect("surface close releases transport");
    let snapshot = registry.snapshot().await;
    assert!(snapshot[0].holders.is_empty(), "界面关闭后 holder 必须清空");
    assert!(!supervisor.is_running().await, "界面关闭后 transport 必须关停");
    assert!(!mdns_advertiser.read().await.is_advertising().await);

    plugin_host
        .deactivate_plugin(HTTP_PLUGIN_ID, false)
        .await
        .expect("deactivate http fixture");
    let snapshot = registry.snapshot().await;
    assert!(snapshot[0].holders.is_empty(), "停用后 holder 必须清空");

    // ==================== 8. backgroundTransport：租约跟运行期，不跟界面 ====================
    // 服务端型应用：启动成功即持有传输面；界面打开 / 关闭都不改变租约，
    // 停用由内核 `release_all_for` 统一回收。
    let lifecycle =
        wasmnest_desktop_lib::plugin::lifecycle::PluginLifecycleManager::new(plugin_host.clone());
    lifecycle
        .activate_after_preauth(BG_HTTP_PLUGIN_ID)
        .await
        .expect("activate background-transport fixture");
    let snapshot = registry.snapshot().await;
    assert_eq!(
        snapshot[0].holders,
        vec![BG_HTTP_PLUGIN_ID.to_string()],
        "backgroundTransport 应用启动成功后必须持有传输租约"
    );
    assert!(
        supervisor.is_running().await,
        "运行期租约必须拉起传输面（无需打开界面）"
    );
    assert!(
        mdns_advertiser.read().await.is_advertising().await,
        "运行期租约必须登记广播"
    );

    // 界面关闭：宿主命令层对运行期租约应用 no-op（界面不再决定 8775 生死）
    wasmnest_desktop_lib::commands::plugin_surface_close(BG_HTTP_PLUGIN_ID.to_string())
        .await
        .expect("surface close on background app must be a no-op success");
    let snapshot = registry.snapshot().await;
    assert_eq!(
        snapshot[0].holders,
        vec![BG_HTTP_PLUGIN_ID.to_string()],
        "界面关闭不得释放运行期租约"
    );
    assert!(
        supervisor.is_running().await,
        "界面关闭后传输面必须继续运行"
    );

    // 界面打开同样不重复记账（幂等 no-op）
    wasmnest_desktop_lib::commands::plugin_surface_open(BG_HTTP_PLUGIN_ID.to_string())
        .await
        .expect("surface open on background app must be a no-op success");
    assert_eq!(
        registry.snapshot().await[0].holders,
        vec![BG_HTTP_PLUGIN_ID.to_string()],
        "界面打开不得产生第二个 holder"
    );

    // 停用：release_all_for 兜住回收（停服 + 停播）
    lifecycle
        .deactivate(BG_HTTP_PLUGIN_ID)
        .await
        .expect("deactivate background fixture");
    let snapshot = registry.snapshot().await;
    assert!(snapshot[0].holders.is_empty(), "停用后 holder 必须清空");
    assert!(
        !supervisor.is_running().await,
        "停用后传输面必须关停（release_all_for 兜底）"
    );
    assert!(!mdns_advertiser.read().await.is_advertising().await);

    // 兜底：即使断言中途失败，也不把进程级服务留给后续用例
    let _ = registry.shutdown_all().await;
    let _ = supervisor.stop().await;
}
