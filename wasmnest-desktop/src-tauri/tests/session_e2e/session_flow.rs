//! 会话流闭环：create_with_spec / actions / annotate_devices / filetransfer 四个 e2e

use super::*;

/// 票 09 真实 wasm 闭环：真实会话中心产物 + 真实 `host-session`
/// `create-with-spec` 原语 + 真实插件私有库真源——「创建编排经插件」从
/// 命名唯一化到会话落库的完整链路（S1 已知缺口补：session 域成功路径）。
///
/// 流程：桥接播种配置（真源 + 投影）→ 激活会话中心 → 桥接编排创建
/// （`start=false`，不 spawn 进程无残留）→ 异步等待会话落库 → 断言命名
/// 唯一化（同配置第二次 → `(1)` 后缀）→ 降级（注销互调面 → 桥接返回 None）。
#[test]

fn test_session_create_with_spec_closed_loop() {
    // 会话插件私有库是进程级共享路径：与其它会话闭环用例串行（见锁文档）
    let _serial = session_plugin_db_guard();
    const SESSION_ID: &str = "com.wasmnest.terminal-session";
    let wasm_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.terminal-session/bedcode_plugin_terminal_session.wasm");
    if !wasm_path.exists() {
        eprintln!("[skip] session wasip3 artifact not built");
        return;
    }

    let (wasm_runtime, host_ctx) = setup_wasm_runtime();
    // 独立私有库根目录：进程级 `plugin_db_root()` 被 wasm_runtime::tests 内
    // 多个并行测试共享（各自 remove_dir_all + 写同一 SQLite 文件 → BUSY/缺失），
    // 本测试对私有库只读真源（不测迁移），用独立目录消除并行文件竞争。
    let mut host_ctx = host_ctx;
    if let Some(ctx) = Arc::get_mut(&mut host_ctx) {
        ctx.set_plugin_db_root(Some(std::env::temp_dir().join(format!(
                    "wasmnest_plugin_dbs_spec_{}_{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                ))));
    }
    let _ = std::fs::remove_dir_all(plugin_db_root().join(SESSION_ID));
    let component = wasm_runtime
        .compile_component(&std::fs::read(&wasm_path).expect("read session artifact"))
        .expect("compile session artifact");

    host_ctx.grant_permissions(
        SESSION_ID,
        &[
            "auth".to_string(),
            "peer".to_string(),
            "storage".to_string(),
            "session:read".to_string(),
            // 票 09：host-session.create-with-spec（创建编排执行端）
            // 会话引擎下沉 P1-b：业务会话改走 host-pty 原语
            "pty:spawn".to_string(),
            "pty:io".to_string(),
            "storage".to_string(),
        ],
    );
    host_ctx
        .api_registry()
        .register(
            SESSION_ID,
            &session_apis().iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .unwrap();

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        // v32（ADR 0031）：桥接门查进程级单中心注册表 → 与闭环用例互斥（见 helper）
        let _center_desk = lock_auth_center_desk().await;
        // ==================== 1. 激活会话中心（配置面 v21 起插件必需） ====================
        let instances = Arc::new(RwLock::new(HashMap::new()));
        let session = Arc::new(Mutex::new(
            wasm_runtime
                .instantiate_component(&component, SESSION_ID, host_ctx.clone(), &[], None)
                .expect("instantiate session"),
        ));
        instances.write().await.insert(SESSION_ID.to_string(), session.clone());
        host_ctx
            .message_bus
            .set_dispatcher(Arc::new(TestInstanceDispatcher {
                instances: Arc::clone(&instances),
            }))
            .await;
        session.lock().await.activate().expect("activate session");

        // ==================== 2. 播种配置（插件真源；激活后必经） ====================
        let seeded = seed_config_in_plugin_store(&mut *session.lock().await, "编排会话", "/tmp", "bash").await;

        // ==================== 3. 编排创建（P1-b：插件自产 id + host-pty.spawn，同步完成） ====================
        // 不再有 start=false 双态：host-pty 无 create-without-spawn，创建即启动真实进程
        //（bash，cwd=/tmp 存在）；回执即会话 id，无需轮询宿主落库。
        let sid1 = session_id_of(
            wasmnest_desktop_lib::utils::session_gateway::start(
                &host_ctx,
                &seeded["id"].as_str().unwrap(),
                None,
                None,
                true,
                None,
            )
            .await
            .expect("plugin active → 必须编排成功"),
            "创建 sid1",
        );
        assert_eq!(sid1.len(), 36, "插件自产 UUID; got: {sid1}");
        let v1 = wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid1)
            .await
            .expect("view");
        assert!(!v1.is_null(), "会话应在册");
        assert_eq!(v1["status"], serde_json::json!("running"), "P1-b 创建即启动 → Running");
        assert_eq!(
            v1["name"],
            serde_json::json!("编排会话"),
            "命名唯一化首见 = 原名（插件决策）"
        );
        assert_eq!(
            v1["configId"],
            serde_json::json!(seeded["id"].as_str().unwrap()),
            "configId 透传（会话记录标真源配置）"
        );
        assert!(v1.get("startedAt").is_some(), "创建即启动 → startedAt 已填");
        // 真源切换验收：**宿主内核会话表已不存在**（票 11 随 `session/` 目录删除），
        // 故此处不再有「查一下宿主有没有登记」的运行时断言——该事实现在由结构性锁
        // `retired_kernel_session_domain_is_not_reintroduced`（wasm_flow_test）保证。

        // ==================== 4. 命名唯一化：同配置第二次 → 原名(1) ====================
        let sid2 = session_id_of(
            wasmnest_desktop_lib::utils::session_gateway::start(
                &host_ctx,
                &seeded["id"].as_str().unwrap(),
                None,
                None,
                true,
                None,
            )
            .await
            .expect("plugin active → 必须编排成功"),
            "创建 sid2",
        );
        let v2 = wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid2)
            .await
            .expect("view");
        assert!(!v2.is_null(), "会话应在册");
        assert_eq!(
            v2["name"],
            serde_json::json!("编排会话(1)"),
            "重名冲突 → 插件改写为 (1) 后缀"
        );
        assert_eq!(v2["configId"], serde_json::json!(seeded["id"].as_str().unwrap()));

        // ============ 4b. P1-b 真源：插件会话登记域（宿主窄转发层改读本域） ============
        // 经 `session.status` 诊断字段观测登记规模
        let status: serde_json::Value = {
            let mut plugin = session.lock().await;
            let raw = plugin
                .invoke_command("session.status", "{}")
                .expect("session.status command");
            serde_json::from_str(&raw).expect("session.status json")
        };
        assert_eq!(
            status["sessionRegistry"]["count"], 2,
            "两次创建都应进入插件登记域: {status}"
        );
        assert_eq!(
            status["sessionRegistry"]["active"], 2,
            "Running 两会话都算活跃: {status}"
        );

        // ============ 4c. 宿主窄转发层读取面对齐锁：网关视图 == 插件登记域视图 ============
        // 注解槽经插件自己的 annotate api 写（真源在本域），任务字段随网关视图透传
        let call_api = wasmnest_desktop_lib::wasm_core::intercall::call_api;
        call_api(
            &host_ctx,
            "com.wasmnest.terminal-session.annotate",
            serde_json::json!({ "sessionId": sid1, "key": "taskStatus", "value": "asking" }),
        )
        .expect("annotate 互调成功");
        call_api(
            &host_ctx,
            "com.wasmnest.terminal-session.annotate",
            serde_json::json!({
                "sessionId": sid1,
                "key": "taskQuestions",
                "value": r#"[{"question":"继续吗？"}]"#,
            }),
        )
        .expect("annotate questions 互调成功");

        let listed = call_api(
            &host_ctx,
            "com.wasmnest.terminal-session.session-list",
            serde_json::json!({}),
        )
        .expect("session-list 互调成功");
        let sessions = listed["sessions"].as_array().expect("sessions 数组");
        assert_eq!(sessions.len(), 2, "登记域两条会话: {listed}");

        // 网关列表（宿主窄转发层消费面）与登记域视图逐字段一致：宿主零解析，
        // 网关 reply 原样透传 → 与插件登记域视图 JSON 逐字节同值（忠实投影）
        let gateway_reply = wasmnest_desktop_lib::utils::session_gateway::list_views(&host_ctx)
            .await
            .expect("gateway list");
        let gateway_sessions = gateway_reply["sessions"].as_array().expect("网关 reply sessions 数组");
        assert_eq!(gateway_sessions, sessions, "网关透传 = 登记域视图（忠实投影）");

        // 关窗守卫专用查询（`session-list {filter:"running"}`，2026-09-25 下沉）：
        // 「哪些状态算运行中需确认」判据在插件会话域，宿主无状态集合;
        // 当前两会话均为 Running → 全量返回，与全量列表同源同位。
        let running_reply = wasmnest_desktop_lib::utils::session_gateway::running_views(&host_ctx)
            .await
            .expect("gateway running list");
        let running_arr = running_reply["sessions"]
            .as_array()
            .expect("running reply sessions 数组");
        let mut running_ids: Vec<&str> = running_arr.iter().filter_map(|v| v["id"].as_str()).collect();
        running_ids.sort_unstable();
        let mut expected_running = vec![sid1.as_str(), sid2.as_str()];
        expected_running.sort_unstable();
        assert_eq!(
            running_ids, expected_running,
            "Running 两会话都应出现在 running_views（filter=running 透传判据）"
        );

        let gw_by_id: std::collections::HashMap<String, &serde_json::Value> = gateway_sessions
            .iter()
            .map(|v| (v["id"].as_str().expect("视图含 id").to_string(), v))
            .collect();
        let raw1 = sessions.iter().find(|s| s["id"] == sid1).expect("登记域含 sid1");
        assert_eq!(raw1["id"], serde_json::json!(sid1));
        assert_eq!(raw1["name"], serde_json::json!("编排会话"));
        assert_eq!(raw1["configId"], serde_json::json!(seeded["id"].as_str().unwrap()));
        assert_eq!(raw1["status"], serde_json::json!("running"), "wire 形态与插件视图一致");
        // 网关视图行与登记域视图同值（宿主窄转发层 = 插件登记域的忠实投影）
        let gw1 = gw_by_id.get(&sid1).expect("网关视图含 sid1");
        assert_eq!(gw1["name"], serde_json::json!("编排会话"));
        assert_eq!(gw1["taskStatus"].as_str(), Some("asking"), "任务字段随网关视图透传");
        assert_eq!(
            gw1["taskQuestions"],
            serde_json::json!([{"question": "继续吗？"}]),
            "taskQuestions 透传为数组"
        );

        // 单条读面与列表同源；未知 id → null（不是报错，调用方按「无此会话」分类）
        let one = call_api(
            &host_ctx,
            "com.wasmnest.terminal-session.session-get",
            serde_json::json!({ "sessionId": sid1 }),
        )
        .expect("session-get 互调成功");
        assert_eq!(one["name"], "编排会话", "与列表项同值: {one}");
        let ghost = call_api(
            &host_ctx,
            "com.wasmnest.terminal-session.session-get",
            serde_json::json!({ "sessionId": "no-such-session" }),
        )
        .expect("session-get 未知 id 不报错");
        assert!(ghost.is_null(), "未知会话 → null, got: {ghost}");
        let bad_get = call_api(
            &host_ctx,
            "com.wasmnest.terminal-session.session-get",
            serde_json::json!({}),
        );
        assert!(bad_get.is_err(), "缺 sessionId 必须显性报错，不静默当空串");

        // 清理：经网关移除两条会话（杀真实 bash 进程 + 摘记录），再停用插件
        wasmnest_desktop_lib::utils::session_gateway::remove(&host_ctx, &sid1, None)
            .await
            .expect("remove s1");
        wasmnest_desktop_lib::utils::session_gateway::remove(&host_ctx, &sid2, None)
            .await
            .expect("remove s2");
        assert!(
            wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid1)
                .await
                .expect("view")
                .is_null(),
            "移除后视图为空"
        );
        // filter=running 不残留幽灵：移除后 running_views 必须为空
        let running_after = wasmnest_desktop_lib::utils::session_gateway::running_views(&host_ctx)
            .await
            .expect("running list post-removal");
        assert_eq!(
            running_after["sessions"].as_array().map(|a| a.len()),
            Some(0),
            "移除后无运行中会话（filter=running 不残留已移除记录）: {running_after:?}"
        );

        // ==================== 5. 插件必需：注销互调面 → 显性报错（无宿主降级） ====================
        // v32（ADR 0031 K7）后「插件不可用」是**两道独立的门**，报错随之分岔：
        // - 桥接门（`session_active()` 查认证中心注册表）：无中心在册 → "session plugin not active"；
        // - 互调门（api-call gate 查声明面）：中心在册但声明面已注销 → "not declared by any
        //   activated plugin (gate)"（点名 api）。
        // 本步注销的是**互调面** → 断言第二道门；第一道门由 host 侧闭环用例
        // （`host/tests/system_component_test.rs`，走 `registry_gate()` 串行）覆盖。
        host_ctx.api_registry().unregister(SESSION_ID);
        let err = wasmnest_desktop_lib::utils::session_gateway::start(
            &host_ctx,
            &seeded["id"].as_str().unwrap(),
            None,
            None,
            true,
            None,
        )
        .await
        .expect_err("插件不可用 → 必须显性报错（host-business-decarriage 收尾：降级轨已删）");
        let text = err.to_string();
        assert!(
            text.contains("not declared by any activated plugin") && text.contains("session-create"),
            "互调面注销后必须由 api-call gate 显性报错并点名 api, got: {err}"
        );

        session.lock().await.deactivate().expect("final deactivate");
    });
}

