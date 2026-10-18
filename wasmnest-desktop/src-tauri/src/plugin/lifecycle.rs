//! 桌面宿主侧插件生命周期编排层（与移动端 `PluginManager` 同构的宿主侧编排）
//!
//! **定位**（AGENTS §5.4 双端差异落宿主；`2026-10-17-desktop-host-lifecycle-sync`）：
//! wasm-core 单形态运行时持有**机制原语**（activate/deactivate/preauth/approve/
//! uninstall/权限授予与撤销/总线退订/store 回收——`PluginHost` 一整面），本模块
//! 是**桌面宿主侧的编排收口**：把「壳要驱动的动作」与「wasm-core 原语」一对一
//! 接起来，并补上移动端同款 key 语义的启用 / 自启偏好持久化。双端各持一份宿主
//! 编排（语义一致、实现各自），机制不再重复。
//!
//! 生命周期契约（与移动端逐字一致，`wasmnest-test/cross-end-tests` 门禁覆盖）：
//! - **打开** = `activate_after_preauth` → wasm-core `activate_plugin(id, persist=true)`
//!   ——持久化激活意图（下次 boot `auto_activate_from_persisted_state` 复活）；
//! - **关闭** = `deactivate` → wasm-core `deactivate_plugin(id, persist=true)`
//!   ——**真停用**：guest deactivate + 权限 `revoke_all` + 消息总线退订 + 注册表/
//!   令牌/互调 API 注销 + store 随实例回收（机制已证，见 wasm-core
//!   `deactivate_plugin_inner` 步骤 ①—统一清理段，D4 只补编排不重复实现）；
//! - **偏好** = `plugin.enabled.{id}`（可用性标记，不驱动启动）/ `plugin.autostart.{id}`
//!   （boot 自启偏好，缺省即关；只改偏好不触发当前进程启停，与移动端
//!   `plugin_set_autostart` 语义逐字一致）；
//! - **审批** = `preauthorize`（预授权/高权限位提示）→ 未授权落 `NeedsApproval`
//!   → `approve`（人工整单批准 + 目录内容哈希钉扎）→ 重新激活；
//! - **卸载** = `uninstall`（仅未启用插件可卸；停用 → 丢私有库 → 删目录 → 清存储
//!   → 撤销审批与激活持久化）。
//!
//! **boot 装配**：`PluginHost::new` 内部已跑 `auto_activate_from_persisted_state`
//! （保留，wasm-core 机制）；本模块补 `apply_autostart`（按 `plugin.autostart.{id}`
//! 偏好补激活未运行的应用）——两个驱动都是「按持久化偏好装配」，不改变
//! wasm-core 启动路径。旧「前端直连自启常驻」的隐含假设已随壳改造移除：
//! 前端加载由壳驱动（`useShellApps` 动作 → 本模块命令面）。

use std::sync::Arc;

use tauri::State;
use wasmnest_wasm_core::manager::host::PluginHost;
use wasmnest_wasm_core::manager::types::HostPluginInfo;
use wasmnest_wasm_core::storage::PluginStorage;

use crate::Result;

/// 系统级插件存储分区 id（真源 = `wasmnest_wasm_core::storage::SYSTEM_PLUGIN_ID`；
/// 桌面编排层读写启用 / 自启偏好与该分区（`activation_state` 同分区同一张
/// `plugin_storage` 表，属主 `__system__` 与插件数据隔离）。wasm-core 侧为
/// `pub(crate)`，本端只读同名常量并在测试里钉住逐字一致）。
pub const SYSTEM_PLUGIN_ID: &str = "__system__";

/// 启用偏好 key 前缀（移动端 `PLUGIN_ENABLED_KEY_PREFIX` 同款语义与字面：
/// `plugin.enabled.{plugin_id}`，值为 JSON `true` / `false`）
pub const ENABLED_KEY_PREFIX: &str = "plugin.enabled.";

/// 自启偏好 key 前缀（移动端 `PLUGIN_AUTOSTART_KEY_PREFIX` 同款语义与字面：
/// `plugin.autostart.{plugin_id}`；缺省即关——只有显式打开的才在 boot 自动激活）
pub const AUTOSTART_KEY_PREFIX: &str = "plugin.autostart.";

