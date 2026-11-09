//! 桌面宿主面命令身份绑定锁（ADR 0058 方案 A / 安全审查 #48、#45）
//!
//! 锁的是**不变式**：宿主 UI 职权的写命令必须带宿主面凭证、且门禁先于副作用。
//! 应用前端与宿主同 webview、共享同一 Tauri IPC——「命令不带凭证」等于「任意应用
//! 可调用」，所以这类命令的签名里 `credential` 与命令体里的 `require_host_frontend`
//! 是形状契约，不是实现细节。
//!
//! 为什么用源码扫描而不是调用测试：`#[tauri::command]` 函数要 `tauri::State` /
//! `tauri::Webview` 才能调，进程内构造不出来；本锁要防的正是「有人改签名把门摘了」
//! 这类形状回归。门禁判据本身（凭证 → 身份、fail-closed）由 wasm-core
//! `FrontendChannelRegistry` 的单测覆盖，这里只管「接没接、在不在副作用之前」。
//!
//! 未纳入本锁的面（显式登记，防「以为锁住了」）：
//! - `plugin_mark_error` 已按 #48 收口：桌面版本改为 `src/plugin/lifecycle.rs`
//!   的插件自报面（插件令牌只能标自己），归 `PLUGIN_GATED` 表锁形状；
//!   `api_bridge` 的无凭证同名命令仍被 glob 再导出，但**不再注册**；
//! - `set_terminal_bg_image` / `update_server_{port,network_config}` /
//!   `reset_server_network_config`——前者应改为原生对话框（#44），后三条当前由
//!   bedcode 应用前端直接调用（#45），改宿主门会破坏应用，需先裁决归属
//!   （宿主门 vs 应用令牌 + 权限位）。
//! - 链路加密策略属于应用（2026-11-04 裁决）：写命令 `set_app_link_crypto_policy`
//!   归 `PLUGIN_GATED`（own-token，只能改自己）；宿主设置页只读审计，没有整机下限。

use std::path::{Path, PathBuf};

/// 必须带宿主凭证并过门的命令：(命令名, 源文件, 首个副作用特征串)
///
/// 副作用特征串用于断言「门禁先于副作用」——只看有没有 `credential` 参数，挡不住
/// 「先把事做了再验身份」这种顺序错误。
const HOST_GATED: [(&str, &str, &str); 9] = [
    // #48：界面租约——释放他人租约 = 掐断对端传输
    ("plugin_surface_open", "src/commands.rs", "acquire_for_surface"),
    ("plugin_surface_close", "src/commands.rs", "release_for_surface"),
    // #48：启停 / 自启偏好（宿主界面职权，持久化）
    ("plugin_set_enabled", "src/plugin/lifecycle.rs", "manager.set_enabled"),
    (
        "plugin_set_autostart",
        "src/plugin/lifecycle.rs",
        "manager.set_autostart",
    ),
    // #45：整份 AppConfig 写入口（含 network / ui / terminal / log）
    ("save_app_settings", "src/commands.rs", "settings.save"),
    // 宿主 UI 职权：退出 / 更新安装 / 日志级别与容量（应用前端可裸 invoke 时
    // 任意应用能退宿主、触发安装、写盘 DoS）
    ("confirm_window_close", "src/commands.rs", "begin_graceful_shutdown"),
    ("install_update", "src/commands.rs", "updater()"),
    ("save_log_settings", "src/commands.rs", "config.save"),
    ("set_log_level", "src/commands.rs", "file_level_reload"),
];

/// 插件自报面：必须带通道令牌，且「只能标自己」（#48）
///
/// 与宿主门分开判：这里的门是 `FrontendChannelRegistry::authorize`（插件令牌的
/// 目标必须等于自己；宿主凭证可代报任意目标），不是 `require_host_frontend`。
const PLUGIN_GATED: [(&str, &str, &str); 2] = [
    ("plugin_mark_error", "src/plugin/lifecycle.rs", "mark_error("),
    // 链路加密策略按应用：own-token 目标必须等于自己；副作用先落策略表再落库
    (
        "set_app_link_crypto_policy",
        "src/commands.rs",
        "link_crypto::set_app_policy",
    ),
];

