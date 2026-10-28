//! 桌面宿主侧生命周期编排层集成测试（Seam 1 · 真实装配路径）
//!
//! 契约来源：`.scratch/2026-10-17-desktop-host-lifecycle-sync/spec.md`（D1/D3/D4）。
//!
//! 被测面 = `PluginLifecycleManager`（宿主侧编排）对外行为，只断言外部契约：
//! - 清单 / 状态查询接回编排层（真实产物目录扫描）；
//! - 打开 = activate_after_preauth（persist=false）→ 运行中，但**不写启动快照**
//!   （下次 boot 不复活）；关闭 = deactivate（persist=true）→ 停用 + 快照写停用
//!   （机制层的 revoke_all / 总线退订 / store 回收由 wasm-core 自身测试覆盖，
//!   本层只证「编排把 persist 语义接到原语上」）；
//! - enabled / autostart 偏好：移动端同款 key 字面（只改偏好、系统分区持久化、
//!   只落偏好不触发当前进程启停）；enabled 语义 = 桌面主屏入口可见性（缺省可见，
//!   用户裁决 2026-10-21），与移动端「可用性标记缺省关」已裁决分叉；
//! - boot 装配补路：apply_autostart 按偏好补激活未运行应用、幂等、无偏好零副作用；
//!   系统服务（L1/L2）由 wasm-core 角色层先激活，用户显式关自启时在 boot 收口停用
//!   （2026-10-22 spec D4）。
//!
//! 装配走 `support::setup_host`（`PluginHost::new` 真实路径 + 随包产物），
//! 与 wasm_flow_e2e / broadcast_shutdown 同一基座。
//!
//! **插件 id 家族随 ADR 0056 全改 `com.wasmnest`**：本测试一律**从实际加载清单按
//! 目录名后缀派生**插件 id，不写死任一形态——产物重建后无需改本文件。

mod support;

use std::sync::Arc;

use support::*;
use wasmnest_desktop_lib::plugin::lifecycle::{
    PluginLifecycleManager, AUTOSTART_KEY_PREFIX, ENABLED_KEY_PREFIX, SYSTEM_PLUGIN_ID,
};

/// 目录名后缀（随包产物；`com.wasmnest.bedcode` 的实现 id 尾段）
const TERMINAL_SESSION_ID_SUFFIX: &str = "bedcode";
const AGENT_HUB_ID_SUFFIX: &str = "agent-hub";

/// 构造编排层（同一宿主的薄包装）
async fn setup_manager() -> Arc<PluginLifecycleManager> {
    let host = setup_host().await;
    Arc::new(PluginLifecycleManager::new(host))
}

/// 从实际加载清单取目录名后缀匹配的插件 id（改名窗口跨两形态，按产物派生）
async fn bundled_id(manager: &PluginLifecycleManager, suffix: &str) -> String {
    let infos = manager.list_loaded().await;
    let id = infos
        .iter()
        .map(|i| i.id.as_str())
        .find(|id| id.ends_with(suffix))
        .unwrap_or_else(|| panic!("随包插件目录名后缀 {suffix} 不在加载清单"));
    id.to_string()
}