/// 桌面宿主侧插件生命周期编排层
///
/// 命令面（`lib.rs` 注册）与壳（`wasm-apps/bedcode/src/shell/useShellApps.ts`）
/// 的单一落点；全部动作委托 wasm-core `PluginHost`，本层不重复机制。
pub struct PluginLifecycleManager {
    host: Arc<PluginHost>,
}

impl PluginLifecycleManager {
    pub fn new(host: Arc<PluginHost>) -> Self {
        Self { host }
    }

    /// wasm-core 宿主句柄（供命令面 / 测试取用；编排层对外动作一律经本层方法）
    pub fn host(&self) -> &Arc<PluginHost> {
        &self.host
    }

    // ==================== 清单 / 状态查询（接回编排层；壳主屏与应用管理页消费） ====================

    /// 已加载插件清单（含运行态，供壳注册表投影）
    pub async fn list_loaded(&self) -> Vec<HostPluginInfo> {
        self.host.list_plugins().await
    }

    /// 单个插件信息
    pub async fn get_info(&self, plugin_id: &str) -> Option<HostPluginInfo> {
        self.host.get_plugin(plugin_id).await
    }

    /// 插件实例是否在运行（`Activated` / `Degraded`；供壳主屏状态 chip）
    pub async fn is_running(&self, plugin_id: &str) -> bool {
        self.host.is_running(plugin_id).await
    }

    /// 插件是否严格 `Activated`（功能门禁口径；壳审批 / 详情用）
    pub async fn is_activated(&self, plugin_id: &str) -> bool {
        self.host.is_activated(plugin_id).await
    }

    // ==================== 启停（persist 语义：打开即持久化激活 / 停用即持久化停用态） ====================

    /// 预授权（启用前置，独立命令供壳先行调用）：收集插件需授权路径单次合并弹窗；
    /// 拒绝直接返回 Err 不进入激活。已授权路径短路无二次弹窗。
    pub async fn preauthorize(&self, plugin_id: &str) -> Result<()> {
        self.host.preauthorize_plugin(plugin_id).await.map_err(|e| {
            crate::AppError::Plugin(format!("预授权插件 '{plugin_id}' 失败: {e}"))
        })
    }

    /// 壳「打开应用」的激活入口：前端已先行调 `preauthorize`，此处走完整激活
    /// （`activate_plugin` 内部的预授权兜底对已授权路径短路，无副作用），
    /// persist=true = 持久化激活意图（boot 复活）。
    pub async fn activate_after_preauth(&self, plugin_id: &str) -> Result<()> {
        self.host.activate_plugin(plugin_id, true).await.map_err(|e| {
            crate::AppError::Plugin(format!("激活插件 '{plugin_id}' 失败: {e}"))
        })
    }

    /// 壳「关闭应用」：**真停用**（guest deactivate + revoke_all + 总线退订 +
    /// store 随实例回收，机制在 wasm-core），persist=true = 持久化停用态
    /// （下次 boot 不再复活）。
    pub async fn deactivate(&self, plugin_id: &str) -> Result<()> {
        self.host
            .deactivate_plugin(plugin_id, true)
            .await
            .map_err(|e| crate::AppError::Plugin(format!("停用插件 '{plugin_id}' 失败: {e}")))
    }

    /// 人工批准插件权限（仅 `UserInstalled` 来源需要；整单批准 + 内容哈希钉扎）
    pub async fn approve(&self, plugin_id: &str) -> Result<Vec<String>> {
        self.host
            .approve_plugin(plugin_id)
            .await
            .map_err(|e| crate::AppError::Plugin(format!("批准插件 '{plugin_id}' 失败: {e}")))
    }

    /// 卸载插件（停用 → 丢私有库 → 删安装目录 → 清插件存储 → 撤销审批与持久化）
    ///
    /// 清理完成后**回收本编排层自持的启用 / 自启偏好**（`plugin.enabled.{id}` /
    /// `plugin.autostart.{id}`）：这两把 key 以系统分区属主写入，wasm-core
    /// `uninstall_plugin` 不识别、`clear_all(id)` 也清不到——不清理则卸载后同 id
    /// 重装静默继承旧偏好（移动端 manager.rs 同款回收；偏好清理失败 warn 留痕，
    /// 不阻断卸载——插件本体已卸，残留行由重装覆盖 / 下次卸载再清）。
    pub async fn uninstall(&self, plugin_id: &str) -> Result<()> {
        self.host
            .uninstall_plugin(plugin_id)
            .await
            .map_err(|e| crate::AppError::Plugin(format!("卸载插件 '{plugin_id}' 失败: {e}")))?;
        remove_prefs(&self.host.storage(), plugin_id).await;
        Ok(())
    }

