//! host-task（ABI v20）fixture 插件
use wasmnest_plugin_api::host::{HostLog, HostStorage, HostTask};
use wasmnest_plugin_api::types::PluginManifest;
use wasmnest_plugin_api::wasm::WasmPlugin;
use wasmnest_plugin_api::wasm_host::WasmHost;

/// 收到的 `on-task-event` 原始事件 JSON 序列（供宿主断言，按到达序）
///
/// 实例级静态 + storage 双写（storage 供宿主断言非空；静态供宿主读序列）。
/// 回调投递发生在宿主消费派发任务（tokio），命令查询发生在宿主调用线程——
/// wasm32-wasip3 的 thread_local 是真 TLS 跨调用线程读空，静态 Mutex 是唯一可靠载体。
static TASK_EVENTS: std::sync::Mutex<Vec<serde_json::Value>> = std::sync::Mutex::new(Vec::new());

/// storage 累积键（宿主断言用）
pub const TASK_EVENTS_KEY: &str = "task-events.v1";

pub struct TaskTestPlugin;

impl WasmPlugin for TaskTestPlugin {
    const ID: &'static str = "com.wasmnest.task-test";

    fn manifest() -> PluginManifest {
        // ADR-0005 单一真源：plugin.json
        serde_json::from_str(include_str!("../task.json"))
            .expect("plugin.json must be valid PluginManifest")
    }

    fn activate() -> anyhow::Result<()> {
        let host = WasmHost;
        host.log_info("task-test fixture activated: host-task（v20）ready");
        Ok(())
    }

    fn deactivate() -> anyhow::Result<()> {
        Ok(())
    }

    fn invoke_command(name: &str, args: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let host = WasmHost;
        match name {
            // execute-batch：args = { plan: "<plan-json>" } → 返回全量结果 JSON
            "execute-batch" => {
                let plan = require_str(&args, "plan")?;
                let out = host
                    .execute_batch(plan)
                    .map_err(|e| anyhow::anyhow!("execute_batch failed: {}", e.message))?;
                Ok(serde_json::json!({ "result": out }))
            }
            // submit：args = { plan: "<plan-json>" } → { jobId }
            "submit" => {
                let plan = require_str(&args, "plan")?;
                let job_id = host
                    .submit(plan)
                    .map_err(|e| anyhow::anyhow!("submit failed: {}", e.message))?;
                Ok(serde_json::json!({ "jobId": job_id }))
            }
            // status：args = { jobId } → { statusJson | null }
            "status" => {
                let job_id = require_str(&args, "jobId")?;
                let out = host
                    .task_status(job_id)
                    .map_err(|e| anyhow::anyhow!("task_status failed: {}", e.message))?;
                Ok(serde_json::json!({ "status": out }))
            }
            // cancel：args = { jobId } → { hit }
            "cancel" => {
                let job_id = require_str(&args, "jobId")?;
                let hit = host
                    .cancel(job_id)
                    .map_err(|e| anyhow::anyhow!("cancel failed: {}", e.message))?;
                Ok(serde_json::json!({ "hit": hit }))
            }
            // list-jobs → { jobs: "[...]" }
            "list-jobs" => {
                let out = host
                    .list_jobs()
                    .map_err(|e| anyhow::anyhow!("list_jobs failed: {}", e.message))?;
                Ok(serde_json::json!({ "jobs": out }))
            }
            // 读已收任务事件序列（供宿主断言）
            "task-events" => {
                let events = TASK_EVENTS
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                Ok(serde_json::json!({ "events": events }))
            }
            _ => Err(anyhow::anyhow!("unknown command: {}", name)),
        }
    }

    /// 宿主并发任务进度/终态回调（v20，events-task 可选导出）：累积进
    /// 实例级静态 + storage（观察型回调，无返回值；失败经 host-log 记录）
    fn on_task_event(event_json: &str) -> anyhow::Result<()> {
        let parsed: serde_json::Value = serde_json::from_str(event_json)
            .map_err(|e| anyhow::anyhow!("on_task_event: bad event json: {}", e))?;
        {
            let mut events = TASK_EVENTS.lock().unwrap_or_else(|e| e.into_inner());
            events.push(parsed.clone());
        }
        let host = WasmHost;
        let mut stored = host
            .storage_get(TASK_EVENTS_KEY)
            .ok()
            .flatten()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        stored.push(parsed);
        host.storage_set(TASK_EVENTS_KEY, &serde_json::json!(stored))?;
        Ok(())
    }
}

fn require_str<'a>(args: &'a serde_json::Value, key: &str) -> anyhow::Result<&'a str> {
    args.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing string field: {}", key))
}

wasmnest_plugin_api::wasm_entry!(TaskTestPlugin);
