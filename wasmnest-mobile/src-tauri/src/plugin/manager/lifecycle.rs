use super::*;

impl PluginManager {
    /// 激活插件
    ///
    /// 锁约定：执行 WASM 导出函数期间不持有 plugins / wasm_plugins map 守卫
    /// （仅持单插件实例锁），避免 WASM 回调 host function 重入取 map 锁死锁。
    ///
    /// `_app_handle` 移除：原签名保留 `&tauri::AppHandle` 是为给 `app_handle: Some(...)`
    /// 场景做显式依赖；现状体内未使用且 Tauri 命令侧 `app.state()` 已可取
    /// `Arc<PluginManager>` 内的 `app_handle` 字段，删去以允许 `#[cfg(test)]`
    /// 构造无头 PluginManager 走真 activate 路径
    pub async fn activate(&self, plugin_id: &str) -> Result<()> {
        self.activate_impl(plugin_id, true).await
    }

    /// 前端已预授权（`plugin_preauthorize` 先行）后的激活入口
    ///
    /// 跳过 `activate_inner` step 0.5 的预授权弹窗——前端 toggle 时序已保证
    /// 授权在 loading 遮罩之前完成，重复弹窗（含 SAF URI 授权后再次触发）会
    /// 与 loading 同现；启动 auto-activate / 热重载仍走完整 `activate` 保留兜底。
    pub async fn activate_after_preauth(&self, plugin_id: &str) -> Result<()> {
        self.activate_impl(plugin_id, false).await
    }

    async fn activate_impl(&self, plugin_id: &str, run_preauth: bool) -> Result<()> {
        // 激活失败补偿：插件可能在 activate() 里已 acquire 服务、随后才失败；
        // 不回收会留下「插件未激活、服务仍在运行 / 仍在广播」的孤儿引用。
        // 服务由插件经原语自行请求（双端同构），宿主不再按产品 id 开关节点。
        let result = self.activate_inner(plugin_id, run_preauth).await;
        if result.is_err() {
            self.release_services_for(plugin_id, "activation failed").await;
        }
        result
    }

    /// 释放插件持有的全部应用作用域服务租约（停用 / 激活失败 / Error 态共用）
    pub(super) async fn release_services_for(&self, plugin_id: &str, reason: &str) {
        let reports = self.service_registry.release_all_for(plugin_id).await;
        log_release_reports(plugin_id, reason, reports);
    }

