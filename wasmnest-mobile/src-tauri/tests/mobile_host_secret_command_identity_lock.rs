//! 移动宿主机密命令身份绑定锁（安全审查 #42 / #43，2026-11-02）
//!
//! 与 `mobile_plugin_command_identity_lock.rs` 同一判据、不同面：
//! - 那边锁 `plugin/commands.rs`（插件面命令，身份 = 插件通道令牌 / 宿主凭证）；
//! - 这边锁 `commands/{auth,connection,egress,http_proxy}.rs`——**宿主机密面**：
//!   认证凭据、全局 JWT、连接目标、链路加密开关、egress 决策、HTTP 出站。
//!
//! 为什么必须锁：移动运行面与宿主壳同 webview（ADR 0058 F2），任何随包 / 用户安装
//! 应用的前端都能裸 invoke 这些命令。这些命令一旦「漏接门」，缺失是**静默**的
//! ——功能照用、界面无异常，只有攻击者知道边界没了。ADR 0058 F3 推论 1：
//! 任何无凭证参数的 Tauri 命令都必须按「任意前端 JS 可调用」设防。
//!
//! 判据（形状回归，不追求通用 Rust 语法）：
//! - 签名必须含 `credential: String`；
//! - 命令体必须出现门禁调用（`require_host_surface(` / `require_host_connection_surface(`
//!   / `require_host_token_surface(` / `require_egress_host(` / `resolve_caller(`）；
//! - 门禁必须**先于**首个副作用（`manager.` / `get_connection_manager(` / `set_global_token(`
//!   / `clear_global_token(` / `crate::egress::policy()`）；
//! - 只读 / 无身份语义的命令走显式白名单，且反向断言其**没有**凭证参数；
//! - 未归类的命令（含新增）一律失败——不允许「悄悄多出一条裸命令」。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// 待扫的命令面文件（相对 `src-tauri`）
const COMMAND_FILES: [&str; 4] = [
    "src/commands/auth.rs",
    "src/commands/connection.rs",
    "src/commands/egress.rs",
    "src/commands/http_proxy.rs",
];

/// 必须带 `credential` 且先过门禁的命令（宿主机密面全量）
const CREDENTIAL_GATED: [&str; 16] = [
    // auth.rs：JWT / 设备凭据 / 生物密钥（#42）
    "ws_authenticate",
    "ws_get_auth_credentials",
    "ws_bind_biometric_credential",
    "ws_unbind_biometric_credential",
    "ws_get_biometric_key_status",
    // connection.rs：连接目标 + token + 链路加密开关（#42）
    "ws_connect",
    "ws_disconnect",
    "ws_reconnect",
    "set_auto_reconnect",
    "get_ws_token",
    "ws_get_token",
    "ws_set_token",
    "ws_clear_token",
    "set_link_crypto_context",
    // egress.rs：目标声明与授权回执（#42）
    "egress_declare_desktop_target",
    "egress_consent_resolve",
];

/// HTTP 出站面：身份分流（宿主 vs 应用），门禁是 `resolve_caller(` 而不是宿主门
const CALLER_RESOLVED: [&str; 2] = ["http_request", "http_cancel"];

/// 无身份参数的合法命令：只读查询（不改变状态、不触达他人数据）
const READ_ONLY: [&str; 3] = ["ws_get_status", "ws_is_connected", "get_ws_url"];

/// 任一门禁调用名（出现即视为「已接门」）
const GATES: [&str; 5] = [
    "require_host_surface(",
    "require_host_connection_surface(",
    "require_host_token_surface(",
    "require_egress_host(",
    "resolve_caller(",
];

/// 副作用调用名（门禁必须先于这些调用出现）
const SIDE_EFFECTS: [&str; 5] = [
    "manager.",
    "get_connection_manager(",
    "set_global_token(",
    "clear_global_token(",
    "crate::egress::policy()",
];

/// 一条 `#[tauri::command]` 的形状：名字 / 参数表文本 / 函数体文本
struct CommandShape {
    name: String,
    signature: String,
    body: String,
}

fn src_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/wasmnest-mobile/src-tauri
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

/// 按 `#[tauri::command]` 切块解析命令形状（与插件面锁同一套极简解析）
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

/// 只取该命令自己的函数体：截到首个顶格 `}`（后续无属性的辅助函数会被并进
/// 同一块文本——不截断会把辅助函数里的 `let source` 误判成命令自身的缺陷）
fn code_only(text: &str) -> String {
    let body: Vec<&str> = text
        .lines()
        .take_while(|line| line.trim_end() != "}")
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect();
    body.join("\n")
}

