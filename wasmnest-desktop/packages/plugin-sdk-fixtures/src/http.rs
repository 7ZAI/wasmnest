//! host-http（ABI v29）fixture 插件
use wasmnest_plugin_api::host::{HostHttp, HostLog};
use wasmnest_plugin_api::types::PluginManifest;
use wasmnest_plugin_api::wasm::WasmPlugin;
use wasmnest_plugin_api::wasm_host::WasmHost;

/// 注册的 host 别名与内部路径（宿主断言用常量）
pub const HOST_ALIAS: &str = "/api/http-test/hello";
pub const TEMPLATE_ALIAS: &str = "/api/http-test/{id}/x";
pub const INTERNAL_HELLO: &str = "hello";
pub const INTERNAL_TEMPLATE: &str = "x/{id}";

/// HTTP fixture 插件
pub struct HttpTestPlugin;

impl WasmPlugin for HttpTestPlugin {
    const ID: &'static str = "com.wasmnest.http-test";

    fn manifest() -> PluginManifest {
        serde_json::from_str(include_str!("../http.json"))
            .expect("plugin.json must be valid PluginManifest")
    }

    fn activate() -> anyhow::Result<()> {
        let host = WasmHost;
        // 内部路径 + host 别名（jwt 档，缺省最严）
        let id = host
            .http_register_endpoint(
                &serde_json::json!({
                    "path": INTERNAL_HELLO,
                    "host": HOST_ALIAS,
                    "methods": ["GET"],
                })
                .to_string(),
            )
            .map_err(|e| anyhow::anyhow!("register hello: {}", e.message))?;
        host.log_info(&format!("http fixture registered hello: {}", id));
        // 模板别名（none 档——公开捕获参数）
        let id2 = host
            .http_register_endpoint(
                &serde_json::json!({
                    "path": "x/{id}",
                    "host": TEMPLATE_ALIAS,
                    "methods": ["GET"],
                    "auth": "none",
                })
                .to_string(),
            )
            .map_err(|e| anyhow::anyhow!("register template: {}", e.message))?;
        host.log_info(&format!("http fixture registered template: {}", id2));
        Ok(())
    }

    fn deactivate() -> anyhow::Result<()> {
        Ok(())
    }

    fn invoke_command(name: &str, args: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let host = WasmHost;
        match name {
            // 回显请求（网关 / /api/plugin/* 转发入参的形状锚点）
            "_http_endpoint" => {
                let path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let method = args
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let query = args
                    .get("query")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let params = args
                    .get("params")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let body = args.get("body").cloned().unwrap_or(serde_json::Value::Null);
                Ok(serde_json::json!({
                    "status": 200,
                    "body": {
                        "code": 0, "message": "ok",
                        "data": { "path": path, "method": method, "query": query, "params": params, "body": body }
                    }
                }))
            }
            // 注销命令（属主仲裁测试入口）：{endpointId}
            "http-unregister" => {
                let endpoint_id = args
                    .get("endpointId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("endpointId required"))?;
                let hit = host
                    .http_unregister_endpoint(endpoint_id)
                    .map_err(|e| anyhow::anyhow!("unregister: {}", e.message))?;
                Ok(serde_json::json!({ "hit": hit }))
            }
            other => Err(anyhow::anyhow!("Unknown command: {}", other)),
        }
    }
}

wasmnest_plugin_api::wasm_entry!(HttpTestPlugin);
