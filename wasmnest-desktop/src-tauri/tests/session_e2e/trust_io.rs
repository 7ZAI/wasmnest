//! 信任/端点/IO 闭环：artifact_lifecycle / trust_and_consent / business_endpoints / output_ring / input_gateway 五个 e2e

use super::*;

#[test]

fn test_session_plugin_artifact_lifecycle() {
    // 同一份会话中心私有库（与全部会话闭环用例共用进程级根）：持串行锁
    let _serial = session_plugin_db_guard();
    // 认证中心注册表是**进程级单中心**：本用例的 guest `deactivate` 会
    // `auth-center-unregister` 清台，若与并行用例交错会把对方的桥接门瞬时打成
    // 「插件未激活」。同步用例用自带 runtime 取闸门 permit 并持到用例结束。
    let gate_rt = tokio::runtime::Runtime::new().expect("runtime");
    let _center_desk = gate_rt.block_on(lock_auth_center_desk());

    let wasm_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.terminal-session/bedcode_plugin_terminal_session.wasm");
    if !wasm_path.exists() {
        eprintln!("[skip] session wasip3 artifact not built");
        return;
    }
    let (wasm_runtime, host_ctx) = setup_wasm_runtime();
    // 会话登记域建表（P1-b 起阻断激活）需要 storage；会话面 host-pty 需要
    // pty:spawn/pty:io。与 manifest 权限表同源的最小集。
    host_ctx.grant_permissions(
        "com.wasmnest.terminal-session",
        &[
            "auth".to_string(),
            "broadcast".to_string(),
            // 票 04：连接清单迁独立原语，判据换挂 connection:read
            "connection:read".to_string(),
            "fs:read".to_string(),
            "fs:write".to_string(),
            "peer".to_string(),
            "pty:spawn".to_string(),
            "pty:io".to_string(),
            "session:read".to_string(),
            "storage".to_string(),
            "task:run".to_string(),
            "terminal:input".to_string(),
            "terminal:observe".to_string(),
            "timer:schedule".to_string(),
            "ui:input".to_string(),
            "ui:settings".to_string(),
            "ui:sidebar".to_string(),
        ],
    );
    let mut plugin = wasm_runtime
        .load_plugin_from_file(
            &wasm_path,
            "com.wasmnest.terminal-session",
            Arc::clone(&host_ctx),
            &[],
            None,
        )
        .expect("load wasip3 session: all imports must resolve");

    assert_eq!(plugin.activate().expect("activate"), 0);

    let manifest: serde_json::Value = serde_json::from_str(&plugin.get_manifest().expect("manifest")).unwrap();
    assert_eq!(manifest["id"], "com.wasmnest.terminal-session");
    assert_eq!(
        manifest["pluginType"], "rust-ts",
        "骨架即 rust-ts 形态：P3 贡献式前端的落点"
    );
    assert_eq!(
        manifest["permissions"],
        serde_json::json!([
            "auth",
            // 票 15 任务域：broadcast（任务 / 模式 / 队列广播）、fs:read + fs:write
            // （写项目级 Agent 集成）、terminal:input（键盘输入，v27 起经本插件命令
            // 通道 `session.input` 写入）、timer:schedule（队列周期 tick）。
            // **v27（票 10）退役两位**：`session:write`（host-session 整 interface
            // 删除）与 `terminal:observe`（提交输入行观察面，派发点票 03 已删）
            "broadcast",
            // 票 04：`host-connection` 独立原语的判据位
            "connection:read",
            "fs:read",
            "fs:write",
            // v29（HTTP 路由代码注册下沉）：本插件 activate 期经 host-http
            // register-endpoint 注册全部业务路由，需要客户端/服务端同权限位
            "network:http",
            "peer",
            // 票 03：文件浏览域 git diff 经 host-process run-sync
            "process:run",
            // 会话引擎下沉 P1-b：业务会话改走 host-pty 原语——
            // pty:spawn（spawn/kill，高风险面）+ pty:io（write/resize/ring_fetch/is_running）
            // 排序形态跟随 manifest-gen 的 `[...permissions].sort()`（与本文件下方
            // 「ASCII 升序重排」注同源）：HEAD 里的 pty:spawn/pty:io 是未排序的陈旧源清单，
            // 任何人重建产物都会归一成 io→spawn——本 pin 早前就对不上生成物
            "pty:io",
            "pty:spawn",
            "session:read",
            "storage",
            // 票 21（v20 host-task）：`task:run` ——git 域 diff_file_tree 三路只读
            // 命令改走 execute-batch 并行（池线程真并发，替代 run-sync 串行）。
            // 注意顺序：wasm 产物经 manifest-gen **ASCII 升序**重排（task < terminal）
            "task:run",
            "terminal:input",
            "timer:schedule",
            // 票 17：`ui:input`（任务队列弹窗的终端工具栏入口，纯前端贡献面）
            // 清单顺序 = manifest-gen 的 ASCII 升序口径（release 构建会重排）
            "ui:input",
            "ui:settings",
            // 票 14：`ui:sidebar`（票 13 起运行期注册侧边栏目录实际需要，此前漏声明
            // → 前端权限门会抛错）
            "ui:sidebar",
            // 票 09b：`ws:server`（声明端点 session/control 的 events-ws 回包
            // 经 host-websocket send-text-to-client，服务端域判据位）
            "ws:server"
        ]),
        "票 05：host-auth + host-peer；票 08：session:read（config-list 精简列表）+\
             session:read（config-get 全量行，迁移读 legacy 用）+ storage（配置私有库）；\
             票 14：ui:sidebar + ui:settings（两个纯前端贡献面）；票 15：任务域四位（v27 起）；\
             票 17：ui:input（任务弹窗工具栏入口）；票 21：task:run（git 域 execute-batch 并行）"
    );
    let declared_api: Vec<String> = manifest["api"]
        .as_array()
        .expect("api 数组")
        .iter()
        .map(|v| v.as_str().expect("api 字符串").to_string())
        .collect();
    assert_eq!(
        declared_api.len(),
        34,
        "pairing 八项 + trust 两项 + consent 一项 + config 三项 + session-create 一项（票 09）+ \
             会话动作四项（票 10）+ annotate + devices-connect-list 两项（票 11）\
             + quick-actions-import 一项（票 02）\
             + v24 认证记录下沉五项（auth-records-import / devices-list / history-list / \
             connection-touch / connection-close）\
             + 会话登记域读取面两项（P1：session-list / session-get）\
             + P1-b 停止/输入两项（session-close / session-input）\
             + 票 08 历史快照一项（session-history，websocket 业务下沉）\
             + 票 09b WS 会话控制词表分派一项（session-ws-control）\
             + v32 认证中心组合式出口一项（auth-grant，ADR 0031），got: {declared_api:?}"
    );
    // P1-b 互调面必须存在：宿主窄转发层的停止 / 输入转发依赖
    for p1b_api in [
        "com.wasmnest.terminal-session.session-close",
        "com.wasmnest.terminal-session.session-input",
    ] {
        assert!(
            declared_api.iter().any(|a| a == p1b_api),
            "manifest 缺 P1-b 会话 api {p1b_api}"
        );
    }
    // P1 读取面必须成对存在：宿主窄转发层真源切换时按这两条取会话事实
    for read_face in [
        "com.wasmnest.terminal-session.session-list",
        "com.wasmnest.terminal-session.session-get",
    ] {
        assert!(
            declared_api.iter().any(|a| a == read_face),
            "manifest 缺会话读取面 api {read_face}"
        );
    }
    // 票 08：宿主配置命令面转发依赖这三项（缺一即静默降级到只读投影）
    for consumed in [
        "com.wasmnest.terminal-session.config-list",
        "com.wasmnest.terminal-session.config-upsert",
        "com.wasmnest.terminal-session.config-delete",
    ] {
        assert!(
            declared_api.iter().any(|a| a == consumed),
            "manifest 缺配置面 api {consumed}"
        );
    }
    // 票 09/10：宿主命令面（创建 / 重启 / 删除 / 尺寸裁决）的桥接目标必须在声明面里，
    // 否则「未声明 api 不可调」门禁会把转发整片拒掉（静默降级回宿主旧路径）
    for consumed in [
        "com.wasmnest.terminal-session.session-create",
        "com.wasmnest.terminal-session.session-restart",
        "com.wasmnest.terminal-session.session-remove",
        "com.wasmnest.terminal-session.session-rename",
        "com.wasmnest.terminal-session.session-resize",
    ] {
        assert!(
            declared_api.iter().any(|a| a == consumed),
            "manifest 缺会话动作 api {consumed}"
        );
    }
    // 认证中心组合式出口（v32 ADR 0031 K6）必须在声明面里：`auth-method-invoke`
    // 经宿主窄转发到 `auth-grant`，未声明则「未声明 api 不可调」门禁整片拒绝。
    // 桥接探活锚点（旧 SESSION_MARKER_API/trust-list）已随注册表显式登记退役（K7）
    assert!(
        declared_api.contains(&"com.wasmnest.terminal-session.auth-grant".to_string()),
        "manifest 缺认证中心组合式出口 api auth-grant"
    );
    // 文件传输插件经互调消费 consent / trust：两条 api 必须在声明面里，
    // 否则「未声明 api 不可调」门禁会把它的调用整片拒掉（静默降级）
    for consumed in [
        "com.wasmnest.terminal-session.consent-decide",
        "com.wasmnest.terminal-session.trust-list",
    ] {
        assert!(
            declared_api.iter().any(|a| a == consumed),
            "manifest 缺消费方 api {consumed}"
        );
    }
    for api in &declared_api {
        assert!(
            api.starts_with("com.wasmnest.terminal-session."),
            "api 必须落在本插件命名空间, got: {api}"
        );
    }

    // 命令面可调用：状态命令回传 manifest 声明，宿主据此确认 api/permissions 生效
    let result = plugin.invoke_command("session.status", "{}").expect("session.status");
    let r: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert_eq!(r["plugin"], "com.wasmnest.terminal-session");
    assert_eq!(
        r["domains"],
        serde_json::json!([
            "pairing",
            "trust",
            "consent",
            "config",
            "session",
            "devices",
            "environment",
            // 票 15：任务域后端①（Agent 集成 + 会话状态/映射 + 队列随迁）
            "task"
        ]),
        "票 11 devices 域（注解槽 + 设备派生视图）；票 13 追加 environment 域\
             （WSL 发行版枚举，供插件会话配置表单的执行环境分支）；票 15 追加 task 域"
    );
    assert_eq!(r["permissions"], manifest["permissions"]);
    assert_eq!(r["api"], manifest["api"]);

    // 未声明命令明确报错（命令面快速失败）：wasm_entry 将 Err 序列化为
    // `{"error": ...}` JSON 返回（宿主侧 Ok）——断言错误形状而非 is_err
    let ghost = plugin
        .invoke_command("session.ghost", "{}")
        .expect("session.ghost 返回 JSON");
    let r: serde_json::Value = serde_json::from_str(&ghost).unwrap();
    assert!(
        r["error"]
            .as_str()
            .map(|e| e.contains("Unknown command"))
            .unwrap_or(false),
        "未知命令必须返回 error 形状, got: {ghost}"
    );

    assert_eq!(plugin.deactivate().expect("deactivate"), 0);
}

