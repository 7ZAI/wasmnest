//! 真实 SDK 链路 + 互调 fixture 插件
use wasmnest_plugin_api::host::{
    ConfigKey, HostBus, HostConfig, HostEvents, HostLog, HostNotify, HostPluginDatabase,
    HostStorage, NotifyOptions,
};
use wasmnest_plugin_api::types::PluginManifest;
use wasmnest_plugin_api::wasm::WasmPlugin;
use wasmnest_plugin_api::wasm_host::WasmHost;
use wasmnest_plugin_api::{plugin_api, BusMessage};

/// 最近一次收到的二进制消息（v11 events-binary 回调）——SDK 链路字节完整性验证
/// 实例级全局（wasip3 thread_local 按宿主调用线程隔离，投递线程写 / 查询线程读
/// 会读空；wasm 单线程内 Mutex 无竞争）
static LAST_BINARY: std::sync::Mutex<Option<(String, String, Vec<u8>)>> =
    std::sync::Mutex::new(None);

/// 插件互调 api 声明：trait 方法名 ↔ manifest.api 条目
/// （`com.wasmnest.sdk-test.<method>`），宏在编译期比对防漂移
#[plugin_api]
pub trait SdkTestApi {
    /// 回声：参数原样回传（请求/响应配对成功验收）
    fn echo(text: String) -> Result<String, String>;
    /// 恒失败：目标方法返回 error（错误传播验收）
    fn fail() -> Result<String, String>;
}

/// SDK 测试插件 — 覆盖组件 import 的主要能力
pub struct SdkTestPlugin;

impl SdkTestApi for SdkTestPlugin {
    fn echo(text: String) -> Result<String, String> {
        Ok(format!("echo: {}", text))
    }

    fn fail() -> Result<String, String> {
        Err("boom".to_string())
    }
}

impl WasmPlugin for SdkTestPlugin {
    const ID: &'static str = "com.wasmnest.sdk-test";

    fn manifest() -> PluginManifest {
        // ADR-0005 单一真源：合集 crate 根的 plugin.json（与 #[plugin_api]
        // 宏编译期读的同一份——宏会比对 trait 方法名 ↔ 这里的 api 字段，
        // 若模块另指一份 sdk.json，两份可能漂移且防漂移比对形同虚设）
        serde_json::from_str(include_str!("../plugin.json"))
            .expect("plugin.json must be valid PluginManifest")
    }

    fn activate() -> anyhow::Result<()> {
        // 订阅互调请求 topic（宏生成）：`wasmnest.api.<api>` 逐个订阅，
        // 宿主订阅去重幂等
        SdkTestApiDispatcher::register()?;
        // v11：以二进制格式偏好订阅（经 SDK HostBus）——宿主 `publish_binary`
        // 才会投递到 on_message_binary 回调
        WasmHost.bus_subscribe_binary("sdk:binary-topic")?;
        Ok(())
    }

    /// 启动初始化失败注入：宿主测试预写 storage key `component-test-fail-startup`
    /// 时返回 Err，用于验证宿主 Degraded 路径（运行期开关，免构建矩阵）。
    /// 随 `plugin-component-test` 删除而并入本夹具。
    fn on_startup() -> anyhow::Result<()> {
        if let Ok(Some(_)) = WasmHost.storage_get("component-test-fail-startup") {
            return Err(anyhow::anyhow!("simulated startup init failure (sdk-test)"));
        }
        Ok(())
    }

    fn deactivate() -> anyhow::Result<()> {
        Ok(())
    }

    /// 总线消息入口：互调请求先经宏生成的分派器（命中 api topic 则处理并回复），
    /// 其余消息保持原语义（本插件无其他订阅，直接忽略）
    fn on_message(msg: &BusMessage) -> anyhow::Result<()> {
        SdkTestApiDispatcher::dispatch::<Self>(msg)?;
        Ok(())
    }

    /// v11 二进制消息入口：记录最近一次 topic/sender/字节列，
    /// 供宿主测试断言字节完整性
    fn on_message_binary(msg: &BusMessage) -> anyhow::Result<()> {
        let payload = msg.payload_binary.clone().unwrap_or_default();
        *LAST_BINARY.lock().unwrap() = Some((msg.topic.clone(), msg.sender.clone(), payload));
        Ok(())
    }

