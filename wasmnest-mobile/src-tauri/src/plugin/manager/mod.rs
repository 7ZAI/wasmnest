//! Mobile Plugin Manager
//!
//! 插件生命周期管理 — WASM 动态加载、激活、停用、状态持久化

use wasmnest_wasm_core::db::Database;

use crate::plugin::approval::{
    compute_dir_hash, effective_permissions, verify_approval, ApprovalStatus, PluginApprovalStore,
};
use crate::plugin::loader::PluginLoader;
use crate::plugin::registry::builtin_manifests;
use crate::plugin::storage::PluginStorage;
use crate::plugin::types::*;
use crate::plugin::wasm_runtime::{LoadedWasmPlugin, WasmHostContext, WasmRuntime};
use crate::system::constants::plugin::PLUGIN_AUTOSTART_KEY_PREFIX;
use crate::system::constants::plugin::PLUGIN_DATA_DIR;
use crate::system::constants::plugin::PLUGIN_ENABLED_KEY_PREFIX;
use crate::system::settings::SettingsManager;
use crate::Result;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use tauri::{Emitter, Manager};
use tokio::sync::{Mutex as TokioMutex, RwLock};

mod events;
mod lifecycle;
mod loading;

#[cfg(test)]
mod tests;
/// 预授权 storage key(file-transfer mount-local 时追加写入)。
pub const PREAUTH_PATHS_STORAGE_KEY: &str = "preauth_paths";

/// 移动端内核配置：配置文件覆盖面 + 移动端固定项
///
/// - 先经 `CoreConfig::load_or_default` 读应用配置目录下的 `wasm-core.json`
///   （与 `WasmRuntime::new` 同一入口，配置文件覆盖面不被绕过）；
/// - 再施加移动端固定项：**关掉信号式 trap**（`signals_based_traps = false`）。
///
/// **为什么移动端必须关**：Android 的 ART 经 `libsigchain` 接管应用注册的信号处理器，
/// wasmtime 的信号式 trap 在这条链上会被判成「非 wasm 故障」并把信号交回上一个处理器
/// （WebView/crashpad）⇒ **任何 guest trap（插件 panic / 越界 / 栈溢出 / 燃料耗尽）都
/// 变成宿主进程 SIGILL 退出**，而不是一条带 wasm backtrace 的插件错误（2026-10-15
/// ai-chatbox 崩溃即此路径，诊断见 `.scratch/2026-10-15-mobile-ai-chatbox-sigill/`）。
/// 关掉后全部 trap 由生成代码经显式 libcall 抛出（内存访问附带显式边界检查），语义
/// 完全等价，代价是代码略大 / 内存访问略慢。
///
/// 桌面端保持上游默认（信号式 trap 可用且更快，实测 trap 能正常转成插件错误）——
/// 这是端事实差异，取值归本端宿主（ADR 0052 D4），机制（配置项本身）住 wasm-core。
pub fn mobile_core_config(app_config_dir: Option<&std::path::Path>) -> wasmnest_wasm_core::config::CoreConfig {
    let mut config = app_config_dir
        .map(|dir| {
            wasmnest_wasm_core::config::CoreConfig::load_or_default(
                &dir.join(wasmnest_wasm_core::config::CoreConfig::FILE_NAME),
            )
        })
        .unwrap_or_default();
    config.engine.tuning.signals_based_traps = Some(false);
    config
}

/// 收集插件的预授权路径
///
/// 当前恒返回空：注册入口（原 `register_preauth_provider`）在本端无任何
/// 调用方——机制真源已迁共享 crate `wasmnest-wasm-core`
/// （`manager/host/preauth.rs`），移动端没有对应的 host function / WIT 原语
/// 能触到它。保留读侧是为了不动 `preauthorize_plugin` 的两段式取路径逻辑
/// （先 provider 后 storage）：一旦移动端重新接入注册面，读侧无需再改。
///
/// 判据：真源在共享 crate 且本端无注册入口时，不要在本端留一份永不写入的
/// 注册表——它是「看起来可扩展、实际永远为空」的假扩展点。
async fn collect_preauth_paths(_plugin_id: &str) -> Vec<String> {
    Vec::new()
}