/// 票 15 任务域后端闭环（真实 wasm 产物 + 真实宿主原语，S1 主接缝）
///
/// 验收的是「搬入即可用」，而不是「搬入即编译通过」：
/// - 私有库：`activate` 建表后，预设任务经 `preset-create` → `preset-list`
///   真实往返（证明 `host-plugin-database` 在 wasm 内可用，schema 生效）
/// - 会话开关：`set-auto-mode` → `session-settings` 读回（session_settings 表，
///   且开关在宿主会话不存在时仍按会话键独立记账）
/// - 定时器 tick：队列两域 + 定时任务域都执行（`tick` 分发表 + 私有库查询可用）
/// - **编排反转载体**：`on_session_lifecycle(Creating)` 对未适配 agent 不得
///   产生任何集成写入（项目目录保持为空）——本插件自己注册监听并推进注入，
///   不再等宿主反向调用
/// - 命令面：未知命令显性报错（`{"error"...}` 形状）
///
/// **不调用 deactivate**：停用会走全局 hooks 清理（`~/.claude/settings.json`），
/// 那是真实用户目录上的写操作，只在真机与插件单测里验证，不在本闭环触发。
/// 产物缺失（未跑插件构建）时跳过。

/// 票 05 会话中心互调闭环（消费方 = sdk-test caller 角色），两条路径：
///
/// **trust 路径（列表 → 撤销 → 列表变化）**：认证中心私有库 `auth_pairings`
/// 播种（1 活跃 + 1 已软删，v24 认证记录下沉后真源在私有库）→ `trust-list` 只回
/// 活跃条目（软删行不出现，但原始记录里仍在，撤销检测因此成立）→
/// `trust-revoke` 软删私有库真源 → 再 `trust-list` 立即消失 → 直查私有库表确认
/// `is_active = 0`（**真源一致性**：插件不再自持账本）。
///
/// **consent 路径**（headless 宿主：host-peer require_app 失败 → 信任不可验证 →
/// fail-closed 按未知处理，见 consent/ops.rs 模块文档）：阶段 1（无用户意向）→ ask；
/// 阶段 2（回传 userDecision）→ accept/explicit、deny、accept/one_time。
/// 已信任免确认的自动放行路径由插件 native 单测覆盖（mock 可信集注入）。
///
/// 另钉两条边界：未声明 api 被宿主门禁拒绝（ADR 0017）；peerError 显性透出
/// （无头上下文 host-peer 不可用不静默降级为空列表）。产物缺失时跳过。
#[test]