    fn invoke_command(name: &str, args: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let host = WasmHost;

        match name {
            // 回包形状对齐原 `plugin-component-test`（已删）：`name` / `args` /
            // `stored`（读固定 key `component-test-key`）——多个引擎测试断言这三个
            // 字段，故保留该形状。DB 往返另开 `test.db-roundtrip`（见下）。
            "test.echo" => {
                let stored = match WasmHost.storage_get("component-test-key")? {
                    Some(v) => v,
                    None => serde_json::Value::Null,
                };
                // `args` 必须是**字符串**而非嵌套对象：宿主在调用前把
                // `resource_dir` 注入 args JSON，测试侧按
                // `from_str(result["args"].as_str())` 再解析取该字段
                // （原 component-test 走原始 WIT 绑定，args 本就是 String，
                // 直接放进回包即可；SDK 侧拿到的是 Value，需回序列化）。
                Ok(serde_json::json!({
                    "name": name,
                    "args": serde_json::to_string(&args).unwrap_or_default(),
                    "stored": stored,
                }))
            }
            // 主库 + 插件私有库往返（原 `plugin-component-test` 在 `invoke` 的
            // 默认分支里做，拆分出来是因为它带两次建表+插入+查询，而 `test.echo`
            // 被燃料/性能探针高频调用，不宜背这份开销）
            "test.db-roundtrip" => {
                // 插件私有库往返（2026-10-09 双端机制决策：主库由 wasm-core 管理、
                // 不给插件直接调用，主库段随 host-database 退役）
                let mut out = serde_json::json!({ "name": name });
                if let Err(e) = WasmHost.plugin_db_execute(
                    "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, val TEXT)",
                ) {
                    out["pdbCreateError"] = serde_json::json!(e.to_string());
                }
                let _ = WasmHost.plugin_db_execute("INSERT INTO t (val) VALUES ('pdb')");
                out["pdbRows"] = WasmHost
                    .plugin_db_query("SELECT val FROM t ORDER BY id")?
                    .unwrap_or(serde_json::Value::Null);
                Ok(out)
            }
            // 测试专用 trap：宿主测试制造确定性 panic（验证 wasm backtrace 栈
            // 穿透到业务函数 invoke，而非只在宿主分配 helper 处）。panic 在
            // wasm32 上即 unreachable trap
            "test.panic" => panic!("intentional panic for wasm backtrace test"),
            // 按 key 读宿主 storage：能力路由测试用——宿主注册表命中系统组件
            // 提供者时，该 import 经 Linker 转发到系统组件实例的同形导出，
            // 读到的值来源可区分（系统组件内存 KV vs 宿主 SQLite）
            "test.storage-get" => {
                let key = args.get("key").and_then(|v| v.as_str()).unwrap_or_default();
                // **必须捕获错误而非传播**：系统组件 trap 隔离用例要求应用插件的
                // invoke 不失败——trap 经能力注册表转发后应表现为 guest 可见的
                // `storageError` 字段（不跨实例扩散），而不是命令整体 Err。
                let out = match WasmHost.storage_get(key) {
                    Ok(Some(v)) => serde_json::json!({ "key": key, "value": v }),
                    Ok(None) => serde_json::json!({ "key": key, "value": serde_json::Value::Null }),
                    Err(e) => serde_json::json!({ "key": key, "storageError": e.to_string() }),
                };
                Ok(out)
            }
            "test_storage" => {
                let key = args
                    .get("key")
                    .and_then(|v| v.as_str())
                    .unwrap_or("sdk_test_key");
                let value = args
                    .get("value")
                    .cloned()
                    .unwrap_or(serde_json::json!("sdk_value"));
                host.storage_set(key, &value)?;
                let got = host.storage_get(key)?.unwrap_or(serde_json::Value::Null);
                Ok(serde_json::json!({ "set": value, "got": got }))
            }
            "test_config" => {
                let port = host.config_get(ConfigKey::NetworkPort)?.unwrap_or_default();
                Ok(serde_json::json!({ "port": port }))
            }
            "test_log" => {
                host.log_info("sdk test info");
                host.log_debug("sdk test debug");
                host.log_warn("sdk test warn");
                host.log_error("sdk test error");
                Ok(serde_json::json!({ "logged": true }))
            }
            "test_emit" => {
                host.emit_event(
                    "sdk-test-event",
                    &serde_json::json!({ "source": "sdk_test" }),
                );
                Ok(serde_json::json!({ "emitted": true }))
            }
            // v27：`test_session_list` 随 host-session 整 interface 删除（票 10）——
            // 本夹具不再有会话原语可测；会话事实由插件登记域持有。
            "test_bus" => {
                host.bus_publish("sdk:topic", &serde_json::json!({ "msg": "sdk-hello" }))?;
                Ok(serde_json::json!({ "published": true }))
            }
            // v11：二进制发布——args.bytes 为 0-255 数字数组，
            // args.topic 缺省 sdk:binary-topic
            "test_binary_publish" => {
                let topic = args
                    .get("topic")
                    .and_then(|v| v.as_str())
                    .unwrap_or("sdk:binary-topic");
                let bytes: Vec<u8> = args
                    .get("bytes")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_u64().map(|n| n as u8))
                            .collect()
                    })
                    .unwrap_or_default();
                host.bus_publish_binary(topic, &bytes)?;
                Ok(serde_json::json!({ "published": bytes.len() }))
            }
            // v11：读回 on_message_binary 最近一次收到的消息（宿主断言字节完整性）
            "test_binary_received" => {
                let received = LAST_BINARY.lock().unwrap().as_ref().map(
                        |(topic, sender, payload)| serde_json::json!({ "topic": topic, "sender": sender, "bytes": payload }),
                    );
                Ok(serde_json::json!({ "received": received }))
            }
            // 无头测试上下文无 AppHandle：宿主 notify 返回错误，验证错误透传
            // （2026-10-13 起走共享 host-notify 契约，options 为显式空对象）
            "test_notify" => {
                host.notify("sdk title", "sdk body", &NotifyOptions::new())?;
                Ok(serde_json::json!({ "notified": true }))
            }
            // ==================== 插件互调（ADR 0017） ====================

            // 调用方 client：请求/响应配对成功（目标 com.wasmnest.sdk-test 由宿主
            // 测试以第二个实例加载；本命令由 caller 实例调用）
            "test_api_echo" => {
                let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("hello");
                let client = SdkTestApiClient::new(Self::ID);
                match client.echo(text.to_string()) {
                    Ok(v) => Ok(serde_json::json!({ "echo": v })),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                }
            }
            // 错误传播：目标方法返回 error → JSON-RPC error 对象 → client 报错
            "test_api_fail" => {
                let client = SdkTestApiClient::new(Self::ID);
                match client.fail() {
                    Ok(v) => Ok(serde_json::json!({ "unexpected": v })),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                }
            }
            // 超时：目标声明且订阅但未实现（宿主测试绕过声明登记 + 订阅
            // `no-response` topic），短超时快速失败
            "test_api_timeout" => {
                let client = SdkTestApiClient::new(Self::ID).with_timeout(800);
                match client.call_json("no-response", serde_json::json!([])) {
                    Ok(v) => Ok(serde_json::json!({ "unexpected": v })),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                }
            }
            // 门禁拒绝：目标 api 未声明（com.wasmnest.sdk-test.ghost 不在注册表）
            "test_api_undeclared" => {
                let client = SdkTestApiClient::new(Self::ID).with_timeout(800);
                match client.call_json("ghost", serde_json::json!([])) {
                    Ok(v) => Ok(serde_json::json!({ "unexpected": v })),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                }
            }
            // ==================== 跨插件调用计划任务插件 ====================

            // 调用方指向 com.wasmnest.scheduler 调 `list`（api 已在插件声明，宿主注册表有登记）
            "test_schedule_list" => {
                let client = SdkTestApiClient::new("com.wasmnest.scheduler").with_timeout(3000);
                match client.call_json("list", serde_json::json!([])) {
                    Ok(v) => Ok(v),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                }
            }
            // 调用方调未声明 api：宿主门禁拒绝
            "test_schedule_undeclared" => {
                let client = SdkTestApiClient::new("com.wasmnest.scheduler").with_timeout(800);
                match client.call_json("ghost", serde_json::json!([])) {
                    Ok(v) => Ok(serde_json::json!({ "unexpected": v })),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                }
            }
            // ==================== 会话中心互调闭环 ====================
            // caller 角色指向 com.wasmnest.bedcode（宿主测试加载真实会话中心产物）：
            // `consent-decide` 两阶段决策流 + `trust-list` / `trust-revoke` 统一视图与撤销
            // + 未声明 api 门禁拒绝（ADR 0017）

            // 阶段 1：仅传 peer 信息（无用户意向）→ 已信任免确认 / 未知 → ask
            "test_session_consent_decide" => {
                let peer = args.get("peerInfo").cloned().unwrap_or(serde_json::json!({
                    "requestId": "req-consent-1",
                    "nodeId": "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344",
                    "fingerprintShort": "aabbccdd",
                    "deviceName": "消费方模拟对端",
                }));
                let client = SdkTestApiClient::new("com.wasmnest.bedcode").with_timeout(5000);
                match client.call_json("consent-decide", peer) {
                    Ok(v) => Ok(serde_json::json!({ "decision": v })),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                }
            }
            // 阶段 2：回传用户意向（accept / deny / one_time）→ 最终决策
            "test_session_consent_decide_explicit" => {
                let mut peer = args.get("peerInfo").cloned().unwrap_or(serde_json::json!({
                    "requestId": "req-consent-2",
                    "nodeId": "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344",
                }));
                if let Some(ud) = args.get("userDecision").and_then(|v| v.as_str()) {
                    if let Some(obj) = peer.as_object_mut() {
                        obj.insert("userDecision".to_string(), serde_json::json!(ud));
                    }
                }
                let client = SdkTestApiClient::new("com.wasmnest.bedcode").with_timeout(5000);
                match client.call_json("consent-decide", peer) {
                    Ok(v) => Ok(serde_json::json!({ "decision": v })),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                }
            }
            // 统一信任视图（零参 api）
            "test_session_trust_list" => {
                let client = SdkTestApiClient::new("com.wasmnest.bedcode").with_timeout(5000);
                match client.call_json("trust-list", serde_json::Value::Null) {
                    Ok(v) => Ok(v),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                }
            }
            // 撤销统一条目（id 经 args 传入）
            "test_session_trust_revoke" => {
                let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("ghost");
                let client = SdkTestApiClient::new("com.wasmnest.bedcode").with_timeout(5000);
                match client.call_json("trust-revoke", serde_json::json!(id)) {
                    Ok(v) => Ok(v),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                }
            }
            // 未声明 api：宿主门禁拒绝
            "test_session_undeclared" => {
                let client = SdkTestApiClient::new("com.wasmnest.bedcode").with_timeout(2000);
                match client.call_json("ghost-api", serde_json::Value::Null) {
                    Ok(v) => Ok(serde_json::json!({ "unexpected": v })),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                }
            }
            // 任意命令名兜底：回显 `name` / `args`。
            // 属主任务测试（owner_e2e）用 `echo-0` / `echo-1` … 这类序号化命令名
            // 验证「应答与请求配对 + 完成序 = 入队序」，没有固定命令表可用。
            // （`session_e2e` 里断言 `Unknown command` 的是 bedcode
            // 插件，不走本夹具。）
            other => Ok(serde_json::json!({ "name": other, "args": args })),
        }
    }

    // v27：`on_terminal_input` / `on_terminal_output` 已随 `terminal-hooks` interface
    // 删除（票 10）——本夹具不再覆盖它们。
}

// ==================== 供通用引擎测试复用的测试专用能力 ====================
//
// 以下三条随 `plugin-component-test` 删除而并入本夹具（它被 30+ 处通用引擎测试
// 当“随便一个组件”用，实际依赖的只是这几个可观测点，与手写绑定与否无关）。
// **遗留降级路径的覆盖**（未导出 `events-ws` / `events-task` 的旧产物走
// `Ok(false)`）随该夹具一并删除——那是手写绑定专属能力，SDK 的 `wasm_entry!`
// 无条件导出全部 interface，造不出缺导出的产物。

wasmnest_plugin_api::wasm_entry!(SdkTestPlugin);