/// 展开 manifest `preauthDirs` 声明目录为真实路径列表
///
/// 镜像桌面 wasiPreopenDirs 展开语义:支持 `${downloads}` 模板(展开为宿主
/// app 下载目录,ai-chatbox 数据目录 `{AppDownloadsDir}/ai-chatbox` 用)。
/// 只剥尾部分隔符;展开失败(如无头上下文拿不到下载目录)的条目丢弃。
async fn expand_preauth_dirs(
    app_handle: &Option<Arc<tauri::AppHandle>>,
    plugin_id: &str,
    declared: &[String],
) -> Vec<String> {
    // 仅 Android 真机/app_handle 场景可解析下载目录;无头/测试上下文返回空
    let downloads = match app_handle {
        Some(app) => crate::plugin::android_plugins::resolve_app_downloads_dir(app)
            .await
            .map(|p| p.trim_end_matches(['/', '\\']).to_string()),
        None => None,
    };
    let Some(downloads) = downloads else {
        if !declared.is_empty() {
            tracing::warn!(
                plugin_id = %plugin_id,
                "preauthDirs: app downloads dir unavailable, skipping expansion"
            );
        }
        return Vec::new();
    };
    declared
        .iter()
        .filter_map(|raw| {
            let dir = raw.trim().replacen("${downloads}", &downloads, 1);
            let dir = dir.trim().trim_end_matches(['/', '\\']).trim_end().to_string();
            (!dir.is_empty()).then_some(dir)
        })
        .collect()
}

/// 插件生命周期管理器
pub struct PluginManager {
    /// 已加载的插件清单
    plugins: Arc<RwLock<HashMap<String, LoadedPlugin>>>,
    /// WASM 运行时（延迟初始化，必须在 Tokio 上下文中创建）
    wasm_runtime: OnceLock<Arc<WasmRuntime>>,
    /// 已加载的 WASM 插件实例
    ///
    /// 每插件独立 Mutex：map 守卫只短持有（查找/增删），同步执行 WASM 期间
    /// 仅持有单插件实例锁，避免持 map 守卫执行 WASM 导致 host function 重入死锁
    wasm_plugins: Arc<RwLock<HashMap<String, Arc<TokioMutex<LoadedWasmPlugin>>>>>,
    /// WASM 宿主上下文（延迟初始化）
    wasm_host_ctx: OnceLock<Arc<WasmHostContext>>,
    /// 插件键值存储
    storage: Arc<PluginStorage>,
    /// 权限审批存储（批准记录 + 内容哈希钉扎，见 approval.rs）
    approvals: Arc<PluginApprovalStore>,
    /// 设置管理器
    settings: Arc<SettingsManager>,
    /// 插件数据目录
    plugins_dir: PathBuf,
    /// 插件数据库连接（WASM Host Function 使用；std Mutex，见 lib.rs 创建处注释；
    /// 批次 2b：底库类型 = fork crate Database wrapper）
    plugin_db: Arc<std::sync::Mutex<Database>>,
    /// Tauri AppHandle
    ///
    /// Option 化以允许 `#[cfg(test)]` 模块构造无头 PluginManager（不走
    /// `app_handle.path()` / `app_handle.emit()` 的路径）。生产调用方
    /// `lib.rs` 仍传 `Some(...)`；`None` 分支只走状态机与 WASM 生命周期，
    /// 不依赖任何 Tauri 能力（详见 `init_wasm_runtime` 与 `emit_frontend_event`
    /// 的 None 降级路径）
    app_handle: Option<Arc<tauri::AppHandle>>,
    /// 文件系统访问校验器
    ///
    /// 真源 = wasm-core `security::fs_auth::FsAuthChecker`（用户裁决 2026-10-11
    /// 「wasm-core 机制全部以桌面端为准收敛一套：fs 授权统一到桌面判定链，移动
    /// 自实现已退役」）——宿主不再自持闸门实现；路径 / 插件白名单管理命令随之
    /// 退役（语义不进入统一机制），只剩弹窗回执命令 `plugin_fs_auth_respond`。
    fs_auth: Arc<wasmnest_wasm_core::security::fs_auth::FsAuthChecker>,
    /// 消息总线
    message_bus: Arc<crate::plugin::message_bus::MessageBus>,
    /// 应用作用域共享服务注册表（与桌面同一机制）：boot 注册 `net.peer-node`
    /// 服务并注入 wasm 宿主上下文；插件离开运行态时按 holder 回收。
    service_registry: Arc<wasmnest_server_base::service::ServiceRegistry>,
}

