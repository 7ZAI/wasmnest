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
//! - **打开** = `activate_after_preauth` → wasm-core `activate_plugin(id, persist=false)`
//!   ——**只在当前会话运行**：关闭宿主 / 重启后不复活。跨启动启动由显式
//!   `plugin.autostart.{id}` 偏好决定（用户 2026-10-20 裁决：打开过的应用不能
//!   在下次启动变成「没打开却显示运行中」）；
//! - **服务端型应用**（manifest `backgroundTransport: true`）：内核在启动成功后
//!   建 `net.transport` 运行期租约（界面挂载 / 卸载不参与其生死），停用 /
//!   启动失败 / Error 由内核 `release_all_for` 回收——本编排层不重复该机制。
//! - **关闭** = `deactivate` → wasm-core `deactivate_plugin(id, persist=true)`
//!   ——**真停用**：guest deactivate + 权限 `revoke_all` + 消息总线退订 + 注册表/
//!   令牌/互调 API 注销 + store 随实例回收（机制已证，见 wasm-core
//!   `deactivate_plugin_inner` 步骤 ①—统一清理段，D4 只补编排不重复实现）；
//!   `persist=true` 同时把历史版本留下的「启动复活」快照写成停用；
//! - **偏好** = `plugin.enabled.{id}`（桌面语义 = **主屏入口可见性**，2026-10-21
//!   用户裁决「启用赋予真实语义」，缺省无行 = 可见；`false` = 用户停用 → 主屏 /
//!   搜索隐藏入口——不触发当前进程启停、不停止已运行实例，显式自启偏好独立生效。
//!   同一 key 移动端仍是「可用性标记」且无行为消费，双端语义分叉已在
//!   [`ENABLED_KEY_PREFIX`] 文档记录）/ `plugin.autostart.{id}`
//!   （boot 自启偏好，缺省按角色：L1/L2 系统服务默认开、L3 应用默认关；只改偏好
//!   不触发当前进程启停，与移动端 `plugin_set_autostart` 语义逐字一致）；
//! - **审批** = `preauthorize`（预授权/高权限位提示）→ 未授权落 `NeedsApproval`
//!   → `approve`（人工整单批准 + 目录内容哈希钉扎）→ 重新激活；
//! - **卸载** = `uninstall`（仅未启用插件可卸；停用 → 丢私有库 → 删目录 → 清存储
//!   → 撤销审批与激活持久化）。
//!
//! **boot 装配**：wasm-core `PluginHost::new` 内部仍会跑
//! `auto_activate_from_persisted_state`（能力仓机制，桌面不删）；平台在创建
//! `PluginHost` **之前**调用 [`clear_persisted_activation_snapshot`] 清空历史会话
//! 快照，保证 L3 业务应用不会因上次运行被复活。唯一允许 boot 启动应用的是
//! `apply_autostart`（按 `plugin.autostart.{id}` 偏好；用户显式开启）——旧
//! 「前端直连自启常驻」的隐含假设已随壳改造移除：前端加载由壳驱动
//! （`useShellApps` 动作 → 本模块命令面）。

use std::collections::HashMap;
use std::sync::Arc;

use tauri::State;
use wasmnest_wasm_core::manager::host::{PluginHost, UninstallOptions};
use wasmnest_wasm_core::manager::types::{HostPluginInfo, PluginSource};
use wasmnest_wasm_core::storage::PluginStorage;

use crate::Result;

/// 系统级插件存储分区 id（真源 = `wasmnest_wasm_core::storage::SYSTEM_PLUGIN_ID`；
/// 桌面编排层读写启用 / 自启偏好与该分区（`activation_state` 同分区同一张
/// `plugin_storage` 表，属主 `__system__` 与插件数据隔离）。wasm-core 侧为
/// `pub(crate)`，本端只读同名常量并在测试里钉住逐字一致）。
pub const SYSTEM_PLUGIN_ID: &str = "__system__";

/// 启用偏好 key 前缀（移动端 `PLUGIN_ENABLED_KEY_PREFIX` 同款 key 字面与 JSON bool
/// 值形态：`plugin.enabled.{plugin_id}`。
///
/// **双端语义分叉（已裁决，勿"修复"到单边）**：桌面把该行解读为**主屏入口可见性**
/// ——缺省（无行 / 坏行 / 读取失败）= 可见，`false` = 用户显式停用；移动端仍按
/// 「可用性标记」持有该行并保持缺省 false 的 fail-safe 读（该端 legacy 迁移
/// `auto_approve_legacy` 与错误路径写 false 都依赖缺省为"未启用"，改缺省会把
/// 全量插件自动补审批，故移动端不动）。跨端锁只钉命令名与 key 字面
/// （`command_vocabulary_lock.rs`），不钉缺省值语义。
pub const ENABLED_KEY_PREFIX: &str = "plugin.enabled.";

