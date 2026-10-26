//! 移动宿主源码「产品词汇」锁（issue #24，B1–B6 判据的源码文本表达）
//!
//! ## 为什么不能用行为测试表达
//!
//! B1–B6 命中是**词汇存在性**事实：产品类型 / 编排 / 真源 / 投影 / 默认值 / 生命周期
//! 挂钩一旦写进宿主源码，它的词汇就在场。产品语义没有行为替身——不存在一个用例能在
//! 「词汇缺席」时表现出产品行为，行为测试只能证明**已写下的东西怎么做**，证不了
//! 「宿主没有产品语义」（AGENTS.md §2 / `docs/host-exceptions.md` §7）。故本锁读宿主
//! 源码文本做断言（形态对照桌面 `wasmnest-desktop/src-tauri/tests/retired_session_command_lock.rs`），
//! 命中处置 = 走 `docs/host-exceptions.md` §3 例外登记（须给「为什么是机制」正面论证）
//! 或开迁移票；**禁止扩大本锁白名单**（§7 口径）。
//!
//! ## 判据口径：只扫 B1–B6 词汇，不扫机制词
//!
//! 词表 = 直连栈（§4.1「随直连栈退役」桶）实测在场的 B1/B2 词汇：会话状态机 /
//! 任务状态 / 会话摘要与控制 / 配对与认证编排 / 前向事件面。**机制词不算**：
//! loader 会话 / 前端通道会话（「会话」针的 `通道会话` carve-out）/ transport
//! session / channel token 是宿主机制事实，不在锁面。
//!
//! ## 扫描面与注释豁免
//!
//! 扫 `src-tauri/src` 全部 `.rs` 的**非注释代码段**（注释里出现产品词是「为什么删 /
//! 怎么退役」的记账，桌面同款锁同口径）；`tests/` 与构建产物不进扫描面。
//! 注释剥离覆盖整行注释、**行尾 `//` 注释**与**跨行块注释正文**（字符串字面量里的
//! `//` / `/*` 不误切，如 URL）——只按行首判会把行尾注释与块注释正文当代码扫（误红）。
//!
//! ## 白名单与 host-exceptions.md 的映射
//!
//! [`WHITELIST`] 逐**文件 × 逐词**登记（禁止目录通配），每行注明来源：
//! `§3` = 例外表（机制，例外登记即终态）；`§4.1` = 处置清单里「随直连栈退役」桶
//! （活消费但未处置，票 #19 / #25）。白名单行是**承载判据**的死登记探测点：
//! `whitelist_rows_are_load_bearing` 保证每行当前仍有命中，行失效即红——
//! **截止条件：#25（直连栈引擎收敛）完成后，对应 §4.1 白名单行应随栈一并删除**，
//! 届时锁红即催办，不许静默保留空登记。
//!
//! 变异自检（Seam 3，2026-10-24 实测）：在非白名单文件 `src/system/info.rs` 临时加
//! `struct TestSessionStatus;` ⇒ 锁红并点名 `src/system/info.rs` + `SessionStatus`；
//! 删掉复原 ⇒ 锁绿。证明扫描面与词表都是承载判据的，不是恒真空转。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 宿主 Rust 源码根（`src-tauri/src`）
fn host_src_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// 产品词汇针（子串匹配 + 机制复合词 carve-out，见 [`MECHANISM_COMPOUNDS`]）。
///
/// 判据按**包含针的完整标识符 token** 判：token 含针即命中，除非 token 整体是
/// 已登记的机制复合词。选 token 语义而非词边界：`TestSessionStatus` 这类前缀
/// 复合（Seam 3 实测）会从词边界下漏过，而「标识符里携带产品词汇」本身就是
/// B1 词汇在场——产品词不论以什么前后缀混进标识符都该红。
/// `会话` / `配对` 是中文针：按出现点判，「会话」带 `通道会话` carve-out
/// （loader / 前端通道会话是通道机制词，非产品会话）；「配对」无机制同形词。
const NEEDLES: &[&str] = &[
    // 会话状态机 / 任务状态（#24 已删 `enums/session.rs`，零容忍——白名单无行）
    "SessionStatus",
    "TaskStatus",
    // 会话摘要 / 配置摘要（B1 类型，enums/sumary.rs 真源）
    "SessionSummary",
    "SessionConfigSummary",
    // 会话控制族（B1/B2，enums/control.rs + model/message.rs 信封；含 *Action/*Payload）
    "SessionControl",
    // 前向同步事件族（B2/B4 投影面，router/event.rs MobileEvent；含 Sync* 变体）
    "SyncSession",
    "MobileEvent",
    // 认证 / 配对编排（B2/B3，auth 桶 + 信封 + 命令面；含 snake_case 字段）
    "AuthStage",
    "AuthPayload",
    "AuthCredentials",
    "AuthStatus",
    "AuthManager",
    "AuthRequest",
    "pairing_code",
    "session_token",
    // 中文产品词（B1/B2）
    "会话",
    "配对",
];