impl PluginManager {
    /// 创建插件管理器（不初始化 WASM 运行时）
    ///
    /// WASM 运行时通过 init_wasm_runtime() 延迟初始化，
    /// 因为 Engine 创建需要 Tokio 运行时上下文
    pub fn new(
        app_data_dir: &PathBuf,
        settings: Arc<SettingsManager>,
        plugin_db: Arc<std::sync::Mutex<Database>>,
        app_handle: Option<Arc<tauri::AppHandle>>,
    ) -> Self {
        // 票 05b：插件 KV 真源 = 主库 plugin_storage 表（共享 plugin_db 连接；
        // 旧文件落盘路径已随 05b 移除，启动迁移见 lib.rs setup）
        let storage = Arc::new(PluginStorage::new(plugin_db.clone()));
        let approvals = Arc::new(PluginApprovalStore::new(storage.clone()));
        let plugins_dir = app_data_dir.join(PLUGIN_DATA_DIR);

        // 统一判定链（wasm-core `security::fs_auth`）：移动无 first-party 免弹窗
        // 概念 ⇒ 归属清单传空表；弹窗投递端口由 app_handle 装配（无头为 None ⇒
        // 授权请求一律拒绝，fail-closed 与迁移前逐字一致）
        let fs_auth = Arc::new(wasmnest_wasm_core::security::fs_auth::FsAuthChecker::new(
            storage.clone(),
            app_handle.clone(),
            Vec::new(),
        ));
        let message_bus = Arc::new(crate::plugin::message_bus::MessageBus::new());
        // 应用作用域服务注册表：实例随宿主，测试各自 new（互不干扰）
        let service_registry = Arc::new(wasmnest_server_base::service::ServiceRegistry::new());

        // builtin_manifests() 当前返回空 Vec，内置插件走 APK assets 加载
        let mut plugins = HashMap::new();
        for manifest in builtin_manifests() {
            let id = manifest.id.clone();
            plugins.insert(
                id,
                LoadedPlugin {
                    manifest,
                    state: PluginState::Loaded,
                    source: PluginSource::FrontendOnly,
                    extension_path: String::new(),
                },
            );
        }

        Self {
            plugins: Arc::new(RwLock::new(plugins)),
            wasm_runtime: OnceLock::new(),
            wasm_plugins: Arc::new(RwLock::new(HashMap::new())),
            wasm_host_ctx: OnceLock::new(),
            storage,
            approvals,
            settings,
            plugins_dir,
            plugin_db,
            app_handle,
            fs_auth,
            message_bus,
            service_registry,
        }
    }

    /// 应用作用域共享服务注册表（boot 用它注册 `PeerNodeService`）
    pub fn service_registry(&self) -> Arc<wasmnest_server_base::service::ServiceRegistry> {
        Arc::clone(&self.service_registry)
    }
}

impl PluginManager {
    /// 调用 WASM 插件命令
    ///
    /// 取实例句柄后 drop map 守卫，命令执行期间仅持单插件实例锁
    pub async fn invoke_command(&self, plugin_id: &str, command_name: &str, args_json: &str) -> Result<String> {
        // 状态门禁（与桌面 `PluginHost::invoke_rust_command` 同一道闸）：
        // 插件 guest 侧 activate 未成功时，实例已存在但插件自持状态未初始化，
        // 命令进 guest 就是「拿未初始化状态做 expect」——真机实证（2026-10-15
        // ai-chatbox：activate 在 store::init 失败后前端仍调 list-conversations
        // → guest panic → wasm trap → 进程 SIGILL）。
        //
        // 判据取「实例活着」而非严格 Activated：Degraded（activate 成功、on_startup
        // 失败）实例是活的、状态已初始化，与移动自身派发面（`dispatch_lifecycle_event`
        // / `dispatch_to_wasm` 的 `Activated | Degraded`）同口径；桌面那道闸更严
        // （只 Activated），此处保留移动现有语义，不把一般不涉及的降级插件一并禁掉。
        if !self.is_running(plugin_id).await {
            return Err(crate::AppError::Plugin(format!(
                "plugin {} is not running (command {}); activate must succeed first",
                plugin_id, command_name
            )));
        }
        let wasm_plugin = {
            let wasm_plugins = self.wasm_plugins.read().await;
            wasm_plugins.get(plugin_id).cloned()
        };
        let Some(wasm_plugin) = wasm_plugin else {
            return Err(crate::AppError::Plugin(format!("WASM plugin not found: {}", plugin_id)));
        };

        let mut loaded = wasm_plugin.lock().await;
        loaded.invoke_command(command_name, args_json)
    }