/// 自启偏好 key 前缀（移动端 `PLUGIN_AUTOSTART_KEY_PREFIX` 同款语义与字面：
/// `plugin.autostart.{plugin_id}`；缺省即关——只有显式打开的才在 boot 自动激活）
pub const AUTOSTART_KEY_PREFIX: &str = "plugin.autostart.";

/// 已卸载覆盖表 key（系统分区 JSON map：`plugin_id -> keep_data`）
///
/// **只服务随包内置应用**：资源目录随宿主更新、且可能只读，不能靠删目录表达
/// 「已卸载」。宿主把 id 记入本表后，boot 在 `apply_autostart` 之前把该插件从
/// 运行时注册表摘除（wasm-core `keep_install_dir` 卸载）；用户安装副本重装成功
/// 时清表项。用户安装应用不需要本表（目录删除即卸载）。
pub const UNINSTALLED_KEY: &str = "plugin.uninstalled";

/// 清空 wasm-core 的「上次激活快照」（系统分区 `activation_state`）。
///
/// **为什么必须在创建 `PluginHost` 之前调用**：wasm-core `PluginHost::new` 会按
/// 该快照跑 `auto_activate_from_persisted_state`，把上次运行过的 L3 业务应用直接
/// 复活。桌面壳的「打开」是会话级动作（见模块头契约），宿主要在能力仓机制执行前
/// 清掉快照；否则用户重启后没打开过的应用会后台运行并显示运行中状态点。
///
/// 幂等；只清系统分区的快照行，不触碰插件私有数据 / 启用与自启偏好。
pub async fn clear_persisted_activation_snapshot(storage: &PluginStorage) -> Result<()> {
    storage
        .save_activated_plugins(&HashMap::new())
        .await
        .map_err(|e| crate::AppError::Plugin(format!("清理插件激活快照失败: {e}")))?;
    tracing::info!("[PluginLifecycle] cleared persisted activation snapshot (boot startup is autostart-only)");
    Ok(())
}

/// 宿主壳清单条目（注册表投影 + 偏好同位）
///
/// `flatten` 让 wire 形状仍是「插件字段平铺 + enabled/autostart」——与逐应用偏好
/// 查询的结果合并后同形，前端不必区分两种清单。应用前端消费的
/// `plugin_list_loaded`（能力仓 `HostPluginInfo`）形状不受影响。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostShellPluginInfo {
    #[serde(flatten)]
    pub plugin: HostPluginInfo,
    /// 主屏入口可见性偏好（缺省 true；`false` = 用户停用 → 主屏 / 搜索隐藏入口）
    pub enabled: bool,
    /// 启动时自动激活偏好（缺省按装配角色：L1/L2 开、L3 关）
    pub autostart: bool,
}

/// 桌面宿主侧插件生命周期编排层
///
/// 命令面（`lib.rs` 注册）与壳（`wasm-apps/bedcode/src/shell/useShellApps.ts`）
/// 的单一落点；全部动作委托 wasm-core `PluginHost`，本层不重复机制。
pub struct PluginLifecycleManager {
    host: Arc<PluginHost>,
    /// 已卸载覆盖表读改写串行化（同一进程内并发卸载 / 重装不丢表项）
    uninstalled_lock: tokio::sync::Mutex<()>,
}