/// boot 装配顺序锁：清理历史激活快照必须发生在 `PluginHost::new` **之前**。
///
/// 顺序反了 = wasm-core 先按旧快照把 L3 应用复活（「没打开却显示运行中」的
/// 绿点假象回归）。机制行为由 wasm-core 自身测试与本文件生命周期用例覆盖，
/// 平台侧这里只钉组合根里的调用顺序。
#[test]
fn boot_clears_activation_snapshot_before_creating_host() {
    // boot 装配点在 bootstrap/mod.rs（lib.rs 已收薄为入口声明）
    let boot_src = include_str!("../src/bootstrap/mod.rs");
    let clear = boot_src
        .find("clear_persisted_activation_snapshot(&plugin_storage)")
        .expect("bootstrap boot 必须在 PluginHost::new 前调用 clear_persisted_activation_snapshot");
    let host_new = boot_src
        .find("wasm_core::PluginHost::new")
        .expect("bootstrap boot 必须创建 PluginHost");
    assert!(
        clear < host_new,
        "清理激活快照必须在 PluginHost::new 之前（否则旧快照会复活 L3 应用）"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn list_loaded_projects_real_bundled_apps() {
    let manager = setup_manager().await;
    let infos = manager.list_loaded().await;
    let ids: Vec<&str> = infos.iter().map(|i| i.id.as_str()).collect();

    // 随包四应用在册（真实产物目录扫描；缺一个 = 构建/装配断链）
    for suffix in [
        TERMINAL_SESSION_ID_SUFFIX,
        AGENT_HUB_ID_SUFFIX,
        "ai-chatbox",
        "file-transfer",
    ] {
        assert!(
            ids.iter().any(|id| id.ends_with(suffix)),
            "随包应用 {suffix} 不在清单: {ids:?}"
        );
    }

    // L3 业务应用：空持久化状态下 boot 不得自动激活
    let agent_hub = bundled_id(&manager, AGENT_HUB_ID_SUFFIX).await;
    assert!(
        !manager.is_running(&agent_hub).await,
        "agent-hub 是 L3 业务应用，空持久化状态下 boot 不得自动激活"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn activate_then_deactivate_toggles_running_state() {
    let manager = setup_manager().await;
    let agent_hub = bundled_id(&manager, AGENT_HUB_ID_SUFFIX).await;

    // 打开（壳 openApp 时序：preauthorize 先行 + activate_after_preauth 会话级激活）
    manager
        .preauthorize(&agent_hub)
        .await
        .expect("preauthorize (空路径直接放行)");
    manager.activate_after_preauth(&agent_hub).await.expect("打开 = 激活");
    assert!(manager.is_running(&agent_hub).await, "激活后应运行");
    assert!(manager.is_activated(&agent_hub).await, "严格 Activated");

    // 关闭（真停用：deactivate persist=true → 持久化停用态）
    manager.deactivate(&agent_hub).await.expect("关闭 = 停用");
    assert!(!manager.is_running(&agent_hub).await, "停用后不应运行");
    assert!(!manager.is_activated(&agent_hub).await, "停用后严格 Activated 为假");
}

/// 打开是**会话级**动作：`activate_after_preauth` 不得写「下次 boot 复活」快照
/// （persist=false）；关闭才持久化停用态（persist=true），即使用户先打开再关闭，
/// 下次 boot 也只会看到 false。用户 2026-10-20 裁决：没打开的应用不能在重启后
/// 变成运行中（绿点假象）。
#[tokio::test(flavor = "multi_thread")]
async fn open_is_session_scoped_deactivate_persists_stop() {
    let manager = setup_manager().await;
    let agent_hub = bundled_id(&manager, AGENT_HUB_ID_SUFFIX).await;
    let storage = manager.host().storage();

    // 打开（persist=false）→ 运行中，但快照里不得出现 true
    manager.activate_after_preauth(&agent_hub).await.expect("activate");
    assert!(manager.is_running(&agent_hub).await, "打开后应运行");
    let map = storage.load_activated_plugins().await.expect("load activated map");
    assert!(
        !map.get(&agent_hub).copied().unwrap_or(false),
        "打开不得写启动复活快照（persist=false）"
    );

    // 关闭（persist=true）→ 快照明确写停用（boot 不复活）
    manager.deactivate(&agent_hub).await.expect("deactivate");
    let map = storage.load_activated_plugins().await.expect("load activated map");
    assert_eq!(
        map.get(&agent_hub).copied(),
        Some(false),
        "停用后快照必须明确写 false（下次 boot 不复活）"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn enabled_pref_roundtrip_and_persisted_in_system_partition() {
    let manager = setup_manager().await;
    let agent_hub = bundled_id(&manager, AGENT_HUB_ID_SUFFIX).await;

    // 缺省 = 可见（主屏入口可见性缺省成立——停用是显式 false，缺省不隐藏任何应用）
    assert!(
        manager.is_enabled(&agent_hub).await,
        "无偏好行 = 主屏入口可见（启用语义：主屏入口可见性，2026-10-21 用户裁决）"
    );

    manager.set_enabled(&agent_hub, true).await.expect("set enabled");
    assert!(
        manager.is_enabled(&agent_hub).await,
        "置 true 后生效；偏好行可读且为 true"
    );
    // 持久化契约：用户显式 true 也落行（可见取向显式化，不依赖缺省推断）
    let storage = manager.host().storage();
    let value = storage
        .get(SYSTEM_PLUGIN_ID, &format!("{ENABLED_KEY_PREFIX}{agent_hub}"))
        .await
        .expect("read pref row");
    assert_eq!(value, Some(serde_json::json!(true)), "偏好行必须可读且为 true");

    manager.set_enabled(&agent_hub, false).await.expect("set disabled");
    assert!(
        !manager.is_enabled(&agent_hub).await,
        "置 false = 主屏 / 搜索隐藏入口（不停止已运行实例，由壳层过滤）"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn autostart_pref_roundtrip_without_activating() {
    let manager = setup_manager().await;
    let agent_hub = bundled_id(&manager, AGENT_HUB_ID_SUFFIX).await;

    assert!(!manager.is_autostart(&agent_hub).await, "缺省 = 不自启");

    manager.set_autostart(&agent_hub, true).await.expect("set autostart");
    assert!(manager.is_autostart(&agent_hub).await, "置 true 后生效");

    // 只改偏好，不在当前进程立即激活（移动端同款语义：偏好 → 下次 boot 生效）
    assert!(
        !manager.is_running(&agent_hub).await,
        "set_autostart 不得触发当前进程激活"
    );

    // 持久化契约：系统分区 plugin.autostart.{id} 行
    let storage = manager.host().storage();
    let value = storage
        .get(SYSTEM_PLUGIN_ID, &format!("{AUTOSTART_KEY_PREFIX}{agent_hub}"))
        .await
        .expect("read pref row");
    assert_eq!(value, Some(serde_json::json!(true)), "偏好行必须可读且为 true");

    manager.set_autostart(&agent_hub, false).await.expect("set false");
    assert!(!manager.is_autostart(&agent_hub).await, "置 false 后回退");
}

#[tokio::test(flavor = "multi_thread")]
async fn apply_autostart_stops_role_driven_service_when_disabled_by_preference() {
    let manager = setup_manager().await;
    let monitor_id = bundled_id(&manager, "monitor").await;

    let info = manager.get_info(&monitor_id).await.expect("monitor 在随包清单");
    assert!(
        info.kind.is_role_driven(),
        "随包 monitor 必须声明为系统服务（internal-business）"
    );
    // wasm-core boot 的角色驱动层（ADR 0032）先于业务应用激活服务
    assert!(manager.is_running(&monitor_id).await, "角色驱动层应已激活服务");
    assert!(
        manager.is_autostart(&monitor_id).await,
        "未写偏好 = 系统服务缺省自启开（D4）"
    );

    // 用户显式关闭自启 → boot 收口停用本会话实例（不写启动快照）
    manager.set_autostart(&monitor_id, false).await.expect("set false");
    assert_eq!(manager.apply_autostart().await, 0, "停用不计入激活数");
    assert!(
        !manager.is_running(&monitor_id).await,
        "显式关闭自启后 boot 收口应停用系统服务"
    );

    // 幂等：再跑一次仍停用、不报错；偏好仍为显式 false
    assert_eq!(manager.apply_autostart().await, 0);
    assert!(!manager.is_running(&monitor_id).await);
    assert!(!manager.is_autostart(&monitor_id).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn apply_autostart_is_idempotent_and_activates_marked_apps() {
    let manager = setup_manager().await;
    let agent_hub = bundled_id(&manager, AGENT_HUB_ID_SUFFIX).await;

    // 无任何自启偏好 → 零副作用（不得把「没标自启」的应用带起来）
    assert_eq!(manager.apply_autostart().await, 0, "无偏好不得激活任何应用");

    // 给 L3 业务应用标自启 → boot 装配补激活；重复调用幂等
    manager.set_autostart(&agent_hub, true).await.expect("set autostart");
    assert_eq!(manager.apply_autostart().await, 1, "标自启的应用应被补激活");
    assert!(manager.is_running(&agent_hub).await, "自启应用应运行");
    assert_eq!(manager.apply_autostart().await, 0, "已运行再装配 = 幂等零动作");
    // 已运行应用不受再次装配影响（状态保持）
    assert!(manager.is_running(&agent_hub).await);
}
