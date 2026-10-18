//! 生命周期命令面注册完备性锁（桌面 · 2026-10-17 lifecycle-sync）
//!
//! `#[tauri::command]` 只是给函数贴一个可被 invoke 的标签——真正让它成为命令的
//! 是 `lib.rs` 里 `generate_handler![…]` 的注册条目。两处不一致编译器不校验：
//! 漏注册能过 `cargo build`、能在测试里直接调用，只有前端 `invoke` 到时才回
//! "command not found"（移动端 `plugin_approve` 漏注册真实咬过，见移动端
//! `command_registration_completeness_lock.rs` 头注释）。
//!
//! 本锁只钉 2026-10-17 新增的六臂（D3：桌面补移动端同款缺失臂）——它们是
//! 壳动作（启停/审批/偏好）的真正落点，漏一条壳的「关闭应用 / 自启开关」就
//! 会在运行时静默失效：
//! `plugin_is_enabled / plugin_set_enabled / plugin_is_autostart /
//! plugin_set_autostart / plugin_is_running / plugin_is_activated`。

use std::path::{Path, PathBuf};

const LIFECYCLE_COMMANDS: [&str; 6] = [
    "plugin_is_enabled",
    "plugin_set_enabled",
    "plugin_is_autostart",
    "plugin_set_autostart",
    "plugin_is_running",
    "plugin_is_activated",
];

fn src_tauri_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn read_file(rel: &str) -> String {
    std::fs::read_to_string(src_tauri_root().join(rel)).expect("read source file")
}

/// lib.rs 的 generate_handler 注册块（去注释；注释里的命令名是记账，不是注册）
fn registered_block() -> String {
    let lib = read_file("src/lib.rs");
    let start = lib
        .find("generate_handler![")
        .unwrap_or_else(|| panic!("lib.rs 必须包含 generate_handler![ 注册块"));
    let body = &lib[start..];
    body.lines()
        .filter_map(|raw| {
            let line = raw.split("//").next().unwrap_or("").trim();
            (!line.is_empty() && !line.starts_with('#')).then_some(line)
        })
        .take_while(|line| !line.contains(']'))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn lifecycle_commands_are_registered_in_the_invoke_handler() {
    let block = registered_block();
    for name in LIFECYCLE_COMMANDS {
        assert!(
            block.contains(&format!("::{}", name)),
            "命令 {name} 未在 lib.rs generate_handler! 注册——\
             壳 invoke 会得到 \"command not found\"，而 Rust 侧照常编译通过。\
             修法：lib.rs 注册 `plugin::lifecycle::{name}`,"
        );
    }
}

#[test]
fn lifecycle_commands_are_declared_with_tauri_command_attr() {
    let lifecycle = read_file("src/plugin/lifecycle.rs");
    for name in LIFECYCLE_COMMANDS {
        // 声明形态：`#[tauri::command]` 之后 `pub async fn <name>`
        let attr = lifecycle
            .find("#[tauri::command]")
            .unwrap_or_else(|| panic!("lifecycle.rs 必须至少有一个 #[tauri::command]"));
        let _ = attr;
        assert!(
            lifecycle.contains(&format!("pub async fn {name}(")),
            "命令 {name} 缺 #[tauri::command] 声明（或改名后未同步本锁）"
        );
    }
}

#[test]
fn the_lifecycle_command_face_is_non_empty() {
    // 防判据自身失效：扫描写法坏了会空跑成全绿
    let lifecycle = read_file("src/plugin/lifecycle.rs");
    let declared = LIFECYCLE_COMMANDS
        .iter()
        .filter(|name| lifecycle.contains(&format!("pub async fn {name}(")))
        .count();
    assert!(
        declared >= 6,
        "命令声明解析失败（只数到 {declared} 条），需检查扫描约定"
    );
    let block = registered_block();
    let registered = LIFECYCLE_COMMANDS
        .iter()
        .filter(|name| block.contains(&format!("::{}", name)))
        .count();
    assert!(
        registered >= 6,
        "命令注册解析失败（只数到 {registered} 条），需检查扫描约定"
    );
}
