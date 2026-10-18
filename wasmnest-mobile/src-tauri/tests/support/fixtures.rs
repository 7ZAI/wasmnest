//! 移动宿主测试夹具构建器（票 08 批次三自能力仓 `test_support/bare.rs` 迁入）
//!
//! 为什么迁来：`build_test_component` 读移动夹具 crate
//! （`wasmnest-mobile/packages/plugin-component-test`），`build_terminal_session_component`
//! 读应用仓 bedcode 移动工程——两者都不在能力仓，构建器住宿主测试面才不产生
//! 「能力仓读平台/应用仓」的反向耦合。
//!
//! 消费面：
//! - 集成测试（`tests/component_e2e.rs` / `ws_client_e2e.rs` /
//!   `terminal_session_e2e.rs`）经 `#[path = "support/fixtures.rs"] mod fixtures;`
//!   引入；
//! - 宿主编译单元内的 `#[cfg(test)]` 用例（`plugin/loader.rs` / `plugin/manager.rs`）
//!   经 `src/lib.rs` 的 `#[cfg(test)] #[path = "../tests/support/fixtures.rs"]` 引入
//!   （与 `mock_plugin_ws` 同款做法）。
//!
//! 产物落点与能力仓时代一致：移动 `target/fixtures`（与夹具 crate 共用 target，
//! 避免 SDK / wit-bindgen 依赖图逐夹具重复编译）。

#![allow(dead_code)]

use std::path::PathBuf;

// 平台侧测试读应用仓的集中 resolver（三仓拆分 §5-E7；移动版在 tests/common/）
#[path = "../common/app_paths.rs"]
mod app_paths;

/// 夹具共享 target 目录（`wasmnest-mobile/target/fixtures`）
///
/// terminal-session 插件与 plugin-component-test 夹具原本各写各自 `target/`，
/// 把 SDK / wit-bindgen / serde 这份相同依赖图编译两遍（各 ~170M）；共享后只编译一遍。
fn fixture_target_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/fixtures")
}

/// 测试组件字节缓存（按 features key），跨用例复用避免重复 cargo build
static COMPONENT_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>,
> = std::sync::OnceLock::new();

/// 构建真实插件组件：SDK `wasm_entry!` 宏产物（样本 = 合并后的
/// `com.wasmnest.terminal-session`（终端域 + 任务域））
///
/// 与 `build_test_component` 同链路：cargo build（wasm32，wasm feature）→
/// wit-component 编码。被测对象是 SDK 宏生成的组件（区别于手写 Guest impl
/// 的 plugin-component-test）——宏展开错误 / export! 接线错误在此暴露。
pub fn build_terminal_session_component() -> Vec<u8> {
    let cache = COMPONENT_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    const KEY: &str = "terminal-session";
    if let Some(bytes) = cache.lock().unwrap().get(KEY) {
        return bytes.clone();
    }

    // 三仓拆分 §5-E7：bedcode 移动工程住应用仓 `apps/bedcode/mobile`，经共享
    // resolver 解析（`WASMNEST_APPS_ROOT` > 兄弟目录；缺失即 panic）。
    let plugin_dir = app_paths::app_dir("bedcode", "mobile");
    let target_dir = fixture_target_dir().to_str().unwrap().to_string();
    let manifest_path = plugin_dir.join("rust/Cargo.toml").to_str().unwrap().to_string();
    let status = std::process::Command::new("cargo")
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "--target-dir",
            &target_dir,
            "--no-default-features",
            "--features",
            "wasm",
            "--manifest-path",
            &manifest_path,
        ])
        .status()
        .expect("Failed to run cargo build for terminal-session component");
    assert!(status.success(), "terminal-session WASM build failed");

    let core = std::fs::read(
        fixture_target_dir().join("wasm32-unknown-unknown/release/bedcode_plugin_terminal_session.wasm"),
    )
    .expect("Failed to read terminal-session module after build");
    // 宏产物必经 componentize（等效本函数内编码）；SDK 构建链已内置该步骤。
    // 此处直接编码 core module（若传入已组件化产物，编码器会拒绝）
    let component = wit_component::ComponentEncoder::default()
        .validate(true)
        .module(&core)
        .expect("component encoder module")
        .encode()
        .expect("component encoder encode");
    assert_eq!(
        &component[..4],
        [0x00, 0x61, 0x73, 0x6d],
        "terminal-session 组件应以 core module 段起始"
    );
    assert_eq!(
        &component[4..8],
        [0x0d, 0x00, 0x01, 0x00],
        "terminal-session 组件头应为 0d 00 01 00"
    );

    cache.lock().unwrap().insert(KEY.to_string(), component.clone());
    component
}

/// 构建并编码测试组件：cargo build（指定 features）→ wit-component 编码
pub fn build_test_component(features: &[&str]) -> Vec<u8> {
    let cache = COMPONENT_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let key = if features.is_empty() {
        "default".to_string()
    } else {
        features.join("+")
    };
    if let Some(bytes) = cache.lock().unwrap().get(&key) {
        return bytes.clone();
    }

    // 移动夹具 crate（与宿主同仓 packages/ 下）
    let plugin_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages/plugin-component-test");
    let target_dir = fixture_target_dir().to_str().unwrap().to_string();
    let features_arg = features.join(",");
    let manifest_path = plugin_dir.join("Cargo.toml").to_str().unwrap().to_string();
    let mut args = vec![
        "build",
        "--release",
        "--target",
        "wasm32-unknown-unknown",
        "--target-dir",
        &target_dir,
    ];
    if !features.is_empty() {
        args.push("--features");
        args.push(&features_arg);
    }
    args.push("--manifest-path");
    args.push(&manifest_path);

    let status = std::process::Command::new("cargo")
        .args(&args)
        .status()
        .expect("Failed to run cargo build for test component");
    assert!(status.success(), "Test component WASM build failed");

    let core = std::fs::read(
        fixture_target_dir().join("wasm32-unknown-unknown/release/wasmnest_plugin_component_test.wasm"),
    )
    .expect("Failed to read test component module after build");
    let component = wit_component::ComponentEncoder::default()
        .validate(true)
        .module(&core)
        .expect("component encoder module")
        .encode()
        .expect("component encoder encode");
    // 产物形态：核心模块段在前、组件头随后（spike 实证 00 61 73 6d 0d 00 01 00）
    assert_eq!(
        &component[..4],
        [0x00, 0x61, 0x73, 0x6d],
        "编码后组件应以 core module 段起始"
    );
    assert_eq!(
        &component[4..8],
        [0x0d, 0x00, 0x01, 0x00],
        "编码后组件头应为 0d 00 01 00"
    );

    cache.lock().unwrap().insert(key, component.clone());
    component
}