    // ==================== 偏好（移动端同款 key 语义；只改偏好，不触发当前进程启停） ====================

    /// 应用「已启用 / 可用」偏好（缺省 false；不是启动触发器）
    pub async fn is_enabled(&self, plugin_id: &str) -> bool {
        read_bool_pref(&self.host.storage(), ENABLED_KEY_PREFIX, plugin_id).await
    }

    /// 设置应用「已启用 / 可用」偏好并持久化（不触发激活）
    pub async fn set_enabled(&self, plugin_id: &str, enabled: bool) -> Result<()> {
        write_bool_pref(&self.host.storage(), ENABLED_KEY_PREFIX, plugin_id, enabled).await
    }

    /// 应用「启动时自动激活」偏好（缺省 false = 不自动启动）
    pub async fn is_autostart(&self, plugin_id: &str) -> bool {
        read_bool_pref(&self.host.storage(), AUTOSTART_KEY_PREFIX, plugin_id).await
    }

    /// 设置应用「启动时自动激活」偏好并持久化
    ///
    /// 只改偏好，不在当前进程立即激活 / 停用（与移动端一致：偏好 → 下次 boot
    /// 或用户显式操作生效，避免「改配置即启停」的隐式副作用）。
    pub async fn set_autostart(&self, plugin_id: &str, autostart: bool) -> Result<()> {
        write_bool_pref(&self.host.storage(), AUTOSTART_KEY_PREFIX, plugin_id, autostart).await
    }

    // ==================== boot 装配（按 autostart 偏好；补在 wasm-core 持久化激活之后） ====================

    /// boot 后按 `plugin.autostart.{id}` 偏好补激活未运行的应用
    ///
    /// `PluginHost::new` 内部已按持久化激活状态装配（`auto_activate_from_persisted_state`，
    /// 保留）；本方法补上**显式自启偏好**这一路：autostart=true 且当前未运行的应用
    /// 激活（persist=false——偏好与「运行中快照」解耦，关掉自启后下次 boot 不再
    /// 因快照复活；close 动作本身写 persist=false 收口停用意图）。
    ///
    /// 角色驱动层（L1/L2）由 wasm-core boot 无条件激活，不消费偏好；此处幂等
    /// （已运行即跳过）。返回本次实际激活数（供 boot 日志 / 测试断言）。
    pub async fn apply_autostart(&self) -> usize {
        let infos = self.list_loaded().await;
        let mut activated = 0usize;
        for info in infos {
            if info.source == "builtin" {
                // 静态注册的系统组件（能力提供面）不消费用户偏好
                continue;
            }
            if !self.is_autostart(&info.id).await {
                continue;
            }
            if self.host.is_running(&info.id).await {
                continue;
            }
            match self.host.activate_plugin(&info.id, false).await {
                Ok(()) => {
                    activated += 1;
                    tracing::info!(plugin_id = %info.id, "[PluginLifecycle] autostart preference applied");
                }
                Err(e) => {
                    // 单个失败不阻断其余（与 wasm-core boot 同策略）；fail-visible 留痕
                    tracing::warn!(
                        plugin_id = %info.id,
                        error = %e,
                        "[PluginLifecycle] autostart activation failed"
                    );
                }
            }
        }
        activated
    }
}

// ==================== 偏好读写（纯函数，可单测；存储真源 = 插件存储系统分区） ====================