    async fn activate_inner(&self, plugin_id: &str, run_preauth: bool) -> Result<()> {
        // 0. 审批门禁（防冒名顶替获取权限）
        //
        // 内置插件（ApkAsset/FrontendOnly）属于应用构建信任域，直接放行；
        // 用户安装的插件必须已获人工批准且内容哈希未变，否则拒绝激活：
        // - 无批准 → NeedsApproval（权限清单未经用户确认，不得生效）
        // - 批准后文件被替换（哈希不匹配）→ 撤销批准 + NeedsApproval，
        //   防止「批准 A 插件后换入 B 插件代码」的在位冒名攻击
        let gate = {
            let plugins = self.plugins.read().await;
            plugins
                .get(plugin_id)
                .map(|p| (p.source.clone(), p.extension_path.clone()))
        };
        let Some((source, extension_path)) = gate else {
            return Err(crate::AppError::Plugin(format!("Plugin not found: {}", plugin_id)));
        };
        let trusted_source = source == PluginSource::ApkAsset || source == PluginSource::FrontendOnly;
        // 生效权限集（桌面同款口径，`PluginHost::activate_plugin`）：受信来源 = manifest
        // 全量；用户安装 = 批准 ∩ 请求。**只算不授**：授予在审批门禁之后、guest
        // activate 之前（见 step 1.5）——未批准插件不得拿到任何权限。
        let requested: Vec<String> = {
            let plugins = self.plugins.read().await;
            plugins
                .get(plugin_id)
                .map(|p| p.manifest.permissions.clone())
                .unwrap_or_default()
        };
        let effective: std::collections::HashSet<String> = if trusted_source {
            // 受信来源直接全量（等价 `effective_permissions(requested, None, trusted=true)`）
            effective_permissions(&requested, None, true)
        } else {
            let approval = self.approvals.get(plugin_id).await?;
            // 目录哈希不进 async 事件循环（Android 主线程阻塞风险）
            let (status, _current_hash) = {
                let approval_for_hash = approval.clone();
                let ext_for_hash = extension_path.clone();
                tokio::task::spawn_blocking(move || {
                    verify_approval(approval_for_hash.as_ref(), std::path::Path::new(&ext_for_hash))
                })
                .await
                .map_err(|e| crate::AppError::Plugin(format!("Approval verify task failed: {}", e)))?
                .map_err(|e| crate::AppError::Plugin(format!("Failed to verify plugin approval: {}", e)))?
            };
            match status {
                ApprovalStatus::Approved => effective_permissions(&requested, approval.as_ref(), false),
                _ => {
                    // Pending / HashMismatch 一律置 NeedsApproval 并拒绝激活
                    let mut plugins = self.plugins.write().await;
                    if let Some(p) = plugins.get_mut(plugin_id) {
                        p.state = PluginState::NeedsApproval;
                    }
                    if status == ApprovalStatus::HashMismatch {
                        tracing::warn!(
                            plugin_id = %plugin_id,
                            "Plugin content changed since approval, revoking approval"
                        );
                        // 撤销失败不阻断本次拒绝（插件仍无法激活），但必须留痕
                        if let Err(e) = self.approvals.revoke(plugin_id).await {
                            tracing::error!(
                                plugin_id = %plugin_id,
                                error = %e,
                                "Failed to revoke approval after content mismatch"
                            );
                        }
                    }
                    return Err(crate::AppError::Plugin(format!(
                        "Plugin '{}' requires user approval before activation (or its files changed since approval)",
                        plugin_id
                    )));
                }
            }
        };

        // 0.5 预授权 — 审批门禁之后、状态写之前(无锁);失败直接返回,
        // 前端 catch 后回退 toggle。loading 遮罩由前端 toggle 推迟到此
        // 调用之后才显示,确保授权弹窗与 loading 不会同时出现。
        // run_preauth=false(前端已预授权):跳过——重复弹窗会与 loading 同现
        if run_preauth {
            self.preauthorize_plugin(plugin_id).await?;
        }

        // 1. 检查状态与插件类型（短锁）
        let plugin_type = {
            let mut plugins = self.plugins.write().await;
            let plugin = plugins
                .get_mut(plugin_id)
                .ok_or_else(|| crate::AppError::Plugin(format!("Plugin not found: {}", plugin_id)))?;

            if matches!(plugin.state, PluginState::Activated | PluginState::Degraded { .. }) {
                // Activated / Degraded 均为终态：Degraded 可重试激活但重入无副作用，
                // 保持当前状态返回成功（幂等）
                return Ok(());
            }
            plugin.manifest.plugin_type.clone()
        };

        // 1.5 授予生效权限（桌面 `PluginHost::activate_plugin` 同款：每次激活重新授予
        // ——停用会 revoke，重激活不复授就全拒）。唯一真源 = 内核 `PermissionManager`：
        // 宿主 adapter 判定（bindings / host_domains）与内核 core_binding 域读同一份，
        // 移动独有 `granted_permissions` 镜像已退役（2026-10-14 权限面桌面同构）。
        // 授予必须早于 guest activate：插件启动期（activate / on_startup）即可用宿主能力。
        if let Some(ctx) = self.wasm_host_ctx.get() {
            let effective_vec: Vec<String> = effective.iter().cloned().collect();
            let granted = ctx.grant_permissions(plugin_id, &effective_vec);
            // 受信来源：manifest 声明但未生效 = 不在 SDK 词表（授权时被过滤）——
            // 必须可见，否则插件作者只能靠运行时 denied 反推（桌面同款告警）。
            // 用户安装插件不查：未批准位本就不在生效集，告警会误导。
            if trusted_source {
                let dropped: Vec<&String> = requested.iter().filter(|p| !granted.contains(p.as_str())).collect();
                if !dropped.is_empty() {
                    tracing::warn!(
                        plugin_id = %plugin_id,
                        dropped = ?dropped,
                        "plugin manifest declared permissions outside the SDK vocabulary; filtered at grant time"
                    );
                }
            }
            tracing::info!(
                plugin_id = %plugin_id,
                granted = granted.len(),
                "plugin permissions granted (effective set)"
            );
        } else {
            // 上下文未装配（扫描前 / 无头异常）：不授予——后续 host 调用一律 fail-closed 拒绝
            tracing::warn!(
                plugin_id = %plugin_id,
                "WASM host context not initialized; activation continues with no granted permissions"
            );
        }

        if plugin_type != PluginType::Wasm {
            // TS-only 插件：仅标记状态
            let mut plugins = self.plugins.write().await;
            if let Some(plugin) = plugins.get_mut(plugin_id) {
                plugin.state = PluginState::Activated;
            }
            tracing::info!(plugin_id = %plugin_id, "Plugin activated (ts-only)");
            return Ok(());
        }

        // 2. WASM 插件：置中间态 Activating（列表可见激活进行中）
        {
            let mut plugins = self.plugins.write().await;
            if let Some(plugin) = plugins.get_mut(plugin_id) {
                plugin.state = PluginState::Activating;
            }
        }

        // 2. WASM 插件：取实例句柄（短锁），执行 activate 导出（不持 map 守卫）
        let wasm_plugin = {
            let wasm_plugins = self.wasm_plugins.read().await;
            wasm_plugins.get(plugin_id).cloned()
        };

        let Some(wasm_plugin) = wasm_plugin else {
            // WASM 实例不存在，仅标记前端激活
            let mut plugins = self.plugins.write().await;
            if let Some(plugin) = plugins.get_mut(plugin_id) {
                plugin.state = PluginState::Activated;
            }
            tracing::info!(plugin_id = %plugin_id, "Plugin activated (frontend only, no WASM instance)");
            return Ok(());
        };

        let activation_result: std::result::Result<PluginState, String> = {
            let mut loaded = wasm_plugin.lock().await;
            // phase 1: WASM activate() 导出
            match loaded.activate() {
                Ok(0) => {
                    // phase 1b: 激活成功后立即调用 on_startup 导出，结果驱动终态
                    // 统一壳 on_startup 返回双层 Result（桌面语义）：外层 = 调用
                    // 故障（trap/燃料），内层 = guest 自报启动失败 → 都进 Degraded
                    match loaded.on_startup() {
                        Ok(Ok(())) => Ok(PluginState::Activated),
                        Ok(Err(msg)) => {
                            tracing::error!(
                                plugin_id = %plugin_id,
                                error = %msg,
                                "WASM plugin on_startup reported failure, state degraded"
                            );
                            Ok(PluginState::Degraded { error: msg })
                        }
                        Err(e) => {
                            tracing::error!(
                                plugin_id = %plugin_id,
                                error = %e,
                                "WASM plugin on_startup failed, state degraded"
                            );
                            Ok(PluginState::Degraded { error: e.to_string() })
                        }
                    }
                }
                Ok(code) => Err(format!("WASM activate() returned error code: {}", code)),
                Err(e) => Err(e.to_string()),
            }
        };

        // 3. 根据执行结果更新状态（短锁）
        let mut plugins = self.plugins.write().await;
        let plugin = plugins
            .get_mut(plugin_id)
            .ok_or_else(|| crate::AppError::Plugin(format!("Plugin not found: {}", plugin_id)))?;

        match activation_result {
            Ok(state) => {
                plugin.state = state.clone();
                match state {
                    PluginState::Activated => {
                        tracing::info!(plugin_id = %plugin_id, "WASM plugin activated");
                    }
                    PluginState::Degraded { error } => {
                        tracing::error!(
                            plugin_id = %plugin_id,
                            error = %error,
                            "WASM plugin activated but degraded (startup init incomplete)"
                        );
                    }
                    _ => {}
                }
                Ok(())
            }
            Err(e) => {
                plugin.state = PluginState::Error { error: e.clone() };
                Err(crate::AppError::Plugin(e))
            }
        }
    }