/// 票 10 真实 wasm 闭环（P1-b：真源切换后动作全在插件登记域 + host-pty）：
/// 真实会话中心产物走**产品路径**（宿主窄转发层 → 插件互调 → 登记域 / host-pty）
/// 一遍，断言外部可见结果（P1-b 起无内核登记可对照，回归断言改为插件视图）：
///
/// 1. 播种配置 → 创建会话（P1-b 创建即启动真实 bash，cwd=/tmp）
/// 2. **改名**：经插件互调 api 改名 + 回执原名 + 未知会话显性错
/// 3. **尺寸裁决四态**（规则与登记事实都在插件登记域，宿主窄转发层统一走
///    `session-resize`）：无渲染端 → applied；单端 → applied（无确认）；
///    多端争用 → needsConfirmation（行为可观察：原归属者随后 resize 仍直通）；
///    force → applied 且归属移交（被抢占者可观察到 needsConfirmation）
/// 4. **重启**：同一 id 重建并启动（真实 bash），名字 / configId 保持、状态回到
///    Running、正统端回到启动端（重启后归属者可直通 resize）
/// 5. **移除**：记录消失（插件视图 gone）
/// 6. **插件必需**：注销互调面 → 宿主窄转发层显性报错（无降级轨）
#[test]
fn test_session_actions_closed_loop() {
    // 会话插件私有库是进程级共享路径：与其它会话闭环用例串行（见锁文档）
    let _serial = session_plugin_db_guard();
    // 请求方身份 JSON（形状契约在插件 `session-resize` 入参；宿主零解释，2026-09-25）
    let desktop = || serde_json::json!({ "kind": "desktop" });
    let mobile = || serde_json::json!({ "kind": "mobile", "deviceName": "Pixel-9" });

    const SESSION_ID: &str = "com.wasmnest.terminal-session";
    let wasm_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.terminal-session/bedcode_plugin_terminal_session.wasm");
    if !wasm_path.exists() {
        eprintln!("[skip] session wasip3 artifact not built");
        return;
    }

    let (wasm_runtime, host_ctx) = setup_wasm_runtime();
    // 独立私有库根目录：进程级 `plugin_db_root()` 被本模块多个并行测试共享
    // （各自 remove_dir_all + 写同一 SQLite 文件 → BUSY/缺失），见票 09 同款处置
    let mut host_ctx = host_ctx;
    if let Some(ctx) = Arc::get_mut(&mut host_ctx) {
        ctx.set_plugin_db_root(Some(std::env::temp_dir().join(format!(
                "wasmnest_plugin_dbs_actions_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ))));
    }
    let _ = std::fs::remove_dir_all(plugin_db_root().join(SESSION_ID));

    let component = wasm_runtime
        .compile_component(&std::fs::read(&wasm_path).expect("read session artifact"))
        .expect("compile session artifact");

    host_ctx.grant_permissions(
        SESSION_ID,
        &[
            "auth".to_string(),
            "peer".to_string(),
            "storage".to_string(),
            "session:read".to_string(),
            // 会话引擎下沉 P1-b：业务会话改走 host-pty 原语
            "pty:spawn".to_string(),
            "pty:io".to_string(),
            "storage".to_string(),
        ],
    );
    host_ctx
        .api_registry()
        .register(
            SESSION_ID,
            &session_apis().iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .unwrap();

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        // v32（ADR 0031）：桥接门查进程级单中心注册表 → 与闭环用例互斥（见 helper）
        let _center_desk = lock_auth_center_desk().await;
        let instances = Arc::new(RwLock::new(HashMap::new()));
        let session = Arc::new(Mutex::new(
            wasm_runtime
                .instantiate_component(&component, SESSION_ID, host_ctx.clone(), &[], None)
                .expect("instantiate session"),
        ));
        instances.write().await.insert(SESSION_ID.to_string(), session.clone());
        host_ctx
            .message_bus
            .set_dispatcher(Arc::new(TestInstanceDispatcher {
                instances: Arc::clone(&instances),
            }))
            .await;
        session.lock().await.activate().expect("activate session");

        // ==================== 1. 播种配置 + 创建会话（P1-b 创建即启动真实 bash） ====================
        // working_dir /tmp 必须存在（真实 spawn）；无正统端归属 = 裁决态 1 起点
        let seeded = seed_config_in_plugin_store(&mut *session.lock().await, "动作会话", "/tmp", "bash").await;
        let sid = session_id_of(
            wasmnest_desktop_lib::utils::session_gateway::start(
                &host_ctx,
                &seeded["id"].as_str().unwrap(),
                None,
                None,
                true,
                None,
            )
            .await
            .expect("plugin active → 必须编排成功"),
            "创建",
        );
        let v = wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid)
            .await
            .expect("view");
        assert!(!v.is_null(), "会话应在册");
        assert_eq!(v["name"], serde_json::json!("动作会话"));
        assert_eq!(v["id"], serde_json::json!(sid));
        assert_eq!(v["status"], serde_json::json!("running"), "创建即启动 → Running");

        // ==================== 2. 改名（插件互调 api；真源 = 登记域记录） ====================
        let renamed = wasmnest_desktop_lib::wasm_core::intercall::call_api(
            &host_ctx,
            "com.wasmnest.terminal-session.session-rename",
            serde_json::json!({ "sessionId": sid, "name": "重命名后" }),
        )
        .expect("rename 互调成功");
        assert_eq!(renamed["previousName"], "动作会话", "回执改名前的名字");
        let v = wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid)
            .await
            .expect("view");
        assert!(!v.is_null(), "会话应在册");
        assert_eq!(v["name"], serde_json::json!("重命名后"));

        // 未知会话：显性失败（插件侧存在性预检同步可见）
        let missing = wasmnest_desktop_lib::wasm_core::intercall::call_api(
            &host_ctx,
            "com.wasmnest.terminal-session.session-rename",
            serde_json::json!({ "sessionId": "ghost-session", "name": "x" }),
        );
        assert!(missing.is_err(), "未知会话改名必须显性报错");

        // ==================== 3. 尺寸裁决四态（规则与登记事实都在插件登记域） ====================
        // 态 1 无渲染端 → 首个请求方即位正统（Desktop）
        let applied = wasmnest_desktop_lib::utils::session_gateway::resize(&host_ctx, &sid, 100, 30, desktop(), false)
            .await
            .expect("resize");
        assert_eq!(
            applied,
            serde_json::json!({ "status": "applied", "canonical": { "kind": "desktop" } }),
            "无渲染端 → applied(Desktop), got: {applied:?}"
        );

        // 态 2 单端（归属 = 请求方）→ 直接应用，无确认
        let applied = wasmnest_desktop_lib::utils::session_gateway::resize(&host_ctx, &sid, 110, 32, desktop(), false)
            .await
            .expect("resize again");
        assert_eq!(
            applied["status"],
            serde_json::json!("applied"),
            "单端 → applied, got: {applied:?}"
        );

        // 态 3 多端争用（归属 Desktop；移动端未 force）→ needsConfirmation 且零改动
        // （零改动的行为断言：随后 Desktop resize 依然直通——归属未被抢占）
        let outcome = wasmnest_desktop_lib::utils::session_gateway::resize(&host_ctx, &sid, 80, 24, mobile(), false)
            .await
            .expect("resize contended");
        assert_eq!(
            outcome,
            serde_json::json!({
                "status": "needsConfirmation",
                "currentCanonical": { "kind": "desktop" }
            }),
            "多端争用 → 需覆盖确认（回执当前正统端）"
        );
        let still_owner =
            wasmnest_desktop_lib::utils::session_gateway::resize(&host_ctx, &sid, 90, 30, desktop(), false)
                .await
                .expect("original owner resize");
        assert_eq!(
            still_owner["status"],
            serde_json::json!("applied"),
            "需确认路径必须零改动（归属仍是 Desktop，可直通）"
        );

        // 态 4 端接管（force = 覆盖确认通过）→ 应用并移交归属；
        // 移交后原归属者（Desktop）成为被抢占方 → 未 force 需确认
        let outcome = wasmnest_desktop_lib::utils::session_gateway::resize(&host_ctx, &sid, 80, 24, mobile(), true)
            .await
            .expect("resize takeover");
        assert_eq!(
            outcome,
            serde_json::json!({
                "status": "applied",
                "canonical": { "kind": "mobile", "deviceName": "Pixel-9" }
            }),
            "force → 应用并移交归属"
        );
        let displaced = wasmnest_desktop_lib::utils::session_gateway::resize(&host_ctx, &sid, 90, 30, desktop(), false)
            .await
            .expect("displaced resize");
        assert_eq!(
            displaced,
            serde_json::json!({
                "status": "needsConfirmation",
                "currentCanonical": { "kind": "mobile", "deviceName": "Pixel-9" }
            }),
            "归属移交后原归属者被抢占（需确认）"
        );

        // ==================== 4. 重启（同一 id 重建并启动）+ 完成信号 ====================
        // P1-b：重启全同步（摘记录 → 杀旧 pty → 同 id spawn → 重登记），回执即完成；
        // 完成信号 = 插件视图回到 Running（名字/configId 保持）
        let restarted = wasmnest_desktop_lib::wasm_core::intercall::call_api(
            &host_ctx,
            "com.wasmnest.terminal-session.session-restart",
            serde_json::json!({ "sessionId": sid }),
        )
        .expect("restart 互调成功");
        assert_eq!(restarted["sessionId"], sid, "重启保持同一 session id");
        let v = wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid)
            .await
            .expect("view");
        assert!(!v.is_null(), "重启后在册");
        assert_eq!(v["status"], serde_json::json!("running"), "重启后 Running");
        assert_eq!(v["name"], serde_json::json!("重命名后"), "重启保持名字（不做二次命名）");
        assert_eq!(
            v["configId"],
            serde_json::json!(seeded["id"].as_str().unwrap()),
            "重启保持 configId"
        );
        // 正统端回到启动端（Desktop）：重启后 Desktop resize 直通
        let owner_again =
            wasmnest_desktop_lib::utils::session_gateway::resize(&host_ctx, &sid, 95, 35, desktop(), false)
                .await
                .expect("resize after restart");
        assert_eq!(
            owner_again["status"],
            serde_json::json!("applied"),
            "重启归属回到启动端（Desktop 可直通）"
        );

        // ==================== 5. 移除 ====================
        wasmnest_desktop_lib::utils::session_gateway::remove(&host_ctx, &sid, None)
            .await
            .expect("remove");
        assert!(
            wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid)
                .await
                .expect("view")
                .is_null(),
            "会话记录必须消失"
        );

        // ==================== 6. 插件必需：注销互调面 → 宿主窄转发层显性报错 ====================
        // 两道门分岔同步骤 5（ADR 0031 K7）：此处注销互调面 → api-call gate 拒
        host_ctx.api_registry().unregister(SESSION_ID);
        let err = wasmnest_desktop_lib::utils::session_gateway::remove(&host_ctx, &sid, None)
            .await
            .expect_err("插件不可用 → 必须显性报错（无宿主降级轨）");
        let text = err.to_string();
        assert!(
            text.contains("not declared by any activated plugin") && text.contains("session-remove"),
            "互调面注销后必须由 api-call gate 显性报错并点名 api, got: {err}"
        );

        session.lock().await.deactivate().expect("final deactivate");
    });
}