    /// 返回所有已加载插件信息
    pub async fn list_loaded(&self) -> Vec<MobilePluginInfo> {
        let plugins = self.plugins.read().await;
        plugins.values().map(|p| MobilePluginInfo::from(p)).collect()
    }

    /// 返回单个插件信息
    pub async fn get_info(&self, plugin_id: &str) -> Option<MobilePluginInfo> {
        let plugins = self.plugins.read().await;
        plugins.get(plugin_id).map(|p| MobilePluginInfo::from(p))
    }

    /// 插件是否处于 Activated 状态（Tauri command 身份校验用）
    pub async fn is_activated(&self, plugin_id: &str) -> bool {
        let plugins = self.plugins.read().await;
        plugins
            .get(plugin_id)
            .map(|p| p.state == PluginState::Activated)
            .unwrap_or(false)
    }

    /// 插件实例是否在运行（`Activated` / `Degraded`）
    ///
    /// 与 [`Self::is_activated`] 的区别：Degraded（activate 成功、on_startup 失败）
    /// 实例是活的，guest 侧自持状态（如 ai-chatbox 的 DATA_DIR）已初始化；
    /// 命令派发 / 事件派发这类「进 guest」的门禁都取本判据。
    pub async fn is_running(&self, plugin_id: &str) -> bool {
        let plugins = self.plugins.read().await;
        plugins
            .get(plugin_id)
            .map(|p| matches!(p.state, PluginState::Activated | PluginState::Degraded { .. }))
            .unwrap_or(false)
    }

    /// 插件是否持有指定权限（真源 = 内核 `PermissionManager`，2026-10-14 桌面同构）
    ///
    /// 与桌面 `host_api::check_permission` 同一判定；上下文未装配即拒（fail-closed）。
    pub async fn has_permission(&self, plugin_id: &str, permission: &str) -> bool {
        match self.wasm_host_ctx.get() {
            Some(ctx) => ctx.has_permission(plugin_id, permission),
            None => false,
        }
    }

    /// 查询插件启用状态（应用「已启用 / 可用」偏好，不是启动触发器）
    ///
    /// 启用偏好与自启动偏好分离：启用表示「这个应用可用」，不决定 boot 是否启动。
    pub async fn is_enabled(&self, plugin_id: &str) -> bool {
        let key = format!("{}{}", PLUGIN_ENABLED_KEY_PREFIX, plugin_id);
        match self.settings.get(&key).await {
            Ok(Some(v)) => v == "true",
            _ => false,
        }
    }

    /// 设置插件启用状态并持久化（应用「已启用 / 可用」偏好，不触发激活）
    pub async fn set_enabled(&self, plugin_id: &str, enabled: bool) -> Result<()> {
        let key = format!("{}{}", PLUGIN_ENABLED_KEY_PREFIX, plugin_id);
        self.settings.set(key, enabled.to_string()).await?;
        tracing::info!(plugin_id = %plugin_id, enabled = enabled, "Plugin enabled state persisted");
        Ok(())
    }

    /// 查询插件「启动时自动激活」偏好
    ///
    /// 缺省值按装配角色：L1 基础服务 / L2 内部业务 = `true`（系统服务默认随宿主
    /// 启动），L3 业务应用 = `false`。显式写入的 `false` 优先——用户关掉后不会
    /// 因缺省值又被拉起；不写偏好行，避免卸载重装回到默认开。
    pub async fn is_autostart(&self, plugin_id: &str) -> bool {
        let key = format!("{}{}", PLUGIN_AUTOSTART_KEY_PREFIX, plugin_id);
        match self.settings.get(&key).await {
            Ok(Some(v)) if v == "true" => true,
            Ok(Some(v)) if v == "false" => false,
            _ => {
                let plugins = self.plugins.read().await;
                plugins
                    .get(plugin_id)
                    .map(|p| p.manifest.kind.is_role_driven())
                    .unwrap_or(false)
            }
        }
    }