    /// 停用插件
    ///
    /// 锁约定同 activate：执行 WASM deactivate 导出期间不持 map 守卫
    pub async fn deactivate(&self, plugin_id: &str) -> Result<()> {
        // 停用成功（guest 清理已跑完）后回收该插件的服务租约：对端即时感知下线；
        // 插件自己没主动 release 时由这一层兜底。
        let result = self.deactivate_inner(plugin_id).await;
        if result.is_ok() {
            self.release_services_for(plugin_id, "plugin deactivated").await;
        }
        result
    }

    async fn deactivate_inner(&self, plugin_id: &str) -> Result<()> {
        // mDNS 基础能力服务（spec v2 §5.1）：插件停用即回收其全部浏览 + 广播
        // 句柄（host-mdns v2 生命周期随属主；只碰本人，宿主/它插件登记不受影响）
        crate::plugin::host_domains::purge_for_plugin(self.wasm_host_ctx(), plugin_id);

        // 1. 检查状态与插件类型（短锁）
        let (plugin_type, was_active) = {
            let mut plugins = self.plugins.write().await;
            let plugin = plugins
                .get_mut(plugin_id)
                .ok_or_else(|| crate::AppError::Plugin(format!("Plugin not found: {}", plugin_id)))?;

            (
                plugin.manifest.plugin_type.clone(),
                matches!(plugin.state, PluginState::Activated | PluginState::Degraded { .. }),
            )
        };
        if !was_active {
            // 未在运行（Loaded / Deactivated / Error）：无 guest 需要清理，直接收权——
            // Error 态可能是「激活成功后前端 mark_error」残留，授权不能留在下一轮激活
            if let Some(ctx) = self.wasm_host_ctx.get() {
                ctx.revoke_permissions(plugin_id);
            }
            return Ok(());
        }

        // 2. WASM 插件：取实例句柄（短锁），执行 deactivate 导出（不持 map 守卫）
        if plugin_type == PluginType::Wasm {
            let wasm_plugin = {
                let wasm_plugins = self.wasm_plugins.read().await;
                wasm_plugins.get(plugin_id).cloned()
            };
            if let Some(wasm_plugin) = wasm_plugin {
                let result = {
                    let mut loaded = wasm_plugin.lock().await;
                    loaded.deactivate()
                };
                if let Err(e) = result {
                    tracing::warn!(plugin_id = %plugin_id, error = %e, "WASM plugin deactivate failed");
                }
            }
        }

        // 3. 清理消息总线订阅（async 上下文直接 await，禁止 block_on）
        self.message_bus.remove_all_subscriptions(plugin_id).await;

        // 4. 权限随停用撤销（桌面 `PluginHost::deactivate_plugin` 的 `revoke_all` 同款）：
        // 真源是内核 PermissionManager，未撤销的授权会活到下一轮激活。放在 guest
        // deactivate **之后**——清理期 guest 仍要调宿主原语（mdns 停浏览 / peer 断开 /
        // 总线退订），先收权会把插件自己的清理动作拒掉；且在 plugins 锁之前取权限
        // 锁，避免锁序交叉。
        if let Some(ctx) = self.wasm_host_ctx.get() {
            ctx.revoke_permissions(plugin_id);
        }

        // 5. 更新状态（短锁）
        let mut plugins = self.plugins.write().await;
        if let Some(plugin) = plugins.get_mut(plugin_id) {
            plugin.state = PluginState::Deactivated;
        }
        tracing::info!(plugin_id = %plugin_id, "Plugin deactivated");
        Ok(())
    }
}

