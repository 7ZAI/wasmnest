//! 移动插件面命令身份绑定锁（ADR 0058 / issue #28）
//!
//! 锁的是**不变式**，不是实现细节：`plugin/commands.rs` 里每一条会改变状态或
//! 触达插件数据的命令，都必须带身份参数并先过门禁；任何新增命令都必须在本锁里
//! 显式归类（凭证门 / 只读 / 已知缺口），不允许「悄悄多出一条裸命令」。
//!
//! 为什么用源码扫描而不是调用测试：`#[tauri::command]` 函数要 `tauri::State` /
//! `tauri::Webview` 才能调，进程内构造不出来；而本锁要防的正是「有人新加一条
//! 命令、忘了接门」这类**形状回归**——门禁判据本身（令牌 → 身份、fail-closed）
//! 由 wasm-core `FrontendChannelRegistry` 的单测覆盖，这里只管「接没接」。
//!
//! 分类口径（与 ADR 0058 F3 推论 1 一致：任何无凭证参数的 Tauri 命令都必须按
//! 「任意前端 JS 可调用」设防）：
//! - **凭证门**：签名含 `credential: String`，且命令体在首个副作用调用（`manager.`）
//!   之前出现门禁调用（`authorize_plugin_call` / `require_host_surface` /
//!   `require_storage_access`）；
//! - **只读 / bootstrap**：不改变状态、不触达他人数据，与桌面同口径留白名单；
//! - **已知缺口**：本轮明确不在票内（另票或已登记），列名字 + 原因，出现新面孔即失败。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// 必须带身份并过门禁的命令（issue #28 收敛面 + issue #21 已落地的管理面
/// + 2026-11-02 同判据补收的授权回执与终端通道登记）
const CREDENTIAL_GATED: [&str; 19] = [
    // issue #28：插件面命令（令牌决定身份，plugin_id 只作目标）
    "plugin_invoke",
    "plugin_storage_get",
    "plugin_storage_set",
    "plugin_storage_delete",
    "plugin_mark_error",
    "plugin_report_ready",
    // issue #28：偏好写面归宿主门
    "plugin_set_enabled",
    "plugin_set_autostart",
    // issue #21：管理类命令（宿主职权）
    "plugin_preauthorize",
    "plugin_activate",
    "plugin_deactivate",
    "plugin_approve",
    "plugin_download",
    "plugin_install_from_file",
    "plugin_uninstall",
    "reload_wasm_plugin",
    // 2026-11-02 同判据补收：授权回执（桌面早有门）与终端页面通道登记
    "plugin_fs_auth_respond",
    "terminal_page_subscribe",
    "terminal_page_unsubscribe",
];

/// 令牌签发命令（身份参数是 loader 会话而不是 `credential`，单独判据）
const CHANNEL_TOKEN_COMMAND: &str = "plugin_channel_token";

/// 无身份参数的合法命令：只读查询与 bootstrap
const READ_ONLY_OR_BOOTSTRAP: [&str; 5] = [
    // 宿主前端 bootstrap：域内首个调用者生效，「无凭证」是它的语义本身
    "plugin_frontend_loader_session",
    // 只读查询面（信息面，与桌面现状一致：低危，不进本票）
    "plugin_list_loaded",
    "plugin_get_info",
    "plugin_is_enabled",
    "plugin_is_autostart",
];

/// 已知缺口：同属「无凭证命令面」，但不在本轮的收敛范围（另票 / 已登记）
///
/// 出现**新**名字即失败——新增裸命令必须先归类，不能靠本表默许。
const KNOWN_UNGATED: [&str; 4] = [
    // 日志面（只写宿主 tracing，参数自报 plugin_id，风险为伪造日志）
    "plugin_log",
    // system:open 三条（前端 requireSystemOpenPermission 自查在前，宿主不复核；
    // 触达面是「打开系统界面 / 目录」，无跨应用数据读写）
    "plugin_reveal_received_file",
    "plugin_open_all_files_access",
    "plugin_open_download_dir",
];

