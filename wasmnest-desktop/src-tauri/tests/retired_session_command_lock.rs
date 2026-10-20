//! 已注销的会话命令面防回接锁（票 08）
//!
//! 原住能力仓 `wasm-core/src/manager/host/api_bridge.rs` 的内联测试——它扫描的是
//! **桌面宿主源码**（外加能力仓 server 侧 crate），主题属平台侧判据；三仓拆分票 08
//! 批次三迁入桌面宿主测试面后，平台仓装配下宿主经 sibling `../wasmnest-lib` 入图，
//! 能力仓侧 crate 同场可读。
//!
//! 注销的是「宿主-会话」这一族命令（`list_sessions` / `get_session` /
//! `resize_session` / `write_to_session` / `send_special_key`）与
//! `plugin_terminal_send_input`。判据是**两侧同时干净**（票 08 验收原文）：
//!
//! - Rust 侧：`generate_handler!` 注册表与 `commands::` 路径都不再出现；
//! - 前端侧：没有任何 `invoke('…')` 还能调到已注销的命令名。
//!
//! 只扫非注释行——各模块的「为什么删」说明段落里出现这些名字是**记账**。
//! 注释豁免的代价是「把回接写进注释不算违规」，这是有意的：注释不参与运行。
//!
//! 扫描面含**六个 server lib crate 的 `src`**（server-lib-split 票 07）：宿主侧
//! 的会话命令面与 WS 面的会话观察面是对偶的一族退役面（`host-session` /
//! `host-terminal` interface 已于 ABI v27 退役），命令名若被回接到面 crate 里，
//! 只扫宿主 `src` 的锁看不见。crate 清单来自 wasm-core 公开登记表
//! （`crate_boundary_lock::server_lib_src_roots`，单一事实源，避免两处登记表漂移）。
//!
//! **已知判据边界**（票 07 变异自检实测）：Rust 侧 needle 只认 `commands::` 限定
//! 形态，所以面 crate 里一个**裸**的 `list_sessions` 不会被本锁拦下（M8 变异实测
//! 假绿、M8b 的 `commands::` 形态实测打红）。这是刻意收窄：Rust 里裸名与前端
//! 不同，会大量误中无关标识符；本锁守的是「注册表与调用路径」，裸名函数进不了
//! `generate_handler!` 也就调不到。真正的兜底是 `retired_session_observation_*`
//! （对偶退役面，扫全 crate 的裸形态标识符）。
//!
//! **前端面边界**：宿主前端扫描曾指向 `wasmnest-desktop/plugins`，该目录 2026-09-25
//! 改名 `wasm-apps` 后即空转（三仓拆分后应用前端整体入住应用仓）；**app 前端不在
//! 本锁扫描面**——它们有自己的命令面，同名 `list_sessions` 属应用自有词汇，判据
//! 不同（恢复扫描须先厘清判据，另立票据）。宿主 shell 前端（ADR 0057 的
//! `wasmnest-desktop/src`）与 Rust 侧同判据，随下次前端面收口一并接入。

use std::path::PathBuf;

/// 宿主 Rust 源码根（`src-tauri/src`）
fn host_src_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
}

#[test]
fn retired_session_command_surface_is_not_reintroduced() {
    // 两个 Rust 源码面：宿主（`src-tauri/src`）+ 能力仓 server 侧 crate（清单来自
    // wasm-core 公开登记表）。前端面当前不上场（见文件头注释的两条边界）。
    let mut scan_roots: Vec<PathBuf> = vec![host_src_root()];
    scan_roots.extend(wasmnest_desktop_lib::wasm_core::crate_boundary_lock::server_lib_src_roots());

    let rust_needles = [
        "commands::list_sessions",
        "commands::get_session",
        "commands::resize_session",
        "commands::write_to_session",
        "commands::send_special_key",
        "plugin_terminal_send_input",
    ];
    // 前端**不带引号**匹配：`invoke('list_sessions')` / `invoke("list_sessions")` /
    // 模板串三种写法都要拦。这些是 snake_case 命令名，前端源码里除 invoke 串之外
    // 不该出现（首轮写成带单引号的针，变异自检用双引号接回时**漏判**，故收窄到名字）。
    let frontend_needles = [
        "list_sessions",
        "get_session",
        "resize_session",
        "write_to_session",
        "send_special_key",
        "plugin_terminal_send_input",
    ];

    let mut violations: Vec<String> = Vec::new();
    for root in &scan_roots {
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    // node_modules / dist / target 不进扫描（构建产物不是源码面）
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if matches!(name, "node_modules" | "dist" | "target" | ".git") {
                        continue;
                    }
                    stack.push(path);
                    continue;
                }
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                let needles: &[&str] = match ext {
                    "rs" => &rust_needles,
                    "ts" | "vue" => &frontend_needles,
                    _ => continue,
                };
                // crate 侧结构锁以字符串形式携带这些命令名去匹配（自锁规避）
                if path.ends_with("dependency_direction_lock.rs") {
                    continue;
                }
                let Ok(content) = std::fs::read_to_string(&path) else {
                    continue;
                };
                for (idx, raw_line) in content.lines().enumerate() {
                    let line = raw_line.trim_start();
                    if line.starts_with("//") || line.starts_with('*') || line.starts_with("/*") {
                        continue;
                    }
                    for needle in needles {
                        if line.contains(needle) {
                            violations.push(format!("{}:{}: {}", path.display(), idx + 1, line.trim()));
                        }
                    }
                }
            }
        }
    }

    assert!(
        violations.is_empty(),
        "已注销的会话命令面出现回接痕迹（票 08）：\n{}",
        violations.join("\n")
    );
}
