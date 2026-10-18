//! SDK 夹具产物 keeper（票 08 批次三自能力仓迁入桌面宿主测试面）
//!
//! 夹具 crate（`packages/plugin-sdk-fixtures` / `plugin-system-test`）与产物落点
//! （`wasmnest-desktop/target/fixtures`）都属平台仓；宿主 e2e 只读不建（见
//! `support::{sdk_fixture_artifact_bytes, system_test_artifact_bytes}` 的缺失报错
//! 文案）。本二进制是**唯一的产物构建方**：没有它，宿主 e2e 会在「产物缺失」上红，
//! 且该红指向一条没人负责的重建路径。
//!
//! 各夹具一个 keeper 用例（feature 名 = `plugin-sdk-fixtures` 的 cargo feature）：
//! - `crypto`（宿主角：`host_crypto_e2e`，host-crypto WIT 实现已迁宿主）；
//! - `task`（宿主角：`task_e2e`，host-task WIT 实现已迁宿主）；
//! - `pty` / `ws`（宿主角：`terminal_output_perf` / `ws_e2e`）；
//! - `sdk` / `http`（宿主角：`component_e2e` / `sdk_e2e` / `engine_e2e` /
//!   `owner_e2e` / `wasm_flow_e2e` / `http_e2e`）；
//! - system-test 独立 crate（宿主角：`system_component_test`）。
//!
//! 95% 的调用会命中缓存（产物在场且不比源文件旧即返回），keeper 的成本 = 一次
//! 存在性检查 + mtime 递归扫描。

mod support;

use support::fixture_build::{build_sdk_fixture, build_system_test_fixture, wasip3_toolchain_ready};

/// keeper 共用断言体（各夹具一个入口用例，skip 口径一致）
fn keep_fixture_alive(feature: &str) {
    // 工具链未装（CI stable / 本地未 install）时跳过——夹具构建走 pinned nightly +
    // wasm32-wasip3，缺工具链不是本用例要抓的回归。
    if !wasip3_toolchain_ready() {
        eprintln!(
            "[skip] wasip3 工具链未安装，{feature} 夹具产物未构建——宿主侧 e2e 会在产物缺失处显性报错（先补工具链跑本 keeper）"
        );
        return;
    }
    let bytes = build_sdk_fixture(feature);
    assert!(
        bytes.len() > 1024,
        "{feature} 夹具产物异常（{} 字节）——构建成功但产物为空/截断",
        bytes.len()
    );
}

#[test]
fn crypto_fixture_artifact_is_built_for_host_e2e() {
    keep_fixture_alive("crypto");
}

#[test]
fn task_fixture_artifact_is_built_for_host_e2e() {
    keep_fixture_alive("task");
}

#[test]
fn pty_fixture_artifact_is_built_for_host_e2e() {
    keep_fixture_alive("pty");
}

#[test]
fn ws_fixture_artifact_is_built_for_host_e2e() {
    keep_fixture_alive("ws");
}

#[test]
fn sdk_fixture_artifact_is_built_for_host_e2e() {
    keep_fixture_alive("sdk");
}

#[test]
fn http_fixture_artifact_is_built_for_host_e2e() {
    keep_fixture_alive("http");
}

/// 系统组件夹具（consumer = `system_component_test.rs` 的 L1 基础服务 / 能力路由 /
/// trap 隔离场景）。它不走 `plugin-sdk-fixtures` 的 feature 合集，而是独立 crate
/// `packages/plugin-system-test`，故构建器也独立；缺本 keeper 时该夹具**无人构建**，
/// 桌面集成测试会在 `support::system_test_artifact_bytes` 的「产物缺失」上红——
/// 6 个用例同因。
#[test]
fn system_test_fixture_artifact_is_built_for_host_e2e() {
    if !wasip3_toolchain_ready() {
        eprintln!(
            "[skip] wasip3 工具链未安装，system-test 夹具产物未构建——桌面 system_component_test 会在产物缺失处显性报错（先补工具链跑本 keeper）"
        );
        return;
    }
    let bytes = build_system_test_fixture();
    assert!(
        bytes.len() > 1024,
        "system-test 夹具产物异常（{} 字节）——构建成功但产物为空/截断",
        bytes.len()
    );
}