/// 门禁调用名（任一出现即视为「已接门」）
const GATES: [&str; 3] = [
    "authorize_plugin_call(",
    "require_host_surface(",
    "require_storage_access(",
];

/// 一条 `#[tauri::command]` 的形状：名字 / 参数表文本 / 函数体文本
struct CommandShape {
    name: String,
    signature: String,
    body: String,
}

fn commands_rs_path() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/wasmnest-mobile/src-tauri
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/plugin/commands.rs")
}

/// 按 `#[tauri::command]` 切块解析命令形状
///
/// 只做形状解析（名字 / 参数表 / 函数体），不追求通用 Rust 语法——本文件里
/// 命令一律是顶层 `pub (async) fn`，属性独占一行。
fn parse_commands(src: &str) -> Vec<CommandShape> {
    let mut blocks: Vec<Vec<&str>> = Vec::new();
    for line in src.lines() {
        if line.trim() == "#[tauri::command]" {
            blocks.push(Vec::new());
            continue;
        }
        if let Some(current) = blocks.last_mut() {
            current.push(line);
        }
    }

    blocks
        .into_iter()
        .filter_map(|lines| {
            let text = lines.join("\n");
            let fn_at = text.find("fn ")? + "fn ".len();
            let rest = &text[fn_at..];
            let name_end = rest.find('(')?;
            let name = rest[..name_end].trim().to_string();

            // 参数表：从 fn 名后的 '(' 起按括号深度找配对的 ')'
            let mut depth = 0usize;
            let mut close_at = None;
            for (offset, ch) in rest.char_indices().skip(name_end) {
                match ch {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            close_at = Some(offset);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let close_at = close_at.unwrap_or_else(|| panic!("命令 {name} 的参数表未闭合"));

            Some(CommandShape {
                name,
                signature: rest[..=close_at].to_string(),
                body: rest[close_at + 1..].to_string(),
            })
        })
        .collect()
}

/// 去掉纯注释行（本文件的「为什么」段落不该影响门禁判据）
fn code_only(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn mutating_commands_carry_credential_and_gate_before_side_effects() {
    let src = std::fs::read_to_string(commands_rs_path()).expect("读取 plugin/commands.rs 失败");
    let commands = parse_commands(&src);

    let mut violations = Vec::new();
    for expected in CREDENTIAL_GATED {
        let Some(command) = commands.iter().find(|c| c.name == expected) else {
            violations.push(format!("`{expected}`：命令不存在（锁表过期？）"));
            continue;
        };
        if !command.signature.contains("credential: String") {
            violations.push(format!("`{expected}`：签名缺 `credential: String`"));
            continue;
        }

        let body = code_only(&command.body);
        let gate_at = GATES.iter().filter_map(|gate| body.find(gate)).min();
        let Some(gate_at) = gate_at else {
            violations.push(format!("`{expected}`：命令体未出现门禁调用（{}）", GATES.join(" / ")));
            continue;
        };
        // 门禁必须先于副作用：首个 `manager.` 调用不得早于门禁调用
        if let Some(effect_at) = body.find("manager.") {
            if effect_at < gate_at {
                violations.push(format!(
                    "`{expected}`：副作用调用早于门禁（manager. 在 offset {effect_at}，门禁在 {gate_at}）"
                ));
            }
        }
    }

    assert!(violations.is_empty(), "命令面身份绑定回归：\n{}", violations.join("\n"));
}

#[test]
fn channel_token_requires_loader_session_and_running_state() {
    let src = std::fs::read_to_string(commands_rs_path()).expect("读取 plugin/commands.rs 失败");
    let commands = parse_commands(&src);
    let token_cmd = commands
        .iter()
        .find(|c| c.name == CHANNEL_TOKEN_COMMAND)
        .unwrap_or_else(|| panic!("`{CHANNEL_TOKEN_COMMAND}` 缺失：插件面命令无法取得身份令牌"));

    assert!(
        token_cmd.signature.contains("loader_session: String"),
        "`{CHANNEL_TOKEN_COMMAND}` 必须以 loader 会话为签发前置（插件前端不该自取令牌）"
    );
    let body = code_only(&token_cmd.body);
    assert!(
        body.contains("verify_loader_session("),
        "`{CHANNEL_TOKEN_COMMAND}` 未校验 loader 会话：任意前端可自签身份"
    );
    assert!(
        body.contains("is_running("),
        "`{CHANNEL_TOKEN_COMMAND}` 未校验运行态：未激活插件也会拿到令牌"
    );
    assert!(
        body.contains("issue_token("),
        "`{CHANNEL_TOKEN_COMMAND}` 未走 registry 签发"
    );
}

#[test]
fn storage_commands_check_activation_and_storage_permission() {
    let src = std::fs::read_to_string(commands_rs_path()).expect("读取 plugin/commands.rs 失败");

    // 三段（身份 → 运行态 → storage 权限）收敛在 require_storage_access，替身只此一份
    let helper_at = src
        .find("async fn require_storage_access(")
        .expect("缺 `require_storage_access`：存储面三段校验的唯一实现点");
    let helper_body = code_only(&src[helper_at..]);
    let helper_body = &helper_body[..helper_body.find("\n}").unwrap_or(helper_body.len())];

    for needle in ["is_running(", "has_permission(", "\"storage\""] {
        assert!(
            helper_body.contains(needle),
            "`require_storage_access` 缺 `{needle}`：移动存储面退化回「只查令牌」"
        );
    }

    // 三条存储命令都必须经该 helper（不得绕开去直接调 manager.storage()）
    let commands = parse_commands(&src);
    for name in ["plugin_storage_get", "plugin_storage_set", "plugin_storage_delete"] {
        let command = commands
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("`{name}` 缺失"));
        assert!(
            code_only(&command.body).contains("require_storage_access("),
            "`{name}` 未走三段校验"
        );
    }
}

#[test]
fn every_command_is_classified() {
    let src = std::fs::read_to_string(commands_rs_path()).expect("读取 plugin/commands.rs 失败");
    let actual: BTreeSet<String> = parse_commands(&src).into_iter().map(|c| c.name).collect();

    let mut declared: BTreeSet<String> = BTreeSet::new();
    declared.extend(CREDENTIAL_GATED.iter().map(|s| s.to_string()));
    declared.extend(READ_ONLY_OR_BOOTSTRAP.iter().map(|s| s.to_string()));
    declared.extend(KNOWN_UNGATED.iter().map(|s| s.to_string()));
    declared.insert(CHANNEL_TOKEN_COMMAND.to_string());

    let unclassified: Vec<&String> = actual.difference(&declared).collect();
    let stale: Vec<&String> = declared.difference(&actual).collect();

    assert!(
        unclassified.is_empty(),
        "未归类的新命令（必须显式决定身份面）：{unclassified:?}\n\
         变更类命令要带 `credential: String` 并先过门禁，只读命令请加入 READ_ONLY_OR_BOOTSTRAP"
    );
    assert!(stale.is_empty(), "锁表里登记了不存在的命令（表已过期）：{stale:?}");
}

#[test]
fn read_only_surface_stays_credential_free() {
    let src = std::fs::read_to_string(commands_rs_path()).expect("读取 plugin/commands.rs 失败");
    let commands = parse_commands(&src);

    // 反向断言：只读面若被「顺手」加了 credential，调用方会白跑一次签发，
    // 且真实语义（低危信息面）会被误读成已设防——两条路都不该悄悄发生。
    for name in READ_ONLY_OR_BOOTSTRAP {
        let command = commands.iter().find(|c| c.name == name).expect("只读命令缺失");
        assert!(
            !command.signature.contains("credential: String"),
            "`{name}` 是只读 / bootstrap 面，不该要求 credential（如已改判，请同步锁表与 ADR）"
        );
    }
}