impl PluginLifecycleManager {
    pub fn new(host: Arc<PluginHost>) -> Self {
        Self {
            host,
            uninstalled_lock: tokio::sync::Mutex::new(()),
        }
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

    /// 已加载插件清单 + 两个偏好同位返回（壳主屏投影一次性取齐）
    ///
    /// 为什么把偏好并进清单：壳主屏每次刷新都要 `enabled` / `autostart`，逐应用
    /// 两条命令在随包 7 应用时就是 1+2N 次串行 IPC（动作后还会再全量刷一轮）。
    /// 偏好真源在本编排层（`plugin.enabled.*` / `plugin.autostart.*` 的系统分区行），
    /// 只有平台侧知道 key 语义——由本层在进程内合并，壳只付一次往返。
    ///
    /// 缺省取向与 [`Self::is_enabled`] / [`Self::is_autostart`] 逐字一致（enabled 缺省
    /// 可见、autostart 按装配角色），不另立第二套判据。
    pub async fn list_loaded_with_prefs(&self) -> Vec<HostShellPluginInfo> {
        // 先取完清单再逐条读偏好：`is_autostart` 内部要 `get_plugin`（再取一次
        // 插件表读锁），不能与 `list_plugins` 的读锁嵌套（tokio 公平锁下有写者
        // 排队时可能自锁）
        let infos = self.list_loaded().await;
        let mut out = Vec::with_capacity(infos.len());
        for info in infos {
            let enabled = self.is_enabled(&info.id).await;
            let autostart = self.is_autostart(&info.id).await;
            out.push(HostShellPluginInfo {
                plugin: info,
                enabled,
                autostart,
            });
        }
        out
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

    // ==================== 启停（persist 语义：打开仅当前会话 / 停用即持久化停用态） ====================

    /// 预授权（启用前置，独立命令供壳先行调用）：收集插件需授权路径单次合并弹窗；
    /// 拒绝直接返回 Err 不进入激活。已授权路径短路无二次弹窗。
    pub async fn preauthorize(&self, plugin_id: &str) -> Result<()> {
        self.host
            .preauthorize_plugin(plugin_id)
            .await
            .map_err(|e| crate::AppError::Plugin(format!("预授权插件 '{plugin_id}' 失败: {e}")))
    }

    /// 壳「打开应用」的激活入口：前端已先行调 `preauthorize`，此处走完整激活
    /// （`activate_plugin` 内部的预授权兜底对已授权路径短路，无副作用）。
    ///
    /// persist=false：打开是**当前会话**动作，不写「下次 boot 复活」快照；跨启动
    /// 启动只由 `plugin.autostart.{id}` 偏好决定（见模块头「生命周期契约」）。
    pub async fn activate_after_preauth(&self, plugin_id: &str) -> Result<()> {
        self.host
            .activate_plugin(plugin_id, false)
            .await
            .map_err(|e| crate::AppError::Plugin(format!("激活插件 '{plugin_id}' 失败: {e}")))
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

    // ==================== 偏好（移动端同款 key 语义；只改偏好，不触发当前进程启停） ====================

    /// 应用「主屏入口可见性」偏好（缺省 `true` = 显示；`false` = 用户停用）
    ///
    /// 桌面壳把 `false` 解读为「主屏 / 搜索隐藏入口」：不触发启停、不停止已运行
    /// 实例，显式自启偏好独立生效。移动端维持「可用性标记」原义（分叉见模块头）。
    pub async fn is_enabled(&self, plugin_id: &str) -> bool {
        read_bool_pref(&self.host.storage(), ENABLED_KEY_PREFIX, plugin_id, true).await
    }

    /// 设置应用「主屏入口可见性」偏好并持久化（不触发激活、不停止已运行实例）
    pub async fn set_enabled(&self, plugin_id: &str, enabled: bool) -> Result<()> {
        write_bool_pref(&self.host.storage(), ENABLED_KEY_PREFIX, plugin_id, enabled).await
    }

    /// 应用「启动时自动激活」偏好
    ///
    /// 缺省值按装配角色：L1 基础服务 / L2 内部业务 = `true`（系统服务默认随宿主
    /// 启动），L3 业务应用 = `false`。显式写入的 `false` 优先——用户关掉后不会
    /// 因缺省值又被拉起；不写偏好行，避免卸载重装回到默认开。
    pub async fn is_autostart(&self, plugin_id: &str) -> bool {
        let kind = self.host.get_plugin(plugin_id).await.map(|info| info.kind);
        let fallback = autostart_fallback(kind);
        read_bool_pref(&self.host.storage(), AUTOSTART_KEY_PREFIX, plugin_id, fallback).await
    }

    /// 设置应用「启动时自动激活」偏好并持久化
    ///
    /// 只改偏好，不在当前进程立即激活 / 停用（与移动端一致：偏好 → 下次 boot
    /// 或用户显式操作生效，避免「改配置即启停」的隐式副作用）。
    pub async fn set_autostart(&self, plugin_id: &str, autostart: bool) -> Result<()> {
        write_bool_pref(&self.host.storage(), AUTOSTART_KEY_PREFIX, plugin_id, autostart).await
    }

    // ==================== 卸载（L3 应用；服务拒绝；可选保留应用数据） ====================

    /// 卸载业务应用（L3）。`keep_data` = 保留应用数据（私有库 + KV），重装后可用。
    ///
    /// 随包内置应用不删资源目录（只读 / 随宿主更新），改为写 [`UNINSTALLED_KEY`]
    /// 覆盖表并在 boot 重放；用户安装应用真正删安装目录。审批 / 授权记录始终撤销
    /// ——数据可留，信任不随重装继承。
    pub async fn uninstall(&self, plugin_id: &str, keep_data: bool) -> Result<()> {
        let info = self
            .host
            .get_plugin(plugin_id)
            .await
            .ok_or_else(|| crate::AppError::Plugin(format!("Plugin not found: {plugin_id}")))?;
        if info.kind.is_role_driven() {
            return Err(crate::AppError::Plugin(format!(
                "System service cannot be uninstalled: {plugin_id}"
            )));
        }
        // 判据用枚举序列化字面量的单一来源：裸字符串一旦漂移，卸载会静默退化成
        // 「保留目录 + 走 tombstone」，代码留在磁盘上而无人察觉。
        let keep_install_dir = info.source != PluginSource::UserInstalled.as_str();
        // 内置应用先落覆盖再摘运行时记录：写表失败时不得出现「记录已删、boot 又复活」
        // 的半卸载态；core 卸载失败则把覆盖恢复原值（不是清空——原值可能是既有表项）。
        let previous_override = if keep_install_dir {
            Some(self.set_uninstalled(plugin_id, keep_data).await?)
        } else {
            None
        };
        let uninstall_result = self
            .host
            .uninstall_plugin_with_options(
                plugin_id,
                UninstallOptions {
                    keep_data,
                    keep_install_dir,
                },
            )
            .await;
        if let Err(e) = uninstall_result {
            if let Some(previous) = previous_override {
                if let Err(restore_err) = self.restore_uninstalled(plugin_id, previous).await {
                    tracing::warn!(
                        plugin_id = %plugin_id,
                        error = %restore_err,
                        "[PluginLifecycle] failed to roll back uninstall override"
                    );
                }
            }
            return Err(e);
        }

        // 启用 / 自启偏好属于「安装态配置」，不随应用数据保留：重装后从默认态开始，
        // 避免已卸载应用的旧自启偏好把新装实例静默拉起。
        self.remove_install_pref(ENABLED_KEY_PREFIX, plugin_id).await;
        self.remove_install_pref(AUTOSTART_KEY_PREFIX, plugin_id).await;
        tracing::info!(
            plugin_id = %plugin_id,
            keep_data,
            keep_install_dir,
            "[PluginLifecycle] app uninstalled"
        );
        Ok(())
    }

    /// 重装成功后清除「已卸载」覆盖（内置应用从 zip 重装 / 恢复时调用）
    pub async fn clear_uninstalled(&self, plugin_id: &str) -> Result<()> {
        let _guard = self.uninstalled_lock.lock().await;
        let mut map = read_uninstalled(self.host.storage()).await;
        if map.remove(plugin_id).is_some() {
            write_uninstalled(self.host.storage(), &map).await?;
            tracing::info!(plugin_id = %plugin_id, "[PluginLifecycle] uninstall override cleared");
        }
        Ok(())
    }

    /// boot 重放「已卸载」覆盖：把随包内置应用从运行时注册表摘除
    ///
    /// **必须在 `apply_autostart` 之前**：否则旧的自启偏好会把已卸载应用拉起。
    /// 只摘运行时记录，不删资源目录；数据策略按覆盖表记录的原值重放（`keep_data`
    /// 为 false 时顺带再清一次数据目录，卸载当时清失败也能在此收敛）。用户安装
    /// 副本已存在时跳过（不误删用户重装的版本）。返回本次摘除数。
    pub async fn apply_uninstalled_tombstones(&self) -> usize {
        let map = read_uninstalled(self.host.storage()).await;
        let mut removed = 0usize;
        for (plugin_id, keep_data) in map.iter() {
            let Some(info) = self.host.get_plugin(plugin_id).await else {
                continue;
            };
            if info.source == PluginSource::UserInstalled.as_str() {
                tracing::warn!(
                    plugin_id = %plugin_id,
                    "[PluginLifecycle] uninstall override ignored: user-installed copy exists"
                );
                continue;
            }
            if info.kind.is_role_driven() {
                tracing::warn!(
                    plugin_id = %plugin_id,
                    "[PluginLifecycle] uninstall override ignored: system service"
                );
                continue;
            }
            // boot 重放不假设状态：历史会话 / 外部激活可能留下运行实例，
            // core 卸载对运行中插件 fail-visible 拒绝，这里先停再摘。
            if self.host.is_running(plugin_id).await {
                if let Err(e) = self.host.deactivate_plugin(plugin_id, true).await {
                    tracing::warn!(
                        plugin_id = %plugin_id,
                        error = %e,
                        "[PluginLifecycle] uninstall override deactivate failed at boot"
                    );
                }
            }
            match self
                .host
                .uninstall_plugin_with_options(
                    plugin_id,
                    UninstallOptions {
                        keep_data: *keep_data,
                        keep_install_dir: true,
                    },
                )
                .await
            {
                Ok(()) => {
                    removed += 1;
                    tracing::info!(
                        plugin_id = %plugin_id,
                        "[PluginLifecycle] uninstall override reapplied at boot"
                    );
                }
                Err(e) => tracing::warn!(
                    plugin_id = %plugin_id,
                    error = %e,
                    "[PluginLifecycle] uninstall override failed at boot"
                ),
            }
        }
        removed
    }

    /// 写入 / 合并已卸载覆盖；返回该 id 的**原值**（供失败回滚恢复原状）
    async fn set_uninstalled(&self, plugin_id: &str, keep_data: bool) -> Result<Option<bool>> {
        let _guard = self.uninstalled_lock.lock().await;
        let mut map = read_uninstalled(self.host.storage()).await;
        let previous = map.insert(plugin_id.to_string(), keep_data);
        write_uninstalled(self.host.storage(), &map).await?;
        Ok(previous)
    }

    /// 回滚覆盖：`Some` 恢复原值，`None` 删除表项（卸载前本来没有这条）
    async fn restore_uninstalled(&self, plugin_id: &str, previous: Option<bool>) -> Result<()> {
        let _guard = self.uninstalled_lock.lock().await;
        let mut map = read_uninstalled(self.host.storage()).await;
        match previous {
            Some(value) => {
                map.insert(plugin_id.to_string(), value);
            }
            None => {
                map.remove(plugin_id);
            }
        }
        write_uninstalled(self.host.storage(), &map).await
    }

    /// 删除单个安装态偏好（失败只 warn，不阻断卸载主流程）
    async fn remove_install_pref(&self, prefix: &str, plugin_id: &str) {
        let key = format!("{prefix}{plugin_id}");
        if let Err(e) = self.host.storage().delete(SYSTEM_PLUGIN_ID, &key).await {
            tracing::warn!(
                plugin_id = %plugin_id,
                key = %key,
                error = %e,
                "[PluginLifecycle] failed to remove install preference on uninstall"
            );
        }
    }

    // ==================== boot 装配（唯一启动源 = autostart 偏好） ====================

    /// boot 后按 `plugin.autostart.{id}` 偏好装配：启动标记自启的业务应用，停用
    /// 用户显式关闭自启的系统服务。
    ///
    /// 业务应用（L3）：autostart=true 且当前未运行 → 激活（persist=false——偏好是
    /// 启动真源，运行快照不再参与下次 boot）。历史「上次运行快照」在
    /// `PluginHost::new` 之前已由 [`clear_persisted_activation_snapshot`] 清空。
    ///
    /// 系统服务（L1/L2）：wasm-core boot 按角色**无条件**激活（ADR 0032：层序保证
    /// auth / gateway 先于业务就绪）。用户显式把自启关掉时，偏好行已存在 `false`
    /// （`is_autostart` 对角色驱动缺省 true，走不到这里），本方法在 boot 收口处停用
    /// 本会话实例，让桌面「自启」开关对服务同样生效（2026-10-22 用户裁决 D4）。
    /// 不写启动快照（服务启停仍不持久化），下次 boot 仍按偏好重新判定。
    ///
    /// 幂等：服务已停止 / 应用已运行时零动作。返回本次实际激活数（供 boot 日志 /
    /// 测试断言；停用不计入）。
    pub async fn apply_autostart(&self) -> usize {
        let infos = self.list_loaded().await;
        let mut activated = 0usize;
        for info in infos {
            if info.source == "builtin" {
                // 静态注册的系统组件（能力提供面）不消费用户偏好
                continue;
            }
            let autostart = self.is_autostart(&info.id).await;
            if info.kind.is_role_driven() {
                if autostart || !self.host.is_running(&info.id).await {
                    continue;
                }
                match self.host.deactivate_plugin(&info.id, false).await {
                    Ok(()) => tracing::info!(
                        plugin_id = %info.id,
                        "[PluginLifecycle] service autostart disabled by preference, stopped after boot"
                    ),
                    Err(e) => tracing::warn!(
                        plugin_id = %info.id,
                        error = %e,
                        "[PluginLifecycle] service autostart-off deactivation failed"
                    ),
                }
                continue;
            }
            if !autostart {
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

/// 自启缺省值：L1 基础服务 / L2 内部业务默认开，L3 应用 / 未知默认关。
///
/// 只决定「偏好行不存在时」的取向；显式写入的 `false` 仍由 `read_bool_pref` 优先。
fn autostart_fallback(kind: Option<wasmnest_wasm_core::manifest::PluginKind>) -> bool {
    kind.map(|k| k.is_role_driven()).unwrap_or(false)
}

/// 读布尔偏好（缺省 / 损坏 / 读取失败一律回落到 `fallback`——不静默吞错，warn 留痕
/// 让两次启动间的持续失败可见；`fallback` 按各 key 的语义取向分别给定：
/// enabled = `true`（主屏入口可见性缺省成立，坏行不静默藏掉入口），
/// autostart = `false`（自启只能显式打开，坏行绝不静默启动应用））
async fn read_bool_pref(storage: &PluginStorage, prefix: &str, plugin_id: &str, fallback: bool) -> bool {
    let key = format!("{prefix}{plugin_id}");
    match storage.get(SYSTEM_PLUGIN_ID, &key).await {
        Ok(Some(serde_json::Value::Bool(value))) => value,
        // None（缺省）/ 非 Bool（历史字符串形态 / 手工写坏）→ 按 fallback 取向
        Ok(_) => fallback,
        Err(e) => {
            tracing::warn!(
                plugin_id = %plugin_id,
                key = %key,
                fallback = %fallback,
                error = %e,
                "[PluginLifecycle] pref read failed, fall back (fail-safe)"
            );
            fallback
        }
    }
}

/// 写布尔偏好（JSON `true` / `false`；错误补操作上下文——§6 禁裸透传）
async fn write_bool_pref(storage: &PluginStorage, prefix: &str, plugin_id: &str, value: bool) -> Result<()> {
    let key = format!("{prefix}{plugin_id}");
    storage
        .set(SYSTEM_PLUGIN_ID, &key, serde_json::json!(value))
        .await
        .map_err(|e| crate::AppError::Plugin(format!("写插件偏好 '{key}' 失败: {e}")))
}

/// 读取已卸载覆盖表（缺省 / 损坏 / 读取失败一律空表 + warn——boot 不因坏行
/// 拒绝启动；下一次卸载会重写该行）
async fn read_uninstalled(storage: &PluginStorage) -> HashMap<String, bool> {
    match storage.get(SYSTEM_PLUGIN_ID, UNINSTALLED_KEY).await {
        Ok(Some(value)) => serde_json::from_value(value).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "[PluginLifecycle] uninstall override table corrupted, reset");
            HashMap::new()
        }),
        Ok(None) => HashMap::new(),
        Err(e) => {
            tracing::warn!(error = %e, "[PluginLifecycle] failed to read uninstall override table");
            HashMap::new()
        }
    }
}

/// 写入已卸载覆盖表（系统分区；JSON map `plugin_id -> keep_data`）
async fn write_uninstalled(storage: &PluginStorage, map: &HashMap<String, bool>) -> Result<()> {
    storage
        .set(SYSTEM_PLUGIN_ID, UNINSTALLED_KEY, serde_json::json!(map))
        .await
        .map_err(|e| crate::AppError::Plugin(format!("写已卸载覆盖表失败: {e}")))
}

// ==================== 卸载命令面（覆盖 api_bridge 裸卸载，带数据保留策略） ====================

/// 卸载已安装应用（L3；系统服务拒绝），`keepData` 缺省 = 删除应用数据
///
/// 宿主面门（ADR 0058）：卸载是宿主 UI 职权，应用前端同 webview 可直接调用
/// ⇒ 不带凭证时任一应用能删掉其他应用。注册点从 `api_bridge::plugin_uninstall`
/// 改到本命令（bootstrap），旧裸臂不再注册。
#[tauri::command]
pub async fn plugin_uninstall(
    webview: tauri::Webview,
    plugin_id: String,
    credential: String,
    keep_data: Option<bool>,
    manager: State<'_, Arc<PluginLifecycleManager>>,
) -> Result<()> {
    super::require_host_frontend(
        manager.host().as_ref(),
        webview.label(),
        &credential,
        "plugin_uninstall",
    )?;
    manager.uninstall(&plugin_id, keep_data.unwrap_or(false)).await
}

/// 清除「已卸载」覆盖（内置应用从 zip 重装 / 恢复成功后调用）
#[tauri::command]
pub async fn plugin_clear_uninstalled(
    webview: tauri::Webview,
    plugin_id: String,
    credential: String,
    manager: State<'_, Arc<PluginLifecycleManager>>,
) -> Result<()> {
    super::require_host_frontend(
        manager.host().as_ref(),
        webview.label(),
        &credential,
        "plugin_clear_uninstalled",
    )?;
    manager.clear_uninstalled(&plugin_id).await
}

// ==================== 命令面（D3：桌面补移动端同款缺失臂，语义逐字一致） ====================
//
// 仅补移动端 `commands.rs` 已有而桌面 api_bridge 缺失的六臂；清单 / 启停 /
// 审批 / 卸载等既有臂已由 api_bridge 注册（lib.rs 保留）。

/// 标记插件错误（插件自报面 + 宿主代报面）
///
/// 身份绑定（安全审查 #48，与移动端 `plugin/commands.rs::plugin_mark_error` 同判据）：
/// 插件通道令牌只能标自己，宿主 loader 会话凭证可代报任意目标。桌面原先经
/// `api_bridge` 的裸命令暴露（无 `webview` / `credential`），任意应用前端可把他人
/// 标成 Error 并释放其服务租约（`PluginHost::mark_error` → `release_services_for`）；
/// 该裸命令已从注册表摘除，改由本命令承接（`bootstrap` 注册本路径）。
#[tauri::command]
pub async fn plugin_mark_error(
    webview: tauri::Webview,
    plugin_id: String,
    error: String,
    credential: String,
    plugin_host: State<'_, Arc<PluginHost>>,
) -> Result<()> {
    plugin_host
        .frontend_channel()
        .authorize(webview.label(), &plugin_id, &credential)
        .map_err(|e| crate::AppError::Plugin(e.to_string()))?;
    plugin_host.mark_error(&plugin_id, error).await;
    Ok(())
}

/// 宿主壳应用清单（注册表投影 + 偏好同位；壳 `useShellApps` 的唯一清单来源）
///
/// 与逐应用 `plugin_is_enabled` / `plugin_is_autostart` 并存不冲突：那两条仍是
/// 「单点查询 / 设置页回读」的命令面，本命令只服务「一次刷新取齐」。应用前端拿不到
/// 本命令（它不在 `APP_FRONTEND_INVOKE_WHITELIST`），清单面仍走 `plugin_list_loaded`。
#[tauri::command]
pub async fn plugin_list_with_prefs(
    manager: State<'_, Arc<PluginLifecycleManager>>,
) -> Result<Vec<HostShellPluginInfo>> {
    Ok(manager.list_loaded_with_prefs().await)
}

/// 查询插件启用状态（主屏入口可见性偏好：缺省 true = 显示；不是启动触发器）
#[tauri::command]
pub async fn plugin_is_enabled(plugin_id: String, manager: State<'_, Arc<PluginLifecycleManager>>) -> Result<bool> {
    Ok(manager.is_enabled(&plugin_id).await)
}

/// 设置插件启用状态并持久化（不触发激活、不停止已运行实例；桌面壳消费为主屏入口可见性）
///
/// 宿主面门（安全审查 #48）：启停偏好是宿主 UI 的职权，应用前端同 webview 可直接
/// 调用 ⇒ 不带凭证时任一应用能静默启停他人应用。
#[tauri::command]
pub async fn plugin_set_enabled(
    webview: tauri::Webview,
    plugin_id: String,
    enabled: bool,
    credential: String,
    manager: State<'_, Arc<PluginLifecycleManager>>,
) -> Result<()> {
    super::require_host_frontend(
        manager.host().as_ref(),
        webview.label(),
        &credential,
        "plugin_set_enabled",
    )?;
    manager.set_enabled(&plugin_id, enabled).await
}

/// 查询插件「启动时自动激活」偏好（缺省 false = 不自动启动）
#[tauri::command]
pub async fn plugin_is_autostart(plugin_id: String, manager: State<'_, Arc<PluginLifecycleManager>>) -> Result<bool> {
    Ok(manager.is_autostart(&plugin_id).await)
}

/// 设置插件「启动时自动激活」偏好（只改偏好，下次 boot 生效）
///
/// 宿主面门（安全审查 #48）：自启偏好可被静默改写 ⇒ 配合重启即形成驻留，
/// 与 `plugin_set_enabled` 同判据。
#[tauri::command]
pub async fn plugin_set_autostart(
    webview: tauri::Webview,
    plugin_id: String,
    autostart: bool,
    credential: String,
    manager: State<'_, Arc<PluginLifecycleManager>>,
) -> Result<()> {
    super::require_host_frontend(
        manager.host().as_ref(),
        webview.label(),
        &credential,
        "plugin_set_autostart",
    )?;
    manager.set_autostart(&plugin_id, autostart).await
}

/// 插件实例是否在运行（`Activated` / `Degraded`；壳主屏状态 chip）
#[tauri::command]
pub async fn plugin_is_running(plugin_id: String, manager: State<'_, Arc<PluginLifecycleManager>>) -> Result<bool> {
    Ok(manager.is_running(&plugin_id).await)
}

/// 插件是否严格 Activated（功能门禁口径）
#[tauri::command]
pub async fn plugin_is_activated(plugin_id: String, manager: State<'_, Arc<PluginLifecycleManager>>) -> Result<bool> {
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
    async fn enabled_pref_roundtrip_and_default_visible() {
        let storage = storage();
        // 缺省 = 可见（主屏入口可见性缺省成立——停用是显式 `false`，
        // 缺省不隐藏任何应用，2026-10-21 用户裁决「启用赋予真实语义」）
        assert!(read_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.a", true).await);

        write_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.a", true)
            .await
            .expect("write true");
        assert!(read_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.a", true).await);

        write_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.a", false)
            .await
            .expect("write false");
        assert!(!read_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.a", true).await);
    }

    /// 壳清单 wire 形状（F1）：插件字段**平铺** + enabled/autostart 同位
    ///
    /// 前端 `HostShellPluginInfo` 按这个形状读（`info.enabled` / `info.autostart`），
    /// 包一层 `{ plugin: {...} }` 会让投影静默丢掉全部字段（TS 侧不看错字段）。
    #[test]
    fn shell_list_wire_shape_flattens_plugin_fields_with_prefs() {
        use wasmnest_wasm_core::manifest::{PluginContributes, PluginKind, PluginState, PluginType};
        let info = HostPluginInfo {
            id: "com.wasmnest.test".into(),
            name: "Test".into(),
            version: "1.0.0".into(),
            description: String::new(),
            author: String::new(),
            main: "index.js".into(),
            plugin_type: PluginType::Frontend,
            kind: PluginKind::BusinessApp,
            background_transport: false,
            update: None,
            rust_library: String::new(),
            permissions: vec!["storage".into()],
            state: PluginState::Activated,
            extension_path: "/tmp/plugin".into(),
            contributes: PluginContributes::default(),
            icon: None,
            source: "wasm".into(),
            size_bytes: 0,
            installed_at: None,
        };
        let json = serde_json::to_value(HostShellPluginInfo {
            plugin: info,
            enabled: true,
            autostart: false,
        })
        .expect("serialize");
        assert_eq!(json["id"], "com.wasmnest.test");
        assert_eq!(json["pluginType"], "frontend");
        assert_eq!(json["enabled"], true);
        assert_eq!(json["autostart"], false);
        assert!(
            json.get("plugin").is_none(),
            "壳清单必须平铺（前端按顶层字段读），不得包一层 plugin"
        );
    }

    #[test]
    fn autostart_fallback_is_role_driven() {
        use wasmnest_wasm_core::manifest::PluginKind;
        assert!(autostart_fallback(Some(PluginKind::BasicService)));
        assert!(autostart_fallback(Some(PluginKind::InternalBusiness)));
        assert!(!autostart_fallback(Some(PluginKind::BusinessApp)));
        assert!(!autostart_fallback(None), "未知插件不得缺省自启");
    }

    #[tokio::test]
    async fn autostart_pref_roundtrip_and_default_off() {
        let storage = storage();
        assert!(!read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.b", false).await);

        write_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.b", true)
            .await
            .expect("write true");
        assert!(read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.b", false).await);
    }

    #[tokio::test]
    async fn clear_activation_snapshot_keeps_preferences() {
        let storage = storage();
        // 模拟旧版本留下的「上次运行」快照 + 用户显式自启偏好
        let mut snapshot = HashMap::new();
        snapshot.insert("com.wasmnest.test.legacy".to_string(), true);
        storage
            .save_activated_plugins(&snapshot)
            .await
            .expect("seed legacy snapshot");
        write_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.legacy", true)
            .await
            .expect("seed autostart pref");

        clear_persisted_activation_snapshot(&storage)
            .await
            .expect("clear snapshot");

        // 快照清空（boot 不再复活任何历史应用），但显式偏好原样保留
        assert!(storage
            .load_activated_plugins()
            .await
            .expect("load after clear")
            .is_empty());
        assert!(
            read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.legacy", false).await,
            "清理启动快照不得触碰 plugin.autostart 偏好"
        );

        // 幂等：重复清理不报错
        clear_persisted_activation_snapshot(&storage)
            .await
            .expect("clear snapshot twice");
    }

    #[tokio::test]
    async fn prefs_are_isolated_per_plugin_and_per_kind() {
        let storage = storage();
        // 启用 / 自启互不串扰
        write_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.c", true)
            .await
            .expect("enabled");
        assert!(!read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.c", false).await);

        // 插件间互不串扰
        write_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.c", true)
            .await
            .expect("autostart c");
        write_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.d", false)
            .await
            .expect("autostart d");
        assert!(read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.c", false).await);
        assert!(!read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.d", false).await);
        // id 前缀匹配不得放宽（plugin.autostart.com.wasmnest.test.c 不应命中 test.d）
        assert!(!read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.d", false).await);
    }

    #[tokio::test]
    async fn corrupted_pref_value_falls_back_to_key_default() {
        let storage = storage();
        // 非 Bool 值（历史字符串形态 / 手工写坏）一律按各 key 的 fallback 取向：
        // 自启坏行不得误判成「自启」（false，防静默启动应用）；
        // 启用坏行不得静默藏掉主屏入口（true，可见性缺省成立）——两者都 warn 留痕
        storage
            .set(
                SYSTEM_PLUGIN_ID,
                &format!("{AUTOSTART_KEY_PREFIX}com.wasmnest.test.e"),
                serde_json::json!("true"),
            )
            .await
            .expect("seed string value");
        assert!(!read_bool_pref(&storage, AUTOSTART_KEY_PREFIX, "com.wasmnest.test.e", false).await);

        storage
            .set(
                SYSTEM_PLUGIN_ID,
                &format!("{ENABLED_KEY_PREFIX}com.wasmnest.test.e"),
                serde_json::json!("false"),
            )
            .await
            .expect("seed corrupt enabled value");
        assert!(
            read_bool_pref(&storage, ENABLED_KEY_PREFIX, "com.wasmnest.test.e", true).await,
            "启用偏好坏行按缺省可见解读（不在坏行时静默隐藏应用）"
        );
    }

    #[tokio::test]
    async fn key_prefixes_match_mobile_contract_literally() {
        // 移动端 `system/constants/plugin.rs`：plugin.enabled. / plugin.autostart.
        // 跨端锁（wasmnest-test/cross-end-tests 门禁）钉的是**命令名与 key 前缀字面**
        // 一致；缺省值语义已裁决分叉（桌面 enabled 缺省 = 可见 / 移动端 = 未启用），
        // 改前缀而不改移动端 = 双端偏好互相读不到，故字面钉死不变
        assert_eq!(ENABLED_KEY_PREFIX, "plugin.enabled.");
        assert_eq!(AUTOSTART_KEY_PREFIX, "plugin.autostart.");
        assert_eq!(SYSTEM_PLUGIN_ID, "__system__");
    }

    #[tokio::test]
    async fn uninstalled_override_roundtrip_and_corrupt_fallback() {
        let storage = storage();
        assert!(read_uninstalled(&storage).await.is_empty(), "缺省空表");

        let mut map = HashMap::new();
        map.insert("com.wasmnest.test.removed".to_string(), true);
        write_uninstalled(&storage, &map).await.expect("write override");
        assert_eq!(read_uninstalled(&storage).await, map);

        // 坏行：boot 不得因覆盖表损坏拒绝启动（空表 + warn，下一个卸载重写）
        storage
            .set(SYSTEM_PLUGIN_ID, UNINSTALLED_KEY, serde_json::json!("not-a-map"))
            .await
            .expect("seed corrupt override");
        assert!(read_uninstalled(&storage).await.is_empty());
    }
}
