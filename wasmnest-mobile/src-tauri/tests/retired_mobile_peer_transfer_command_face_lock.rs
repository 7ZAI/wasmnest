//! 传输 / 接收 / 远端浏览调度面退役锁（票 10 · 移动端）
//!
//! 票 06/07/08 把发送编排、接收编排与任务真源整体下沉 `file-transfer` 插件，
//! 票 09 摘掉发现投影与连接编排命令面；本票收掉**最后一段宿主前端命令面**——
//! 传输调度面（取消 / 暂停 / 恢复 / 选源）、接收设置面（读面 / 加密开关 /
//! 并发上限）与远端浏览拉取面（列共享根 / 浏览 / 拉取）。
//!
//! A 刀（移动端 peer/mdns 脱绑到能力 lib `common-host`）之后，宿主 `src/peer/`
//! 模块由六个（net / ports / seam / transfer / receive / remote）收为四个
//! （net / ports / seam / transfer）：`receive.rs` / `remote.rs` 整文件删除，
//! `transfer.rs` 剥到只剩 `peer_pick_files` 平台选源缝 + 两个私有 relay helper。
//! 19 条 `host-peer` 原语的 `Host` impl 由能力 lib 直调 crate 域函数，宿主不再
//! 持任何 peer 中转委托；本锁的判据方向因此从「原语必须在」翻成「退役面不得
//! 回接」——fail-visible，点名缺失 + 给出路。
//!
//! 与前四把锁（发送编排 / 接收编排 / 发现投影）互不重叠：它们锁**构件定义**，
//! 本锁锁**命令面**（`#[tauri::command]` 属性 + `invoke_handler!` 注册 + 退役
//! 命令字面量）——构件没删干净由那三把锁负责，构件还在但又被挂回前端由本锁负责。
//!
//! 为什么要单独锁命令面：一旦有人把注册加回 `invoke_handler!` 或给残留函数
//! 挂回 `#[tauri::command]`，前端就又有一条绕过插件命令面的旁路（票 06/07/08
//! 的裁决前提是「任务真源在插件」，旁路命令面等于让插件与宿主同时写状态）。
//!
//! 只扫非注释行：模块头「为什么删」的记账段落与本锁自身的说明不算回接。

use std::path::{Path, PathBuf};

/// 平台选源原语：必须保留（host-platform `pick-files` 在调），但不得
/// 重新挂上 `#[tauri::command]` 或被注册进 `invoke_handler!`
const PLATFORM_PICK_FACE: [&str; 1] = ["fn peer_pick_files("];

/// 已彻底退役的符号（函数定义 + DTO + 命令字面量），出现即回接
const RETIRED_TRANSFER_SETTINGS_FACE: [&str; 4] = [
    "fn get_peer_receive_settings(",
    "fn set_peer_transfer_encryption(",
    "fn set_peer_transfer_concurrency(",
    "PeerReceiveSettingsDto",
];

/// 随 host-peer 脱绑退役的宿主中转委托（19 条原语的 `Host` impl 已在能力 lib
/// `common-host` 层直调 crate 域函数，宿主再持有同名委托即第二份入口）
const RETIRED_PEER_DELEGATES: [&str; 10] = [
    "fn cancel_peer_transfer(",
    "fn pause_peer_transfer(",
    "fn resume_peer_transfer(",
    "fn browse_peer_directory(",
    "fn send_files_to_peer_with_policy(",
    "fn collect_outgoing_for_plugin(",
    "fn active_transfers_json(",
    "fn respond_peer_transfer(",
    "fn cancel_peer_receiving(",
    "fn list_peer_shared_roots(",
];

/// `invoke_handler!` 里不得出现的宿主 peer 模块注册路径（含 `crate::peer::`
/// 与 `peer::` 两种写法；只在该注册块内扫描，不致误伤函数体引用）
const RETIRED_HANDLER_NEEDLES: [&str; 1] = ["peer::"];

fn mobile_src_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/wasmnest-mobile/src-tauri
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

/// 逐行扫描指定文件（跳过纯注释行），返回命中的违规记录
fn scan(files: &[&str], needles: &[&str]) -> Vec<String> {
    let mut violations: Vec<String> = Vec::new();
    for rel in files {
        let path = mobile_src_root().join(rel);
        let content = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读取 {rel} 失败：{e}"));
        for (idx, raw_line) in content.lines().enumerate() {
            let line = raw_line.trim_start();
            if line.starts_with("//") {
                continue;
            }
            for needle in needles {
                if line.contains(needle) {
                    violations.push(format!("{rel}:{}: {}", idx + 1, line.trim()));
                }
            }
        }
    }
    violations
}