    /// 设置插件「启动时自动激活」偏好并持久化
    ///
    /// 只改偏好，不在当前进程立即激活 / 停用（与启用偏好一致：偏好 → 下次 boot
    /// 或用户显式操作生效，避免宿主「改配置即启停」的隐式副作用）。
    pub async fn set_autostart(&self, plugin_id: &str, autostart: bool) -> Result<()> {
        let key = format!("{}{}", PLUGIN_AUTOSTART_KEY_PREFIX, plugin_id);
        self.settings.set(key, autostart.to_string()).await?;
        tracing::info!(plugin_id = %plugin_id, autostart = autostart, "Plugin autostart state persisted");
        Ok(())
    }

    /// 标记插件错误状态
    ///
    /// 例外：`NeedsApproval` 不被覆盖——待审批是「需要用户动作」的事实（壳的详情页
    /// / 权限总览靠它派生审批入口），被通用 `Error` 覆盖会让审批入口消失（前端
    /// loader 在 `plugin_activate` 失败后固定调本方法，审批被拒走的正是那条路径）。
    pub async fn mark_error(&self, plugin_id: &str, error: String) {
        {
            let mut plugins = self.plugins.write().await;
            let Some(plugin) = plugins.get_mut(plugin_id) else {
                return;
            };
            if plugin.state == PluginState::NeedsApproval {
                tracing::debug!(
                    plugin_id = %plugin_id,
                    "mark_error skipped: plugin needs approval (approval entry must stay visible)"
                );
                return;
            }
            plugin.state = PluginState::Error { error };
        }
        // 锁外释放：release 会 await 服务 stop，不能持 plugins 锁
        self.release_services_for(plugin_id, "plugin marked error").await;
    }

    /// 插件显式上报启动成功
    ///
    /// Error → Activated 自愈（插件修复配置后重新上报）；
    /// Loaded → Activated（前端未走标准 activate 流程时兜底）。
    /// 已激活状态保持不动。
    pub async fn report_ready(&self, plugin_id: &str) -> Result<()> {
        let mut plugins = self.plugins.write().await;
        let plugin = plugins
            .get_mut(plugin_id)
            .ok_or_else(|| crate::AppError::Plugin(format!("Plugin not found: {}", plugin_id)))?;

        if plugin.state != PluginState::Activated {
            plugin.state = PluginState::Activated;
            tracing::info!(plugin_id = %plugin_id, "Plugin reported ready, state set to Activated");
        }
        Ok(())
    }
}

impl PluginManager {
    /// 获取存储管理器引用
    pub fn storage(&self) -> &PluginStorage {
        &self.storage
    }

    /// 获取文件系统访问校验器引用
    pub fn fs_auth(&self) -> &Arc<wasmnest_wasm_core::security::fs_auth::FsAuthChecker> {
        &self.fs_auth
    }

    /// 获取消息总线引用
    pub fn message_bus(&self) -> &Arc<crate::plugin::message_bus::MessageBus> {
        &self.message_bus
    }

    /// 获取插件数据目录
    pub fn plugins_dir(&self) -> &PathBuf {
        &self.plugins_dir
    }

    /// 获取 WASM 运行时引用
    ///
    /// # Panics
    /// 如果 init_wasm_runtime 未调用则 panic
    pub fn wasm_runtime(&self) -> &Arc<WasmRuntime> {
        self.wasm_runtime.get().expect("WasmRuntime not initialized")
    }

    /// 获取 WASM 宿主上下文引用
    ///
    /// # Panics
    /// 如果 init_wasm_runtime 未调用则 panic
    pub fn wasm_host_ctx(&self) -> &Arc<WasmHostContext> {
        self.wasm_host_ctx.get().expect("WasmHostContext not initialized")
    }
}
// ==================== 服务租约释放日志（生命周期路径共用） ====================

/// 逐条记录租约释放结果：单 key 失败只记录、不阻断插件生命周期。
fn log_release_reports(plugin_id: &str, reason: &str, reports: Vec<wasmnest_server_base::service::ReleaseReport>) {
    for report in reports {
        match &report.outcome {
            Ok(outcome) => tracing::info!(
                plugin_id = %plugin_id,
                service_key = %report.key,
                outcome = ?outcome,
                reason = %reason,
                "scoped service released on plugin lifecycle"
            ),
            Err(error) => tracing::error!(
                plugin_id = %plugin_id,
                service_key = %report.key,
                error = %error,
                reason = %reason,
                "scoped service release on plugin lifecycle failed"
            ),
        }
    }
}
