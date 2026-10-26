//! task 域会话闭环：task_domain / http_and_scheduled / rotation 三个 e2e

use super::*;

#[test]

fn test_session_task_domain_closed_loop() {
    let _serial = session_plugin_db_guard();
    const PROBE_SESSION: &str = "probe-task-session";

    let wasm_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.terminal-session/bedcode_plugin_terminal_session.wasm");
    if !wasm_path.exists() {
        eprintln!("[skip] session wasip3 artifact not built");
        return;
    }
    let (wasm_runtime, host_ctx) = setup_wasm_runtime();
    // 本测试不经 PluginHost 激活，权限门所需的 grant 需显式下发（与 manifest 同表）
    // v27（票 10）：`session:write` / `terminal:observe` 已退役，不再授予
    host_ctx.grant_permissions(
        "com.wasmnest.terminal-session",
        &[
            "auth",
            "peer",
            "storage",
            "session:read",
            "storage",
            "broadcast",
            "fs:read",
            "fs:write",
            // 会话引擎下沉 P1-b：业务会话经 host-pty 创建（session.create 走 spawn）
            "pty:spawn",
            "pty:io",
            "terminal:input",
            "timer:schedule",
            "ui:sidebar",
            "ui:settings",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>(),
    );
    host_ctx
        .api_registry()
        .register(
            "com.wasmnest.terminal-session",
            &session_apis().iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .unwrap();

    // 实例化 + 总线分派器（宿主窄转发层的互调回复需经总线路由回插件实例）
    let component = wasm_runtime
        .compile_component(&std::fs::read(&wasm_path).expect("read session artifact"))
        .expect("compile session artifact");
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    rt.block_on(async {
        // v32（ADR 0031）：桥接门查进程级单中心注册表 → 与闭环用例互斥（见 helper）
        let _center_desk = lock_auth_center_desk().await;
        let instances = Arc::new(RwLock::new(HashMap::new()));
        let plugin = Arc::new(Mutex::new(
            wasm_runtime
                .instantiate_component(&component, "com.wasmnest.terminal-session", host_ctx.clone(), &[], None)
                .expect("instantiate session"),
        ));
        instances
            .write()
            .await
            .insert("com.wasmnest.terminal-session".to_string(), Arc::clone(&plugin));
        host_ctx
            .message_bus
            .set_dispatcher(Arc::new(TestInstanceDispatcher {
                instances: Arc::clone(&instances),
            }))
            .await;
        plugin.lock().await.activate().expect("activate");

        // 1. agent 能力清单（wasm 内 registry，纯计算面）
        let out = plugin
            .lock()
            .await
            .invoke_command("session.task.supported-agents", "{}")
            .expect("supported-agents");
        let r: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(r["error"].is_null(), "supported-agents 不得报错, got: {out}");
        let agents = r["agents"].as_array().expect("agents 数组").clone();
        assert!(
            agents.iter().any(|a| a.as_str() == Some("claude")),
            "claude 必须在受支持 agent 名单内, got: {agents:?}"
        );

        // 2. 预设任务真实往返（私有库 task_preset 表）
        let out = plugin
            .lock()
            .await
            .invoke_command("session.task.preset-create", r#"{"prompt":"probe-prompt"}"#)
            .expect("preset-create");
        let r: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(r["error"].is_null(), "preset-create 不得报错, got: {out}");
        let preset_id = r["preset_id"].as_str().expect("preset_id").to_string();
        let out = plugin
            .lock()
            .await
            .invoke_command("session.task.preset-list", "{}")
            .expect("preset-list");
        let r: serde_json::Value = serde_json::from_str(&out).unwrap();
        let presets = r["presets"].as_array().expect("presets 数组").clone();
        assert!(
            presets
                .iter()
                .any(|p| p["id"] == preset_id.as_str() && p["prompt"] == "probe-prompt"),
            "创建的预设必须可由私有库读回且字段一致, got: {presets:?}"
        );

        // 3. 会话开关写入 → 读回（task_session_settings 表，两个开关独立）
        let out = plugin
            .lock()
            .await
            .invoke_command(
                "session.task.set-auto-mode",
                &serde_json::json!({
                    "session_id": PROBE_SESSION,
                    "auto_execute": true,
                    "auto_answer": false
                })
                .to_string(),
            )
            .expect("set-auto-mode");
        let r: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(r["error"].is_null(), "set-auto-mode 不得报错, got: {out}");
        let out = plugin
            .lock()
            .await
            .invoke_command(
                "session.task.session-settings",
                &serde_json::json!({ "session_id": PROBE_SESSION }).to_string(),
            )
            .expect("session-settings");
        let r: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(r["error"].is_null(), "session-settings 不得报错, got: {out}");
        assert_eq!(r["auto_execute"], true, "自动执行开关必须落库, got: {out}");
        assert_eq!(r["auto_answer"], false, "自动应答开关保持关闭, got: {out}");

        // 4. 定时器 tick：三个域步骤都执行（分发表 + 私有库查询可用）
        let out = plugin
            .lock()
            .await
            .invoke_command("session.task.scheduler-tick", r#"{"now_utc":"2026-09-20 00:00:00"}"#)
            .expect("scheduler-tick");
        let r: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(r["error"].is_null(), "scheduler-tick 不得报错, got: {out}");
        assert_eq!(
            r["executed"],
            serde_json::json!([
                "queue-delay-clear",
                "queue-silence-check",
                "queue-retrying-check",
                "scheduled-trigger"
            ]),
            "tick 必须顺序执行队列三域与定时任务域且都成功（票 16 并入第三域；\
             queue-retrying-check 为既有断言修复——2026-09-30 起产品重试域并入 tick，\
             断言未跟上，见 memory 基线红记录）, got: {out}"
        );
        assert!(
            r["failed"].as_array().map(|a| a.is_empty()).unwrap_or(false),
            "tick 无失败域, got: {out}"
        );

        // 5. 未适配 agent（`bash`）→ 不写入任何 agent 集成
        //
        // **v27（票 10）改走生产路径**：原先这里直接喂合成 `Creating` 事件；
        // 回调随 WIT 面退役后，agent 集成注入只发生在 `launch::spawn_session` 内，
        // 故本断言必须经真实 `session.create`（比原形态更贴近生产）。
        let probe_dir = std::env::temp_dir().join(format!("wasmnest-task-probe-{}", std::process::id()));
        std::fs::create_dir_all(&probe_dir).expect("create probe dir");
        let unsupported = seed_config_in_plugin_store(
            &mut *plugin.lock().await,
            "未适配探针",
            &probe_dir.to_string_lossy(),
            "bash",
        )
        .await;
        let unsupported_out = plugin
            .lock()
            .await
            .invoke_command(
                "session.create",
                &serde_json::json!({ "configId": unsupported["id"].as_str().unwrap() }).to_string(),
            )
            .expect("session.create（未适配 agent）");
        let unsupported_created: serde_json::Value = serde_json::from_str(&unsupported_out).unwrap();
        let unsupported_sid = unsupported_created["sessionId"]
            .as_str()
            .expect("未适配会话回执 sessionId")
            .to_string();
        let entries: Vec<String> = std::fs::read_dir(&probe_dir)
            .expect("read probe dir")
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
            .collect();
        assert!(
            entries.is_empty(),
            "未适配 agent 的会话不得写入任何集成文件, got: {entries:?}"
        );
        let _ = std::fs::remove_dir_all(&probe_dir);
        wasmnest_desktop_lib::utils::session_gateway::remove(&host_ctx, &unsupported_sid, None)
            .await
            .expect("remove unsupported session");

        // 6. 状态推进序列（票 15 的对照核心）：受支持 agent 会话收到提交输入 →
        //    任务行 in_progress → 注解槽投影；会话终止 → 兜底中断 interrupted
        //
        // **v27 起本步全程走生产路径**（不再直接调已删除的两个回调）：
        // - 输入经 `session.input`（写 PTY + 提交行重建 + 任务域分发，与本插件
        //   前端键盘输入同一入口）；
        // - 终态经 `session.close`（登记 Stopping + `host-pty.kill` → `pty:exit`
        //   事件 → `session::on_pty_exit` 收尾并兜底中断任务行）。
        // agent 判定读配置真源的 command（含 `claude` 关键词 → 受支持 agent → 建任务行）；
        // 尾部 `exec bash` 让 shell 驻留（命令不存在时 `bash -lic` 会立刻退出，
        // 而本步要经真实 PTY 写入输入——会话必须先活着）
        let config = seed_config_in_plugin_store(
            &mut *plugin.lock().await,
            "任务域探针",
            "/tmp",
            "echo claude && exec bash",
        )
        .await;

        // 经插件命令面创建（launch 编排 → host-pty.spawn → 登记域真源写入）
        let create_out = plugin
            .lock()
            .await
            .invoke_command(
                "session.create",
                &serde_json::json!({"configId": config["id"].as_str().unwrap()}).to_string(),
            )
            .expect("session.create");
        let create: serde_json::Value = serde_json::from_str(&create_out).unwrap();
        let sid = create["sessionId"]
            .as_str()
            .expect("session.create 回执 sessionId")
            .to_string();

        // 提交输入（非命令、非空行、受支持 agent、无在途任务）→ 建任务行
        let input_out = plugin
            .lock()
            .await
            .invoke_command(
                "session.input",
                &serde_json::json!({ "sessionId": sid, "data": "probe task input\n" }).to_string(),
            )
            .expect("session.input");
        let input_reply: serde_json::Value = serde_json::from_str(&input_out).unwrap();
        assert!(
            input_reply["error"].is_null(),
            "session.input 不得报错, got: {input_out}"
        );

        // 注解槽在登记域（读插件视图的任务字段）
        let after_input = wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid)
            .await
            .expect("view");
        assert!(!after_input.is_null(), "会话应在册");

        // 会话结束兜底：运行中任务行与注解槽一并收敛到 interrupted。
        // 终态由 `pty:exit` 异步收尾（kill → 退出监听 → 事件总线 → 插件），
        // 故按**有界轮询**等待（终态事件到达 ≠ 收尾帧已消费，见 P0 记的时序间隙）。
        let close_out = plugin
            .lock()
            .await
            .invoke_command("session.close", &serde_json::json!({ "sessionId": sid }).to_string())
            .expect("session.close");
        let close_reply: serde_json::Value = serde_json::from_str(&close_out).unwrap();
        assert!(
            close_reply["error"].is_null(),
            "session.close 不得报错, got: {close_out}"
        );

        let mut converged: Option<serde_json::Value> = None;
        for _ in 0..100 {
            let v = wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid)
                .await
                .expect("view");
            assert!(!v.is_null(), "会话应在册（不在册 → 轮询终止条件假）");
            if v.get("taskStatus").and_then(|x| x.as_str()) == Some("interrupted") {
                converged = Some(v);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let after_stopped = converged.expect("会话终止后任务状态必须在 5s 内收敛为 interrupted");

        let out = plugin
            .lock()
            .await
            .invoke_command(
                "session.task.get-status",
                &serde_json::json!({ "session_id": sid }).to_string(),
            )
            .expect("get-status");
        let r: serde_json::Value = serde_json::from_str(&out).unwrap();

        assert_eq!(
            after_input["taskStatus"].as_str(),
            Some("in_progress"),
            "提交输入必须把任务状态推进为 in_progress（真源 + 注解槽）, got: {after_input:?}"
        );
        assert_eq!(
            after_input["taskReason"].as_str(),
            Some("User submitted input"),
            "注解槽键名 contract（票 12）：taskReason 由本域写入, got: {after_input:?}"
        );
        assert!(
            after_input["taskUpdatedAt"]
                .as_str()
                .map(|v| !v.is_empty())
                .unwrap_or(false),
            "taskUpdatedAt 必须是非空时间戳, got: {after_input:?}"
        );
        assert_eq!(
            after_stopped["taskStatus"].as_str(),
            Some("interrupted"),
            "会话停止兜底必须把运行中任务收敛为 interrupted, got: {after_stopped:?}"
        );
        assert_eq!(
            r["task_status"],
            serde_json::json!("interrupted"),
            "命令面读到的状态必须与注解槽一致, got: {r}"
        );

        // 清理：经网关移除（杀真实 bash 进程 + 摘记录）
        wasmnest_desktop_lib::utils::session_gateway::remove(&host_ctx, &sid, None)
            .await
            .expect("remove session");

        // 7. 未知任务命令显性报错（命令面快速失败）
        let ghost = plugin
            .lock()
            .await
            .invoke_command("session.task.ghost", "{}")
            .expect("session.task.ghost 返回 JSON");
        let r: serde_json::Value = serde_json::from_str(&ghost).unwrap();
        assert!(
            r["error"]
                .as_str()
                .map(|e| e.contains("Unknown command"))
                .unwrap_or(false),
            "未知任务命令必须返回 error 形状, got: {ghost}"
        );
        plugin.lock().await.deactivate().expect("final deactivate");
    });
}
/// 票 16 任务域 HTTP 面 + 定时任务四态闭环（真实 wasm 产物 + 真实私有库，S1）
///
/// 断言的外部可见结果分两层：
/// - **HTTP 面**：宿主 `_http_endpoint` 的入参形状与旧插件逐字一致（`method` /
///   `path` / `body` / `query`），回包是 `{status, body}`——`path` 段一个都不改
///   （spec D1「基址随插件 id 改、路径段不改」的落地证据）。未声明路径由插件
///   自答 404（宿主侧「声明命中 / 未声明放行」的精确匹配另有纯函数单测）。
/// - **定时任务四态**：`pending →(到期且宽限内) creating →(Created 事件)
///   executed`，以及 `pending →(超过宽限) missed →(reset) pending →(remove) 消失`
///   ——prompts 入队与自动执行开关都从私有库读回验证，不测内部函数。
///
/// 时间基准：插件全部时间判断以宿主注入的 `now_utc` 为准（WASM 无系统时钟），
/// 但私有库的 `created_at` 用 SQLite `datetime('now')`（真实 UTC）——故队列内容
/// 的断言放在「首轮下发兜底」可能被真实时钟判 stale 之前完成。
///
/// 不调用 deactivate（同票 15 用例：停用会写真实用户目录的 hooks 配置）。
#[test]

fn test_session_task_http_and_scheduled_closed_loop() {
    let _serial = session_plugin_db_guard();
    const HTTP_SESSION: &str = "probe-http-session";
    const TRIGGER_AT: &str = "2026-09-20 00:00:00";
    // 超过宽限 → 判 missed（不补跑）
    const NOW_PAST_GRACE: &str = "2026-09-20 01:00:00";

    let wasm_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.terminal-session/bedcode_plugin_terminal_session.wasm");
    if !wasm_path.exists() {
        eprintln!("[skip] session wasip3 artifact not built");
        return;
    }
    let (wasm_runtime, host_ctx) = setup_wasm_runtime();
    // v27（票 10）：清单与真源同步——`session:write` / `terminal:observe` 已退役，
    // 新增 `pty:spawn` / `pty:io`（本用例的 Created 腿改走生产路径 `session.create`，
    // 真实 spawn 一条会话，需要这两位的门禁）。
    host_ctx.grant_permissions(
        "com.wasmnest.terminal-session",
        &[
            "auth",
            "peer",
            "storage",
            "session:read",
            "storage",
            "broadcast",
            "fs:read",
            "fs:write",
            "terminal:input",
            "timer:schedule",
            "ui:sidebar",
            "ui:settings",
            "pty:spawn",
            "pty:io",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>(),
    );
    let mut plugin = wasm_runtime
        .load_plugin_from_file(
            &wasm_path,
            "com.wasmnest.terminal-session",
            Arc::clone(&host_ctx),
            &[],
            None,
        )
        .expect("load wasip3 session");
    assert_eq!(plugin.activate().expect("activate"), 0);

    /// 以客户端形态打一次插件 HTTP 端点（宿主 plugin_controller 构造的同一形状）
    fn http_call(
        plugin: &mut LoadedWasmPlugin,
        method: &str,
        path: &str,
        body: serde_json::Value,
        query: serde_json::Value,
    ) -> serde_json::Value {
        let args = serde_json::json!({
            "method": method,
            "path": path,
            "headers": {},
            "body": body,
            "query": query,
        });
        let out = plugin
            .invoke_command("_http_endpoint", &args.to_string())
            .unwrap_or_else(|e| panic!("_http_endpoint {method} {path} 调用失败: {e}"));
        serde_json::from_str(&out)
            .unwrap_or_else(|e| panic!("_http_endpoint {method} {path} 回包非法 JSON: {e} / {out}"))
    }

    // 1. 声明命中的只读端点 → 200 + 载荷（supported-agents 与旧插件同形状）
    let r = http_call(
        &mut plugin,
        "GET",
        "supported-agents",
        serde_json::Value::Null,
        serde_json::json!({}),
    );
    assert_eq!(r["status"], 200, "supported-agents 必须 200, got: {r}");
    assert!(
        r["body"]["data"]["agents"]
            .as_array()
            .map(|a| a.iter().any(|v| v.as_str() == Some("claude")))
            .unwrap_or(false),
        "agents 载荷必须含 claude, got: {r}"
    );

    // 2. 插件未实现的路径 → 插件自答 404（不是 200 空体，也不是宿主错误）
    let r = http_call(
        &mut plugin,
        "GET",
        "not-a-real-endpoint",
        serde_json::Value::Null,
        serde_json::json!({}),
    );
    assert_eq!(r["status"], 404, "未知道路必须由插件返回 404, got: {r}");

    // 3. 队列 HTTP 往返：add → list 读回同一项（path 段 task-queue/* 与旧插件一致）
    let r = http_call(
        &mut plugin,
        "POST",
        "task-queue/add",
        serde_json::json!({ "session_id": HTTP_SESSION, "prompt": "probe-queue-prompt" }),
        serde_json::json!({}),
    );
    assert_eq!(r["status"], 200, "task-queue/add 必须 200, got: {r}");
    let queue_task_id = r["body"]["data"]["task_id"]
        .as_str()
        .unwrap_or_else(|| panic!("add 回包缺 task_id: {r}"))
        .to_string();
    let r = http_call(
        &mut plugin,
        "GET",
        "task-queue/list",
        serde_json::Value::Null,
        serde_json::json!({ "session_id": HTTP_SESSION }),
    );
    assert_eq!(r["status"], 200, "task-queue/list 必须 200, got: {r}");
    assert!(
        r["body"]["data"]["tasks"]
            .as_array()
            .map(|tasks| tasks.iter().any(|t| t["id"].as_str() == Some(queue_task_id.as_str())))
            .unwrap_or(false),
        "HTTP 入队项必须能从 HTTP 列表读回（同一私有库）, got: {r}"
    );

    // 4. 定时任务：HTTP create → list 可见 pending；配置播种走插件真源
    //    （scheduled → launch spec 的解析链读私有库，见 task/scheduled.rs 模块文档）
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let config_id = rt
        .block_on(async { seed_config_in_plugin_store(&mut plugin, "定时探针", "/tmp", "claude").await })["id"]
        .as_str()
        .unwrap()
        .to_string();

    let r = http_call(
        &mut plugin,
        "POST",
        "scheduled-jobs/create",
        serde_json::json!({
            "name": "probe-job",
            "config_id": config_id,
            "trigger_at": TRIGGER_AT,
            "prompts": ["probe-scheduled-prompt"],
        }),
        serde_json::json!({}),
    );
    assert_eq!(r["status"], 200, "scheduled-jobs/create 必须 200, got: {r}");
    let job_id = r["body"]["data"]["job_id"]
        .as_str()
        .unwrap_or_else(|| panic!("create 回包缺 job_id: {r}"))
        .to_string();

    /// 直接播种/改写 `task_scheduled` 行（外部可见真源），返回 job id
    fn seed_scheduled_job(
        status: &str,
        id: &str,
        config_id: &str,
        trigger_at: &str,
        prompts_json: &str,
        session_id: Option<&str>,
    ) -> String {
        let db_path = plugin_db_root().join("com.wasmnest.terminal-session").join("plugin.db");
        let job_id = if id.is_empty() {
            format!(
                "probe-{}-{}-{}",
                status,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_nanos())
                    .unwrap_or(0)
            )
        } else {
            id.to_string()
        };
        let conn = rusqlite::Connection::open(&db_path)
            .unwrap_or_else(|e| panic!("打开插件私有库失败 {}: {e}", db_path.display()));
        // 插件侧连接可能正在写（同一文件的跨连接竞态）：等锁而不是立刻失败
        let _ = conn.busy_timeout(std::time::Duration::from_secs(10));
        let inserted = conn
            .execute(
                "INSERT OR REPLACE INTO task_scheduled \
                     (id, name, config_id, trigger_at, prompts, status, session_id, executed_at, error, created_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, datetime('now'))",
                rusqlite::params![job_id, "probe", config_id, trigger_at, prompts_json, status, session_id],
            )
            .unwrap_or_else(|e| panic!("播种 task_scheduled 行失败: {e}"));
        assert_eq!(inserted, 1, "播种必须命中一行");
        job_id
    }

    /// 从 HTTP 列表端点取指定 job 行（真源 = 私有库 task_scheduled）
    fn job_row(plugin: &mut LoadedWasmPlugin, job_id: &str) -> serde_json::Value {
        let r = http_call(
            plugin,
            "GET",
            "scheduled-jobs/list",
            serde_json::Value::Null,
            serde_json::json!({}),
        );
        assert_eq!(r["status"], 200, "scheduled-jobs/list 必须 200, got: {r}");
        r["body"]["data"]["jobs"]
            .as_array()
            .and_then(|jobs| jobs.iter().find(|j| j["id"].as_str() == Some(job_id)).cloned())
            .unwrap_or_else(|| panic!("列表中找不到 job {job_id}: {r}"))
    }

    let job = job_row(&mut plugin, &job_id);
    assert_eq!(job["status"], "pending", "新建定时任务必须是 pending, got: {job}");
    assert_eq!(job["config_id"], config_id.as_str(), "config_id 原样落库, got: {job}");

    // 5. creating → executed（Created 逻辑驱动的入队腿）
    //
    // **v27（票 10）改走生产路径**：原形态直接喂合成 `Created` 事件（理由是宿主
    // `host-session.create-with-spec` 在无头 harness 里要经全局 AppContext 回灌）。
    // 回调随 WIT 面退役后，Created 逻辑只存在于 `launch::spawn_session`
    // （`session.create` 与 `session.action.restart` 都走它），故本步改为：
    //   ① 真实创建一条会话拿 sid；
    //   ② 把 creating 态 job 的 `session_id` 播成该 sid（真源同一行，不造第二份事实）；
    //   ③ `session.action.restart` 触发同 id 重建 → 跑 Created 逻辑 → job 归档 executed。
    // 「pending → creating」这一腿仍由生产路径与人工回归清单覆盖（tick 的创建腿需要
    // 真实会话创建，理由同上）。
    let scheduled_session_id = format!("probe-scheduled-{}", std::process::id());
    let create_out = plugin
        .invoke_command(
            "session.create",
            &serde_json::json!({ "configId": config_id }).to_string(),
        )
        .expect("session.create（定时探针会话）");
    let created: serde_json::Value = serde_json::from_str(&create_out).unwrap();
    assert!(created["error"].is_null(), "session.create 不得报错, got: {create_out}");
    let scheduled_session_id = created["sessionId"]
        .as_str()
        .expect("session.create 回执 sessionId")
        .to_string();

    seed_scheduled_job(
        "creating",
        &job_id,
        &config_id,
        TRIGGER_AT,
        r#"["probe-scheduled-prompt"]"#,
        Some(&scheduled_session_id),
    );
    let job = job_row(&mut plugin, &job_id);
    assert_eq!(job["status"], "creating", "播种的 creating 行必须可读, got: {job}");

    // 同 id 重启：`spawn_session` 的 Created 逻辑即本步要走的路径
    let restart_out = plugin
        .invoke_command(
            "session.action.restart",
            &serde_json::json!({ "sessionId": scheduled_session_id }).to_string(),
        )
        .expect("session.action.restart");
    let restart: serde_json::Value = serde_json::from_str(&restart_out).unwrap();
    assert!(
        restart["error"].is_null(),
        "session.action.restart 不得报错, got: {restart_out}"
    );
    let job = job_row(&mut plugin, &job_id);
    assert_eq!(
        job["status"], "executed",
        "Created 逻辑跑完后必须归档 executed, got: {job}"
    );

    let r = http_call(
        &mut plugin,
        "GET",
        "task-queue/list",
        serde_json::Value::Null,
        serde_json::json!({ "session_id": scheduled_session_id }),
    );
    assert!(
        r["body"]["data"]["tasks"]
            .as_array()
            .map(|tasks| !tasks.is_empty() && tasks.iter().all(|t| t["source"].as_str() == Some("scheduled")))
            .unwrap_or(false),
        "定时 prompts 必须以 source='scheduled' 入队, got: {r}"
    );
    let r = http_call(
        &mut plugin,
        "GET",
        "session-settings",
        serde_json::Value::Null,
        serde_json::json!({ "session_id": scheduled_session_id }),
    );
    assert_eq!(
        r["body"]["data"]["auto_execute"],
        serde_json::json!(true),
        "定时任务语义要求无人值守：入队即打开自动执行, got: {r}"
    );

    // 6. creating 卡死兑底：超过宽限仍在 creating 的行（宿主创建失败、事件永不到达）
    //    → tick 标 failed 并带原因
    let stuck_job_id = seed_scheduled_job(
        "creating",
        "",
        &config_id,
        TRIGGER_AT,
        r#"["probe-stuck-prompt"]"#,
        Some("probe-stuck-session"),
    );
    let out = plugin
        .invoke_command(
            "session.task.scheduler-tick",
            &serde_json::json!({ "now_utc": NOW_PAST_GRACE }).to_string(),
        )
        .expect("tick for stuck job");
    let r: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(
        r["failed"].as_array().map(|a| a.is_empty()).unwrap_or(false),
        "tick 不得有失败域（定时域内某一步失败也只降级本域，D7）, got: {out}"
    );
    let job = job_row(&mut plugin, &stuck_job_id);
    assert_eq!(job["status"], "failed", "creating 超宽限必须兑底为 failed, got: {job}");
    assert!(
        job["error"]
            .as_str()
            .map(|e| e.contains("Session creation timed out"))
            .unwrap_or(false),
        "failed 必须带创建超时原因, got: {job}"
    );

    // 7. missed 路径：新建 job 与上面同触发时刻，本轮 now 已超宽限 → missed（不补跑）
    let r = http_call(
        &mut plugin,
        "POST",
        "scheduled-jobs/create",
        serde_json::json!({
            "config_id": config_id,
            "trigger_at": TRIGGER_AT,
            "prompts": ["probe-late-prompt"],
        }),
        serde_json::json!({}),
    );
    let late_job_id = r["body"]["data"]["job_id"].as_str().expect("job_id").to_string();
    let out = plugin
        .invoke_command(
            "session.task.scheduler-tick",
            &serde_json::json!({ "now_utc": NOW_PAST_GRACE }).to_string(),
        )
        .expect("tick past grace");
    let r: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(r["error"].is_null(), "tick 不得整体失败, got: {out}");
    let job = job_row(&mut plugin, &late_job_id);
    assert_eq!(
        job["status"], "missed",
        "超过宽限期未执行必须判 missed（不补跑）, got: {job}"
    );
    assert!(
        job["error"]
            .as_str()
            .map(|e| e.contains("app was not running"))
            .unwrap_or(false),
        "missed 必须带原因文本, got: {job}"
    );

    // 8. reset → 回 pending（可改触发时间）；remove → 从清单消失
    let r = http_call(
        &mut plugin,
        "POST",
        "scheduled-jobs/reset",
        serde_json::json!({ "job_id": late_job_id, "trigger_at": "2026-12-31 00:00:00" }),
        serde_json::json!({}),
    );
    assert_eq!(r["status"], 200, "reset 必须 200, got: {r}");
    let job = job_row(&mut plugin, &late_job_id);
    assert_eq!(job["status"], "pending", "reset 后回 pending, got: {job}");
    assert_eq!(
        job["trigger_at"], "2026-12-31 00:00:00",
        "reset 可改触发时间, got: {job}"
    );

    let r = http_call(
        &mut plugin,
        "DELETE",
        "scheduled-jobs/remove",
        serde_json::json!({ "job_id": late_job_id }),
        serde_json::json!({}),
    );
    assert_eq!(r["status"], 200, "remove 必须 200, got: {r}");
    let r = http_call(
        &mut plugin,
        "GET",
        "scheduled-jobs/list",
        serde_json::Value::Null,
        serde_json::json!({}),
    );
    let jobs = r["body"]["data"]["jobs"].as_array().expect("jobs 数组");
    assert!(
        jobs.iter().all(|j| j["id"].as_str() != Some(late_job_id.as_str())),
        "删除后不得再出现在清单里, got: {jobs:?}"
    );

    // 9. 命令面与 HTTP 面同源：同一私有库读回同一条 job
    let out = plugin
        .invoke_command("session.task.scheduled-list", "{}")
        .expect("scheduled-list");
    let r: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(
        r["jobs"]
            .as_array()
            .map(|jobs| jobs.iter().any(|j| j["id"].as_str() == Some(job_id.as_str())))
            .unwrap_or(false),
        "命令面与 HTTP 面必须读同一份真源, got: {r}"
    );

    // 10. 参数非法显性报错（HTTP 与命令面都不得静默吞掉）
    let r = http_call(
        &mut plugin,
        "POST",
        "scheduled-jobs/create",
        serde_json::json!({ "config_id": "", "trigger_at": "", "prompts": [] }),
        serde_json::json!({}),
    );
    assert_eq!(r["status"], 400, "缺参数必须 400, got: {r}");
    let out = plugin
        .invoke_command("session.task.scheduled-delete", "{}")
        .expect("scheduled-delete 返回 JSON");
    let r: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(
        r["error"]
            .as_str()
            .map(|e| e.contains("missing job_id"))
            .unwrap_or(false),
        "命令面缺参数必须显性报错, got: {out}"
    );
}

/// 任务轮换闭环（票：任务终态后不再发 clear/new，关闭旧会话 + 同配置新建）
///
/// 真实 PTY 多会话链路，验证「自动任务中一个任务执行完毕 → 关闭上一个执行完的
/// 会话 → 创建新会话执行下一个任务」的完整编排与 **session_id 传递逻辑**：
///
/// 1. `session.create`（command 含 `claude` → agent=claude → 走轮换）→ sid1；
/// 2. 入队 T1/T2/T3 + 开自动执行 → 首任务直接下发（全新会话，executing）；
/// 3. 模拟 T1 completed（hook 推送形态：`wasmnest_session_id`=sid1）→ 轮换：
///    - sid1 关闭（有界轮询收敛 stopped）；
///    - sid2 创建（**同一 config_id**）；
///    - 队列迁移：sid1 队列空、sid2 的 active_task = T2(waiting)；
///    - session flags（auto_execute）复制到 sid2；
/// 4. 模拟 sid2 的 agent SessionStart idle → on_session_idle 下发 T2（executing）；
/// 5. T2 completed → 再次轮换（sid3）→ T3 迁移 waiting——证明链路可连续重复；
///
/// 轮换失败路径（新会话创建失败回退 pending）由插件 native 单测覆盖（无宿主依赖）。
#[test]
fn test_session_task_rotation_closed_loop() {
    // 会话插件私有库是进程级共享路径：与其它会话闭环用例串行（见锁文档）
    let _serial = session_plugin_db_guard();

    let wasm_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.terminal-session/bedcode_plugin_terminal_session.wasm");
    if !wasm_path.exists() {
        eprintln!("[skip] session wasip3 artifact not built");
        return;
    }
    let (wasm_runtime, host_ctx) = setup_wasm_runtime();
    host_ctx.grant_permissions(
        "com.wasmnest.terminal-session",
        &[
            "auth",
            "peer",
            "storage",
            "session:read",
            "broadcast",
            "fs:read",
            "fs:write",
            "terminal:input",
            "timer:schedule",
            "ui:sidebar",
            "ui:settings",
            "pty:spawn",
            "pty:io",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>(),
    );
    host_ctx
        .api_registry()
        .register(
            "com.wasmnest.terminal-session",
            &session_apis().iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .unwrap();

    let component = wasm_runtime
        .compile_component(&std::fs::read(&wasm_path).expect("read session artifact"))
        .expect("compile session artifact");
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    rt.block_on(async {
        // v32（ADR 0031）：桥接门查进程级单中心注册表 → 与闭环用例互斥（见 helper）
        let _center_desk = lock_auth_center_desk().await;
        let instances = Arc::new(RwLock::new(HashMap::new()));
        let plugin = Arc::new(Mutex::new(
            wasm_runtime
                .instantiate_component(&component, "com.wasmnest.terminal-session", host_ctx.clone(), &[], None)
                .expect("instantiate session"),
        ));
        instances
            .write()
            .await
            .insert("com.wasmnest.terminal-session".to_string(), Arc::clone(&plugin));
        host_ctx
            .message_bus
            .set_dispatcher(Arc::new(TestInstanceDispatcher {
                instances: Arc::clone(&instances),
            }))
            .await;
        plugin.lock().await.activate().expect("activate");

        /// 以客户端形态打一次插件 HTTP 端点（宿主 plugin_controller 构造的同一形状）
        async fn http_call(
            plugin: &Arc<Mutex<LoadedWasmPlugin>>,
            method: &str,
            path: &str,
            body: serde_json::Value,
            query: serde_json::Value,
        ) -> serde_json::Value {
            let args = serde_json::json!({
                "method": method,
                "path": path,
                "headers": {},
                "body": body,
                "query": query,
            });
            let out = plugin
                .lock()
                .await
                .invoke_command("_http_endpoint", &args.to_string())
                .unwrap_or_else(|e| panic!("_http_endpoint {method} {path} 调用失败: {e}"));
            serde_json::from_str(&out)
                .unwrap_or_else(|e| panic!("_http_endpoint {method} {path} 回包非法 JSON: {e} / {out}"))
        }

        /// 会话列表 → 找到「运行中且非给定 sid」的新会话（轮换新建的那条）
        async fn running_session_other_than(
            plugin: &Arc<Mutex<LoadedWasmPlugin>>,
            exclude: &str,
            config_id: &str,
        ) -> String {
            for _ in 0..100 {
                let out = plugin
                    .lock()
                    .await
                    .invoke_command("session.list", "{}")
                    .expect("session.list");
                let sessions: serde_json::Value = serde_json::from_str(&out).unwrap();
                if let Some(found) = sessions["sessions"]
                    .as_array()
                    .and_then(|arr| {
                        arr.iter().find(|s| {
                            s["id"].as_str() != Some(exclude)
                                && s["configId"].as_str() == Some(config_id)
                                && s["status"].as_str() == Some("running")
                        })
                    })
                    .and_then(|s| s["id"].as_str().map(str::to_string))
                {
                    return found;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            panic!("5s 内未找到轮换新建的运行会话（config_id={config_id}, exclude={exclude}）");
        }

        /// 有界轮询：会话收敛到 stopped
        async fn wait_stopped(plugin: &Arc<Mutex<LoadedWasmPlugin>>, sid: &str) {
            for _ in 0..100 {
                let out = plugin
                    .lock()
                    .await
                    .invoke_command("session.list", "{}")
                    .expect("session.list");
                let sessions: serde_json::Value = serde_json::from_str(&out).unwrap();
                let stopped = sessions["sessions"].as_array().map(|arr| {
                    arr.iter()
                        .find(|s| s["id"].as_str() == Some(sid))
                        .map(|s| s["status"].as_str() == Some("stopped"))
                        .unwrap_or(false)
                });
                if stopped == Some(true) {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            panic!("5s 内会话 {sid} 未收敛为 stopped");
        }

        // 1. 播种配置（command 含 claude → agent=claude → profile 带 clear_command → 轮换）
        let probe_dir = std::env::temp_dir().join(format!("wasmnest-task-rotate-{}", std::process::id()));
        std::fs::create_dir_all(&probe_dir).expect("create probe dir");
        let config = seed_config_in_plugin_store(
            &mut *plugin.lock().await,
            "轮换探针",
            &probe_dir.to_string_lossy(),
            "echo claude && exec bash",
        )
        .await;
        let config_id = config["id"].as_str().unwrap().to_string();

        // 2. 创建 sid1（真实 PTY）
        let create_out = plugin
            .lock()
            .await
            .invoke_command(
                "session.create",
                &serde_json::json!({ "configId": config_id }).to_string(),
            )
            .expect("session.create");
        let created: serde_json::Value = serde_json::from_str(&create_out).unwrap();
        assert!(created["error"].is_null(), "session.create 不得报错, got: {create_out}");
        let sid1 = created["sessionId"].as_str().expect("sessionId").to_string();

        // 2.5 播种一条 executed 定时任务档案关联 sid1（验证轮换时关联迁移——
        //     队列清空时最终会话仍能被无人值守关闭）
        let db_path = plugin_db_root().join("com.wasmnest.terminal-session").join("plugin.db");
        {
            let conn = rusqlite::Connection::open(&db_path)
                .unwrap_or_else(|e| panic!("打开插件私有库失败 {}: {e}", db_path.display()));
            let _ = conn.busy_timeout(std::time::Duration::from_secs(10));
            conn.execute(
                "INSERT OR REPLACE INTO task_scheduled \
                 (id, name, config_id, trigger_at, prompts, status, session_id, executed_at, error, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 'executed', ?6, NULL, NULL, datetime('now'))",
                rusqlite::params![
                    "rotate-job",
                    "rotate-probe",
                    config_id,
                    "2026-09-20 00:00:00",
                    r#"["rotate-scheduled-prompt"]"#,
                    sid1
                ],
            )
            .expect("seed executed scheduled job");
        }

        // 3. 入队 T1/T2/T3 + 开自动执行 → 首任务直接下发（全新会话，无终态上下文）
        let mut task_ids = Vec::new();
        for prompt in ["rotate-task-1", "rotate-task-2", "rotate-task-3"] {
            let r = http_call(
                &plugin,
                "POST",
                "task-queue/add",
                serde_json::json!({ "session_id": sid1, "prompt": prompt }),
                serde_json::json!({}),
            )
            .await;
            assert_eq!(r["status"], 200, "task-queue/add 必须 200, got: {r}");
            let task_id = r["body"]["data"]["task_id"]
                .as_str()
                .unwrap_or_else(|| panic!("add 回包缺 task_id: {r}"))
                .to_string();
            task_ids.push(task_id);
        }
        let t1 = task_ids[0].clone();
        let t2 = task_ids[1].clone();
        let t3 = task_ids[2].clone();

        let out = plugin
            .lock()
            .await
            .invoke_command(
                "session.task.set-auto-mode",
                &serde_json::json!({ "session_id": sid1, "auto_execute": true }).to_string(),
            )
            .expect("set-auto-mode");
        let r: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(r["error"].is_null(), "set-auto-mode 不得报错, got: {out}");
        // 全新会话 → T1 直接下发为 executing
        let r = http_call(
            &plugin,
            "GET",
            "task-queue/list",
            serde_json::Value::Null,
            serde_json::json!({ "session_id": sid1 }),
        )
        .await;
        assert_eq!(
            r["body"]["data"]["active_task"]["id"],
            serde_json::json!(t1),
            "全新会话首任务必须直接下发（executing）, got: {r}"
        );
        assert_eq!(
            r["body"]["data"]["active_task"]["status"],
            serde_json::json!("executing"),
            "首任务必须 executing, got: {r}"
        );

        // 4. 模拟 T1 completed（hook 推送形态：wasmnest_session_id = sid1）→ 轮换
        let r = http_call(
            &plugin,
            "POST",
            "task-status",
            serde_json::json!({
                "session_id": "claude-session-rotate-1",
                "wasmnest_session_id": sid1,
                "status": "completed",
                "reason": "rotate probe task 1 done",
            }),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(r["status"], 200, "task-status completed 必须 200, got: {r}");

        // 轮换结果：sid1 队列迁空、sid2 创建（同 config）、T2 迁移为 waiting、开关复制
        let sid2 = running_session_other_than(&plugin, &sid1, &config_id).await;
        wait_stopped(&plugin, &sid1).await;
        let r = http_call(
            &plugin,
            "GET",
            "task-queue/list",
            serde_json::Value::Null,
            serde_json::json!({ "session_id": sid1 }),
        )
        .await;
        assert!(
            r["body"]["data"]["tasks"]
                .as_array()
                .map(|a| a.is_empty())
                .unwrap_or(false),
            "轮换后旧会话队列必须已迁移（sid1 无 pending）, got: {r}"
        );
        assert!(
            r["body"]["data"]["active_task"].is_null(),
            "轮换后旧会话不得残留 active 队列项, got: {r}"
        );
        let r = http_call(
            &plugin,
            "GET",
            "task-queue/list",
            serde_json::Value::Null,
            serde_json::json!({ "session_id": sid2 }),
        )
        .await;
        assert_eq!(
            r["body"]["data"]["active_task"]["id"],
            serde_json::json!(t2),
            "T2 必须迁移到新会话并进入 waiting, got: {r}"
        );
        assert_eq!(
            r["body"]["data"]["active_task"]["status"],
            serde_json::json!("waiting"),
            "T2 必须为 waiting（等待新会话就绪）, got: {r}"
        );
        // session flags 随会话复制（新会话保持自动执行语义）
        let r = http_call(
            &plugin,
            "GET",
            "session-settings",
            serde_json::Value::Null,
            serde_json::json!({ "session_id": sid2 }),
        )
        .await;
        assert_eq!(
            r["body"]["data"]["auto_execute"],
            serde_json::json!(true),
            "新会话必须继承 auto_execute, got: {r}"
        );
        // 定时任务档案关联随轮换迁移（最终会话在队列清空时仍被无人值守关闭）
        let r = http_call(
            &plugin,
            "GET",
            "scheduled-jobs/list",
            serde_json::Value::Null,
            serde_json::json!({}),
        )
        .await;
        let rotated_job = r["body"]["data"]["jobs"]
            .as_array()
            .and_then(|jobs| jobs.iter().find(|j| j["id"].as_str() == Some("rotate-job")).cloned())
            .unwrap_or_else(|| panic!("列表中找不到 rotate-job, got: {r}"));
        assert_eq!(
            rotated_job["session_id"],
            serde_json::json!(sid2),
            "executed 档案的 session_id 必须随轮换迁移到新会话, got: {rotated_job}"
        );

        // 5. 模拟 sid2 的 agent SessionStart idle → on_session_idle 下发 T2
        let r = http_call(
            &plugin,
            "POST",
            "task-status",
            serde_json::json!({
                "session_id": "claude-session-rotate-2",
                "wasmnest_session_id": sid2,
                "status": "idle",
                "reason": "Session started",
            }),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(r["status"], 200, "task-status idle 必须 200, got: {r}");
        let r = http_call(
            &plugin,
            "GET",
            "task-queue/list",
            serde_json::Value::Null,
            serde_json::json!({ "session_id": sid2 }),
        )
        .await;
        assert_eq!(
            r["body"]["data"]["active_task"]["id"],
            serde_json::json!(t2),
            "idle 后 T2 必须仍为 active, got: {r}"
        );
        assert_eq!(
            r["body"]["data"]["active_task"]["status"],
            serde_json::json!("executing"),
            "新会话 idle 到达后 T2 必须已下发（executing）, got: {r}"
        );

        // 6. T2 completed → 再次轮换（链路可连续重复）→ T3 迁移 waiting
        let r = http_call(
            &plugin,
            "POST",
            "task-status",
            serde_json::json!({
                "session_id": "claude-session-rotate-2",
                "wasmnest_session_id": sid2,
                "status": "completed",
                "reason": "rotate probe task 2 done",
            }),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(r["status"], 200, "task-status completed(2) 必须 200, got: {r}");
        let sid3 = running_session_other_than(&plugin, &sid2, &config_id).await;
        wait_stopped(&plugin, &sid2).await;
        let r = http_call(
            &plugin,
            "GET",
            "task-queue/list",
            serde_json::Value::Null,
            serde_json::json!({ "session_id": sid3 }),
        )
        .await;
        assert_eq!(
            r["body"]["data"]["active_task"]["id"],
            serde_json::json!(t3),
            "第二轮换后 T3 必须迁移到 sid3, got: {r}"
        );
        assert_eq!(
            r["body"]["data"]["active_task"]["status"],
            serde_json::json!("waiting"),
            "T3 必须为 waiting, got: {r}"
        );

        // 7. 宽限兑底下发（opencode 等无 idle 信号 agent 的路径）：
        //    把 T3 的 waiting 行改成「第 3 次尝试已过期」（dispatch_attempts=3、
        //    updated_at 30s 前），触发一次 try_dispatch_next（经无行的 completed
        //    推送 → 终态门）→ 宽限耗尽后直接下发，**不取消**，且不会因队列为
        //    空而关闭仍在执行任务的会话
        {
            let conn = rusqlite::Connection::open(&db_path)
                .unwrap_or_else(|e| panic!("打开插件私有库失败 {}: {e}", db_path.display()));
            let _ = conn.busy_timeout(std::time::Duration::from_secs(10));
            let affected = conn
                .execute(
                    "UPDATE task_queue SET dispatch_attempts = 3, \
                     updated_at = datetime('now', '-30 seconds') \
                     WHERE id = ?1 AND session_id = ?2 AND status = 'waiting'",
                    rusqlite::params![t3, sid3],
                )
                .expect("seed stale waiting row");
            assert_eq!(affected, 1, "T3 必须处于 waiting 且被种子命中");
        }
        let r = http_call(
            &plugin,
            "POST",
            "task-status",
            serde_json::json!({
                "session_id": "claude-session-rotate-3",
                "wasmnest_session_id": sid3,
                "status": "completed",
                "reason": "no-row trigger for grace dispatch",
            }),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(r["status"], 200, "task-status 必须 200, got: {r}");
        let r = http_call(
            &plugin,
            "GET",
            "task-queue/list",
            serde_json::Value::Null,
            serde_json::json!({ "session_id": sid3 }),
        )
        .await;
        assert_eq!(
            r["body"]["data"]["active_task"]["id"],
            serde_json::json!(t3),
            "宽限耗尽后 T3 必须直接下发（executing，不取消）, got: {r}"
        );
        assert_eq!(
            r["body"]["data"]["active_task"]["status"],
            serde_json::json!("executing"),
            "宽限耗尽后 T3 必须 executing, got: {r}"
        );
        // 队列为空但有 executing 在途：不得触发定时会话关闭（见 try_dispatch_next
        // 的 empty-queue 守卫）——sid3 必须仍在运行
        let out = plugin
            .lock()
            .await
            .invoke_command("session.list", "{}")
            .expect("session.list");
        let sessions: serde_json::Value = serde_json::from_str(&out).unwrap();
        let sid3_status = sessions["sessions"]
            .as_array()
            .and_then(|arr| arr.iter().find(|s| s["id"].as_str() == Some(sid3.as_str())))
            .and_then(|s| s["status"].as_str().map(str::to_string));
        assert_eq!(
            sid3_status.as_deref(),
            Some("running"),
            "宽限下发后会话不得被空队列守卫关闭（T3 仍在执行）, got: {sessions}"
        );

        // 清理：摘除最终会话（杀真实 bash 进程）与临时工作目录
        wasmnest_desktop_lib::utils::session_gateway::remove(&host_ctx, &sid3, None)
            .await
            .expect("remove final session");
        let _ = std::fs::remove_dir_all(&probe_dir);
    });
}
