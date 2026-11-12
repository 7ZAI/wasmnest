//! session 域（trust/consent/config/http/编排）闭环
//!
//! **wasm-core 纯净性收口票 05b（2026-10-06）从 `wasmnest-wasm-core` 迁入宿主侧**：
//! 本文件加载真实产品插件产物（`resources/plugins/desktop/*.wasm`），是跨 crate 集成
//! 测试——用户裁定全部此类测试归宿主侧 `src-tauri/tests/`（wasm-core 只留测机制本体
//! 的 SDK fixture 测试）。脚手架改经 `wasmnest_wasm_core::test_support`（常编译公开
//! 基建，见 .scratch/2026-10-06-wasm-core-purity/spec.md §6.0.1）；已回宿主 lib 的
//! 桥接（`utils::session_gateway` / `utils::auth::auth_center`）直接用 lib 真源；
//! 产品 api 名 / 插件 id 常量随测试归宿主（P0-1 彻底闭环）。

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

// 宿主测试统一入口模块：`setup_wasm_runtime` 在此是注入 DesktopGuestEvents 的包装
// （内核 test_support 的同名入口不注入派发器，误用会让 `events` 投递走
// `UnwiredGuestEvents`——intercall 到插件的请求无人处理 → api_call 5s 超时）。
// 只显式引入所需一项，不用 glob（本文件自有大量同名 helper）。
#[path = "../support/mod.rs"]
mod support;
use support::setup_wasm_runtime;
// 夹具产物读取面与会话 api 清单（票 08 批次三：住宿主测试 support，不再经内核 re-export）
use support::{sdk_fixture_artifact_bytes, session_apis};

use wasmnest_desktop_lib::wasm_core::manager::runtime::LoadedWasmPlugin;
use wasmnest_desktop_lib::wasm_core::runtime_util::block_on_async;
use wasmnest_desktop_lib::wasm_core::test_support::{
    lock_auth_center_desk, plugin_db_root, session_plugin_db_guard, AuthCenterCaptureHandler, TestInstanceDispatcher,
};

/// 经插件命令面向**配置真源**（插件私有库）播种一条配置 → 写入后的配置
///
/// 测试播种必须落真源：v21 起主库 `session_configs` 只剩 legacy 迁移通道（已无写者），
/// 插件侧解析链（task 域 agent / workingDir 判定、scheduled → launch spec）读的是私有库。
/// 只写主库的 fixture 对解析链不可见，会让用例测到一个生产里不存在的形状。
///
/// v24（2026-09-22）：主库 `session_configs` 表退役，返回 upsert 回执 JSON
/// （camelCase，含 `id`）——不再依赖已删除的 `crate::db::SessionConfig` 模型。
async fn seed_config_in_plugin_store(
    plugin: &mut LoadedWasmPlugin,
    name: &str,
    working_dir: &str,
    command: &str,
) -> serde_json::Value {
    let draft = serde_json::json!({
        "name": name,
        "environment": "linux",
        "workingDir": working_dir,
        "command": command,
    });
    let out = plugin
        .invoke_command("session.config.upsert", &draft.to_string())
        .expect("seed config via plugin command");
    serde_json::from_str(&out).expect("seeded config json")
}

/// 会话创建回执 → session id（`sessionId` 字段契约在插件产出口）。
///
/// e2e 作为插件集成测试的一部分解析回执驱动后续网关调用；宿主生产代码零解析
/// （2026-09-25 网关 Value 化）。
fn session_id_of(reply: serde_json::Value, what: &str) -> String {
    reply["sessionId"]
        .as_str()
        .unwrap_or_else(|| panic!("{what}: session-create reply missing sessionId: {reply}"))
        .to_string()
}

mod session_flow;
mod task_domain;
mod trust_io;