/// 机制复合词 carve-out：**整体 token** 是机制事实、只是字符串上携带了产品针，
/// 不算命中（逐个登记 + 理由；新增机制复合词必须在此登记，禁止扩大成通配）。
const MECHANISM_COMPOUNDS: &[&str] = &[
    // router/event.rs 的自有事件变体（MobileEvent 枚举成员），与已删的
    // enums/session.rs（#24 B1 死码）无关——字段是 String，不用该枚举
    "SyncSessionStatusChanged",
    "SyncTaskStatusChanged",
    // §3 peer 例外：能力仓 wasmnest-server-peer-net 的引擎端口类型（注入面）
    "MobileEventSink",
];

/// 白名单：`（相对 `src/` 的文件路径, 该文件允许的针名）`。
///
/// 逐文件 × 逐词显式登记（host-exceptions.md §7：禁止扩大排除面到目录通配）；
/// 只登记**实测有命中**的文件，无命中的文件不登记——新增词汇即红。
/// 来源标注：`§3` = host-exceptions.md §3 例外表；`§4.1` = §4.1 处置清单
/// 「随直连栈退役」桶（2026-10-24 实测盘点；#25 收敛后 §4.1 行随之删除）。
const WHITELIST: &[(&str, &[&str])] = &[
    // --- auth 桶（§4.1：B2/B3 认证编排，引擎收敛后删） ---
    // `src/auth.rs`：桶类型面（AuthCredentials / AuthStatus B1 类型定义 + AuthManager 再导出）
    (
        "src/auth.rs",
        &["AuthCredentials", "AuthManager", "AuthStatus", "session_token"],
    ),
    ("src/auth/http.rs", &["pairing_code", "session_token"]),
    (
        "src/auth/manager.rs",
        &[
            "AuthCredentials",
            "AuthManager",
            "AuthStatus",
            "MobileEvent",
            "pairing_code",
            "session_token",
        ],
    ),
    ("src/commands/auth.rs", &["AuthCredentials", "session_token"]), // §4.1 commands/{connection,auth}.rs
    // --- connection 桶（§4.1：自研直连栈，wasmnest-ws-client-engine 替换后删） ---
    ("src/connection.rs", &["AuthRequest"]), // 桶 hub 再导出（记账形态）
    ("src/connection/codec.rs", &["SessionControl"]),
    ("src/connection/event_ws.rs", &["MobileEvent"]),
    ("src/connection/manager.rs", &["MobileEvent", "session_token"]),
    (
        "src/connection/request.rs",
        &["AuthPayload", "AuthRequest", "AuthStage", "session_token"],
    ),
    ("src/connection/request_response.rs", &["SessionControl"]),
    ("src/commands/connection.rs", &["session_token"]), // §4.1 commands/{connection,auth}.rs
    // --- enums 桶（§4.1：信封枚举 + hub 再导出行；#24 已删其中的 session.rs） ---
    (
        "src/enums.rs",
        &[
            "AuthPayload",
            "AuthStage",
            "SessionConfigSummary",
            "SessionControl",
            "SessionSummary",
        ],
    ),
    (
        "src/enums/auth.rs",
        &["AuthPayload", "AuthStage", "pairing_code", "session_token"],
    ),
    ("src/enums/control.rs", &["SessionControl"]),
    ("src/enums/sumary.rs", &["SessionConfigSummary", "SessionSummary"]),
    // --- handler / router / model 桶（§4.1：随栈退役的路由 / 事件 / 信封面） ---
    ("src/handler/auth.rs", &["AuthStage", "MobileEvent", "session_token"]),
    (
        "src/handler/plugin_event.rs",
        &["MobileEvent", "SessionSummary", "SyncSession", "TaskStatus"],
    ),
    ("src/handler/system.rs", &["MobileEvent"]),
    (
        "src/model/message.rs",
        &["AuthPayload", "AuthStage", "SessionControl", "session_token"],
    ),
    ("src/router.rs", &["MobileEvent"]), // 桶 hub 再导出（记账形态）
    ("src/router/context.rs", &["MobileEvent", "session_token"]),
    (
        "src/router/event.rs",
        &[
            "MobileEvent",
            "SessionConfigSummary",
            "SessionSummary",
            "SyncSession",
            "session_token",
        ],
    ),
    (
        "src/router/registry.rs",
        &[
            "AuthPayload",
            "AuthStage",
            "SessionControl",
            "pairing_code",
            "session_token",
        ],
    ),
    ("src/router/router.rs", &["SessionControl"]),
    ("src/state.rs", &["AuthManager"]), // §4.1「state.rs 连接认证片段」——仅 AuthManager 注入面，其余行仍在锁面
    // --- §3 例外 / 端口投影 ---
    // 注：peer/* 无白名单行——其实测命中 `MobileEventSink` 是能力仓引擎的端口类型
    // （§3 注入面，机制词），与产品事件面 `MobileEvent` 非同词（词边界区分）。
    ("src/plugin/auth.rs", &["pairing_code"]), // §4.1 auth 行：认证引擎宿主适配（配对提交面）
    // §4.1 auth 行：AuthEnginePort 端口投影（C4 凭据零过境）
    ("src/plugin/host_ports.rs", &["AuthManager", "pairing_code"]),
];

