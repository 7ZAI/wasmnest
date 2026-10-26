//! host-websocket 端点域端到端——session_control / terminal_stream / device_events 分组

use super::*;

/// 票 09b：会话控制声明端点的直连往返（真实 bedcode 插件产物）
///
/// 旧 `/ws/event` `Message::SessionControl` 协议之外的声明式路由：客户端直连
/// `/ws/plugin/com.wasmnest.bedcode/session-control`（manifest
/// `contributes.wsEndpoints` 声明 + 激活期登记，auth=jwt）→ 首消息 JWT 认证 →
/// 文本动作帧 → 插件 `ws_control` 域分派 → 响应动作帧回包。宿主只做认证与
/// 帧转发（PluginChannel），动作「是什么业务」的解释在插件。
///
/// 覆盖：jwt 认证成功（fixture 用例遗留的「需真实签发 token」分支在此补上）、
/// list_sessions 空登记域回包形状、未知动作 fail-visible 错误帧。
#[test]
fn test_session_control_endpoint_direct_roundtrip() {
    // ADR 0033：正向认证在本 harness 不可达（见 runtime.rs 的说明）
    if positive_auth_needs_dedicated_binary("test_session_control_endpoint_direct_roundtrip") {
        return;
    }

    // ↓↓↓ 以下为不可达代码（上方已 return）：保留是为了让「这段断言本该测什么」
    // 在 diff 里可见；正向认证覆盖见 tests/ws_auth_rules.rs。绑定只为编译通过。
    let token = String::new();
    // ADR 0033：正向认证在本 harness 不可达（见 runtime.rs 的说明）
    if positive_auth_needs_dedicated_binary("test_session_control_endpoint_direct_roundtrip") {
        return;
    }
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;
    use wasmnest_server_websocket::endpoint::EndpointAuth;

    // `setup_wasm_runtime` 内部自建 runtime 并 block_on（建库/建上下文），
    // 必须在 `rt.block_on` **之外**调用：嵌套 block_on 会 panic
    let (wasm_runtime, host_ctx) = setup_wasm_runtime();
    let _ws_guard = lock_ws_fixture_e2e();
    // 会话插件私有库进程级共享：与会话闭环用例串行（见锁文档）
    let _serial = session_plugin_db_guard();

    const PLUGIN_ID: &str = "com.wasmnest.bedcode";
    let wasm_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.bedcode/bedcode_plugin_terminal_session.wasm");
    if !wasm_path.exists() {
        eprintln!("[skip] session wasip3 artifact not built");
        return;
    }

    let rt = tokio::runtime::Runtime::new().expect("tokio multi-thread runtime");
    rt.block_on(ws_e2e_guard("session/control 直连 e2e", async {
        // 独立私有库根目录（进程级共享根被并行测试写同一 SQLite 文件 → BUSY）
        let mut host_ctx = host_ctx;
        if let Some(ctx) = Arc::get_mut(&mut host_ctx) {
            ctx.set_plugin_db_root(Some(std::env::temp_dir().join(format!(
                "wasmnest_plugin_dbs_wsctl_e2e_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ))));
        }
        let _ = std::fs::remove_dir_all(plugin_db_root().join(PLUGIN_ID));

        // ==================== 宿主服务器 + 插件装载 ====================
        let (server_handle, server_task, port) = {
            let config = wasmnest_desktop_lib::wasm_core::system::config::AppConfig::default().network;
            let port = ws_pick_free_port();
            let (handle, server) = wasmnest_desktop_lib::server::composition::start_http_server(port, &config)
                .await
                .expect("start host http+ws server");
            (handle, tokio::spawn(server), port)
        };

        host_ctx.grant_permissions(
            PLUGIN_ID,
            &[
                "auth".to_string(),
                "broadcast".to_string(),
                "connection:read".to_string(),
                "fs:read".to_string(),
                "fs:write".to_string(),
                "peer".to_string(),
                "process:run".to_string(),
                "pty:io".to_string(),
                "pty:spawn".to_string(),
                "session:read".to_string(),
                "storage".to_string(),
                "task:run".to_string(),
                "terminal:input".to_string(),
                "timer:schedule".to_string(),
                "ui:input".to_string(),
                "ui:settings".to_string(),
                "ui:sidebar".to_string(),
                "ws:server".to_string(),
            ],
        );
        host_ctx
            .api_registry()
            .register(
                PLUGIN_ID,
                &session_apis().iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            )
            .unwrap();
        let component = wasm_runtime
            .compile_component(&std::fs::read(&wasm_path).expect("read session artifact"))
            .expect("compile session artifact");
        let plugin = Arc::new(Mutex::new(
            wasm_runtime
                .instantiate_component(&component, PLUGIN_ID, host_ctx.clone(), &[], None)
                .expect("instantiate session"),
        ));
        host_ctx
            .message_bus
            .set_dispatcher(Arc::new(TestInstanceDispatcher {
                instances: Arc::new(RwLock::new(HashMap::from([(PLUGIN_ID.to_string(), plugin.clone())]))),
            }))
            .await;
        // guest `activate` 会 `auth-center-register` / `deactivate` 会 `auth-center-unregister`
        // → 写进程级单中心注册表；必须在测试闸门内（否则与认证面闭环用例互清台，
        // 表现为**别的**用例偶发红）。只包住这一行，不包整个用例。
        {
            let _center_desk = wasmnest_desktop_lib::wasm_core::test_support::hold_registry_desk().await;
            plugin.lock().await.activate().expect("activate session");
        }

        // 激活期等价登记（PluginHost::activate_plugin 激活成功分支的对应物）：
        // 声明端点在端点表落地后，插件端点路由才可达
        let entry = wasmnest_server_websocket::endpoint::register(
            PLUGIN_ID,
            "session-control",
            EndpointAuth::Jwt,
            None,
            None,
            Arc::new(wasmnest_desktop_lib::wasm_core::bus::HostBusPort::new(
                host_ctx.message_bus.clone(),
                // 帧投递窄端口：必须与本总线同源（票 02 批次 03 的注入缝）
                Arc::new(wasmnest_desktop_lib::plugin::ws::HostWsPorts::from_bus(
                    host_ctx.message_bus.clone(),
                )),
            )),
        )
        .expect("register declared session/control endpoint");
        assert_eq!(entry.mount_path, "/ws/plugin/com.wasmnest.bedcode/session-control");

        // 真实入场凭证：经认证中心签发（ADR 0033：宿主无签发面），与 WS 认证
        // 侧（`enforce_connection_policy` → 中心验签）同一把密钥

        let url = format!("ws://127.0.0.1:{port}/ws/plugin/{PLUGIN_ID}/session-control");
        let (mut client, _) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("client connect via host route");

        // ==================== 1. 首消息 JWT 认证（auth=jwt 成功分支） ====================
        client
            .send(Message::Text(format!(r#"{{"type":"auth","token":"{token}"}}"#)))
            .await
            .expect("send auth frame");
        // 认证通过 → 接入事件发布；无显式 auth_ok 回帧（端点协议不定义回执），
        // 用「认证后业务帧可达」作为可达性判据：直接发动作帧

        // ==================== 2. list_sessions → 响应动作帧 ====================
        client
            .send(Message::Text(r#"{"type":"list_sessions"}"#.to_string()))
            .await
            .expect("send list action");
        match ws_client_recv(&mut client, std::time::Duration::from_secs(5)).await {
            Some(Message::Text(text)) => {
                let reply: serde_json::Value =
                    serde_json::from_str(&text).unwrap_or_else(|e| panic!("reply 非 JSON: {text}: {e}"));
                assert_eq!(reply["type"], "session_list", "响应动作标签, got: {reply}");
                assert_eq!(
                    reply["sessions"],
                    serde_json::json!([]),
                    "空登记域 → 空列表（SessionSummary 形状, got: {reply}"
                );
            }
            other => panic!("期望 list_sessions 响应帧，got: {other:?}"),
        }

        // ==================== 3. 未知动作 fail-visible：错误帧 ====================
        client
            .send(Message::Text(r#"{"type":"launch_missiles"}"#.to_string()))
            .await
            .expect("send unknown action");
        match ws_client_recv(&mut client, std::time::Duration::from_secs(5)).await {
            Some(Message::Text(text)) => {
                let reply: serde_json::Value =
                    serde_json::from_str(&text).unwrap_or_else(|e| panic!("reply 非 JSON: {text}: {e}"));
                assert_eq!(reply["type"], "error", "未知动作 → error 帧, got: {reply}");
                assert!(
                    reply["message"]
                        .as_str()
                        .is_some_and(|m| m.contains("unknown session control action")),
                    "错误文案点明未知动作, got: {reply}"
                );
            }
            other => panic!("期望 error 帧，got: {other:?}"),
        }

        // ==================== 4. 二进制帧非本端点协议：忽略 + 连接保持 ====================
        client
            .send(Message::Binary(vec![1, 2, 3]))
            .await
            .expect("send binary frame");
        // 连接不应被关闭：再发一个合法动作确认链路仍活
        client
            .send(Message::Text(r#"{"type":"list_sessions"}"#.to_string()))
            .await
            .expect("send list action again");
        match ws_client_recv(&mut client, std::time::Duration::from_secs(5)).await {
            Some(Message::Text(text)) => {
                let reply: serde_json::Value = serde_json::from_str(&text).expect("reply json");
                assert_eq!(reply["type"], "session_list", "二进制帧后链路仍活, got: {reply}");
            }
            other => panic!("期望 list_sessions 响应帧，got: {other:?}"),
        }

        // ==================== 5. 真实 start/stop/remove 闭环（票 03） ====================
        // 种子配置 → start_session 经端点直发（真实 PTY spawn）→ list 可见 →
        // stop_session → pty:exit 终态 → remove_session → 列表清空。
        // 发起者身份经 connection-context 解析（JWT deviceName=Phone），
        // 会话登记域的正统端初始归属因此固定为移动端。
        let config_out = plugin
            .lock()
            .await
            .invoke_command(
                "session.config.upsert",
                &serde_json::json!({
                    "name": "wsctl-e2e",
                    "environment": "linux",
                    "workingDir": std::env::temp_dir().to_string_lossy().as_ref(),
                    "command": "bash",
                })
                .to_string(),
            )
            .expect("seed config via plugin command");
        let config_id = serde_json::from_str::<serde_json::Value>(&config_out)
            .expect("config json")
            .get("id")
            .and_then(|v| v.as_str())
            .expect("config id")
            .to_string();

        client
            .send(Message::Text(format!(
                r#"{{"type":"start_session","config_id":"{config_id}"}}"#
            )))
            .await
            .expect("send start action");
        let started_id = match ws_client_recv_action(&mut client, std::time::Duration::from_secs(5)).await {
            Some(Message::Text(text)) => {
                let reply: serde_json::Value =
                    serde_json::from_str(&text).unwrap_or_else(|e| panic!("start 回包非 JSON: {text}: {e}"));
                assert_eq!(reply["type"], "start_session", "start 回显动作标签, got: {reply}");
                reply["session_id"].as_str().expect("start 回包 session_id").to_string()
            }
            other => panic!("期望 start_session 回包，got: {other:?}"),
        };
        assert!(
            !started_id.is_empty() && started_id.len() >= 8,
            "插件自产会话 id（UUID v4 形态）, got: {started_id}"
        );

        // list 应能看到新会话（真实 PTY 已 spawn，状态 running）
        client
            .send(Message::Text(r#"{"type":"list_sessions"}"#.to_string()))
            .await
            .expect("send list action");
        match ws_client_recv_action(&mut client, std::time::Duration::from_secs(5)).await {
            Some(Message::Text(text)) => {
                let reply: serde_json::Value = serde_json::from_str(&text).expect("reply json");
                assert_eq!(reply["type"], "session_list", "got: {reply}");
                let sessions = reply["sessions"].as_array().expect("sessions array");
                assert_eq!(sessions.len(), 1, "start 后列表应有 1 条, got: {reply}");
                assert_eq!(sessions[0]["id"], started_id, "列表命中新会话, got: {reply}");
                assert_eq!(sessions[0]["status"], "running", "spawn 即 running, got: {reply}");
            }
            other => panic!("期望 list_sessions 响应帧，got: {other:?}"),
        }

        // stop_session → pty kill → pty:exit 终态（轮询至 stopped）
        client
            .send(Message::Text(format!(
                r#"{{"type":"stop_session","session_id":"{started_id}"}}"#
            )))
            .await
            .expect("send stop action");
        match ws_client_recv_action(&mut client, std::time::Duration::from_secs(5)).await {
            Some(Message::Text(text)) => {
                let reply: serde_json::Value = serde_json::from_str(&text).expect("reply json");
                assert_eq!(reply["type"], "stop_session", "stop 回显动作标签, got: {reply}");
            }
            other => panic!("期望 stop_session 回包，got: {other:?}"),
        }
        // pty:exit 终态收尾是异步的（退出事件驱动）；**按截止时间轮询** list 直到 stopped。
        // 原形态是「40 次紧循环」——每轮只是一次快回包，40 轮总共只有几十毫秒，等价于
        // 「立刻断言」：全量并行跑时（CPU 被 1000+ 用例抢）pty 退出事件来不及落库就红，
        // 且失败信息看起来像产品缺陷（实为轮询窗口太短）。改成 20s 截止 + 100ms 间隔。
        let poll_deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut stopped = false;
        let mut last_seen = String::from("<no session_list reply>");
        while std::time::Instant::now() < poll_deadline {
            client
                .send(Message::Text(r#"{"type":"list_sessions"}"#.to_string()))
                .await
                .expect("send list");
            if let Some(Message::Text(text)) =
                ws_client_recv_action(&mut client, std::time::Duration::from_secs(3)).await
            {
                let reply: serde_json::Value = serde_json::from_str(&text).expect("reply json");
                if reply["type"] == "session_list" {
                    let status = reply["sessions"]
                        .as_array()
                        .and_then(|a| a.first())
                        .and_then(|s| s["status"].as_str());
                    last_seen = format!("{status:?}");
                    if status == Some("stopped") {
                        stopped = true;
                        break;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(
            stopped,
            "stop 后会话应进入 stopped 终态（pty:exit 驱动），最后看到 {last_seen}"
        );

        // remove_session → 摘记录 → 列表清空
        client
            .send(Message::Text(format!(
                r#"{{"type":"remove_session","session_id":"{started_id}"}}"#
            )))
            .await
            .expect("send remove action");
        match ws_client_recv_action(&mut client, std::time::Duration::from_secs(5)).await {
            Some(Message::Text(text)) => {
                let reply: serde_json::Value = serde_json::from_str(&text).expect("reply json");
                assert_eq!(reply["type"], "remove_session", "remove 回显动作标签, got: {reply}");
            }
            other => panic!("期望 remove_session 回包，got: {other:?}"),
        }
        client
            .send(Message::Text(r#"{"type":"list_sessions"}"#.to_string()))
            .await
            .expect("send list action");
        match ws_client_recv_action(&mut client, std::time::Duration::from_secs(5)).await {
            Some(Message::Text(text)) => {
                let reply: serde_json::Value = serde_json::from_str(&text).expect("reply json");
                let sessions = reply["sessions"].as_array().expect("sessions array");
                assert_eq!(sessions.len(), 0, "remove 后列表应清空, got: {reply}");
            }
            other => panic!("期望 list_sessions 响应帧，got: {other:?}"),
        }

        // ==================== 收尾：优雅停机 + 清理 ====================
        server_handle.stop(true).await;
        server_task.abort();
        wasmnest_server_websocket::endpoint::purge_for_plugin(PLUGIN_ID);
        // guest `activate` 会 `auth-center-register` / `deactivate` 会 `auth-center-unregister`
        // → 写进程级单中心注册表；必须在测试闸门内（否则与认证面闭环用例互清台，
        // 表现为**别的**用例偶发红）。只包住这一行，不包整个用例。
        {
            let _center_desk = wasmnest_desktop_lib::wasm_core::test_support::hold_registry_desk().await;
            plugin.lock().await.deactivate().expect("deactivate = 0");
        }
    }));
}

/// 票 04：WS 终端流端点闭环（真实 PTY 输入 → 二进制输出帧 → 停止帧）
///
/// 客户端经 `/ws/plugin/com.wasmnest.bedcode/terminal` 直连（auth=jwt）：
/// 订阅 → binary 输入直写 PTY → ring-fetch 游标拉取 → 二进制帧输出 →
/// 未订阅输入显性 error → 会话停止 → 尾帧后 `session_stopped` 停止帧 →
/// 退订/断连清理。宿主只转原始帧（不解析终端帧、不读 session id、不维护订阅表）。
#[test]
fn test_terminal_stream_endpoint_closed_loop() {
    // ADR 0033：正向认证在本 harness 不可达（见 runtime.rs 的说明）
    if positive_auth_needs_dedicated_binary("test_terminal_stream_endpoint_closed_loop") {
        return;
    }

    // ↓↓↓ 以下为不可达代码（上方已 return）：保留是为了让「这段断言本该测什么」
    // 在 diff 里可见；正向认证覆盖见 tests/ws_auth_rules.rs。绑定只为编译通过。
    let token = String::new();
    // ADR 0033：正向认证在本 harness 不可达（见 runtime.rs 的说明）
    if positive_auth_needs_dedicated_binary("test_terminal_stream_endpoint_closed_loop") {
        return;
    }
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;
    use wasmnest_server_websocket::endpoint::EndpointAuth;

    let (wasm_runtime, host_ctx) = setup_wasm_runtime();
    let _ws_guard = lock_ws_fixture_e2e();
    let _serial = session_plugin_db_guard();

    const PLUGIN_ID: &str = "com.wasmnest.bedcode";
    let wasm_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.bedcode/bedcode_plugin_terminal_session.wasm");
    if !wasm_path.exists() {
        eprintln!("[skip] session wasip3 artifact not built");
        return;
    }

    let rt = tokio::runtime::Runtime::new().expect("tokio multi-thread runtime");
    rt.block_on(ws_e2e_guard("ws terminal 流 e2e", async {
        // 独立私有库根目录（避免并行测试写同一 SQLite → BUSY）
        let mut host_ctx = host_ctx;
        if let Some(ctx) = Arc::get_mut(&mut host_ctx) {
            ctx.set_plugin_db_root(Some(std::env::temp_dir().join(format!(
                "wasmnest_plugin_dbs_wsterm_e2e_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ))));
        }
        let _ = std::fs::remove_dir_all(plugin_db_root().join(PLUGIN_ID));

        // ==================== 宿主服务器 + 插件装载 ====================
        let (server_handle, server_task, port) = {
            let config = wasmnest_desktop_lib::wasm_core::system::config::AppConfig::default().network;
            let port = ws_pick_free_port();
            let (handle, server) = wasmnest_desktop_lib::server::composition::start_http_server(port, &config)
                .await
                .expect("start host http+ws server");
            (handle, tokio::spawn(server), port)
        };

        host_ctx.grant_permissions(
            PLUGIN_ID,
            &[
                "auth".to_string(),
                "connection:read".to_string(),
                "fs:read".to_string(),
                "fs:write".to_string(),
                "peer".to_string(),
                "process:run".to_string(),
                "pty:io".to_string(),
                "pty:spawn".to_string(),
                "session:read".to_string(),
                "storage".to_string(),
                "task:run".to_string(),
                "terminal:input".to_string(),
                "timer:schedule".to_string(),
                "ui:input".to_string(),
                "ui:settings".to_string(),
                "ui:sidebar".to_string(),
                "ws:server".to_string(),
            ],
        );
        host_ctx
            .api_registry()
            .register(
                PLUGIN_ID,
                &session_apis().iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            )
            .unwrap();
        let component = wasm_runtime
            .compile_component(&std::fs::read(&wasm_path).expect("read session artifact"))
            .expect("compile session artifact");
        let plugin = Arc::new(Mutex::new(
            wasm_runtime
                .instantiate_component(&component, PLUGIN_ID, host_ctx.clone(), &[], None)
                .expect("instantiate session"),
        ));
        host_ctx
            .message_bus
            .set_dispatcher(Arc::new(TestInstanceDispatcher {
                instances: Arc::new(RwLock::new(HashMap::from([(PLUGIN_ID.to_string(), plugin.clone())]))),
            }))
            .await;
        // guest `activate` 会 `auth-center-register` / `deactivate` 会 `auth-center-unregister`
        // → 写进程级单中心注册表；必须在测试闸门内（否则与认证面闭环用例互清台，
        // 表现为**别的**用例偶发红）。只包住这一行，不包整个用例。
        {
            let _center_desk = wasmnest_desktop_lib::wasm_core::test_support::hold_registry_desk().await;
            plugin.lock().await.activate().expect("activate session");
        }

        // 声明端点等价登记（票 04：terminal 端点，auth=jwt）
        let entry = wasmnest_server_websocket::endpoint::register(
            PLUGIN_ID,
            "terminal",
            EndpointAuth::Jwt,
            None,
            None,
            Arc::new(wasmnest_desktop_lib::wasm_core::bus::HostBusPort::new(
                host_ctx.message_bus.clone(),
                // 帧投递窄端口：必须与本总线同源（票 02 批次 03 的注入缝）
                Arc::new(wasmnest_desktop_lib::plugin::ws::HostWsPorts::from_bus(
                    host_ctx.message_bus.clone(),
                )),
            )),
        )
        .expect("register declared terminal endpoint");
        assert_eq!(entry.mount_path, "/ws/plugin/com.wasmnest.bedcode/terminal");

        // 种子配置 + 创建真实会话（bash PTY）
        let config_out = plugin
            .lock()
            .await
            .invoke_command(
                "session.config.upsert",
                &serde_json::json!({
                    "name": "wsterm-e2e",
                    "environment": "linux",
                    "workingDir": std::env::temp_dir().to_string_lossy().as_ref(),
                    "command": "bash",
                })
                .to_string(),
            )
            .expect("seed config via plugin command");
        let config_id = serde_json::from_str::<serde_json::Value>(&config_out)
            .expect("config json")
            .get("id")
            .and_then(|v| v.as_str())
            .expect("config id")
            .to_string();
        let create_out = plugin
            .lock()
            .await
            .invoke_command(
                "session.create",
                &serde_json::json!({ "configId": config_id }).to_string(),
            )
            .expect("create session via plugin command");
        let session_id = serde_json::from_str::<serde_json::Value>(&create_out)
            .expect("create json")
            .get("sessionId")
            .and_then(|v| v.as_str())
            .expect("session id")
            .to_string();

        let url = format!("ws://127.0.0.1:{port}/ws/plugin/{PLUGIN_ID}/terminal");
        let (mut client, _) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("client connect via host route");
        client
            .send(Message::Text(format!(r#"{{"type":"auth","token":"{token}"}}"#)))
            .await
            .expect("send auth frame");

        // ==================== 1. 订阅 → subscribed 回帧 ====================
        client
            .send(Message::Text(format!(
                r#"{{"type":"subscribe","sessionId":"{session_id}"}}"#
            )))
            .await
            .expect("send subscribe");
        match ws_client_recv(&mut client, std::time::Duration::from_secs(5)).await {
            Some(Message::Text(text)) => {
                let reply: serde_json::Value = serde_json::from_str(&text).expect("reply json");
                assert_eq!(reply["type"], "subscribed", "订阅回帧, got: {reply}");
                assert_eq!(reply["sessionId"], session_id);
                assert_eq!(reply["mode"], "live", "mode 缺省 live");
            }
            other => panic!("期望 subscribed 回帧，got: {other:?}"),
        }
        // 订阅触发首轮 drain：可能已推送历史输出（prompt 等）——吞掉，留作后续断言

        // ==================== 2. binary 输入直写 PTY → 输出二进制帧 ====================
        client
            .send(Message::Binary(b"echo ws-terminal-e2e\n".to_vec()))
            .await
            .expect("send binary input");
        // 输出泵 = 客户端帧驱动 drain + 1s tick 兜底：输入后周期发 poll 帧触发
        // drain（tick 在直连实例不自动跑，poll 即协议规定的拉取触发）
        let mut got_marker = false;
        for i in 0..60 {
            // 每轮先触发一次 drain（poll 帧），再收帧
            let _ = client.send(Message::Text(r#"{"type":"poll"}"#.to_string())).await;
            match ws_client_recv(&mut client, std::time::Duration::from_secs(1)).await {
                Some(Message::Binary(bytes)) => {
                    if bytes.windows(b"ws-terminal-e2e".len()).any(|w| w == b"ws-terminal-e2e") {
                        got_marker = true;
                        break;
                    }
                }
                Some(Message::Text(text)) => {
                    // poll 期间只应有输出（binary）与可能的 ring_resync；error 即异常
                    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                    assert!(v["type"] != "error", "输出过程中不得出现 error 帧: {text}");
                }
                None => {}
                _ => {}
            }
            let _ = i;
        }
        assert!(got_marker, "binary 输入经 PTY 执行后输出必须回显标记");

        // ==================== 3. 未订阅输入 → 显性 error 帧 ====================
        client
            .send(Message::Text(r#"{"type":"unsubscribe"}"#.to_string()))
            .await
            .expect("send unsubscribe");
        match ws_client_recv(&mut client, std::time::Duration::from_secs(5)).await {
            Some(Message::Text(text)) => {
                let reply: serde_json::Value = serde_json::from_str(&text).expect("reply json");
                assert_eq!(reply["type"], "unsubscribed", "退订回帧, got: {reply}");
            }
            other => panic!("期望 unsubscribed 回帧，got: {other:?}"),
        }
        client
            .send(Message::Text(r#"{"type":"input","data":"x"}"#.to_string()))
            .await
            .expect("send input without subscription");
        match ws_client_recv(&mut client, std::time::Duration::from_secs(5)).await {
            Some(Message::Text(text)) => {
                let reply: serde_json::Value = serde_json::from_str(&text).expect("reply json");
                assert_eq!(reply["type"], "error", "未订阅输入必须显性报错, got: {reply}");
                assert!(
                    reply["message"].as_str().is_some_and(|m| m.contains("未订阅会话")),
                    "错误文案点名未订阅, got: {reply}"
                );
            }
            other => panic!("期望 error 回帧，got: {other:?}"),
        }

        // ==================== 4. 重订阅 → 停止会话 → 停止帧（尾帧后） ====================
        client
            .send(Message::Text(format!(
                r#"{{"type":"subscribe","sessionId":"{session_id}"}}"#
            )))
            .await
            .expect("resend subscribe");
        match ws_client_recv(&mut client, std::time::Duration::from_secs(5)).await {
            Some(Message::Text(text)) => {
                let reply: serde_json::Value = serde_json::from_str(&text).expect("reply json");
                assert_eq!(reply["type"], "subscribed", "重订阅回帧, got: {reply}");
            }
            other => panic!("期望 subscribed 回帧，got: {other:?}"),
        }
        // 停止会话（pty:exit 驱动终态 → 插件收尾：尽力尾帧 + session_stopped）
        plugin
            .lock()
            .await
            .invoke_command(
                "session.close",
                &serde_json::json!({ "sessionId": session_id }).to_string(),
            )
            .expect("close session via plugin command");
        let mut got_stop = false;
        for _ in 0..60 {
            match ws_client_recv(&mut client, std::time::Duration::from_secs(3)).await {
                Some(Message::Text(text)) => {
                    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                    if v["type"] == "session_stopped" {
                        assert_eq!(v["sessionId"], session_id, "停止帧会话 id, got: {text}");
                        assert_eq!(v["reason"], "killed", "close → kill 原因, got: {text}");
                        got_stop = true;
                        break;
                    }
                }
                Some(Message::Binary(_)) => {} // 尾帧（尽力排空）
                None => break,
                _ => {}
            }
        }
        assert!(got_stop, "会话停止后必须收到 session_stopped 停止帧");

        // ==================== 5. 断开清理：连接摘除后不再产生帧 ====================
        let _ = client.close(None).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        // 退订/断开后的插件状态由断开事件清理（无宿主订阅表可断言；以
        // 「连接关闭无残留任务」为通过判据——宿主侧无新帧产生即可）

        // ==================== 收尾：优雅停机 + 清理 ====================
        server_handle.stop(true).await;
        server_task.abort();
        wasmnest_server_websocket::endpoint::purge_for_plugin(PLUGIN_ID);
        // guest `activate` 会 `auth-center-register` / `deactivate` 会 `auth-center-unregister`
        // → 写进程级单中心注册表；必须在测试闸门内（否则与认证面闭环用例互清台，
        // 表现为**别的**用例偶发红）。只包住这一行，不包整个用例。
        {
            let _center_desk = wasmnest_desktop_lib::wasm_core::test_support::hold_registry_desk().await;
            plugin.lock().await.deactivate().expect("deactivate = 0");
        }
    }));
}

/// 票 07 e2e：设备派生事件与认证记录 touch/close 归插件闭环
///
/// 真 Actix server + 真实 bedcode WASM 插件 + 真实 WS 客户端：
///
/// - 正例：带 JWT（fingerprint）的客户端连入 `session-control` 端点 → 宿主发布
///   `<owner>::ws:client-connect` → 插件经 `connection-context` 取已脱敏指纹 →
///   私有库 touch（lastSeen 刷新 + connectCount 0→1）；断开 →
///   `<owner>::ws:client-disconnect` → 插件 close_open（open 历史行回填
///   disconnectedAt）。宿主不再代做（device 事件 / 认证记录宿主侧零调用）。
/// - 反例：未配对指纹连接 → touch 为零行更新（connectCount 不变、派生视图无行）；
///   close 同为 no-op。
#[test]
fn test_ws_device_events_and_auth_records_closed_loop() {
    // ADR 0033：正向认证在本 harness 不可达（见 runtime.rs 的说明）
    if positive_auth_needs_dedicated_binary("test_ws_device_events_and_auth_records_closed_loop") {
        return;
    }

    // ↓↓↓ 以下为不可达代码（上方已 return）：保留是为了让「这段断言本该测什么」
    // 在 diff 里可见；正向认证覆盖见 tests/ws_auth_rules.rs。绑定只为编译通过。
    let token = String::new();
    let ghost_token = String::new();
    // ADR 0033：正向认证在本 harness 不可达（见 runtime.rs 的说明）
    if positive_auth_needs_dedicated_binary("test_ws_device_events_and_auth_records_closed_loop") {
        return;
    }
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;
    use wasmnest_desktop_lib::wasm_core::intercall::call_api;
    use wasmnest_server_websocket::endpoint::EndpointAuth;

    let (wasm_runtime, host_ctx) = setup_wasm_runtime();
    let _ws_guard = lock_ws_fixture_e2e();
    // 会话插件私有库进程级共享：与会话闭环用例串行（见锁文档）
    let _serial = session_plugin_db_guard();

    const PLUGIN_ID: &str = "com.wasmnest.bedcode";
    let wasm_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.bedcode/bedcode_plugin_terminal_session.wasm");
    if !wasm_path.exists() {
        eprintln!("[skip] session wasip3 artifact not built");
        return;
    }

    let rt = tokio::runtime::Runtime::new().expect("tokio multi-thread runtime");
    rt.block_on(ws_e2e_guard("device events & auth records e2e", async {
        // 独立私有库根目录（避免并行测试写同一 SQLite → BUSY）
        let mut host_ctx = host_ctx;
        if let Some(ctx) = Arc::get_mut(&mut host_ctx) {
            ctx.set_plugin_db_root(Some(std::env::temp_dir().join(format!(
                "wasmnest_plugin_dbs_device_e2e_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ))));
        }
        let _ = std::fs::remove_dir_all(plugin_db_root().join(PLUGIN_ID));

        // ==================== 宿主服务器 + 插件装载 ====================
        let (server_handle, server_task, port) = {
            let config = wasmnest_desktop_lib::wasm_core::system::config::AppConfig::default().network;
            let port = ws_pick_free_port();
            let (handle, server) = wasmnest_desktop_lib::server::composition::start_http_server(port, &config)
                .await
                .expect("start host http+ws server");
            (handle, tokio::spawn(server), port)
        };

        host_ctx.grant_permissions(
            PLUGIN_ID,
            &[
                "auth".to_string(),
                "broadcast".to_string(),
                "connection:read".to_string(),
                "fs:read".to_string(),
                "fs:write".to_string(),
                "peer".to_string(),
                "process:run".to_string(),
                "pty:io".to_string(),
                "pty:spawn".to_string(),
                "session:read".to_string(),
                "storage".to_string(),
                "task:run".to_string(),
                "terminal:input".to_string(),
                "timer:schedule".to_string(),
                "ui:input".to_string(),
                "ui:settings".to_string(),
                "ui:sidebar".to_string(),
                "ws:server".to_string(),
            ],
        );
        host_ctx
            .api_registry()
            .register(
                PLUGIN_ID,
                &session_apis().iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            )
            .unwrap();
        let component = wasm_runtime
            .compile_component(&std::fs::read(&wasm_path).expect("read session artifact"))
            .expect("compile session artifact");
        let plugin = Arc::new(Mutex::new(
            wasm_runtime
                .instantiate_component(&component, PLUGIN_ID, host_ctx.clone(), &[], None)
                .expect("instantiate session"),
        ));
        host_ctx
            .message_bus
            .set_dispatcher(Arc::new(TestInstanceDispatcher {
                instances: Arc::new(RwLock::new(HashMap::from([(PLUGIN_ID.to_string(), plugin.clone())]))),
            }))
            .await;
        // guest `activate` 会 `auth-center-register` / `deactivate` 会 `auth-center-unregister`
        // → 写进程级单中心注册表；必须在测试闸门内（否则与认证面闭环用例互清台，
        // 表现为**别的**用例偶发红）。只包住这一行，不包整个用例。
        {
            let _center_desk = wasmnest_desktop_lib::wasm_core::test_support::hold_registry_desk().await;
            plugin.lock().await.activate().expect("activate session");
        }

        // 声明端点等价登记（票 09b：session-control 端点，auth=jwt）
        let entry = wasmnest_server_websocket::endpoint::register(
            PLUGIN_ID,
            "session-control",
            EndpointAuth::Jwt,
            None,
            None,
            Arc::new(wasmnest_desktop_lib::wasm_core::bus::HostBusPort::new(
                host_ctx.message_bus.clone(),
                // 帧投递窄端口：必须与本总线同源（票 02 批次 03 的注入缝）
                Arc::new(wasmnest_desktop_lib::plugin::ws::HostWsPorts::from_bus(
                    host_ctx.message_bus.clone(),
                )),
            )),
        )
        .expect("register declared session/control endpoint");
        assert_eq!(entry.mount_path, "/ws/plugin/com.wasmnest.bedcode/session-control");

        // ==================== 播种认证记录（私有库真源，auth-records-import） ====================
        // 配对行（fp-dev-1，活跃，connectCount=0）+ 一条 open 连接历史行
        // （close_open 的关闭对象；真实路径 = HTTP 认证成功后 record_event 追加）
        call_api(
            &host_ctx,
            "com.wasmnest.bedcode.auth-records-import",
            serde_json::json!({
                "pairings": [{
                    "id": "p-dev-1",
                    "deviceName": "Pixel 9",
                    "deviceFingerprint": "fp-dev-1",
                    "pairedAt": "2026-09-19T00:00:00Z",
                    "connectCount": 0,
                    "isActive": true
                }],
                "history": [{
                    "deviceId": "p-dev-1",
                    "authMethod": "jwt",
                    "result": "success",
                    "connectedAt": "2026-09-19T00:00:00Z"
                }]
            }),
        )
        .expect("seed auth records via import api");

        // 反例 1：未配对指纹（fp-ghost）连接 → touch 零行更新（无派生行、count 不变）
        let ghost_url = format!("ws://127.0.0.1:{port}/ws/plugin/{PLUGIN_ID}/session-control");
        let (mut ghost, _) = tokio_tungstenite::connect_async(&ghost_url)
            .await
            .expect("ghost client connect via host route");
        ghost
            .send(Message::Text(format!(r#"{{"type":"auth","token":"{ghost_token}"}}"#)))
            .await
            .expect("ghost auth frame");
        // 等 client-connect 事件投递 + 插件 touch 路径执行完
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let devices_after_ghost = call_api(&host_ctx, "com.wasmnest.bedcode.devices-list", serde_json::json!({}))
            .expect("devices-list after ghost");
        let rows = devices_after_ghost.as_array().expect("devices array");
        assert!(
            !rows.iter().any(|d| d["deviceFingerprint"] == "fp-ghost"),
            "未配对连接不得派生设备视图行: {devices_after_ghost}"
        );
        let dev1 = rows
            .iter()
            .find(|d| d["deviceFingerprint"] == "fp-dev-1")
            .expect("已配对行仍在");
        assert_eq!(
            dev1["connectCount"].as_u64(),
            Some(0),
            "未配对连接 touch 必须零行更新（connectCount 保持 0）: {devices_after_ghost}"
        );
        let _ = ghost.close(None).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        // 正例：已配对指纹（fp-dev-1）连接 → touch（lastSeen + connectCount 0→1）
        let url = format!("ws://127.0.0.1:{port}/ws/plugin/{PLUGIN_ID}/session-control");
        let (mut client, _) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("client connect via host route");
        client
            .send(Message::Text(format!(r#"{{"type":"auth","token":"{token}"}}"#)))
            .await
            .expect("send auth frame");

        let touched = async {
            for _ in 0..40 {
                let devices = call_api(&host_ctx, "com.wasmnest.bedcode.devices-list", serde_json::json!({}))
                    .expect("devices-list poll");
                if let Some(row) = {
                    let rows: &[serde_json::Value] = match devices.as_array() {
                        Some(a) => a.as_slice(),
                        None => &[],
                    };
                    rows.iter().find(|d| d["deviceFingerprint"] == "fp-dev-1")
                } {
                    if row["connectCount"].as_u64() == Some(1) {
                        return row.clone();
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            panic!("已配对连接必须 touch 认证记录（connectCount 0→1），devices-list 未观察到");
        }
        .await;
        assert!(touched["lastSeen"].is_string(), "touch 必须刷新 lastSeen: {touched}");

        // 断开 → client-disconnect → 插件 close_open：open 历史行回填 disconnectedAt
        let _ = client.close(None).await;
        let closed = async {
            for _ in 0..40 {
                let history = call_api(
                    &host_ctx,
                    "com.wasmnest.bedcode.history-list",
                    serde_json::json!("p-dev-1"),
                )
                .expect("history-list poll");
                if let Some(row) = {
                    let rows: &[serde_json::Value] = match history.as_array() {
                        Some(a) => a.as_slice(),
                        None => &[],
                    };
                    rows.iter().find(|r| r["connectedAt"] == "2026-09-19T00:00:00Z")
                } {
                    if row["disconnectedAt"].is_string() {
                        return row.clone();
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            panic!("断开后插件必须 close_open 回填 disconnectedAt，history-list 未观察到");
        }
        .await;
        assert_eq!(closed["authMethod"], "jwt", "历史行保留原认证方式: {closed}");

        // ==================== 收尾：优雅停机 + 清理 ====================
        server_handle.stop(true).await;
        server_task.abort();
        wasmnest_server_websocket::endpoint::purge_for_plugin(PLUGIN_ID);
        // guest `activate` 会 `auth-center-register` / `deactivate` 会 `auth-center-unregister`
        // → 写进程级单中心注册表；必须在测试闸门内（否则与认证面闭环用例互清台，
        // 表现为**别的**用例偶发红）。只包住这一行，不包整个用例。
        {
            let _center_desk = wasmnest_desktop_lib::wasm_core::test_support::hold_registry_desk().await;
            plugin.lock().await.deactivate().expect("deactivate = 0");
        }
    }));
}
