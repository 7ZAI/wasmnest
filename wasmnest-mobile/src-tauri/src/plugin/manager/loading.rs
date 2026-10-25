use super::events::PluginManagerDispatcher;
use super::*;

impl PluginManager {
    ///
    /// 必须在 Tokio 运行时上下文中调用（Engine 创建需要 Handle）。
    /// async：内部需 await 注入 dispatcher，禁止在运行时内使用 block_on（会 panic）
    pub async fn init_wasm_runtime(&self) -> crate::Result<()> {
        // AOT 缓存目录：宿主 cache 目录（非插件目录，防反序列化产物被投毒）
        let aot_cache_dir = self
            .app_handle
            .as_ref()
            .ok_or_else(|| crate::AppError::Plugin("app_handle missing for AOT cache dir".to_string()))?
            .path()
            .app_cache_dir()
            .ok()
            .map(|d| d.join("wasm-aot"));
        self.init_wasm_runtime_with(aot_cache_dir).await
    }

    /// 抽离的初始化内核：把 aot_cache_dir 作为入参注入，
    /// 允许 `#[cfg(test)]` 模块在 `app_handle = None` 场景下用 `None` 调用，
    /// 绕开 `app_handle.path().app_cache_dir()` 读
    pub(super) async fn init_wasm_runtime_with(&self, aot_cache_dir: Option<PathBuf>) -> crate::Result<()> {
        if let Some(dir) = &aot_cache_dir {
            if let Err(e) = std::fs::create_dir_all(dir) {
                tracing::warn!(
                    path = %dir.display(),
                    error = %e,
                    "Failed to create AOT cache dir, AOT cache disabled"
                );
            }
        }
        // 统一运行时壳（单形态 2026-10-13）：wasm-core 零端 ABI 知识——
        // 构造注入移动 ABI 规格（20，无 abi-form 导出）；first_party_dirs 移动
        // 无此概念（桌面 worker 免弹窗通道，ADR 0034）传空表。
        // 引擎配置经 `mobile_core_config`（含移动端固定项：关信号式 trap，见其注释）
        let core_config = mobile_core_config(
            self.app_handle
                .as_ref()
                .and_then(|h| h.path().app_config_dir().ok())
                .as_deref(),
        );
        let runtime = Arc::new(WasmRuntime::with_setup(
            self.storage.clone(),
            self.app_handle.as_ref().cloned(),
            crate::plugin::wasm_runtime::EngineSetup::new(core_config)
                .with_abi(crate::plugin::wasm_runtime::AbiPolicy { form: None }),
        )?);
        // guest 事件派发器（票 05 绑定归位）：`events` 导出是各端契约事实，内核零绑定
        // ——注入移动实现（词汇：on-bus-message / on-auth-success / on-disconnect /
        // on-session-*），缺省 `UnwiredGuestEvents` 派发即 fail-visible。
        // 装配期注入即可（晚绑定共享槽）：派发时实时读取，早于/晚于实例化均生效；
        // 缺省 `UnwiredGuestEvents` 派发即 fail-visible。
        runtime.set_guest_events(Arc::new(crate::plugin::guest_events::MobileGuestEvents));

        // 插件状态上报回调：置 Error + 撤销自启动 + 持久化未启用 + 前端通知
        let plugins = self.plugins.clone();
        let settings = self.settings.clone();
        let app_handle = self.app_handle.as_ref().cloned();
        let service_registry = Arc::clone(&self.service_registry);
        let status_reporter: Arc<dyn Fn(&str, &str) + Send + Sync> = Arc::new(move |plugin_id, error| {
            let plugins = plugins.clone();
            let settings = settings.clone();
            let app_handle = app_handle.clone();
            let service_registry = Arc::clone(&service_registry);
            let pid = plugin_id.to_string();
            let err = error.to_string();
            // async block 需要独占所有权，外层克隆供 emit/日志使用
            let pid_clone = pid.clone();
            let err_clone = err.clone();

            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(async move {
                        // 置 Error 状态
                        let mut map = plugins.write().await;
                        if let Some(p) = map.get_mut(&pid_clone) {
                            p.state = PluginState::Error { error: err_clone.clone() };
                        }
                        drop(map);

                        // Error 态的活实例已不可服务：释放其应用作用域服务租约
                        // （shutdown / release 由注册表模板保证幂等）
                        let reports = service_registry.release_all_for(&pid_clone).await;
                        log_release_reports(&pid_clone, "plugin marked error", reports);

                        // 撤销自启动：坏插件下次启动不再自动激活（旧行为由「持久化未启用」
                        // 承担，启用与自启动解耦后该职责归 autostart 偏好）——避免失败插件
                        // 每次 boot 重试报错。
                        if let Err(e) = settings.set(format!("{}{}", PLUGIN_AUTOSTART_KEY_PREFIX, &pid_clone), "false".to_string()).await {
                            tracing::warn!(plugin_id = %pid_clone, error = %e, "Failed to clear autostart state after plugin error");
                        }
                        // 持久化未启用（应用标记不可用；不再影响启动流程）
                        if let Err(e) = settings.set(format!("{}{}", PLUGIN_ENABLED_KEY_PREFIX, &pid_clone), "false".to_string()).await {
                            tracing::warn!(plugin_id = %pid_clone, error = %e, "Failed to persist disabled state after plugin error");
                        }
                    });
            });

            // 通知前端
            if let Some(handle) = app_handle.as_ref() {
                if let Err(e) = handle.emit(
                    "plugin:error",
                    serde_json::json!({
                        "pluginId": pid,
                        "error": err,
                    }),
                ) {
                    tracing::error!(plugin_id = %pid, error = %e, "Failed to emit plugin:error event");
                }
            }

            tracing::info!(plugin_id = %pid, error = %err, "Plugin reported error, marked Error and disabled");
        });

        // 下载目录端事实预热：`host-config.app.downloads_dir` 的同步端口读
        // `peer::ports` 进程内缓存，而插件 activate() 期就可能读该键（ai-chatbox
        // 数据目录 = `{AppDownloadsDir}/ai-chatbox`），peer 平台缝的预热由文件
        // 传输插件节点启动驱动（晚于激活）——故运行时装配时先单独预热一次。
        // 无 app_handle 的无头 / 测试上下文跳过：端口缺省 None，内核 config 域
        // 转成显性错误（fail-visible）。
        if let Some(handle) = self.app_handle.as_ref() {
            crate::peer::ports::prewarm_downloads_dir(handle.as_ref()).await;
        }

        let host_ctx = Arc::new(WasmHostContext::new_with_ports(
            self.plugin_db.clone(),
            self.storage.clone(),
            self.app_handle.as_ref().cloned(),
            self.fs_auth.clone(),
            self.message_bus.clone(),
            status_reporter,
            Arc::new(crate::plugin::host_ports::HostPorts::new()), // 批次 2b：宿主引擎端口装配
        ));
        // 运行监控出口（WIT `host-metrics`）：快照源 = 本运行时注册表。
        // 与桌面 `PluginHost::new` 同一条装配路径（两阶段注入，实例化前写入）。
        host_ctx.set_metrics_snapshot_source(runtime.monitor());

        // 宿主端事实（平台标识 = "mobile" / 无入站服务器）：单形态收口后从 wasm-core
        // 迁出的端差异实现，在插件实例化 / 激活之前注入（file-transfer 激活期探测
        // `host-platform.platform()`；晚注入 = 激活失败）
        host_ctx.set_host_facts(Arc::new(crate::plugin::host_ports::HostPorts::new()));

        // 服务租约注册表：必须早于任何激活（load_all 在 init 之后触发；激活期
        // 端点注册 / host-peer.start-node 会 acquire）
        host_ctx.set_service_registry(Some(Arc::clone(&self.service_registry)));

        // host-peer 端口（wasm-core-mobile-purity 票 03）：wasm-core bare 面 19 条
        // 原语的薄转发经 crate `ports::ports()` 取本端口——权限判定 / 引擎上下文 /
        // 同步桥 / 服务注册表四面在此与宿主衔接（幂等，重复 init 首装胜出）
        crate::plugin::peer_ports::install(self.app_handle.as_ref().cloned(), Arc::clone(&self.service_registry));

        // 组件路径无启动期签名表校验：契约由 WIT 编译期保证；组件形态由
        // instantiate_component 内的 `abi-form` 检查逐实例校验（移动 WIT 无该导出，
        // 故形态要求为 None），wit 包版本由 linker 的 import 名逐字匹配保证
        // （ADR 0051：整数 ABI 协商已退役）

        let _ = self.wasm_runtime.set(runtime);
        let _ = self.wasm_host_ctx.set(host_ctx);

        // 注入 dispatcher（PluginManagerDispatcher 实现 MessageDispatcher）
        let dispatcher: Arc<dyn crate::plugin::message_bus::MessageDispatcher> = Arc::new(PluginManagerDispatcher {
            plugins: self.plugins.clone(),
            wasm_plugins: self.wasm_plugins.clone(),
        });
        self.message_bus.set_dispatcher(dispatcher).await;

        Ok(())
    }

    /// 扫描并加载所有插件
    ///
    /// 在 APK assets 解压后调用，扫描 plugins_dir 下的所有 plugin.json
    /// 需要 WASM 运行时已初始化（调用 init_wasm_runtime 后）
    pub async fn scan_and_load(&self) {
        let Some(wasm_runtime) = self.wasm_runtime.get() else {
            tracing::warn!("[PluginManager] WASM runtime not initialized, skipping scan");
            return;
        };
        let Some(wasm_host_ctx) = self.wasm_host_ctx.get() else {
            tracing::warn!("[PluginManager] WASM host context not initialized, skipping scan");
            return;
        };

        let (plugins, wasm_plugins) = PluginLoader::load_all(&self.plugins_dir, wasm_runtime, wasm_host_ctx);

        let mut current_plugins = self.plugins.write().await;
        for (id, plugin) in plugins {
            // Egress L2：收集插件 preauthUrls 静态声明（manifest 属性，加载即注册）
            crate::egress::policy().register_plugin_urls(&id, &plugin.manifest.preauth_urls);
            current_plugins.insert(id, plugin);
        }
        drop(current_plugins);

        let mut current_wasm = self.wasm_plugins.write().await;
        for (id, wasm_plugin) in wasm_plugins {
            current_wasm.insert(id, Arc::new(TokioMutex::new(wasm_plugin)));
        }
        drop(current_wasm);

        // 装载 / 重扫后立刻刷新监控元数据：动态安装与重扫不走 `load_all`，
        // 若只在那里同步，新插件的 name / kind / monitorPanels 要到下次启动才出现。
        self.sync_plugin_meta().await;
    }

    /// 存量兼容：迁移后首启，对「已启用且无审批记录」的非内置插件自动批准一次
    ///
    /// 记录当前请求权限 + 目录哈希钉扎，避免升级后用户插件全部失活。
    /// 一次性语义由持久化 migration_done 标记保证：HashMismatch 撤销批准后
    /// 不会重新武装（篡改文件 → 重启不得静默重新批准），必须人工审批。
    /// 哈希计算走 spawn_blocking（插件目录读取不进 async 事件循环）。
    async fn auto_approve_legacy(&self, plugin_ids: &[String]) {
        let done = match self.approvals.migration_done().await {
            Ok(done) => done,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "Failed to read approval migration flag, skipping legacy auto-approval"
                );
                return;
            }
        };
        if done {
            return;
        }

        for id in plugin_ids {
            if self.is_trusted_source(id).await {
                continue;
            }
            let enabled = match self.settings.get(&format!("{}{}", PLUGIN_ENABLED_KEY_PREFIX, id)).await {
                Ok(Some(value)) => value == "true",
                Ok(None) => false,
                Err(e) => {
                    tracing::warn!(plugin_id = %id, error = %e, "Failed to read enabled state");
                    continue;
                }
            };
            if !enabled {
                continue;
            }
            match self.approvals.get(id).await {
                Ok(Some(_)) => continue,
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(plugin_id = %id, error = %e, "Failed to read approval");
                    continue;
                }
            }

            let (extension_path, version, requested) = {
                let plugins = self.plugins.read().await;
                match plugins.get(id) {
                    Some(p) => (
                        p.extension_path.clone(),
                        p.manifest.version.clone(),
                        p.manifest.permissions.clone(),
                    ),
                    None => continue,
                }
            };
            let hash = {
                let ext = extension_path.clone();
                tokio::task::spawn_blocking(move || compute_dir_hash(std::path::Path::new(&ext)))
                    .await
                    .map_err(|e| crate::AppError::Plugin(format!("Approval hash task failed: {}", e)))
                    .and_then(|r| r)
            };
            match hash {
                Ok(hash) => {
                    if let Err(e) = self.approvals.approve(id, &requested, &hash, &version).await {
                        tracing::warn!(
                            plugin_id = %id,
                            error = %e,
                            "Failed to auto-approve legacy enabled plugin"
                        );
                    } else {
                        tracing::info!(
                            plugin_id = %id,
                            "Legacy enabled plugin auto-approved (migration one-time)"
                        );
                    }
                }
                Err(e) => tracing::warn!(
                    plugin_id = %id,
                    error = %e,
                    "Failed to hash plugin dir for legacy auto-approval"
                ),
            }
        }

        // 无论是否有插件被批准，一次性标记置位
        if let Err(e) = self.approvals.set_migration_done().await {
            tracing::warn!(error = %e, "Failed to persist approval migration flag");
        }
    }

    /// 启动时应当自动激活的插件清单（真源 = `plugin.autostart.{id}`，缺省即关）
    ///
    /// 与 `plugin.enabled.{id}`（应用启用 / 可用性偏好）**解耦**：移动端是应用
    /// 模型——启动只扫描已安装 wasm-app，不启动任何应用；只有显式打开自启动开关
    /// 的应用才会在 boot 自动激活，其余保持 Loaded，等用户在宿主壳里点击启动。
    /// 返回按 id 排序（稳定顺序，不依赖 HashMap 迭代序），便于日志与测试断言。
    ///
    /// 抽成独立方法是为可单测：`load_all` 需要真 `tauri::AppHandle`（测试构造不出），
    /// 而「哪些该自启」的判据本身必须能单独钉住。
    pub(crate) async fn auto_start_candidates(&self) -> Vec<String> {
        let ids: Vec<String> = self.plugins.read().await.keys().cloned().collect();
        let mut candidates = Vec::new();
        for id in ids {
            // 缺省按角色：L1/L2 默认自启，L3 默认不自启；显式 false 优先。
            if self.is_autostart(&id).await {
                candidates.push(id);
            }
        }
        candidates.sort();
        candidates
    }

    /// 应用启动时：扫描已完成（`scan_and_load`），此处只对「启动时自动激活」的应用
    /// 做自动激活（`plugin.autostart.{id}`；缺省按角色：L1/L2 默认开、L3 默认关）
    ///
    /// 其余应用保持 Loaded 态，等用户在宿主壳里点击启动（`plugin_activate`）。
    pub async fn load_all(&self) {
        let plugin_ids: Vec<String> = self.plugins.read().await.keys().cloned().collect();

        // 存量兼容：迁移后首启自动批准（一次性，见 auto_approve_legacy）
        self.auto_approve_legacy(&plugin_ids).await;

        let candidates = self.auto_start_candidates().await;
        tracing::info!(
            count = candidates.len(),
            "[PluginManager] autostart candidates resolved (plugin.autostart.{{id}}, role-driven default)"
        );
        for id in candidates {
            if let Err(e) = self.activate(&id).await {
                tracing::warn!(plugin_id = %id, error = %e, "Failed to auto-activate plugin on startup");
            }
        }

        // 把名称 / 装配角色写进监控元数据：移动端 monitor 没有宿主插件清单命令，
        // 服务分类（L1/L2 vs L3）必须由宿主在快照里附带，不能要求目标插件参与。
        self.sync_plugin_meta().await;

        // 通知所有插件应用启动完成
        self.dispatch_lifecycle_event(PluginLifecycleEvent::AppStartup).await;
    }

    /// 同步插件元数据到指标注册表（`plugin_meta` 快照段）
    ///
    /// 只写只读展示字段（name / kind / monitorPanels）；指标仍是全量快照的主体。
    /// 装载 / 重扫后调用（含动态安装路径）；卸载路径由 `MetricsRegistry::remove`
    /// 一并清理元数据，这里只负责 upsert。
    pub(super) async fn sync_plugin_meta(&self) {
        let Some(runtime) = self.wasm_runtime.get() else {
            return;
        };
        let monitor = runtime.monitor();
        let metas: Vec<(String, serde_json::Value)> = {
            let plugins = self.plugins.read().await;
            plugins
                .values()
                .map(|plugin| {
                    (
                        plugin.manifest.id.clone(),
                        serde_json::json!({
                            "name": plugin.manifest.name,
                            "kind": plugin.manifest.kind.as_str(),
                            "monitorPanels": &plugin.manifest.contributes.monitor_panels,
                        }),
                    )
                })
                .collect()
        };
        for (id, meta) in metas {
            monitor.set_plugin_meta(&id, meta);
        }
    }

    /// 判断插件来源是否属于内置信任域（无需审批）
    ///
    /// ApkAsset（APK assets 随包，含无标记历史产物）与 FrontendOnly
    /// （内置注册）为应用构建产物，直接全量授权；FileInstall /
    /// RemoteDownload（用户安装）必须经过人工审批。
    pub async fn is_trusted_source(&self, plugin_id: &str) -> bool {
        let plugins = self.plugins.read().await;
        plugins
            .get(plugin_id)
            .map(|p| p.source == PluginSource::ApkAsset || p.source == PluginSource::FrontendOnly)
            .unwrap_or(false)
    }

    /// 批准插件权限（人工审批入口）
    ///
    /// 记录用户同意的权限全集（manifest 请求）+ 目录内容哈希钉扎。
    /// 仅用户安装插件需要审批；内置插件（ApkAsset/FrontendOnly）返回错误。
    /// 批准成功后插件状态 NeedsApproval → Loaded，由前端继续启用激活。
    pub async fn approve(&self, plugin_id: &str) -> Result<()> {
        if self.is_trusted_source(plugin_id).await {
            return Err(crate::AppError::Plugin(format!(
                "Builtin plugin '{}' does not require approval",
                plugin_id
            )));
        }
        let (extension_path, version, requested) = {
            let plugins = self.plugins.read().await;
            let plugin = plugins
                .get(plugin_id)
                .ok_or_else(|| crate::AppError::Plugin(format!("Plugin not found: {}", plugin_id)))?;
            (
                plugin.extension_path.clone(),
                plugin.manifest.version.clone(),
                plugin.manifest.permissions.clone(),
            )
        };

        let content_hash = {
            let ext = extension_path.clone();
            tokio::task::spawn_blocking(move || compute_dir_hash(std::path::Path::new(&ext)))
                .await
                .map_err(|e| crate::AppError::Plugin(format!("Approval hash task failed: {}", e)))?
                .map_err(|e| crate::AppError::Plugin(format!("Failed to hash plugin dir: {}", e)))?
        };
        self.approvals
            .approve(plugin_id, &requested, &content_hash, &version)
            .await?;

        // NeedsApproval → Loaded（前端随后可启用激活）
        let mut plugins = self.plugins.write().await;
        if let Some(p) = plugins.get_mut(plugin_id) {
            if p.state == PluginState::NeedsApproval {
                p.state = PluginState::Loaded;
            }
        }
        tracing::info!(
            plugin_id = %plugin_id,
            permissions = ?requested,
            "Plugin permissions approved and content pinned"
        );
        Ok(())
    }

    /// 预授权(启用前置):收集插件需授权路径 → 调 `fs_auth::check_batch`
    /// 单次合并弹窗。失败直接返回 `AppError::Plugin`,**不**改 state。
    /// **必须在 `activate` 步骤0(审批门禁)之后、状态写之前调用,持有
    /// plugins 锁时禁止调用**(check_batch 会发事件、可能回调宿主)。
    ///
    /// 路径来源:已注册的 `PreauthProvider` 优先;否则从 `PluginStorage`
    /// `preauth_paths` 数组读(file-transfer mount-local 同步写入);
    /// 另并入 manifest `preauthDirs` 声明目录(如 ai-chatbox 数据目录)——
    /// 插件 WASM activate 内 `fs_request_auth` 的弹窗晚于前端 loading 遮罩,
    /// 声明目录必须提前到本阶段统一弹窗(镜像桌面 wasiPreopenDirs 语义)。
    /// 路径为空 → 直接放行(启用先行:file-transfer 首次启用/全部目录移除后
    /// 均可空目录激活,共享目录配置由插件设置面板引导;硬拒绝会造成
    /// 「配置需激活 → 激活需先配置」死锁)。
    pub async fn preauthorize_plugin(&self, plugin_id: &str) -> Result<()> {
        // 1. 收集路径(注册 provider 优先,否则 storage 数组)
        let mut paths = collect_preauth_paths(plugin_id).await;
        if paths.is_empty() {
            if let Ok(Some(value)) = self.storage.get(plugin_id, PREAUTH_PATHS_STORAGE_KEY).await {
                if let Value::Array(arr) = value {
                    paths = arr.into_iter().filter_map(|v| v.as_str().map(String::from)).collect();
                }
            }
        }

        // 1.5 并入 manifest preauthDirs 声明目录(展开不过滤授权,未授权
        // 项正需在此弹窗)。短读锁克隆后立即释放:check_batch 会发事件、可能
        // 回调宿主,跨 await 持锁有死锁风险
        let declared = {
            let plugins = self.plugins.read().await;
            plugins
                .get(plugin_id)
                .map(|p| p.manifest.preauth_dirs.clone())
                .unwrap_or_default()
        };
        for dir in expand_preauth_dirs(&self.app_handle, plugin_id, &declared).await {
            if !paths.contains(&dir) {
                paths.push(dir);
            }
        }

        if paths.is_empty() {
            return Ok(());
        }

        // 3. 合并未授权路径为单次弹窗(check_batch 内部已实现事件 emit + 30s 超时)
        let allowed = self
            .fs_auth
            .check_batch(plugin_id, &paths, wasmnest_wasm_core::security::fs_auth::FsOps::READ)
            .await;
        if !allowed {
            return Err(crate::AppError::Plugin(
                "Plugin enable denied: file access authorization rejected".to_string(),
            ));
        }
        Ok(())
    }
}