fn test_session_trust_and_consent_api_closed_loop() {
    // 会话插件私有库是进程级共享路径：与其它会话闭环用例串行（见锁文档）
    let _serial = session_plugin_db_guard();
    use wasmnest_desktop_lib::utils::auth::auth_center as bridge;

    const CONSUMER_ID: &str = "com.wasmnest.consent-consumer";
    const NODE: &str = "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344";
    let session_id = bridge::SESSION_PLUGIN_ID;

    let wasm_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.terminal-session/bedcode_plugin_terminal_session.wasm");
    if !wasm_path.exists() {
        eprintln!("[skip] session wasip3 artifact not built");
        return;
    }
    let (wasm_runtime, host_ctx) = setup_wasm_runtime();
    let session_component = wasm_runtime
        .compile_component(&std::fs::read(&wasm_path).expect("read session artifact"))
        .expect("compile session artifact");
    let consumer_component = wasm_runtime
        .compile_component(&sdk_fixture_artifact_bytes("sdk"))
        .expect("compile sdk-test consumer");

    // 授权路径等价 PluginHost 装载（manifest permissions 登记）：会话中心声明
    // auth（secret-store + 记录面）+ peer（consent 取可信集 / trust peer 段）
    host_ctx.grant_permissions(
        session_id,
        &["auth".to_string(), "peer".to_string(), "storage".to_string()],
    );
    // 登记目标插件声明的 api（等价 PluginHost::activate_plugin 的登记）。
    // 清单读插件工程 manifest（单一真源），不在测试里抄第二份。
    let session_api_list = session_apis();
    host_ctx
        .api_registry()
        .register(
            session_id,
            &session_api_list.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .unwrap();

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        // v32（ADR 0031）：桥接门查进程级单中心注册表 → 与闭环用例互斥（见 helper）
        let _center_desk = lock_auth_center_desk().await;
        let session = Arc::new(Mutex::new(
            wasm_runtime
                .instantiate_component(&session_component, session_id, host_ctx.clone(), &[], None)
                .expect("instantiate session"),
        ));
        let consumer = Arc::new(Mutex::new(
            wasm_runtime
                .instantiate_component(&consumer_component, CONSUMER_ID, host_ctx.clone(), &[], None)
                .expect("instantiate consumer"),
        ));
        let instances = Arc::new(RwLock::new(HashMap::from([
            (session_id.to_string(), session.clone()),
            (CONSUMER_ID.to_string(), consumer.clone()),
        ])));
        host_ctx
            .message_bus
            .set_dispatcher(Arc::new(TestInstanceDispatcher { instances }))
            .await;

        session.lock().await.activate().expect("session activate");
        consumer.lock().await.activate().expect("consumer activate");

        // v24 认证记录下沉：配对真源 = 认证中心私有库 `auth_pairings`。activate
        // 已建表（auth_records::ensure_schema_via_host），此处直写播种
        // （1 活跃 + 1 已软删——撤销检测依赖软删行可见）
        {
            let db_path = plugin_db_root().join(bridge::SESSION_PLUGIN_ID).join("plugin.db");
            let conn = rusqlite::Connection::open(&db_path)
                .unwrap_or_else(|e| panic!("打开认证中心私有库失败 {}: {e}", db_path.display()));
            let _ = conn.busy_timeout(std::time::Duration::from_secs(10));
            for (id, name, fp, active, paired_at) in [
                ("p-live", "Trust Phone", "fp-live", 1, "2026-09-19T00:00:00Z"),
                ("p-revoked", "Revoked Pad", "fp-revoked", 0, "2026-09-18T00:00:00Z"),
            ] {
                conn.execute(
                    "INSERT OR REPLACE INTO auth_pairings \
                     (id, device_name, device_fingerprint, address, uid_hash, paired_at, \
                      last_seen, connect_count, is_active) \
                     VALUES (?1, ?2, ?3, NULL, NULL, ?4, NULL, 1, ?5)",
                    rusqlite::params![id, name, fp, paired_at, active],
                )
                .expect("seed auth_pairings");
            }
        }

        // ==================== trust：列表（私有库真源 → 统一视图） ====================
        let result = consumer
            .lock()
            .await
            .invoke_command("test_session_trust_list", "{}")
            .expect("trust-list");
        let r: serde_json::Value = serde_json::from_str(&result).unwrap();
        let devices = r["devices"].as_array().expect("devices 数组");
        assert_eq!(devices.len(), 1, "软删行不进列表（is_active 过滤）, got: {result}");
        assert_eq!(devices[0]["kind"], "pairing");
        assert_eq!(devices[0]["id"], "p-live", "活跃配对可见");
        assert_eq!(devices[0]["name"], "Trust Phone");
        assert_eq!(devices[0]["fingerprint"], "fp-live");
        assert_eq!(devices[0]["active"], true);
        // 无头上下文 peer-net 不可用：peerError 必须透出（不静默降级为空）
        let peer_err = r["peerError"].as_str().expect("peerError 必须透出");
        assert!(
            peer_err.contains("unavailable") || peer_err.contains("headless"),
            "无头上下文 peer 不可用错误透出, got: {peer_err}"
        );

        // ==================== trust：撤销（写内核真源） ====================
        let result = consumer
            .lock()
            .await
            .invoke_command("test_session_trust_revoke", r#"{"id":"p-live"}"#)
            .expect("trust-revoke");
        let r: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(r["removed"], true, "命中即报 removed, got: {result}");
        assert_eq!(r["kind"], "pairing");

        // 撤销后列表立即变化
        let result = consumer
            .lock()
            .await
            .invoke_command("test_session_trust_list", "{}")
            .expect("trust-list after revoke");
        let r: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            r["devices"].as_array().unwrap().len(),
            0,
            "撤销后立即从统一视图消失, got: {result}"
        );

        // 私有库表断言：软删而非物理删除（auth_records::revoke 语义），且真的落库
        {
            let db_path = plugin_db_root().join(bridge::SESSION_PLUGIN_ID).join("plugin.db");
            let conn = rusqlite::Connection::open(&db_path)
                .unwrap_or_else(|e| panic!("打开认证中心私有库失败 {}: {e}", db_path.display()));
            let active: i32 = conn
                .query_row("SELECT is_active FROM auth_pairings WHERE id = 'p-live'", [], |row| {
                    row.get(0)
                })
                .expect("p-live 必须仍在（软删保留记录）");
            assert_eq!(active, 0, "撤销写的是认证中心私有库真源（is_active = 0）");
            let rows: i32 = conn
                .query_row("SELECT COUNT(*) FROM auth_pairings", [], |row| row.get(0))
                .expect("count");
            assert_eq!(rows, 2, "软删保留记录（不物理删除）");
        }

        // ==================== consent：阶段 1（信任预检） ====================
        // 仅 peer 信息（无用户意向）→ 无头上下文 host-peer 不可用 → fail-closed ask
        let result = consumer
            .lock()
            .await
            .invoke_command(
                "test_session_consent_decide",
                &format!(r#"{{"peerInfo":{{"requestId":"req-c1","nodeId":"{NODE}","deviceName":"模拟对端"}}}}"#),
            )
            .expect("consent-decide phase 1");
        let r: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            r["decision"]["decision"], "ask",
            "无头上下文信任不可验证 → fail-closed ask, got: {result}"
        );
        assert_eq!(r["decision"]["requestId"], "req-c1");
        assert!(r["decision"].get("reason").is_none(), "ask 无 reason, got: {result}");

        // 阶段 2（允许）：回传 userDecision=accept → accept / reason=explicit
        let result = consumer
            .lock()
            .await
            .invoke_command(
                "test_session_consent_decide_explicit",
                &format!(r#"{{"userDecision":"accept","peerInfo":{{"requestId":"req-c2","nodeId":"{NODE}"}}}}"#),
            )
            .expect("consent-decide explicit accept");
        let r: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(r["decision"]["decision"], "accept", "got: {result}");
        assert_eq!(
            r["decision"]["reason"], "explicit",
            "用户显式允许 reason=explicit, got: {result}"
        );

        // 阶段 2（拒绝）：userDecision=deny → deny / reason=explicit
        let result = consumer
            .lock()
            .await
            .invoke_command(
                "test_session_consent_decide_explicit",
                &format!(r#"{{"userDecision":"deny","peerInfo":{{"requestId":"req-c3","nodeId":"{NODE}"}}}}"#),
            )
            .expect("consent-decide explicit deny");
        let r: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(r["decision"]["decision"], "deny", "got: {result}");
        assert_eq!(r["decision"]["reason"], "explicit");

        // 阶段 2（一次性确认）：userDecision=one_time → accept / reason=one_time
        // （放行但不改变信任状态——消费方据此不落信任，下次首连仍询问）
        let result = consumer
            .lock()
            .await
            .invoke_command(
                "test_session_consent_decide_explicit",
                &format!(r#"{{"userDecision":"one_time","peerInfo":{{"requestId":"req-c4","nodeId":"{NODE}"}}}}"#),
            )
            .expect("consent-decide explicit one_time");
        let r: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(r["decision"]["decision"], "accept", "got: {result}");
        assert_eq!(
            r["decision"]["reason"], "one_time",
            "一次性确认 reason=one_time, got: {result}"
        );

        // ==================== 门禁：未声明 api 不可调（ADR 0017） ====================
        let result = consumer
            .lock()
            .await
            .invoke_command("test_session_undeclared", "{}")
            .expect("test_session_undeclared");
        let r: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(
            r["error"].as_str().map(|e| e.contains("not declared")).unwrap_or(false),
            "未声明 api 必须被门禁拒绝, got: {result}"
        );

        session.lock().await.deactivate().expect("session deactivate");
        consumer.lock().await.deactivate().expect("consumer deactivate");
    });
}

#[test]

fn test_business_endpoints_dual_track_closed_loop() {
    let _serial = session_plugin_db_guard();
    const SESSION_ID: &str = "com.wasmnest.terminal-session";
    let session_api_list = session_apis();
    let wasm_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/plugins/desktop/com.wasmnest.terminal-session/bedcode_plugin_terminal_session.wasm");
    if !wasm_path.exists() {
        eprintln!("[skip] session wasip3 artifact not built");
        return;
    }

    // 临时工作区（working_dir = 配置真源指向它；node_modules 将被 exclude）
    let ws = tempfile::tempdir().expect("tempdir");
    let work = ws.path().join("work");
    std::fs::create_dir_all(work.join("src")).expect("mkdir src");
    std::fs::create_dir_all(work.join("node_modules")).expect("mkdir node_modules");
    std::fs::write(work.join("src").join("main.rs"), "fn main() {}").expect("write main.rs");
    std::fs::write(work.join("README.md"), "# readme").expect("write readme");
    std::fs::write(work.join("node_modules").join("x.js"), "x").expect("write x.js");
    let working_dir = work.to_string_lossy().to_string();

    let (wasm_runtime, host_ctx) = setup_wasm_runtime();
    // 票 07：为**工作区根**预置持久化授权（生产里 = 用户第一次打开文件树时点的授权 +
    // 记住）。文件浏览根是用户选的任意目录，不在第一方集成目录清单里（清单只覆盖
    // `.claude` 这类具名段）。授权落在工作区根而不是会话目录：越界探测
    // （`../outside.txt`）必须先被宿主 exists 判成 404，而不是被权限层拦成 500——
    // 那条 404/403 的分层语义是插件契约的一部分。
    block_on_async(
        host_ctx
            .fs_auth()
            .seed_legacy_granted_path(SESSION_ID, &ws.path().to_string_lossy()),
    )
    .expect("seed fs grant for workspace");
    // 私有库清空（marker 干净）
    let _ = std::fs::remove_dir_all(plugin_db_root().join(SESSION_ID));
    let rt = tokio::runtime::Runtime::new().expect("runtime");

    // 会话配置播种移到插件激活之后（见下：v21 起配置面插件必需，无宿主降级）

    // 权限（manifest 全量）+ api 注册表（含 quick-actions-import 与桥接锚点）
    host_ctx.grant_permissions(
        SESSION_ID,
        &[
            "auth".to_string(),
            "peer".to_string(),
            "storage".to_string(),
            "session:read".to_string(),
            "storage".to_string(),
            "fs:read".to_string(),
            "fs:write".to_string(),
            "process:run".to_string(),
            "broadcast".to_string(),
            "terminal:input".to_string(),
            "terminal:observe".to_string(),
            "timer:schedule".to_string(),
            "ui:input".to_string(),
            "ui:settings".to_string(),
            "ui:sidebar".to_string(),
        ],
    );
    host_ctx
        .api_registry()
        .register(
            SESSION_ID,
            &session_api_list.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .unwrap();

    rt.block_on(async move {
        // v32（ADR 0031）：桥接门查进程级单中心注册表 → 与闭环用例互斥（见 helper）
        let _center_desk = lock_auth_center_desk().await;
        let component = wasm_runtime
            .compile_component(&std::fs::read(&wasm_path).expect("read session artifact"))
            .expect("compile session artifact");
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

        // ==================== 1. 会话配置播种（插件真源，激活后必经） ====================
        // v21：配置面插件必需（无宿主降级），故播种必须在激活之后
        let seeded_config =
            seed_config_in_plugin_store(&mut *session.lock().await, "工作台", &working_dir, "bash").await;

        // ==================== _http_endpoint 双轨对照 ====================
        async fn http(
            plugin: &Arc<Mutex<LoadedWasmPlugin>>,
            method: &str,
            path: &str,
            body: serde_json::Value,
        ) -> serde_json::Value {
            let args = serde_json::json!({
                "method": method,
                "path": path,
                "headers": {},
                "body": body,
                "query": {},
            });
            let result = plugin
                .lock()
                .await
                .invoke_command("_http_endpoint", &args.to_string())
                .expect("_http_endpoint");
            serde_json::from_str(&result).expect("http envelope json")
        }
        fn data(envelope: serde_json::Value) -> serde_json::Value {
            envelope["body"]["data"].clone()
        }

        // --- GET configs：插件面 == 宿主旧 ConfigItem 形状 ---
        let configs = http(&session, "GET", "configs", serde_json::Value::Null).await;
        let golden_configs = serde_json::to_value(wasmnest_server_http::dtos::config_dto::ConfigListResponseData {
            configs: vec![wasmnest_server_http::dtos::config_dto::ConfigItem {
                id: seeded_config["id"].as_str().unwrap().to_string(),
                name: "工作台".into(),
                environment: "linux".into(),
                wsl_distro: None,
                working_dir: working_dir.clone(),
                command: "bash".into(),
            }],
        })
        .expect("golden configs");
        assert_eq!(
            data(configs),
            golden_configs,
            "configs 插件面必须与宿主旧 DTO 逐字节一致（wslDistro 显式 null）"
        );

        // --- POST file-tree：插件面 == 宿主 scan_dir 语义（exclude + 排序 + 节点形状） ---
        let tree_env = http(
            &session,
            "POST",
            "file-tree",
            serde_json::json!({ "sessionId": seeded_config["id"], "excludeDirs": ["node_modules"] }),
        )
        .await;
        assert_eq!(
            data(tree_env),
            serde_json::json!({
                "tree": [{
                    "name": "src", "nodeType": "folder", "path": "src",
                    "children": [{ "name": "main.rs", "nodeType": "file", "path": "src/main.rs" }]
                }, {
                    "name": "README.md", "nodeType": "file", "path": "README.md"
                }]
            }),
            "file-tree：node_modules 排除 + 文件夹在前 + 文件 children 省略"
        );

        // --- GET file-tree-children：单层 + Cache-Control 头（参数走 query，与宿主一致） ---
        let children_args = serde_json::json!({
            "method": "GET",
            "path": "file-tree-children",
            "headers": {},
            "body": serde_json::Value::Null,
            // query 键名 snake_case（宿主 FileTreeChildrenQuery 无 rename，移动端
            // useHttpApi 同名构造）——camelCase 是假绿，真机请求会解析不到 session_id
            "query": serde_json::json!({ "session_id": seeded_config["id"], "dir_path": "src", "exclude_dirs": "" }),
        });
        let children_env: serde_json::Value = serde_json::from_str(
            &session
                .lock()
                .await
                .invoke_command("_http_endpoint", &children_args.to_string())
                .expect("_http_endpoint children"),
        )
        .expect("children envelope json");
        assert_eq!(
            data(children_env.clone()),
            serde_json::json!({
                "children": [{ "name": "main.rs", "nodeType": "file", "path": "src/main.rs" }]
            })
        );
        assert_eq!(
            children_env["headers"]["Cache-Control"], "private, max-age=30",
            "file-tree-children 必须带迁移前宿主同口径的 Cache-Control（30 秒，缓存值随域下沉插件）"
        );

        // --- POST file-content：成功路径 ---
        let content_env = http(
            &session,
            "POST",
            "file-content",
            serde_json::json!({ "sessionId": seeded_config["id"], "filePath": "src/main.rs" }),
        )
        .await;
        assert_eq!(
            data(content_env),
            serde_json::json!({ "content": "fn main() {}", "fileName": "main.rs" })
        );

        // --- 确定性错误（与宿主文案逐字一致） ---
        let not_found = http(
            &session,
            "POST",
            "file-content",
            serde_json::json!({ "sessionId": seeded_config["id"], "filePath": "../outside.txt" }),
        )
        .await;
        assert_eq!(
            not_found["body"]["code"], 404,
            "不存在的 ../ 路径先答 404（宿主 exists 前置）"
        );
        // 越界但存在 → 403
        std::fs::write(ws.path().join("outside.txt"), "evil").expect("outside");
        let escape = http(
            &session,
            "POST",
            "file-content",
            serde_json::json!({ "sessionId": seeded_config["id"], "filePath": "../outside.txt" }),
        )
        .await;
        assert_eq!(escape["body"]["code"], 403, "穿越工作目录必须拒绝");
        assert_eq!(
            escape["body"]["message"],
            "Access denied: file is outside working directory"
        );

        // --- 非 git 仓库：diff-tree / file-diff 答 400（宿主文案逐字一致） ---
        let diff_tree = http(
            &session,
            "POST",
            "diff-tree",
            serde_json::json!({ "sessionId": seeded_config["id"], "excludeDirs": [] }),
        )
        .await;
        assert_eq!(diff_tree["body"]["code"], 400);
        assert_eq!(diff_tree["body"]["message"], "Not a git repository");
        let file_diff = http(
            &session,
            "POST",
            "file-diff",
            serde_json::json!({ "sessionId": seeded_config["id"], "filePath": "src/main.rs" }),
        )
        .await;
        assert_eq!(file_diff["body"]["code"], 400);
        assert_eq!(file_diff["body"]["message"], "Not a git repository");

        // ==================== 票 04：git 查询域闭环（真实 git 仓库 + 真实 run-sync） ====================
        // 工作区此刻已被上方断言证明是「非 git 仓库」形态——现在把它变成真仓库，
        // 验证插件经 host-process run-sync 执行 git 的完整链路
        let run_git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&work)
                .output()
                .expect("git run");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run_git(&["init", "-q"]);
        run_git(&["config", "user.email", "t@t"]);
        run_git(&["config", "user.name", "t"]);
        run_git(&["add", "."]);
        run_git(&["commit", "-q", "-m", "init"]);
        run_git(&["branch", "dev"]);

        // GET git/branches：query 键名 snake_case（宿主 GitBranchesQuery 无 rename）
        let branches_args = serde_json::json!({
            "method": "GET",
            "path": "git/branches",
            "headers": {},
            "body": serde_json::Value::Null,
            "query": serde_json::json!({ "session_id": seeded_config["id"] }),
        });
        let branches_env: serde_json::Value = serde_json::from_str(
            &session
                .lock()
                .await
                .invoke_command("_http_endpoint", &branches_args.to_string())
                .expect("_http_endpoint branches"),
        )
        .expect("branches envelope json");
        assert_eq!(branches_env["body"]["code"], 0);
        let branches = data(branches_env.clone());
        assert_eq!(branches["isGitRepo"], true);
        assert!(
            branches["branches"]
                .as_array()
                .expect("branches")
                .iter()
                .any(|b| b == "dev"),
            "branch --list 必须含 dev: {branches}"
        );
        let initial_branch = branches["currentBranch"].as_str().expect("current branch").to_string();

        // GET git/status：新文件（未跟踪）→ hasChanges
        std::fs::write(work.join("untracked.txt"), "x").expect("write untracked");
        let status_args = serde_json::json!({
            "method": "GET",
            "path": "git/status",
            "headers": {},
            "body": serde_json::Value::Null,
            "query": serde_json::json!({ "session_id": seeded_config["id"] }),
        });
        let status_env: serde_json::Value = serde_json::from_str(
            &session
                .lock()
                .await
                .invoke_command("_http_endpoint", &status_args.to_string())
                .expect("_http_endpoint status"),
        )
        .expect("status envelope json");
        assert_eq!(status_env["body"]["code"], 0);
        assert_eq!(data(status_env.clone())["hasChanges"], true);
        assert_eq!(data(status_env)["changedCount"], 1);

        // POST git/checkout：切到 dev，回执分支名；再查 currentBranch 即 dev
        let checkout = http(
            &session,
            "POST",
            "git/checkout",
            serde_json::json!({ "sessionId": seeded_config["id"], "branch": "dev" }),
        )
        .await;
        assert_eq!(checkout["body"]["code"], 0);
        assert_eq!(data(checkout), serde_json::json!({ "branch": "dev" }));
        let branches_after = serde_json::from_str::<serde_json::Value>(
            &session
                .lock()
                .await
                .invoke_command("_http_endpoint", &branches_args.to_string())
                .expect("_http_endpoint branches after"),
        )
        .expect("branches envelope json");
        assert_eq!(
            data(branches_after)["currentBranch"],
            "dev",
            "checkout 后当前分支必须是 dev（checkout 前为 {initial_branch}）"
        );

        // checkout 白名单前置：注入形态在插件侧 500 拒绝（不经 git，文案逐字一致）
        let inject = http(
            &session,
            "POST",
            "git/checkout",
            serde_json::json!({ "sessionId": seeded_config["id"], "branch": "main;rm -rf /" }),
        )
        .await;
        assert_eq!(inject["body"]["code"], 500);
        assert_eq!(
            inject["body"]["message"],
            "Invalid input: Invalid branch name: main;rm -rf /"
        );

        session.lock().await.deactivate().expect("final deactivate");
    });
}

/// 票 04 闭环：会话输出经 `host-session.output-ring-fetch` 原语拉取（插件命令面
/// `session.output.pull` → WIT `list<u8>` 二进制直传）——「插件经原语拉取会话输出
/// 字节不 JSON 化 + 慢消费只损失自己的 ring 历史（游标续拉）」的验收主证据。
///
/// 流程：真实 bash 会话启动 → 写输入 `echo OUTPUT_RING_PROBE_*` → bash 输出进
/// GlobalOutputManager 会话 ring → 插件按游标批量拉取 → 断言原始字节包含 probe
/// 文本（原始字节流，非 JSON 字符串包裹）。属主 = 本插件（create 走插件编排），
/// 权限含 `terminal:output`。
#[test]
fn test_session_output_ring_fetch_closed_loop() {
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
    let mut host_ctx = host_ctx;
    if let Some(ctx) = Arc::get_mut(&mut host_ctx) {
        ctx.set_plugin_db_root(Some(std::env::temp_dir().join(format!(
            "wasmnest_plugin_dbs_outring_{}_{}",
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
            // 票 04：输出消费二进制原语（terminal:output）
            "terminal:output".to_string(),
            // 会话引擎下沉 P1-b：业务会话改走 host-pty 原语（含输出环拉取）
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

        // ==================== 1. 播种配置 + 创建（P1-b 创建即启动真实 bash） ====================
        // command 经插件 build_argv 包装（bash -lic "cd ... && pwd && <command>"）：
        // 启动即 echo 探针输出 + sleep 保持会话存活
        let probe = format!("OUTPUT_RING_PROBE_{}", std::process::id());
        let seeded = seed_config_in_plugin_store(
            &mut *session.lock().await,
            "输出环会话",
            "/tmp",
            &format!("echo {probe}; sleep 60"),
        )
        .await;
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
        // P1-b 创建同步完成：回执即已登记并已启动（无需轮询 / start_existing_session）
        let v = wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid)
            .await
            .expect("view");
        assert!(!v.is_null(), "会话应在册");
        assert_eq!(v["status"], serde_json::json!("running"), "创建即启动 → Running");

        // ==================== 2. 等 bash 输出进入会话 ring（echo + pwd + prompt） ====================

        // ==================== 3. 插件按游标拉取（游标前端自持；追平后停） ====================
        let mut cursor: u64 = 0;
        let mut acc: Vec<u8> = Vec::new();
        let mut got_probe = false;
        for _ in 0..100 {
            let raw = session
                .lock()
                .await
                .invoke_command(
                    "session.output.pull",
                    &serde_json::json!({ "sessionId": sid, "fromOffset": cursor }).to_string(),
                )
                .expect("output.pull 命令");
            let value: serde_json::Value = serde_json::from_str(&raw).expect("pull json");
            // 追平 → null
            if value.is_null() {
                if acc.windows(probe.len()).any(|w| w == probe.as_bytes()) {
                    got_probe = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
            let data: Vec<u8> = value["data"]
                .as_array()
                .expect("data 数组")
                .iter()
                .map(|v| v.as_u64().expect("字节") as u8)
                .collect();
            let next = value["nextOffset"].as_u64().expect("nextOffset");
            if value["truncated"].as_bool().unwrap_or(false) {
                panic!("首拉即截断：会话输出不应超过环容量（min_offset 前移）");
            }
            acc.extend_from_slice(&data);
            cursor = next;
            if acc.windows(probe.len()).any(|w| w == probe.as_bytes()) {
                got_probe = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
        assert!(
            got_probe,
            "插件必须经 output-ring-fetch 拉到 bash 输出字节，got: {:?}",
            String::from_utf8_lossy(&acc)
        );

        // ==================== 4. 续拉不重复 + 追平自愈 ====================
        // 游标已追平（最后一次返回后可能仍有增量——再拉直到追平验证不抛错）
        for _ in 0..50 {
            let raw = session
                .lock()
                .await
                .invoke_command(
                    "session.output.pull",
                    &serde_json::json!({ "sessionId": sid, "fromOffset": cursor }).to_string(),
                )
                .expect("pull again");
            let value: serde_json::Value = serde_json::from_str(&raw).expect("pull json");
            if value.is_null() {
                break;
            }
            let data: Vec<u8> = value["data"]
                .as_array()
                .expect("data 数组")
                .iter()
                .map(|v| v.as_u64().expect("字节") as u8)
                .collect();
            cursor = value["nextOffset"].as_u64().expect("nextOffset");
            // 续拉不重复：新段不得与已拉区间重叠（游标单调推进由断言 3 隐含保证）
            assert!(!data.is_empty(), "非追平响应必须带字节");
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }

        // ==================== 清理 ====================
        wasmnest_desktop_lib::utils::session_gateway::remove(&host_ctx, &sid, None)
            .await
            .expect("remove session");
        session.lock().await.deactivate().expect("final deactivate");
    });
}

/// P1-b 输入面闭环：宿主入口 → 会话窄转发层 → 插件 `session-input` → `host-pty.write`
///
/// 为什么必须有这条用例：P1-b 前桌面终端输入走内核 `SessionManager::write_input`
/// （按会话 id 查内核 PTY 注册表），真源切换后内核不再持有会话——原样保留即
/// **终端窗口敲键盘静默丢键、任务队列下发全被标中断**，而编译与既有闭环全绿
/// （e2e 此前只测创建/动作/输出，没有任何一条走输入面）。
///
/// 契约：
/// - **C-01 正例**：普通输入写进真实 bash 并被**执行**——探针串在输出里出现 ≥2 次
///   （tty 回显一次 + 命令输出一次；只出现一次 = 字节进了 PTY 但没被执行）；
/// - **C-02 反例**：未知会话 → 插件登记域显性报错（无内核降级轨）；
/// - **C-03 边界**：特殊键经宿主 `KeyCombo` 翻译成转义字节 + `special` 标记，
///   Ctrl-C 让 bash 打出 `^C`（证明写的是真字节而非被当普通文本提交）；
/// - **C-04 反例**：非法键名在宿主翻译期即拒，不到插件；
/// - **C-05 状态迁移**：Ctrl-D 使 bash 自然退出 → `<owner>::pty:exit` →
///   登记域终态（输入面与终态链之间无断点）。
#[test]
fn test_session_input_via_gateway_closed_loop() {
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
    let mut host_ctx = host_ctx;
    if let Some(ctx) = Arc::get_mut(&mut host_ctx) {
        ctx.set_plugin_db_root(Some(std::env::temp_dir().join(format!(
            "wasmnest_plugin_dbs_input_{}_{}",
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
            // 会话引擎下沉 P1-b：业务会话走 host-pty（写输入 + 拉输出环）
            "pty:spawn".to_string(),
            "pty:io".to_string(),
            "terminal:output".to_string(),
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

        // ==================== 1. 真实 bash 会话（嵌套交互 shell，可接收输入） ====================
        let seeded = seed_config_in_plugin_store(&mut *session.lock().await, "输入会话", "/tmp", "bash").await;
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
            .expect("plugin active → 创建必须成功"),
            "创建",
        );
        assert_eq!(
            wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid)
                .await
                .expect("view")["status"],
            serde_json::json!("running"),
            "创建即启动 → Running（输入面前提）"
        );

        // ==================== 2. C-02 反例：未知会话显性报错（无降级轨） ====================
        let err = wasmnest_desktop_lib::utils::session_gateway::input(&host_ctx, "no-such-session", "ls\r")
            .await
            .expect_err("真源在插件登记域，未知会话必须显性失败");
        // 票 05（ADR 0030）：插件侧只出信封码（中文文案由插件前端按 code 查
        // i18n，见 terminal-session session/mod.rs user_facing_string）——宿主断言
        // 契约码而非旧中文字面量（旧断言停在 09-25，bd3fed0e4 已改信封形态）
        assert!(
            err.to_string()
                .contains("com.wasmnest.terminal-session.session.error.sessionNotFound"),
            "未知会话须报 ADR 0030 信封码（sessionNotFound），got: {err}"
        );

        // ==================== 3. C-01 正例：普通输入被执行（探针回显 + 命令输出各一次） ============
        let probe = format!("INPUT_PROBE_{}", std::process::id());
        wasmnest_desktop_lib::utils::session_gateway::input(&host_ctx, &sid, &format!("echo {}\r", probe))
            .await
            .expect("普通输入必须写入插件会话");
        let mut cursor: u64 = 0;
        let mut acc: Vec<u8> = Vec::new();
        let mut hits = 0usize;
        for _ in 0..100 {
            let raw = session
                .lock()
                .await
                .invoke_command(
                    "session.output.pull",
                    &serde_json::json!({ "sessionId": sid, "fromOffset": cursor }).to_string(),
                )
                .expect("output.pull 命令");
            let value: serde_json::Value = serde_json::from_str(&raw).expect("pull json");
            if !value.is_null() {
                let data: Vec<u8> = value["data"]
                    .as_array()
                    .expect("data 数组")
                    .iter()
                    .map(|v| v.as_u64().expect("字节") as u8)
                    .collect();
                cursor = value["nextOffset"].as_u64().expect("nextOffset");
                acc.extend_from_slice(&data);
                hits = acc.windows(probe.len()).filter(|w| *w == probe.as_bytes()).count();
            }
            if hits >= 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(
            hits >= 2,
            "探针须出现两次（tty 回显 + echo 执行结果），got {hits} 次，输出: {:?}",
            String::from_utf8_lossy(&acc)
        );

        // ==================== 4. C-04 反例：非法特殊键由插件拒签（fail-visible，票 06 下沉后宿主不再翻译） ============
        let err = wasmnest_desktop_lib::utils::session_gateway::special_key(&host_ctx, &sid, "not_a_real_key")
            .await
            .expect_err("未知键名必须显性失败（帧插件翻译面）");
        assert!(
            err.to_string().contains("not_a_real_key"),
            "错误应点名拒绝的键名（插件翻译期），got: {err}"
        );

        // ==================== 5. C-03 边界：Ctrl-C 经 special 通道写真字节（bash 打 ^C） ========
        wasmnest_desktop_lib::utils::session_gateway::special_key(&host_ctx, &sid, "ctrl_c")
            .await
            .expect("ctrl_c 必须写入会话");
        let mut saw_interrupt = false;
        for _ in 0..60 {
            let raw = session
                .lock()
                .await
                .invoke_command(
                    "session.output.pull",
                    &serde_json::json!({ "sessionId": sid, "fromOffset": cursor }).to_string(),
                )
                .expect("output.pull after ctrl_c");
            let value: serde_json::Value = serde_json::from_str(&raw).expect("pull json");
            if !value.is_null() {
                let data: Vec<u8> = value["data"]
                    .as_array()
                    .expect("data 数组")
                    .iter()
                    .map(|v| v.as_u64().expect("字节") as u8)
                    .collect();
                cursor = value["nextOffset"].as_u64().expect("nextOffset");
                acc.extend_from_slice(&data);
            }
            if acc.windows(2).any(|w| w == b"^C") {
                saw_interrupt = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(
            saw_interrupt,
            "Ctrl-C 的 0x03 字节须到达 PTY 并被 tty 回显为 ^C，输出: {:?}",
            String::from_utf8_lossy(&acc)
        );

        // ==================== 6. C-05 状态迁移：Ctrl-D → bash 退出 → 登记域终态 ================
        wasmnest_desktop_lib::utils::session_gateway::special_key(&host_ctx, &sid, "ctrl_d")
            .await
            .expect("ctrl_d 必须写入会话");
        let mut stopped = false;
        for _ in 0..100 {
            let v = wasmnest_desktop_lib::utils::session_gateway::view(&host_ctx, &sid)
                .await
                .expect("view after ctrl_d");
            if v.get("status").and_then(|s| s.as_str()) == Some("stopped") {
                stopped = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(
            stopped,
            "Ctrl-D 退出 bash 后，pty:exit 必须把登记域会话收为 Stopped（输入面与终态链无断点）"
        );

        // ==================== 清理 ====================
        let _ = wasmnest_desktop_lib::utils::session_gateway::remove(&host_ctx, &sid, None).await;
        session.lock().await.deactivate().expect("final deactivate");
    });
}