/// 门禁调用名（宿主面凭证门的唯一实现点）
const GATE: &str = "require_host_frontend(";

/// 一条 `#[tauri::command]` 的形状：名字 / 参数表文本 / 函数体文本
struct CommandShape {
    name: String,
    signature: String,
    body: String,
}

fn src_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/wasmnest-desktop/src-tauri
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

/// 按 `#[tauri::command]` 切块解析命令形状
///
/// 只做形状解析（名字 / 参数表 / 函数体），不追求通用 Rust 语法——本仓命令一律是
/// 顶层 `pub (async) fn`，属性独占一行。
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

/// 去掉纯注释行（「为什么」段落不该影响门禁判据）
fn code_only(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn read_source(relative: &str) -> String {
    let path = src_root().join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读取 {} 失败: {e}", path.display()))
}

/// 插件自报面：签名带 `credential`，`authorize(` 先于副作用（#48）
#[test]
fn plugin_gated_commands_authorize_before_side_effects() {
    // 旧实现在 wasm-core（跨 crate），桌面经 glob 再导出且直接注册；现在注册的
    // 是 `src/plugin/lifecycle.rs` 的身份门版本。这条锁防「注册路径改回去 / 本地
    // 定义被删」后命令面静默落回无门版本。
    let bootstrap = read_source("src/bootstrap/run.rs");
    assert!(
        bootstrap.contains("plugin::lifecycle::plugin_mark_error"),
        "bootstrap 未注册 identity-gated 的 plugin_mark_error（注册路径改回去了？）"
    );
    assert!(
        !bootstrap.contains("commands::plugin_mark_error"),
        "bootstrap 仍注册 api_bridge 的无凭证 plugin_mark_error（#48 回接）"
    );

    let mut violations = Vec::new();
    for (name, file, effect) in PLUGIN_GATED {
        let src = read_source(file);
        let commands = parse_commands(&src);
        let Some(command) = commands.iter().find(|c| c.name == name) else {
            violations.push(format!("`{name}`（{file}）：命令不存在（锁表过期 / 本地定义被删？）"));
            continue;
        };
        if !command.signature.contains("credential: String") {
            violations.push(format!("`{name}`：签名缺 `credential: String`"));
            continue;
        }
        let body = code_only(&command.body);
        // 插件面身份门有两种合法调用形态：直接 `authorize(`（前端通道）或
        // 统一封装 `authorize_plugin_call(`（跨 crate 复用，语义同源）
        let Some(gate_at) = body.find("authorize(").or_else(|| body.find("authorize_plugin_call(")) else {
            violations.push(format!(
                "`{name}`：命令体未出现插件身份门（authorize( / authorize_plugin_call(）"
            ));
            continue;
        };
        if let Some(effect_at) = body.find(effect) {
            if effect_at < gate_at {
                violations.push(format!(
                    "`{name}`：副作用（{effect}）早于身份门（offset {effect_at} < {gate_at}）"
                ));
            }
        } else {
            violations.push(format!("`{name}`：未找到副作用特征串 `{effect}`（锁表需更新）"));
        }
    }
    assert!(
        violations.is_empty(),
        "插件自报面身份绑定回归：\n{}",
        violations.join("\n")
    );
}

#[test]
fn host_gated_commands_carry_credential_and_gate_before_side_effects() {
    let mut violations = Vec::new();

    for (name, file, effect) in HOST_GATED {
        let src = read_source(file);
        let commands = parse_commands(&src);
        let Some(command) = commands.iter().find(|c| c.name == name) else {
            violations.push(format!("`{name}`（{file}）：命令不存在（锁表过期？）"));
            continue;
        };
        if !command.signature.contains("credential: String") {
            violations.push(format!("`{name}`：签名缺 `credential: String`"));
            continue;
        }

        let body = code_only(&command.body);
        let Some(gate_at) = body.find(GATE) else {
            violations.push(format!("`{name}`：命令体未出现门禁调用（{GATE}）"));
            continue;
        };
        if let Some(effect_at) = body.find(effect) {
            if effect_at < gate_at {
                violations.push(format!(
                    "`{name}`：副作用（{effect}）早于门禁（offset {effect_at} < {gate_at}）"
                ));
            }
        } else {
            violations.push(format!("`{name}`：未找到副作用特征串 `{effect}`（锁表需更新）"));
        }
    }

    assert!(
        violations.is_empty(),
        "宿主面命令身份绑定回归：\n{}",
        violations.join("\n")
    );
}

/// 门禁实现必须是「只认宿主凭证」：缺了 `require_host_identity` 就等于任何人都放行
#[test]
fn host_gate_only_accepts_host_credential() {
    let src = read_source("src/plugin.rs");
    let helper_at = src
        .find("pub(crate) fn require_host_frontend(")
        .expect("缺 `require_host_frontend`：宿主面凭证门的唯一实现点");
    let helper = code_only(&src[helper_at..]);
    let helper = &helper[..helper.find("\n}").unwrap_or(helper.len())];

    for needle in ["require_host_identity(", "webview_label", "credential"] {
        assert!(
            helper.contains(needle),
            "`require_host_frontend` 缺 `{needle}`：宿主门退化成无判据放行"
        );
    }
    // fail-visible：拒绝分支必须真的返回错误，不能「拒绝即 Ok」
    assert!(
        helper.contains("AppError::Plugin("),
        "宿主门拒绝分支必须返回错误（不得降级为放行）"
    );
}

/// app 前端 `env.invoke` 白名单与身份边界的形状锁（spec §8 / §9）
///
/// 两条判据：
/// 1. 宿主门写命令**不得**进白名单——白名单是前端失败面（ADR 0058 方案 A），
///    把写命令列进去会给应用一个「看起来可用」的入口，最终仍被 Rust 门拒绝，
///    排查时会把「前端白名单」和「宿主凭证门」两种拒绝混在一起；
/// 2. 应用声明 `required` 端点前必须能确认宿主能力（spec §8），只读能力查询
///    必须可经 `env.invoke` 取用——删掉它等于把旧宿主路径变成静默失败。
#[test]
fn app_invoke_whitelist_matches_identity_boundary() {
    let src = read_source("src/commands.rs");
    let at = src
        .find("pub const APP_FRONTEND_INVOKE_WHITELIST")
        .expect("缺 `APP_FRONTEND_INVOKE_WHITELIST`：app 前端 env.invoke 真源");
    let rest = &src[at..];
    // 从 `= &[` 之后开始切：类型注解 `&[&str]` 里也有一个 `]`，先切会把数组内容切没
    let values_at = rest.find("= &[").expect("白名单声明形状变了（缺 `= &[`）");
    let values = &rest[values_at..];
    let end = values.find(']').expect("白名单数组未闭合");
    let list = &values[..end];

    for (name, _, _) in HOST_GATED {
        let needle = format!("\"{name}\"");
        assert!(
            !list.contains(needle.as_str()),
            "宿主门写命令 `{name}` 不得进 app 前端 env.invoke 白名单"
        );
    }
    assert!(
        list.contains("\"get_link_crypto_capabilities\""),
        "只读能力查询 `get_link_crypto_capabilities` 必须可经 env.invoke 取用（spec §8）"
    );
    assert!(
        !list.contains("\"get_link_crypto_app_policies\""),
        "应用策略审计是宿主只读面，不下放给应用前端"
    );
    assert!(
        !list.contains("\"set_app_link_crypto_policy\""),
        "应用策略写入口必须走 own-token 通道，不得进无身份白名单"
    );
}
