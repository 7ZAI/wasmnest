use super::*;

impl PluginManager {
    /// 分发生命周期事件到所有已激活插件
    ///
    /// 1. 快照目标插件（短锁）→ drop map 守卫 → 逐个锁单插件实例调用导出函数
    /// 2. 通过 app_handle.emit() 发射 Tauri 事件给前端 TS 插件
    pub async fn dispatch_lifecycle_event(&self, event: PluginLifecycleEvent) {
        let event_name = event.name();

        // AppStartup 的 WASM on_startup 已前置到 activate()（phase 1b），
        // 此处不再经 dispatch 二次分发（防 on_startup 被执行两次）；仅保留前端事件。
        // 其余事件（AppShutdown/auth/disconnect/session）照常对
        // Activated + Degraded 插件投递 —— Degraded 实例是活的，运行期回调仍应收到。
        if !matches!(event, PluginLifecycleEvent::AppStartup) {
            // 快照：声明了该事件的已激活（或降级）WASM 插件 id + 实例句柄（短锁）
            let targets: Vec<(String, Option<Arc<TokioMutex<LoadedWasmPlugin>>>)> = {
                let ids: Vec<String> = {
                    let plugins = self.plugins.read().await;
                    plugins
                        .values()
                        .filter(|p| {
                            matches!(p.state, PluginState::Activated | PluginState::Degraded { .. })
                                && p.manifest.plugin_type.has_backend()
                                && p.manifest
                                    .contributes
                                    .lifecycle
                                    .as_ref()
                                    .map(|l| l.is_declared(event_name))
                                    .unwrap_or(false)
                        })
                        .map(|p| p.manifest.id.clone())
                        .collect()
                };

                if ids.is_empty() {
                    Vec::new()
                } else {
                    let wasm_plugins = self.wasm_plugins.read().await;
                    ids.into_iter()
                        .map(|id| {
                            let handle = wasm_plugins.get(&id).cloned();
                            (id, handle)
                        })
                        .collect()
                }
            };

            // WASM 插件回调（不持 map 守卫）
            for (id, wasm_plugin) in targets {
                let Some(wasm_plugin) = wasm_plugin else {
                    continue;
                };
                let mut loaded = wasm_plugin.lock().await;
                if let Err(e) = loaded.call_lifecycle_event(&event) {
                    tracing::warn!(
                        plugin_id = %id,
                        event = %event_name,
                        error = %e,
                        "WASM lifecycle callback failed"
                    );
                }
            }
        }

        // 前端 Tauri 事件发射
        self.emit_frontend_event(&event);
    }

    /// 发射前端 Tauri 生命周期事件
    fn emit_frontend_event(&self, event: &PluginLifecycleEvent) {
        let tauri_event = format!("plugin:lifecycle:{}", event.tauri_event_name());
        let payload = event.to_payload();
        if let Some(handle) = &self.app_handle {
            if let Err(e) = handle.emit(&tauri_event, payload) {
                tracing::error!(
                    event = %tauri_event,
                    error = %e,
                    "Failed to emit frontend lifecycle event"
                );
            }
        } else {
            // 无头上下文（测试场景）：跳过 emit，不报错
            tracing::debug!(
                event = %tauri_event,
                "app_handle not set, skipping frontend lifecycle emit"
            );
        }
    }
}

/// PluginManager 的 MessageDispatcher 代理
///
/// 独立结构体避免 PluginManager 直接实现 trait 导致的生命周期问题
pub(super) struct PluginManagerDispatcher {
    pub(super) plugins: Arc<RwLock<HashMap<String, LoadedPlugin>>>,
    pub(super) wasm_plugins: Arc<RwLock<HashMap<String, Arc<TokioMutex<LoadedWasmPlugin>>>>>,
}

impl crate::plugin::message_bus::MessageDispatcher for PluginManagerDispatcher {
    /// 投递总线消息给 WASM 插件
    ///
    /// 由投递 worker 任务调用（同步 trait 形态，票 02 M3 单形态收敛——wasm-core
    /// `bus::MessageDispatcher` 统一为同步签名，异步依赖经 `runtime_util::block_on_async`
    /// 桥进入；本宿主再包装 async 闭包）：短读 map 取实例句柄 → drop map 守卫 →
    /// 持单插件锁执行 on_bus_message。投递串行进行，慢插件会推迟后续投递
    /// （换取全局顺序与无死锁）。
    fn dispatch_to_wasm(&self, plugin_id: &str, msg: &wasmnest_server_base::wire::BusMessage) -> anyhow::Result<()> {
        let wasm_plugins = self.wasm_plugins.clone();
        let pid = plugin_id.to_string();
        // 与 wasm-core 统一后的总线 trait 同型（票 02 M3）；bare 壳导出仍取
        // 移动 SDK 载荷形状（绑定层词汇，T-05 归位时随迁），此处做形状一致的
        // 值转换——两类型逐字段同构，形状由 `wasmnest-server-base::wire::drift_lock` 钉死
        let msg = wasmnest_plugin_api_mobile::BusMessage {
            topic: msg.topic.clone(),
            sender: msg.sender.clone(),
            payload: msg.payload.clone(),
            payload_binary: msg.payload_binary.clone(),
            timestamp: msg.timestamp,
        };
        wasmnest_wasm_core::runtime_util::block_on_async(async move {
            let wasm_plugin = {
                let map = wasm_plugins.read().await;
                map.get(&pid).cloned()
            };
            let Some(wasm_plugin) = wasm_plugin else {
                tracing::warn!("PluginManagerDispatcher: WASM plugin '{pid}' not loaded, message dropped");
                return Ok(());
            };

            let mut loaded = wasm_plugin.lock().await;
            // v9：按载荷格式路由——二进制消息走可选导出 on_message_binary
            // （总线已按订阅者格式偏好过滤，不会对无导出的旧插件发二进制消息）
            if let Some(bytes) = &msg.payload_binary {
                Ok(loaded.on_message_binary(&msg.topic, &msg.sender, bytes)?)
            } else {
                // 统一壳 on_message（单形态）：BusMessage → topic/sender/payload
                //（移动 WIT `events.on-bus-message` 无 sender 参数，宿主派发器不消费）
                Ok(loaded.on_message(&msg.topic, &msg.sender, &msg.payload)?)
            }
        })
    }

    fn is_activated(&self, plugin_id: &str) -> bool {
        let plugins = self.plugins.clone();
        let pid = plugin_id.to_string();
        wasmnest_wasm_core::runtime_util::block_on_async(async move {
            let plugins = plugins.read().await;
            plugins
                .get(&pid)
                .map(|p| p.state == PluginState::Activated)
                .unwrap_or(false)
        })
    }
}