/// 票 11 真实 wasm 闭环：真实会话中心产物 + 真实 `host-session` 新原语
/// （注解槽写入 `annotate` / 连接清单 `connections-list` / 会话列表 `annotations`
/// 透传）经**产品路径**走一遍，断言外部可见结果（spec S1 闭环矩阵：annotate
/// 透传、connections-list 属主隔离）：
///
/// 1. 播种配置 → 编排创建「只创建不启动」会话（无进程）
/// 2. `session.annotate` 命令经真实组件写注解槽 → 宿主槽可见原样透传；
///    **expand 期双写**：旧任务字段保持 None（wire DTO 形状不变）；
///    同一命令对 ghost 会话显性报错（存在性校验跨 wasm 边界生效）
/// 3. `session.devices.connect-list` 命令（真实组件内调真实原语）：无头上下文
///    连接注册表为空 → `{connections: []}`（形状恒定；connections-list +
///    trusted-devices-list + session-list 三原语在 guest 内完整走通），并对照
///    宿主事实面（连接注册表）为空
#[test]

fn test_session_annotate_and_devices_closed_loop() {
    // 会话插件私有库是进程级共享路径：与其它会话闭环用例串行（见锁文档）
    let _serial = session_plugin_db_guard();
    const SESSION_ID: &str = "com.wasmnest.terminal-session";
    let wasm_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.terminal-session/bedcode_plugin_terminal_session.wasm");
    if !wasm_path.exists() {
        eprintln!("[skip] session wasip3 artifact not built");
        return;
    }

    let (wasm_runtime, host_ctx) = setup_wasm_runtime();
    // 独立私有库根目录：进程级 `plugin_db_root()` 被本模块多个并行测试共享
    // （各自 remove_dir_all + 写同一 SQLite 文件 → BUSY/缺失），见票 09 同款处置
    let mut host_ctx = host_ctx;
    if let Some(ctx) = Arc::get_mut(&mut host_ctx) {
        ctx.set_plugin_db_root(Some(std::env::temp_dir().join(format!(
                "wasmnest_plugin_dbs_annotate_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ))));
    }
    let _ = std::fs::remove_dir_all(plugin_db_root().join(SESSION_ID));

    let component = wasm_runtime
        .compile_component(&std::fs::read(&wasm_path).expect("read session artifact"))
        .expect("compile session artifact");

    host_ctx.grant_permissions(
        SESSION_ID,
        &[
            "auth".to_string(),
            "peer".to_string(),
            "storage".to_string(),
            "session:read".to_string(),
            // 票 04：devices.connect-list 读连接清单走 `host-connection`，判据
            // `connection:read`（缺它即 permission denied —— fail-visible，不静默降级）
            "connection:read".to_string(),
            // 会话引擎下沉 P1-b：业务会话改走 host-pty 原语
            "pty:spawn".to_string(),
            "pty:io".to_string(),
            "storage".to_string(),
        ],
    );
    host_ctx
        .api_registry()
        .register(
            SESSION_ID,
            &session_apis().iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .unwrap();

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        // v32（ADR 0031）：桥接门查进程级单中心注册表 → 与闭环用例互斥（见 helper）
        let _center_desk = lock_auth_center_desk().await;
        let instances = Arc::new(RwLock::new(HashMap::new()));
        let session = Arc::new(Mutex::new(
            wasm_runtime
                .instantiate_component(&component, SESSION_ID, host_ctx.clone(), &[], None)
                .expect("instantiate session"),
        ));
        instances.write().await.insert(SESSION_ID.to_string(), session.clone());
        host_ctx
            .message_bus
            .set_dispatcher(Arc::new(TestInstanceDispatcher {
                instances: Arc::clone(&instances),
            }))
            .await;
        session.lock().await.activate().expect("activate session");

        // ==================== 1. 播种配置 + 创建会话（不启动，无进程） ====================
        let seeded = seed_config_in_plugin_store(&mut *session.lock().await, "注解会话", "/tmp", "bash").await;

        // ==================== 1. 播种配置 + 创建会话（P1-b 创建即启动真实 bash） ====================
        let seeded = seed_config_in_plugin_store(&mut *session.lock().await, "注解会话", "/tmp", "bash").await;

        let sid = session_id_of(
            wasmnest_desktop_lib::utils::session_gateway::start(
                &host_ctx,
                &seeded["id"].as_str().unwrap(),
                None,
                None,
                true,
                None,
            )
            .await
            .expect("plugin active → 必须编排成功"),
            "创建",
        );
        // P1-b 创建同步完成：回执即已登记（无需轮询宿主落库）
        assert!(
            !wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid)
                .await
                .expect("view")
                .is_null(),
            "session {sid} 创建回执后即在册"
        );

        // ==================== 2. annotate：真实组件写注解槽（真源 = 登记域） ====================
        let r = session
            .lock()
            .await
            .invoke_command(
                "session.annotate",
                &serde_json::json!({
                    "sessionId": sid,
                    "key": "taskStatus",
                    "value": "asking",
                })
                .to_string(),
            )
            .expect("annotate command");
        let r: serde_json::Value = serde_json::from_str(&r).unwrap();
        assert_eq!(r["ok"], true, "annotate 命令成功, got: {r}");
        session
            .lock()
            .await
            .invoke_command(
                "session.annotate",
                &serde_json::json!({
                    "sessionId": sid,
                    "key": "taskReason",
                    "value": "等待用户答复",
                })
                .to_string(),
            )
            .expect("annotate reason");

        // 透传断言：guest 写入 → 登记域槽原样（键名语义归本插件，视图随槽透出）
        let v = wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid)
            .await
            .expect("view");
        assert!(!v.is_null(), "会话应在册");
        assert_eq!(v["taskStatus"].as_str(), Some("asking"), "槽值经对外视图透出");
        assert_eq!(v["taskReason"].as_str(), Some("等待用户答复"));
        assert_eq!(
            v["taskStatus"],
            serde_json::json!("asking"),
            "wire 字段名不变（前端 / 移动端契约）"
        );
        // 宿主内核会话表（含其注解槽）已不存在（票 11），真源切换由结构性锁保证
        // （`retired_kernel_session_domain_is_not_reintroduced`）

        // 未知会话跨 wasm 边界显性报错：登记域存在性校验（插件侧同步可见）
        let ghost = session
            .lock()
            .await
            .invoke_command(
                "session.annotate",
                &serde_json::json!({"sessionId": "ghost", "key": "k", "value": "v"}).to_string(),
            )
            .expect("ghost annotate returns json");
        let r: serde_json::Value = serde_json::from_str(&ghost).unwrap();
        assert!(r["error"].as_str().is_some(), "未知会话必须显性报错, got: {ghost}");
        assert!(
            wasmnest_desktop_lib::wasm_core::intercall::call_api(
                &host_ctx,
                "com.wasmnest.terminal-session.session-get",
                serde_json::json!({ "sessionId": "ghost" }),
            )
            .expect("session-get")
            .is_null(),
            "绝不写孤儿键（ghost 无记录）"
        );

        // ==================== 3. devices.connect-list：真实组件内真实原语 ====================
        let view = session
            .lock()
            .await
            .invoke_command("session.devices.connect-list", "{}")
            .expect("devices connect list command");
        let v: serde_json::Value = serde_json::from_str(&view).unwrap();
        assert!(
            v.get("error").is_none(),
            "连接清单命令不得报错（无头上下文注册表为空）, got: {view}"
        );
        assert_eq!(
            v["connections"],
            serde_json::json!([]),
            "无头上下文 → 空连接清单（形状恒定）"
        );

        // 宿主命令面只回引擎事实（连接注册表原始记录），派生视图归插件
        assert_eq!(
            wasmnest_server_websocket::WebSocketManager::global()
                .list_clients()
                .await
                .len(),
            0,
            "无头上下文连接注册表为空 → 宿主事实面为空"
        );

        // 清理：经网关移除（杀真实 bash 进程 + 摘记录）
        wasmnest_desktop_lib::utils::session_gateway::remove(&host_ctx, &sid, None)
            .await
            .expect("remove session");
        session.lock().await.deactivate().expect("final deactivate");
    });
}

/// 票 10 互调闭环（票 05 改指会话中心）：真实 file-transfer 产物消费真实会话中心
/// 产物 ——consent 两阶段流（阶段 1 信任预检 / 阶段 2 用户意向）与统一信任视图
/// 均经总线互调；并在 wire 层捕获断言 file-transfer 发出的 JSON-RPC 请求
/// 形状（requestId / nodeId / userDecision 映射正确），证明改指生效。
///
/// 约束：无头上下文 host-peer 不可用（require_app 失败）——
/// - consent-decide 返回 ask（fail-closed）；accept/deny 决策后的宿主应答
///   以错误形状（headless）透出，恰证「决策已应用到宿主应答路径」
/// - trust-list 经会话中心视图（peerError 透出）错误形状
/// 降级路径（会话中心不可用）：respond-consent / list-trusted 直答宿主
/// （与迁移前行为等价，双轨无单点）。决策本身的正确性由
/// `test_session_trust_and_consent_api_closed_loop` 覆盖，本测试聚焦消费方
/// wire 契约与降级。产物缺失时跳过。
#[test]

fn test_filetransfer_consumes_session_center_closed_loop() {
    // 同一份会话中心私有库：与其余会话闭环用例串行（见 session_plugin_db_guard 文档）
    let _serial = session_plugin_db_guard();
    use wasmnest_desktop_lib::utils::auth::auth_center as bridge;

    const FT_ID: &str = "com.wasmnest.file-transfer";
    const NODE: &str = "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344";
    let session_id = bridge::SESSION_PLUGIN_ID;
    let decide_topic = format!("wasmnest.api.{session_id}.consent-decide");
    let list_topic = format!("wasmnest.api.{session_id}.trust-list");

    let ft_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.file-transfer/wasmnest_plugin_file_transfer.wasm");
    let center_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.terminal-session/bedcode_plugin_terminal_session.wasm");
    if !ft_path.exists() || !center_path.exists() {
        eprintln!("[skip] file-transfer / session wasip3 artifacts not built");
        return;
    }
    let (wasm_runtime, host_ctx) = setup_wasm_runtime();
    // 端事实（平台 = desktop）：file-transfer 共享产物在**激活期**经
    // `host-platform.platform()` 探测端值——未注入则返回契约外 "unknown"（激活失败）。
    // 生产同款实现在 `PluginHost::new` 装配时注入（本用例自建运行时，需自行注入）。
    host_ctx.set_host_facts(Arc::new(wasmnest_desktop_lib::plugin::host_facts::DesktopHostFacts));
    let ft_component = wasm_runtime
        .compile_component(&std::fs::read(&ft_path).expect("read file-transfer artifact"))
        .expect("compile file-transfer artifact");
    let center_component = wasm_runtime
        .compile_component(&std::fs::read(&center_path).expect("read session artifact"))
        .expect("compile session artifact");

    // 授权路径等价 PluginHost 装载（manifest permissions 登记）：
    // - 会话中心声明 auth/peer（auth 含记录面；peer 供 consent 取可信集）
    // - file-transfer 声明 peer（宿主应答/降级直查路径需权限门放行）
    host_ctx.grant_permissions(
        session_id,
        &["auth".to_string(), "peer".to_string(), "storage".to_string()],
    );
    host_ctx.grant_permissions(FT_ID, &["peer".to_string(), "storage".to_string()]);
    let center_apis = session_apis();
    host_ctx
        .api_registry()
        .register(
            session_id,
            &center_apis.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .unwrap();

    // wire 捕获（静态订阅，与会话中心的 wasm 订阅共存 fan-out）
    let captures: Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>> = Arc::new(std::sync::Mutex::new(Vec::new()));

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        // v32（ADR 0031）：桥接门查进程级单中心注册表 → 与闭环用例互斥（见 helper）
        let _center_desk = lock_auth_center_desk().await;
        host_ctx
            .message_bus
            .subscribe_static(
                "capture",
                &decide_topic,
                Box::new(AuthCenterCaptureHandler {
                    captures: Arc::clone(&captures),
                }),
            )
            .await;
        host_ctx
            .message_bus
            .subscribe_static(
                "capture",
                &list_topic,
                Box::new(AuthCenterCaptureHandler {
                    captures: Arc::clone(&captures),
                }),
            )
            .await;

        let filetransfer = Arc::new(Mutex::new(
            wasm_runtime
                .instantiate_component(&ft_component, FT_ID, host_ctx.clone(), &[], None)
                .expect("instantiate file-transfer"),
        ));
        let center = Arc::new(Mutex::new(
            wasm_runtime
                .instantiate_component(&center_component, session_id, host_ctx.clone(), &[], None)
                .expect("instantiate session"),
        ));

        let instances = Arc::new(RwLock::new(HashMap::from([
            (FT_ID.to_string(), filetransfer.clone()),
            (session_id.to_string(), center.clone()),
        ])));
        host_ctx
            .message_bus
            .set_dispatcher(Arc::new(TestInstanceDispatcher { instances }))
            .await;

        center.lock().await.activate().expect("session activate");
        filetransfer.lock().await.activate().expect("file-transfer activate");

        // 等待捕获数（线程安全轮询；事件/互调均异步派发）
        async fn wait_captures(
            captures: &Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>>,
            topic: &str,
            n: usize,
        ) {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
            loop {
                let count = {
                    let c = captures.lock().expect("capture lock");
                    c.iter().filter(|(t, _)| t == topic).count()
                };
                if count >= n {
                    return;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "timeout waiting for {n} captures on '{topic}' (got {count})"
                );
                tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            }
        }
        async fn decide_count(
            captures: &Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>>,
            topic: &str,
        ) -> usize {
            let c = captures.lock().expect("capture lock");
            c.iter().filter(|(t, _)| t == topic).count()
        }

        // ==================== consent：阶段 1 信任预检 ====================
        // 发布 peer:consent（宿主引擎事件桥语义）→ file-transfer 经
        // auth.decide-consent（无 userDecision）预检信任
        host_ctx.message_bus.publish(
            "peer:consent",
            "test-host",
            serde_json::json!({
                "requestId": "req-c1",
                "nodeId": NODE,
                "fingerprintShort": &NODE[..8],
                "deviceName": "消费方测试对端",
            }),
        );
        wait_captures(&captures, &decide_topic, 1).await;
        {
            let c = captures.lock().expect("capture lock");
            let (_, req) = c.iter().find(|(t, _)| t == &decide_topic).unwrap();
            // 阶段 1：无用户意向（仅对端信息），requestId/nodeId 沿事件桥原样
            assert!(
                req["params"].get("userDecision").is_none(),
                "阶段 1 不得携带用户意向, got: {}",
                req["params"]
            );
            assert_eq!(req["params"]["requestId"], "req-c1");
            assert_eq!(req["params"]["nodeId"], NODE);
            assert_eq!(req["params"]["deviceName"], "消费方测试对端");
        }

        // ==================== consent：阶段 2 用户接受 ====================
        // 回传 accepted=true → auth.decide-consent userDecision=accept →
        // 决策 accept → 应答宿主（无头上下文 headless 错误透出——恰证决策
        // 被应用到宿主应答路径，而非静默丢弃）
        let result = filetransfer
            .lock()
            .await
            .invoke_command(
                "file-transfer.respond-consent",
                r#"{"requestId":"req-c1","accepted":true}"#,
            )
            .expect("respond-consent accept");
        let r: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(
            r["error"]
                .as_str()
                .map(|e| e.contains("unavailable") || e.contains("headless"))
                .unwrap_or(false),
            "accept 决策后应答宿主（无头上下文报错透出）, got: {result}"
        );
        wait_captures(&captures, &decide_topic, 2).await;
        {
            let c = captures.lock().expect("capture lock");
            let (_, req) = c.iter().filter(|(t, _)| t == &decide_topic).last().unwrap();
            assert_eq!(
                req["params"]["userDecision"], "accept",
                "阶段 2 必须携带 userDecision=accept, got: {}",
                req["params"]
            );
            assert_eq!(req["params"]["requestId"], "req-c1");
            assert_eq!(req["params"]["nodeId"], NODE, "对端信息沿事件桥登记传递");
        }

        // ==================== consent：阶段 2 用户拒绝 ====================
        host_ctx.message_bus.publish(
            "peer:consent",
            "test-host",
            serde_json::json!({
                "requestId": "req-c2",
                "nodeId": NODE,
                "fingerprintShort": &NODE[..8],
            }),
        );
        wait_captures(&captures, &decide_topic, 3).await; // req-c2 阶段 1
        let result = filetransfer
            .lock()
            .await
            .invoke_command(
                "file-transfer.respond-consent",
                r#"{"requestId":"req-c2","accepted":false}"#,
            )
            .expect("respond-consent deny");
        let r: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(
            r["error"]
                .as_str()
                .map(|e| e.contains("unavailable") || e.contains("headless"))
                .unwrap_or(false),
            "deny 决策后应答宿主（无头上下文报错透出）, got: {result}"
        );
        wait_captures(&captures, &decide_topic, 4).await;
        {
            let c = captures.lock().expect("capture lock");
            let (_, req) = c.iter().filter(|(t, _)| t == &decide_topic).last().unwrap();
            assert_eq!(
                req["params"]["userDecision"], "deny",
                "accepted=false 映射 userDecision=deny, got: {}",
                req["params"]
            );
        }

        // ==================== 降级：认证中心不可用（门禁拒绝） ====================
        // 注销会话中心声明 → 互调请求被门禁拦下。无登记请求（未发布
        // peer:consent）的迟到应答 → file-transfer 直答宿主（迁移前行为
        // 等价，双轨无单点），不发起任何互调。
        // （阶段 1 降级弹窗的编排路径由插件 native 单测
        // phase1_auth_center_down_falls_back_to_ask 覆盖——闭环聚焦可确定的
        // wire 断言，避免异步派发时序竞态。）
        host_ctx.api_registry().unregister(session_id);
        let result = filetransfer
            .lock()
            .await
            .invoke_command(
                "file-transfer.respond-consent",
                r#"{"requestId":"req-unknown","accepted":true}"#,
            )
            .expect("respond-consent degraded");
        let r: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(
            r["error"]
                .as_str()
                .map(|e| e.contains("unavailable") || e.contains("headless"))
                .unwrap_or(false),
            "降级直答宿主（无头上下文报错透出）, got: {result}"
        );
        assert_eq!(
            decide_count(&captures, &decide_topic).await,
            4,
            "认证中心不可用：不得发出版互调请求（门禁拦下 / 无登记直答）"
        );

        // ==================== 信任列表：经认证中心统一视图 ====================
        host_ctx
            .api_registry()
            .register(
                session_id,
                &center_apis.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            )
            .unwrap();
        let result = filetransfer
            .lock()
            .await
            .invoke_command("file-transfer.list-trusted", "{}")
            .expect("list-trusted");
        wait_captures(&captures, &list_topic, 1).await;
        {
            let c = captures.lock().expect("capture lock");
            let (_, req) = c.iter().find(|(t, _)| t == &list_topic).unwrap();
            assert_eq!(req["method"], "trust-list");
        }
        let r: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(
            r["error"]
                .as_str()
                .map(|e| e.contains("unavailable") || e.contains("headless"))
                .unwrap_or(false),
            "认证中心 peerError 透出（不静默空列表）, got: {result}"
        );

        // ==================== 撤销：维持宿主原语（语义不变） ====================
        let result = filetransfer
            .lock()
            .await
            .invoke_command("file-transfer.revoke-trusted", &format!(r#"{{"nodeId":"{NODE}"}}"#))
            .expect("revoke-trusted");
        let r: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(
            r["error"]
                .as_str()
                .map(|e| e.contains("unavailable") || e.contains("headless"))
                .unwrap_or(false),
            "revoke 宿主原语（无头上下文报错透出）, got: {result}"
        );
        assert_eq!(
            decide_count(&captures, &decide_topic).await,
            4,
            "revoke 不走互调（无声明 api）"
        );

        center.lock().await.deactivate().expect("session deactivate");
        filetransfer
            .lock()
            .await
            .deactivate()
            .expect("file-transfer deactivate");
    });
}