/// 收集四文件全部命令（名字 → 形状），文件缺失即失败（扫描面失效不能静默）
fn collect_all() -> Vec<CommandShape> {
    let mut all = Vec::new();
    for rel in COMMAND_FILES {
        let path = src_root().join(rel);
        let src = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读取 {rel} 失败（扫描面失效）：{e}"));
        let parsed = parse_commands(&src);
        assert!(
            !parsed.is_empty(),
            "{rel} 里没有解析到任何 `#[tauri::command]`——解析器或文件形状变了，锁失效"
        );
        all.extend(parsed);
    }
    all
}

#[test]
fn host_secret_commands_carry_credential_and_gate_before_side_effects() {
    let commands = collect_all();
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
            violations.push(format!(
                "`{expected}`：命令体未出现门禁调用（{}）",
                GATES.join(" / ")
            ));
            continue;
        };
        if let Some((effect_at, effect)) = SIDE_EFFECTS
            .iter()
            .filter_map(|needle| body.find(needle).map(|at| (at, *needle)))
            .min_by_key(|(at, _)| *at)
        {
            if effect_at < gate_at {
                violations.push(format!(
                    "`{expected}`：副作用 `{effect}` 早于门禁（offset {effect_at} < {gate_at}）"
                ));
            }
        }
    }

    assert!(violations.is_empty(), "宿主机密命令面身份回归：\n{}", violations.join("\n"));
}

#[test]
fn http_surface_resolves_caller_identity() {
    let commands = collect_all();
    let mut violations = Vec::new();

    for expected in CALLER_RESOLVED {
        let Some(command) = commands.iter().find(|c| c.name == expected) else {
            violations.push(format!("`{expected}`：命令不存在（锁表过期？）"));
            continue;
        };
        if !command.signature.contains("credential: String") {
            violations.push(format!("`{expected}`：签名缺 `credential: String`"));
            continue;
        }
        let body = code_only(&command.body);
        if !body.contains("resolve_caller(") {
            violations.push(format!(
                "`{expected}`：未解析调用方身份（应用前端与宿主同 webview，身份不能默认成 host）"
            ));
        }
        // 反向断言：HTTP 出站面不得使用「只认宿主」的门——否则应用无法代理自己的请求；
        // 也不得把 source 写死成宿主（#43 的原始缺陷形态）。
        if body.contains("require_host_surface(") {
            violations.push(format!(
                "`{expected}`：HTTP 面用了纯宿主门——应用请求会被全拒；应改用 resolve_caller 分流"
            ));
        }
        if body.contains("let source = \"host\"") {
            violations.push(format!("`{expected}`：source 仍被写死成宿主"));
        }
    }

    assert!(violations.is_empty(), "HTTP 面身份分流回归：\n{}", violations.join("\n"));
}

#[test]
fn every_command_is_classified() {
    let actual: BTreeSet<String> = collect_all().into_iter().map(|c| c.name).collect();

    let mut declared: BTreeSet<String> = BTreeSet::new();
    declared.extend(CREDENTIAL_GATED.iter().map(|s| s.to_string()));
    declared.extend(CALLER_RESOLVED.iter().map(|s| s.to_string()));
    declared.extend(READ_ONLY.iter().map(|s| s.to_string()));

    let unclassified: Vec<&String> = actual.difference(&declared).collect();
    let stale: Vec<&String> = declared.difference(&actual).collect();

    assert!(
        unclassified.is_empty(),
        "未归类的新命令（必须显式决定身份面）：{unclassified:?}\n\
         宿主机密面 / 状态面要带 `credential: String` 并先过门禁；HTTP 出站面用 resolve_caller；\
         只读命令请加入 READ_ONLY"
    );
    assert!(stale.is_empty(), "锁表里登记了不存在的命令（表已过期）：{stale:?}");
}

#[test]
fn read_only_surface_stays_credential_free() {
    let commands = collect_all();

    // 反向断言：只读面若被「顺手」加了 credential，调用方会白跑一次签发，
    // 且真实语义（低危信息面）会被误读成已设防。
    for name in READ_ONLY {
        let command = commands.iter().find(|c| c.name == name).expect("只读命令缺失");
        assert!(
            !command.signature.contains("credential: String"),
            "`{name}` 是只读面，不该要求 credential（如已改判，请同步锁表与 ADR）"
        );
    }
}