#[test]
fn peer_host_modules_have_no_tauri_command_attribute() {
    // A 刀后宿主 peer 模块收为四个（net / ports / seam / transfer），皆不得
    // 有任何 Tauri 命令：引擎原语只经能力 lib 的 host-peer 绑定层调用，投影
    // 与业务编排在插件侧。
    let files = [
        "src/peer/net.rs",
        "src/peer/ports.rs",
        "src/peer/seam.rs",
        "src/peer/transfer.rs",
    ];
    let violations = scan(&files, &["#[tauri::command]", "tauri::command"]);
    assert!(
        violations.is_empty(),
        "移动端 peer 宿主模块（A 刀后零前端命令面）出现 #[tauri::command] 回接：\n{}",
        violations.join("\n")
    );
}

#[test]
fn peer_host_modules_are_not_registered_in_invoke_handler() {
    // 注册面是编译期双保险之外的第二道：漏注册时前端 invoke 直接报未知命令，
    // 但留着注册项会让「零命令面」只靠属性维持，任何一次批量加属性就全线回接。
    let path = mobile_src_root().join("src/lib.rs");
    let content = std::fs::read_to_string(&path).expect("read lib.rs");
    let mut violations: Vec<String> = Vec::new();
    let mut in_handler = false;
    for (idx, raw_line) in content.lines().enumerate() {
        let line = raw_line.trim();
        if line.starts_with("invoke_handler!") || line.contains("invoke_handler! {") {
            in_handler = true;
            continue;
        }
        if in_handler {
            if line.starts_with(']') {
                break;
            }
            if line.starts_with("//") {
                continue;
            }
            for needle in RETIRED_HANDLER_NEEDLES {
                if line.contains(needle) {
                    violations.push(format!("src/lib.rs:{}: {}", idx + 1, line));
                }
            }
        }
    }
    assert!(
        violations.is_empty(),
        "invoke_handler! 出现已退役的宿主 peer 注册项（A 刀后零前端命令面）：\n{}",
        violations.join("\n")
    );
}

#[test]
fn retired_peer_transfer_settings_command_face_is_not_reintroduced() {
    // 接收设置真源在插件 settings store（票 10 已迁）；宿主副本只服务引擎
    // 闸门（策略 / 落点）与引擎侧拉取编排。加密开关由插件随 `send-files` 载荷
    // 逐项下发，宿主兜底分支恒为 false；拉取并发上限的写入侧消失后读值退化为
    // 磁盘既有值或缺省 3——两者的读面 DTO 一并退役。
    // A 刀后 `receive.rs` / `remote.rs` 整文件删除，只剩 `transfer.rs` 一个
    // 平台选源缝（`peer_pick_files`）+ 两个私有 relay helper。
    let files = ["src/peer/transfer.rs"];
    let violations = scan(&files, &RETIRED_TRANSFER_SETTINGS_FACE);
    assert!(
        violations.is_empty(),
        "已退役的传输设置命令面（A 刀）出现回接痕迹：\n{}",
        violations.join("\n")
    );
}

#[test]
fn platform_pick_files_is_the_only_remaining_peer_entry() {
    // A 刀之后宿主 `src/peer/` 唯一存活的对外入口是 `peer_pick_files`
    // （host-platform 选源缝，双端差异化实现）。本用例断言它在 `transfer.rs`
    // 中仍在场——若有人连这条缝一起删掉，插件侧的 `platform_pick_files` WIT
    // 调用会失去宿主实现方，实例化期 fail-visible。
    let files = ["src/peer/transfer.rs"];
    let violations = scan(&files, &PLATFORM_PICK_FACE);
    assert!(
        violations.len() == PLATFORM_PICK_FACE.len(),
        "平台选源缝 `peer_pick_files` 缺失或被改名（A 刀后宿主唯一保留的 peer 入口）：命中 {} / 应为 {}",
        violations.len(),
        PLATFORM_PICK_FACE.len()
    );
}

#[test]
fn retired_peer_delegates_do_not_reappear() {
    // 19 条 `host-peer` 原语的宿主中转委托已随 A 刀整文件删除（`receive.rs` /
    // `remote.rs`）或剥到只剩选源缝（`transfer.rs`）。能力 lib `common-host`
    // 层直调 crate 域函数，宿主再持同名委托即第二份入口、违反「lib 能力不
    // 污染宿主代码」裁决。fail-visible：任何一条回接都应点名。
    let files = ["src/peer/transfer.rs"];
    let violations = scan(&files, &RETIRED_PEER_DELEGATES);
    assert!(
        violations.is_empty(),
        "已退役的宿主 peer 中转委托（A 刀）出现回接痕迹：\n{}",
        violations.join("\n")
    );
}