/// 单条违规：文件 + 行号 + 针名 + 命中行
struct Violation {
    file: String,
    line: usize,
    needle: &'static str,
    text: String,
}

/// 行注释 / 块注释剥离：逐行喂入，跨行块注释状态由过滤器持有。
///
/// 只判「行首是 `//` / `*`」不够——行尾注释与块注释正文同样只是记账，按行首判会
/// 把它们当代码扫（误红）。字符串字面量内的 `//` / `/*` 不切（URL 等）。
struct CommentFilter {
    in_block: bool,
}

impl CommentFilter {
    fn new() -> Self {
        Self { in_block: false }
    }

    /// 返回该行的代码段（注释已剥离；整行都是注释时返回空串）
    fn code(&mut self, raw: &str) -> String {
        let bytes = raw.as_bytes();
        let mut code = String::with_capacity(raw.len());
        // 当前代码段起点（ASCII 边界：只按 ASCII 的分隔符切，UTF-8 不会断）
        let mut seg = 0usize;
        let mut i = 0usize;
        let mut in_str = false;
        while i < bytes.len() {
            if self.in_block {
                if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    self.in_block = false;
                    i += 2;
                    seg = i;
                } else {
                    i += 1;
                }
                continue;
            }
            match bytes[i] {
                b'"' => {
                    in_str = !in_str;
                    i += 1;
                }
                b'\\' if in_str => {
                    // 跳过被转义字符（按 UTF-8 首字节长度推进，保持字符边界）
                    i += 1;
                    if i < bytes.len() {
                        i += utf8_len(bytes[i]);
                    }
                }
                b'/' if !in_str && bytes.get(i + 1) == Some(&b'/') => {
                    code.push_str(&raw[seg..i]);
                    return code;
                }
                b'/' if !in_str && bytes.get(i + 1) == Some(&b'*') => {
                    code.push_str(&raw[seg..i]);
                    self.in_block = true;
                    i += 2;
                    seg = i;
                }
                _ => i += 1,
            }
        }
        if !self.in_block {
            code.push_str(&raw[seg..]);
        }
        code
    }
}