impl PluginManager {
    /// 卸载插件（仅用户安装的插件；内置插件拒绝）
    ///
    /// 停用 → 移除运行时实例 → 清理启用偏好与插件存储 → 删除插件目录
    pub async fn uninstall(&self, plugin_id: &str) -> Result<()> {
        {
            let plugins = self.plugins.read().await;
            let plugin = plugins
                .get(plugin_id)
                .ok_or_else(|| crate::AppError::Plugin(format!("Plugin not found: {}", plugin_id)))?;
            if plugin.source == PluginSource::ApkAsset {
                return Err(crate::AppError::Plugin(format!(
                    "Builtin plugin cannot be uninstalled: {}",
                    plugin_id
                )));
            }
            // 系统服务（L1/L2）随宿主分发，卸载入口只为用户安装的 L3 应用保留。
            // 判据 = manifest kind，不依赖来源标记（防绕过 apk-asset 标记的构造路径）。
            if plugin.manifest.kind.is_role_driven() {
                return Err(crate::AppError::Plugin(format!(
                    "System service cannot be uninstalled: {}",
                    plugin_id
                )));
            }
        }

        // 停用（若激活）并清理消息总线订阅
        self.deactivate(plugin_id).await?;

        // 移除 WASM 实例与插件记录
        self.wasm_plugins.write().await.remove(plugin_id);
        self.plugins.write().await.remove(plugin_id);
        // 指标注册表与已加载插件集合求一致：卸载后旧计数不得以幽灵卡留在快照里
        if let Some(runtime) = self.wasm_runtime.get() {
            runtime.monitor().remove(plugin_id);
        }
        // Egress：卸载清策略 + 记录 + URL 声明（重装即全新授权，ADR 0022 §8 生命周期）
        crate::egress::policy().purge_plugin(plugin_id);

        // 清理启用 / 自启动偏好、审批记录与插件存储
        let enabled_key = format!("{}{}", PLUGIN_ENABLED_KEY_PREFIX, plugin_id);
        if let Err(e) = self.settings.remove(&enabled_key).await {
            tracing::warn!(plugin_id = %plugin_id, error = %e, "Failed to remove enabled setting on uninstall");
        }
        let autostart_key = format!("{}{}", PLUGIN_AUTOSTART_KEY_PREFIX, plugin_id);
        if let Err(e) = self.settings.remove(&autostart_key).await {
            tracing::warn!(plugin_id = %plugin_id, error = %e, "Failed to remove autostart setting on uninstall");
        }
        if let Err(e) = self.approvals.revoke(plugin_id).await {
            tracing::warn!(plugin_id = %plugin_id, error = %e, "Failed to revoke approval on uninstall");
        }
        if let Err(e) = self.storage().clear_all(plugin_id).await {
            tracing::warn!(plugin_id = %plugin_id, error = %e, "Failed to clear plugin storage on uninstall");
        }

        // 删除插件目录
        let plugin_dir = self.plugins_dir.join(plugin_id);
        if plugin_dir.exists() {
            std::fs::remove_dir_all(&plugin_dir)
                .map_err(|e| crate::AppError::Plugin(format!("Failed to remove plugin dir: {}", e)))?;
        }

        tracing::info!(plugin_id = %plugin_id, "Plugin uninstalled");
        Ok(())
    }
}