/// 读布尔偏好（缺省 / 损坏一律 false——fail-safe：自启 / 可用性默认不成立；
/// 存储读失败同样按 false 落，但 warn 留痕——不静默吞错，两次启动间持续失败可见）
async fn read_bool_pref(storage: &PluginStorage, prefix: &str, plugin_id: &str) -> bool {
    let key = format!("{prefix}{plugin_id}");
    match storage.get(SYSTEM_PLUGIN_ID, &key).await {
        Ok(Some(serde_json::Value::Bool(value))) => value,
        // None（缺省）/ 非 Bool（历史字符串形态 / 手工写坏）→ fail-safe false
        Ok(_) => false,
        Err(e) => {
            tracing::warn!(
                plugin_id = %plugin_id,
                key = %key,
                error = %e,
                "[PluginLifecycle] pref read failed, fall back to false (fail-safe)"
            );
            false
        }
    }
}

/// 写布尔偏好（JSON `true` / `false`；错误补操作上下文——§6 禁裸透传）
async fn write_bool_pref(storage: &PluginStorage, prefix: &str, plugin_id: &str, value: bool) -> Result<()> {
    let key = format!("{prefix}{plugin_id}");
    storage.set(SYSTEM_PLUGIN_ID, &key, serde_json::json!(value)).await.map_err(|e| {
        crate::AppError::Plugin(format!("写插件偏好 '{key}' 失败: {e}"))
    })
}

/// 回收某插件的启用 / 自启偏好行（卸载时调用；与移动端 `manager.rs` uninstall
/// 同款回收——wasm-core 不知这两把 key，`clear_all(id)` 清不到系统分区）。
/// 失败不阻断卸载，warn 留痕供审计（键含插件 id，不会误删他插件行）。
async fn remove_prefs(storage: &PluginStorage, plugin_id: &str) {
    for prefix in [ENABLED_KEY_PREFIX, AUTOSTART_KEY_PREFIX] {
        let key = format!("{prefix}{plugin_id}");
        if let Err(e) = storage.delete(SYSTEM_PLUGIN_ID, &key).await {
            tracing::warn!(
                plugin_id = %plugin_id,
                key = %key,
                error = %e,
                "[PluginLifecycle] pref cleanup on uninstall failed (row left; will be overwritten on next install)"
            );
        }
    }
}

// ==================== 命令面（D3：桌面补移动端同款缺失臂，语义逐字一致） ====================
//
// 仅补移动端 `commands.rs` 已有而桌面 api_bridge 缺失的六臂；清单 / 启停 /
// 审批 / 卸载等既有臂已由 api_bridge 注册（lib.rs 保留）。

/// 查询插件启用状态（应用「已启用 / 可用」偏好，不是启动触发器）
#[tauri::command]
pub async fn plugin_is_enabled(
    plugin_id: String,
    manager: State<'_, Arc<PluginLifecycleManager>>,
) -> Result<bool> {
    Ok(manager.is_enabled(&plugin_id).await)
}

/// 设置插件启用状态并持久化（不触发激活）
#[tauri::command]
pub async fn plugin_set_enabled(
    plugin_id: String,
    enabled: bool,
    manager: State<'_, Arc<PluginLifecycleManager>>,
) -> Result<()> {
    manager.set_enabled(&plugin_id, enabled).await
}

/// 查询插件「启动时自动激活」偏好（缺省 false = 不自动启动）
#[tauri::command]
pub async fn plugin_is_autostart(
    plugin_id: String,
    manager: State<'_, Arc<PluginLifecycleManager>>,
) -> Result<bool> {
    Ok(manager.is_autostart(&plugin_id).await)
}

/// 设置插件「启动时自动激活」偏好（只改偏好，下次 boot 生效）
#[tauri::command]
pub async fn plugin_set_autostart(
    plugin_id: String,
    autostart: bool,
    manager: State<'_, Arc<PluginLifecycleManager>>,
) -> Result<()> {
    manager.set_autostart(&plugin_id, autostart).await
}

/// 插件实例是否在运行（`Activated` / `Degraded`；壳主屏状态 chip）
#[tauri::command]
pub async fn plugin_is_running(
    plugin_id: String,
    manager: State<'_, Arc<PluginLifecycleManager>>,
) -> Result<bool> {
    Ok(manager.is_running(&plugin_id).await)
}

/// 插件是否严格 Activated（功能门禁口径）
#[tauri::command]
pub async fn plugin_is_activated(
    plugin_id: String,
    manager: State<'_, Arc<PluginLifecycleManager>>,
) -> Result<bool> {
    Ok(manager.is_activated(&plugin_id).await)
}