fn utf8_len(first: u8) -> usize {
    if first < 0x80 {
        1
    } else if first >> 5 == 0b110 {
        2
    } else if first >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

/// 行内 `needle` 出现点的完整标识符 token（两侧扩展到 `[A-Za-z0-9_]`；中文针天然单 token）
fn enclosing_token(line: &str, start: usize, end: usize) -> &str {
    let bytes = line.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut s = start;
    while s > 0 && is_word(bytes[s - 1]) {
        s -= 1;
    }
    let mut e = end;
    while e < bytes.len() && is_word(bytes[e]) {
        e += 1;
    }
    &line[s..e]
}

/// 针在行内是否有非豁免命中（子串匹配 + 机制 carve-out，判据见 NEEDLES / MECHANISM_COMPOUNDS）
fn line_hits(needle: &str, line: &str) -> bool {
    let mut from = 0;
    while let Some(pos) = line[from..].find(needle) {
        let start = from + pos;
        let end = start + needle.len();
        if needle == "会话" {
            // 机制 carve-out：「通道会话」（loader / 前端通道会话是通道机制词）
            if start >= 2 && line[..start].ends_with("通道") {
                from = end;
                continue;
            }
            return true;
        }
        if !MECHANISM_COMPOUNDS.contains(&enclosing_token(line, start, end)) {
            return true;
        }
        // start 与 end 都是字符边界（needle 以字符边界起止），逐字符推进会
        // 落进多字节字符中间使 `line[from..]` panic
        from = end;
    }
    false
}

/// 扫描宿主源码，返回全部未登记命中
fn scan() -> (Vec<Violation>, BTreeMap<(String, &'static str), usize>) {
    let mut violations = Vec::new();
    let mut whitelist_hits: BTreeMap<(String, &'static str), usize> = BTreeMap::new();
    let mut stack = vec![host_src_root()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let rel = path
                .strip_prefix(PathBuf::from(env!("CARGO_MANIFEST_DIR")))
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let mut filter = CommentFilter::new();
            for (idx, raw_line) in content.lines().enumerate() {
                let code = filter.code(raw_line);
                if code.trim().is_empty() {
                    continue;
                }
                for needle in NEEDLES {
                    if !line_hits(needle, &code) {
                        continue;
                    }
                    let registered = WHITELIST
                        .iter()
                        .any(|(f, needles)| *f == rel && needles.contains(needle));
                    if registered {
                        *whitelist_hits.entry((rel.clone(), needle)).or_insert(0) += 1;
                    } else {
                        violations.push(Violation {
                            file: rel.clone(),
                            line: idx + 1,
                            needle,
                            text: raw_line.trim().to_string(),
                        });
                    }
                }
            }
        }
    }
    (violations, whitelist_hits)
}

/// 防空转守卫：扫描面必须非空且白名单路径必须存在（路径写错 = 锁恒真）
#[test]
fn scan_face_is_nonempty_and_whitelist_paths_exist() {
    let mut count = 0;
    let mut stack = vec![host_src_root()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                count += 1;
            }
        }
    }
    assert!(
        count > 100,
        "宿主源码扫描面过小（{count} 个 .rs）——锁可能空转（路径写错？）"
    );
    for (file, _) in WHITELIST {
        let path: &Path = &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(file);
        assert!(path.is_file(), "白名单路径不存在（登记笔误或文件已删未同步）：{file}");
    }
}

/// 主锁：宿主源码不得出现未登记的产品词汇（B1–B6）
#[test]
fn host_source_carries_no_unregistered_product_vocabulary() {
    let (violations, _) = scan();
    assert!(
        violations.is_empty(),
        "宿主源码出现未登记的产品词汇（B1–B6）：\n\
         该词属产品语义——走 docs/host-exceptions.md §3 例外登记（给正面论证）或开迁移票；\n\
         禁止扩大本锁白名单（host-exceptions.md §7）。\n{}",
        violations
            .iter()
            .map(|v| format!("{}:{}: [{}] {}", v.file, v.line, v.needle, v.text))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// 白名单承载性锁：每行（文件 × 词）当前必须有 ≥1 次命中。
///
/// 行失效（词已从该文件消失）即红——#25 直连栈收敛后 §4.1 白名单行应随之删除，
/// 本锁红即催办；禁止静默保留空登记（host-exceptions.md §7 / §5 截止条件）。
#[test]
fn whitelist_rows_are_load_bearing() {
    let (_, hits) = scan();
    let mut dead: Vec<String> = Vec::new();
    for (file, needles) in WHITELIST {
        for needle in *needles {
            let count = hits.get(&((*file).to_string(), *needle)).copied().unwrap_or(0);
            if count == 0 {
                dead.push(format!("{file} × [{needle}]（当前命中 0 次）"));
            }
        }
    }
    assert!(
        dead.is_empty(),
        "白名单出现死登记（该文件已无此词命中）：\n{}\n\
         若属 #25 直连栈收敛后的正常退役 → 删除对应白名单行；否则核对词表。",
        dead.join("\n")
    );
}

/// 注释剥离：整行 / 行尾 / 跨行块注释都不算代码，字符串里的 `//` 不误切。
///
/// 防的是「行首判注释」的形态缺陷：行尾注释与块注释正文被当代码扫 = 产品词记账误红。
#[test]
fn comment_filter_keeps_code_and_strips_comments() {
    let mut f = CommentFilter::new();
    assert_eq!(f.code("let a = 1; // SessionStatus 记账").trim(), "let a = 1;");
    assert_eq!(f.code("/* 说明"), "");
    assert_eq!(f.code("  * MobileEvent"), "");
    assert_eq!(f.code(" */ let b = 2;").trim(), "let b = 2;");
    assert_eq!(
        f.code("let url = \"http://x/y\"; // 注").trim(),
        "let url = \"http://x/y\";"
    );
    assert_eq!(f.code("let c = 3;").trim(), "let c = 3;");
}