// ==================== 编排层单元测试（Seam 1 · 偏好持久化契约） ====================
//
// 激活 / 停用 / 审批 / 权限撤销 / store 回收的机制契约由 wasm-core 自身测试覆盖
// （`manager/host/tests/lifecycle_test.rs` 等）；本层只钉「偏好读写 + key 语义 +
// 键前缀字面与移动端逐字一致」——这些是编排层新引入的持久化面，机制层不负责。

#[cfg(test)]
mod tests {
    use super::*;

    /// 内存库存储夹具（生产 schema；`PluginStorage::test_storage` 常编译共享）
    fn storage() -> Arc<PluginStorage> {
        PluginStorage::test_storage()
    }

    #[tokio::test]
    async fn enabled_pref_roundtrip_and_default_off() {
        let storage = storage();
        // 缺省 = false（fail-safe：可用性 / 自启默认不成立）
        assert!(!read_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.a").await);

        write_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.a", true)
            .await
            .expect("write true");
        assert!(read_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.a").await);

        write_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.a", false)
            .await
            .expect("write false");
        assert!(!read_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.a").await);
    }

    #[tokio::test]
    async fn autostart_pref_roundtrip_and_default_off() {
        let storage = storage();
        assert!(!read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.b").await);

        write_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.b", true)
            .await
            .expect("write true");
        assert!(read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.b").await);
    }

    #[tokio::test]
    async fn prefs_are_isolated_per_plugin_and_per_kind() {
        let storage = storage();
        // 启用 / 自启互不串扰
        write_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.c", true)
            .await
            .expect("enabled");
        assert!(!read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.c").await);

        // 插件间互不串扰
        write_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.c", true)
            .await
            .expect("autostart c");
        write_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.d", false)
            .await
            .expect("autostart d");
        assert!(read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.c").await);
        assert!(!read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.d").await);
        // id 前缀匹配不得放宽（plugin.autostart.com.wasmnest.test.c 不应命中 test.d）
        assert!(!read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.d").await);
    }

    #[tokio::test]
    async fn corrupted_pref_value_falls_back_to_false() {
        let storage = storage();
        // 非 Bool 值（历史字符串形态 / 手工写坏）一律按 false 读——fail-safe，
        // 不因坏行把自启偏好误判成开启
        storage
            .set(
                SYSTEM_PLUGIN_ID,
                &format!("{AUTOSTART_KEY_PREFIX}com.wasmnest.test.e"),
                serde_json::json!("true"),
            )
            .await
            .expect("seed string value");
        assert!(!read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.e").await);
    }

    #[tokio::test]
    async fn remove_prefs_clears_both_pref_rows_and_keeps_other_plugins() {
        let storage = storage();
        write_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.x", true)
            .await
            .expect("enabled x");
        write_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.x", true)
            .await
            .expect("autostart x");
        // 其他插件偏好不受影响（隔离：只清目标插件的两行）
        write_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.y", true)
            .await
            .expect("enabled y");

        remove_prefs(&storage, "com.wasmnest.test.x").await;

        assert!(!read_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.x").await);
        assert!(!read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.x").await);
        assert!(read_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.y").await);
    }

    #[tokio::test]
    async fn remove_prefs_is_idempotent_when_absent() {
        let storage = storage();
        // 无偏好行的插件卸载：不得报错、不得误删任何行
        remove_prefs(&storage, "com.wasmnest.test.z").await;
        assert!(!read_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.z").await);
        assert!(!read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.z").await);
    }

    #[tokio::test]
    async fn key_prefixes_match_mobile_contract_literally() {
        // 移动端 `system/constants/plugin.rs`：plugin.enabled. / plugin.autostart.
        // 双端命令语义逐字一致（wasmnest-test/cross-end-tests 门禁），key 前缀字面必须钉死——
        // 改前缀而不改移动端 = 双端偏好互相读不到
        assert_eq!(ENABLED_KEY_PREFIX, "plugin.enabled.");
        assert_eq!(AUTOSTART_KEY_PREFIX, "plugin.autostart.");
        assert_eq!(SYSTEM_PLUGIN_ID, "__system__");
    }
}
