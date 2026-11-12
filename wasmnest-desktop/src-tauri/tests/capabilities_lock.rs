//! 前端零资源访问 · 能力层与 CSP 层防回接锁
//!
//! 对应 docs/frontend.md §1 前端规范「前端零资源访问（强制红线）」。这条红线的落地分三层，
//! 本文件锁住其中两层**可被静默改回**的两层：
//!
//! 1. **能力层（Tauri ACL，运行期强制）**：`capabilities/*.json` 里**不得**出现任何
//!    具备网络 / 文件访问能力的插件权限。没写进 capability 的权限，Tauri 运行期直接
//!    拒该 invoke（`tauri/src/webview/mod.rs`：`plugin:*` 命令无条件过 ACL，`acl.is_none()`
//!    即 reject），前端无论怎么写都调不动——这与「不写 fetch」是两种性质：后者是约定，
//!    前者是执行期拒绝。
//! 2. **CSP 层（浏览器引擎强制）**：两端 `tauri.conf.json` 的 `app.security.csp` 必须
//!    含 `connect-src 'none'`。它封的是 `fetch` / `XMLHttpRequest` / `WebSocket` /
//!    `EventSource` / `sendBeacon` 全族，与 JS 写法无关，也不依赖 Tauri。
//! 3. **CSP 层配套（index.html 不得有内联 <style> / 内联 <script>）**：见
//!    `index_html_has_no_inline_style_or_script` 的机制说明——Tauri 会因这两个标签
//!    给 `style-src` / `script-src` 注入 nonce/hash，令 `'unsafe-inline'` 失效。
//!
//! 两端配置一并扫：红线是双端红线，锁只写一份避免两份漂移。
//!
//! **为什么是测试而不是文档**：这两个文件都是 JSON，改错了不会编译失败、不会测试变红，
//! 只会在运行期悄悄放行能力——正是「静默降级让断链长期存活」的反面教材。

use std::fs;
use std::path::{Path, PathBuf};

/// 具备网络 / 文件访问能力的插件权限前缀（出现在 capability 里 = 前端可直接发起该访问）
///
/// 注：`dialog:*` 刻意不在禁列——它是**用户点击后弹出的系统选择器**，只回传用户选定的
/// 路径，前端读不到文件内容，真正的读取发生在 Rust 侧并过权限闸门；禁掉它等于禁用
/// 「选择安装包 / 日志目录」这类正常 UI 能力。具体开哪几条由
/// [`WASM_EQUIVALENT_PERMISSION_DECISIONS`] 逐条裁决（见该常量）。
const NETWORK_CAPABLE_PERMISSION_PREFIXES: [&str; 6] = ["shell:", "updater:", "http:", "fs:", "deep-link:", "opener:"];

/// 逐条禁止的进程类权限（`process:default` 只含 exit/restart，不在禁列）
const FORBIDDEN_EXACT_PERMISSIONS: [&str; 1] = ["process:allow-spawn"];

/// **与 wasm 权限位语义重叠**的能力位：出现即要求逐条裁决（安全审查 #47，2026-11-02）
///
/// 这些能力不是「网络 / 文件」类，但同样绕过 `PermissionManager`：前端一份、审计一份，
/// 用户在应用详情页撤销的是 wasm 权限位，而能力位不受它约束。允许的条目必须在本表里
/// **写明理由与门禁落点**，新增条目会在锁里直接跑红——防的是「不知不觉多开一条」而不是
/// 「一条都不允许」（能力位与权限位的收敛需要应用仓同步，跨仓节奏不可在本仓单方面关闭）。
///
/// 裁决口径（`docs/frontend.md` §1 对照表）：
/// - `keep`：保留，但写明谁在用、为什么不能现在撤、收敛入口在哪；
/// - `host-command`：走宿主命令代替（发起权归 Rust）；
/// - 未列出 = 禁止（锁红）。
const WASM_EQUIVALENT_PERMISSION_DECISIONS: &[(&str, &str)] = &[
    (
        "dialog:allow-open",
        "keep：`bedcode` 桌面前端的目录选择器（SessionConfigForm / useLaunchSession）直接调 \
         `@tauri-apps/plugin-dialog`。收敛入口 = 宿主 `plugin.platform_picker` 已端口化的选择器原语 \
         （wasm 侧可用）；应用仓迁走后此项应撤。只回传用户选定路径，内容读取仍在 Rust 且过 fs 授权链。",
    ),
    (
        "dialog:default",
        "keep（移动段）：宿主壳设置页的 `confirm` / 插件安装的 `open` 仍在用。\
         桌面段已收窄到 `dialog:allow-open` 单条；移动段收敛后同样收窄。",
    ),
    (
        "notification:default",
        "keep：`file-transfer` 桌面前端只用 `sendNotification` 发本机进度提示。\
         收敛入口 = 共享域契约 `host-notify`（已有 `notify` 权限位与双端门禁，桌面 #46 已补）。\
         应用仓迁走后应撤此能力，否则「通知权限未授予」的用户预期与实际行为不一致。",
    ),
    (
        "task-notification:default",
        "keep（移动段）：宿主壳的连接 / 任务状态通知（`useNotification`）走 Kotlin 插件命令。\
         它是一组自定义命令而非 `notification:*`，但同样可被应用前端裸 invoke。\
         收敛入口 = 宿主命令封装（发起权归 Rust）+ 应用面走 `host-notify`。",
    ),
    (
        "foreground-service:default",
        "keep（移动段）：宿主连接保活的前台服务，属宿主机制而非产品语义。\
         应用前端无消费者；后续由锁正向白名单固定命令面。",
    ),
    (
        "os:allow-platform",
        "keep：平台判定唯一入口（`usePlatform`，双端同形）。只暴露平台名，不含主机名 / locale。",
    ),
    (
        "os:allow-arch",
        "keep：`PlatformInfo.arch`（宿主壳展示与终端初始尺寸）。",
    ),
    ("os:allow-version", "keep：`PlatformInfo.osVersion`（关于页）。"),
    ("os:allow-os-type", "keep：`PlatformInfo.osType`（关于页）。"),
    (
        "process:allow-restart",
        "keep：宿主设置页「检查更新 → 安装后重启」需要（`useUpdateChecker`）。\
         只放 restart（`relaunch()` 的 ACL 名，不放 exit / spawn）；应用前端不消费。",
    ),
];

/// 逐条扫描「与 wasm 权限位语义重叠」的能力（未裁决即锁红）
#[test]
fn wasm_equivalent_capabilities_are_explicitly_adjudicated() {
    let mut undocumented: Vec<String> = Vec::new();
    let mut scanned = 0usize;

    for (end, dir) in capability_dirs() {
        assert!(dir.is_dir(), "{end} capability 目录缺失：{}", dir.display());
        for file in fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("读取 {} 失败：{e}", dir.display()))
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        {
            let raw = fs::read_to_string(&file).unwrap_or_else(|e| panic!("读取 {} 失败：{e}", file.display()));
            for permission in extract_permission_strings(&raw, &file.display().to_string()) {
                if !is_wasm_equivalent_capability(&permission) {
                    continue;
                }
                scanned += 1;
                if !WASM_EQUIVALENT_PERMISSION_DECISIONS
                    .iter()
                    .any(|(allowed, _)| *allowed == permission)
                {
                    undocumented.push(format!(
                        "{end}:{permission}（{}）",
                        file.file_name().unwrap_or_default().to_string_lossy()
                    ));
                }
            }
        }
    }

    assert!(
        scanned > 0,
        "锁定全空转：两端 capability 里一条与 wasm 权限位重叠的能力都没扫到——\
         扫描面（目录 / 字段名 / 前缀表）失效。取消注释或修正 collect 面，不许删锁。"
    );
    assert!(
        undocumented.is_empty(),
        "能力位绕过 wasm 权限语义且未裁决：{undocumented:?}\n\
         这些权限让前端直接触达 OS 能力，而用户在应用详情页看到 / 撤销的是 wasm 权限位——两套账。\n\
         处置：① 优先把发起权收归 Rust（宿主命令 / host-* 原语），撤掉能力；\n\
         ② 确实当前不能撤（应用仓依赖）→ 在 `WASM_EQUIVALENT_PERMISSION_DECISIONS` 里\
         追加条目并写明用户、不能撤的原因、收敛入口；\n\
         ③ 同步 `docs/frontend.md` §1 的「能力位 ↔ 权限位」对照表。"
    );
}

/// 判定某能力是否与 wasm 权限位语义重叠（`notify` / `fs:pick` / OS 信息面 / 进程面）
fn is_wasm_equivalent_capability(permission: &str) -> bool {
    // 前缀匹配：`os:*`（主机名 / locale 等平台信息面）与 `notification:*` / `task-notification:*`
    if permission.starts_with("notification:")
        || permission.starts_with("task-notification:")
        || permission.starts_with("os:")
        || permission.starts_with("process:")
        || permission.starts_with("machine-uid:")
        || permission.starts_with("foreground-service:")
    {
        return true;
    }
    // 文件选择器：`fs:pick` 的等价面（只回路径，但直接把路径塞给了前端）
    permission == "dialog:default" || permission.starts_with("dialog:allow-")
}

/// 宿主根目录（`wasmnest-desktop/src-tauri`）
fn desktop_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// 双端待扫的 capability 目录；缺失即视为锁失效（显性报错，不静默跳过）
fn capability_dirs() -> Vec<(&'static str, PathBuf)> {
    let desktop = desktop_root().join("capabilities");
    let mobile = desktop_root()
        .parent()
        .and_then(|p| p.parent())
        .map(|repo| repo.join("wasmnest-mobile/src-tauri/capabilities"))
        .expect("src-tauri 的两级上级应是仓库根");
    vec![("desktop", desktop), ("mobile", mobile)]
}

/// 读 capability 的 `permissions` 数组（结构化解析，2026-11-03 审核 P3-1 修正）
///
/// **为什么不再用字符串切割**：旧实现是 `json.find("\"permissions\"")` + `find('[')` +
/// `split(',')` + 手工剥引号。三个失效场景让锁本身变得不可信：
/// 1. 其它字段的值里出现 `"permissions"` 字样（如描述文案）→ 切在错误位置；
/// 2. `permissions` 数组里出现对象形态（Tauri 2 支持 `{"identifier": ...}`）→ 手工剥引号取到空；
/// 3. 数组内含嵌套数组（作用域限定）→ `find(']')` 取到内层闭合，后续全丢。
///
/// 锁的价值在于「断言不空转」，用字符串切割等于把锁的可靠性交给字段顺序与格式细节。
/// `serde_json` 是宿主的生产依赖，测试里用不增加任何负担。
///
/// 非字符串元素（对象形态 / 嵌套数组）**显性 panic** 而非跳过——静默跳过等于缩小断言范围，
/// 正是 docs/testing.md 禁止的「缩窄 glob / 掏空断言」。真要用到对象形态时，让这里红一次，
/// 迫使改成按 `identifier` 字段取值。
fn extract_permission_strings(json: &str, origin: &str) -> Vec<String> {
    let parsed: serde_json::Value =
        serde_json::from_str(json).unwrap_or_else(|e| panic!("{origin} 不是合法 JSON：{e}"));
    let Some(list) = parsed.get("permissions") else {
        return Vec::new();
    };
    let Some(items) = list.as_array() else {
        panic!("{origin} 的 permissions 不是数组：{list}");
    };
    items
        .iter()
        .map(|item| match item.as_str() {
            Some(s) => s.to_string(),
            None => panic!(
                "{origin} 的 permissions 里出现非字符串元素 {item} —— 本锁只认字符串权限位；\
                 若 Tauri 升级为对象形态，请改按 identifier 字段取值后再放开"
            ),
        })
        .collect()
}

/// 能力层：两端 capability 都不得授予网络 / 文件类插件权限
#[test]
fn network_capable_plugin_permissions_are_not_reintroduced() {
    let mut granted: Vec<String> = Vec::new();

    for (end, dir) in capability_dirs() {
        assert!(
            dir.is_dir(),
            "{end} capability 目录缺失：{} —— 防回接锁失效（红线会失去能力层强制）",
            dir.display()
        );

        let entries = fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("读取 {} 失败：{e}", dir.display()))
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
            .collect::<Vec<_>>();
        assert!(
            !entries.is_empty(),
            "{end} capability 目录里没有 json 文件：{}",
            dir.display()
        );

        for file in entries {
            let raw = fs::read_to_string(&file).unwrap_or_else(|e| panic!("读取 {} 失败：{e}", file.display()));
            for permission in extract_permission_strings(&raw, &file.display().to_string()) {
                let forbidden_prefix = NETWORK_CAPABLE_PERMISSION_PREFIXES
                    .iter()
                    .find(|p| permission.starts_with(**p));
                if forbidden_prefix.is_some() || FORBIDDEN_EXACT_PERMISSIONS.contains(&permission.as_str()) {
                    granted.push(format!(
                        "{}（{}）",
                        permission,
                        file.file_name().unwrap_or_default().to_string_lossy()
                    ));
                }
            }
        }
    }

    assert!(
        granted.is_empty(),
        "前端零资源访问红线被回接：capability 里出现了网络 / 文件类插件权限 {:?}。\n\
         这些权限会让前端**运行期**直接发起 HTTP / WebSocket / 文件 / OS 级访问（不是源码约定问题，\n\
         是 Tauri ACL 真的放行）。需要该能力时：\n\
         1) 把发起权收归 Rust（宿主命令或插件 host-* 原语），前端只拿元数据 / 事件；\n\
         2) 在宿主侧加闸门（scheme / 权限 / 配额白名单）；\n\
         3) 同步更新 docs/frontend.md 与 CHANGELOG。\n\
         参考：shell:allow-open → commands::open_external_url；updater:default → commands::check_for_update/install_update",
        granted
    );
}

/// 能力层配套：宿主不得依赖带网络 / 文件能力的 Tauri 插件 crate
///
/// 依赖进了 Cargo.toml 就意味着前端只要加一条 capability 就能打开——防回接锁的前一道防线。
#[test]
fn network_capable_plugin_crates_are_not_depended_on() {
    /// 各端禁依赖的 crate：`http` / `fs` 是纯网络 / 文件面；`shell` 是已移除的前端调用面
    /// （它的 `open` 已废弃，且留着它等于留了一条“加条 capability 就能开”的回头路）。
    const FORBIDDEN: [(&str, [&str; 3]); 2] = [
        (
            "desktop",
            ["tauri-plugin-http", "tauri-plugin-fs", "tauri-plugin-shell"],
        ),
        ("mobile", ["tauri-plugin-http", "tauri-plugin-fs", "tauri-plugin-shell"]),
    ];

    for (end, forbidden) in FORBIDDEN {
        let manifest = if end == "desktop" {
            desktop_root().join("Cargo.toml")
        } else {
            desktop_root()
                .parent()
                .and_then(|p| p.parent())
                .map(|repo| repo.join("wasmnest-mobile/src-tauri/Cargo.toml"))
                .expect("src-tauri 的两级上级应是仓库根")
        };

        assert!(manifest.is_file(), "{end} Cargo.toml 缺失：{}", manifest.display());
        let raw = fs::read_to_string(&manifest).expect("读 Cargo.toml");
        // 逐行解析**真实依赖声明**而不是裸子串包含：否则「注释里说明这个 crate 已被移除」
        // 反而会把锁锁红（本项目就踩过一次：Cargo.toml 的移除说明注释命中了同名检查）。
        for crate_name in forbidden {
            let declared = raw.lines().any(|line| {
                let line = line.split('#').next().unwrap_or("");
                line.contains(crate_name)
            });
            assert!(
                !declared,
                "{end} 依赖了 {crate_name}：它给前端留下了“只差一条 capability”的回头路。\n\
                 如确需宿主侧出站 / 调起 OS，走既有闸门（host-http 原语 / egress / http_request 命令 / \
                 tauri-plugin-opener），不要引带前端调用面的 Tauri 插件。"
            );
        }
    }
}

/// 能力层配套：撤掉能力时必须同步换上宿主命令，否则功能静默失效
///
/// 「撤 capability」与「补宿主命令」是一对动作：只撤不补 = 功能坏了；
/// 只补不撤 = 红线没关上。这条锁把两者绑在一起。
#[test]
fn revoked_capabilities_have_host_command_replacements() {
    let lib_rs = fs::read_to_string(desktop_root().join("src/bootstrap/run.rs")).expect("读 src/bootstrap/run.rs");

    for command in ["commands::open_external_url", "commands::install_update"] {
        assert!(
            lib_rs.contains(command),
            "capability 已撤除但宿主命令 `{command}` 未注册 —— 前端会静默失去该能力。\n\
             撤权限与补宿主命令必须成对提交。"
        );
    }
}

/// CSP 层：两端 `tauri.conf.json` 必须封 `connect-src`
#[test]
fn csp_blocks_frontend_connect_sources() {
    for (end, manifest) in [
        ("desktop", desktop_root().join("tauri.conf.json")),
        (
            "mobile",
            desktop_root()
                .parent()
                .and_then(|p| p.parent())
                .map(|repo| repo.join("wasmnest-mobile/src-tauri/tauri.conf.json"))
                .expect("src-tauri 的两级上级应是仓库根"),
        ),
    ] {
        let raw = fs::read_to_string(&manifest).unwrap_or_else(|e| panic!("读取 {end} tauri.conf.json 失败：{e}"));
        let csp_block = raw
            .split("\"csp\"")
            .nth(1)
            .and_then(|tail| tail.split("\"devCsp\"").next())
            .unwrap_or_else(|| {
                panic!("{end} tauri.conf.json 里找不到 app.security.csp —— 生产构建无 connect-src 兜底")
            });

        assert!(
            csp_block.contains("connect-src"),
            "{end} 的 csp 未约束 connect-src：前端可自由发起 fetch / WebSocket"
        );
        assert!(
            csp_block.contains("'none'"),
            "{end} 的 csp 里 connect-src 不是 'none'：\n{csp_block}\n\
             应为 \"connect-src\": \"'none'\"（dev 期由 devCsp 单独放行 HMR，不在此处开口）。"
        );
        assert!(
            !raw.contains("\"csp\": null"),
            "{end} 的 csp 被置回 null：等于把 CSP 层整个撤掉"
        );
    }
}

/// CSP 层配套：两端 `script-src` 不得保留 `'unsafe-eval'`
///
/// 运行 wasm 只需要 `'wasm-unsafe-eval'`；`'unsafe-eval'` 额外放开 `eval` /
/// `Function` / 字符串转代码，会让任何字符串注入点从「内容注入」升级为「代码执行」。
///
/// 这项能成立的前提是**前端 i18n 消息已在构建期预编译**（`scripts/i18n-precompile.mjs`
/// + `vue-i18n` 运行时构建），运行期不再有消息编译器。若哪天有人为了图省事把
/// `'unsafe-eval'` 加回来，本锁先红；反之若预编译链路被拆掉，i18n 会在运行期
/// 直接报错（fail-visible），不会静默降级。
#[test]
fn csp_forbids_unsafe_eval() {
    for (end, manifest) in [
        ("desktop", desktop_root().join("tauri.conf.json")),
        (
            "mobile",
            desktop_root()
                .parent()
                .and_then(|p| p.parent())
                .map(|repo| repo.join("wasmnest-mobile/src-tauri/tauri.conf.json"))
                .expect("src-tauri 的两级上级应是仓库根"),
        ),
    ] {
        let raw = fs::read_to_string(&manifest).unwrap_or_else(|e| panic!("读取 {end} tauri.conf.json 失败：{e}"));

        // 结构化取值（2026-11-03 审核 P3-1）：旧实现按 `split("\"csp\"")` /
        // `split("\"devCsp\"")` 切文本块，字段顺序一变（`devCsp` 排在 `csp` 前）
        // 或出现任何含 "csp" 字样的键都会**静默取错片段**——锁看着绿，
        // 实际校验的可能是别的字符串。这里按 Tauri schema 的路径取值。
        let conf: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{end} tauri.conf.json 不是合法 JSON：{e}"));

        // Tauri 2 的 `app.security.csp` 可以是**字符串**（整条策略）或**对象**
        // （按指令名分段，如 `{"script-src": "...", "connect-src": "'none'"}`）。
        // 两端当前都是对象形态——这里把两种形态都归一成「一条可校验的文本」，
        // 否则 `as_str()` 在对象形态下直接 None，锁会因为取值失败而误红/误绿。
        let csp_text = csp_to_text(
            conf.pointer("/app/security/csp")
                .unwrap_or_else(|| panic!("{end} tauri.conf.json 里找不到 app.security.csp")),
            end,
            "csp",
        );

        // `devCsp` 是独立字段，不参与本锁；但要确认它**没有**趁开发模式把
        // `'unsafe-eval'` 带回来——它同样会进产物判定路径
        if let Some(dev) = conf.pointer("/app/security/devCsp") {
            let dev_text = csp_to_text(dev, end, "devCsp");
            assert!(
                !dev_text.contains("'unsafe-eval'"),
                "{end} 的 devCsp 仍保留 'unsafe-eval'——开发态会诱导把运行期编译当成可行方案：\n{dev_text}"
            );
        }

        assert!(
            !csp_text.contains("'unsafe-eval'"),
            "{end} 的 csp 仍保留 'unsafe-eval'：\n{csp_text}\n\
             wasm 只需 'wasm-unsafe-eval'。i18n 消息已构建期预编译（安全审查 #50），\n\
             不要用「运行期编译消息」换回这条豁免。"
        );
        assert!(
            csp_text.contains("'wasm-unsafe-eval'"),
            "{end} 的 csp 丢了 'wasm-unsafe-eval'：WebAssembly 无法实例化（wasm 应用起不来）"
        );
    }
}

/// 把 `app.security.csp` 的两种合法形态归一成可校验文本（字符串 / 对象）
///
/// 对象形态把 `指令名: 值` 逐条拼回去，等价于一条完整策略字符串——这样「含
/// `'unsafe-eval'`」的判定对两种形态都成立，不会因为形态不同而漏检。
fn csp_to_text(value: &serde_json::Value, end: &str, field: &str) -> String {
    if let Some(s) = value.as_str() {
        return s.to_string();
    }
    if let Some(map) = value.as_object() {
        assert!(!map.is_empty(), "{end} 的 {field} 是空对象——等于没写策略，锁会空转通过");
        return map
            .iter()
            .map(|(directive, val)| {
                let body = val
                    .as_str()
                    .unwrap_or_else(|| panic!("{end} 的 {field}.{directive} 不是字符串：{val}"));
                format!("{directive} {body}")
            })
            .collect::<Vec<_>>()
            .join("; ");
    }
    panic!("{end} 的 {field} 既不是字符串也不是对象：{value}");
}

/// CSP 层配套：两端 index.html 都不得有**生效的**内联 `<style>` / 内联 `<script>`
///
/// 机制（2026-10-07 实测定位，release 专有故障）：
/// 1. `tauri-codegen/src/context.rs` 的 `map_core_assets` 在启用 CSP 时对每个 html 资产
///    调 `inject_nonce_token` → `tauri-utils/src/html2.rs` 的
///    `inject_nonce(document, "style", STYLE_NONCE_TOKEN)`，给每个 `<style>` 打上 nonce 占位；
///    另有 `inject_script_hashes` 给 `script:not(:empty)`（内联脚本）算 sha256 哈希。
/// 2. 运行期 `tauri/src/manager/mod.rs` 的 `set_csp` → `replace_csp_nonce` 把占位符换成随机
///    nonce 并往 `style-src` 追加 `'self'` + `'nonce-…'`（内联脚本同理进 `script-src`）。
/// 3. CSP3 规定：directive 内一旦出现 nonce-source / hash-source，同一 directive 的
///    `'unsafe-inline'` **被忽略**。于是配置里写好的 `style-src ... 'unsafe-inline'` 静默失效，
///    所有**运行时用 JS 插入**的内联 `<style>` 全被 `style-src-elem` 拒掉（`style.sheet === null`）。
///
/// 本项目四个 wasm 应用的前端样式（`ft-*` / `ah-*` / `session-task-*` / `md-body`）都靠
/// `document.head.appendChild(style)` 注入（宿主只加载插件 dist/index.js，插件独立 CSS
/// 文件无人引用），所以 release 产物里这些界面样式集体失效——插件看着像"没样式"，
/// 而 dev 完全正常（devCsp 只配 connect-src，`AppManager::csp()` 在 dev 分支不取 csp，
/// 无 nonce 注入），极具迷惑性。
///
/// 只挡注释内的写法：移动端 index.html 的历史首屏样式整块被 `<!-- -->` 注释停用，
/// HTML 注释不进 DOM，`dom_query` 的 `select("style")` 选不到它，**不触发 nonce 注入**。
/// 因此本锁先剥注释再判定，与 Tauri 的实际判定口径对齐（移动端当前是绿的）。
#[test]
fn index_html_has_no_inline_style_or_script() {
    for (end, index_html) in [
        // desktop_root() 是 src-tauri，index.html 在其上一级（端根目录）
        ("desktop", desktop_root().join("../index.html")),
        (
            "mobile",
            desktop_root()
                .parent()
                .and_then(|p| p.parent())
                .map(|repo| repo.join("wasmnest-mobile/index.html"))
                .expect("src-tauri 的两级上级应是仓库根"),
        ),
    ] {
        let raw = fs::read_to_string(&index_html)
            .unwrap_or_else(|e| panic!("读取 {end} index.html 失败：{}", index_html.display()));
        // 剥 HTML 注释：注释内不是 DOM 节点，Tauri 的 select() 看不见它
        let stripped = strip_html_comments(&raw);

        assert!(
            !stripped.contains("<style"),
            "{end} index.html 出现了生效的内联 <style>（剥注释后仍命中）：{}。\n\
             Tauri v2 会给它注入 CSP nonce，CSP3 下 style-src 出现 nonce-source 即令 \
             'unsafe-inline' 失效 → 所有运行时注入的内联 <style>（四个 wasm 应用的前端样式）\
             被 style-src-elem 拒掉，release 界面样式集体失效而 dev 正常。\n\
             请改为外部 CSS（桌面首屏见 public/splash.css），机制见本测试头注。",
            index_html.display()
        );

        // 内联 <script>：有内容、无 src —— 与 <style> 同一机制（进的是 script-src 的 sha256）
        let mut rest = stripped.as_str();
        while let Some(open) = rest.find("<script") {
            let after = &rest[open + "<script".len()..];
            let tag_end = after.find('>').expect("<script 标签未闭合：index.html 结构损坏");
            let attrs = &after[..tag_end];
            let body_start = open + "<script".len() + tag_end + 1;
            let body_end = rest[body_start..].find("</script>").map(|i| body_start + i);
            let body = body_end.map(|end| &rest[body_start..end]).unwrap_or("");
            let has_src = attrs.contains("src=");
            assert!(
                has_src || body.trim().is_empty(),
                "{end} index.html 出现了内联 <script>（有内容且无 src）：{}。\n\
                 Tauri v2 会给它算 sha256 塞进 script-src，同 CSP3 规则令 'unsafe-inline' 失效。\n\
                 一并移进外部模块文件。",
                index_html.display()
            );
            rest = match body_end {
                Some(end) => &rest[end + "</script>".len()..],
                None => "",
            };
        }
    }
}

/// 边界：注释内的内联样式**不算**违规（移动端历史首屏样式即停用在注释里）
///
/// 正例：不剥注释的裸子串检查会把移动端判红，而它对 Tauri 的 nonce 注入毫无影响——
/// 这类假阴性会让结构锁名存实亡。
#[test]
fn index_html_inline_style_check_ignores_commented_blocks() {
    let commented = "<html><body><!-- <style>.x{}</style> --></body></html>";
    assert!(
        !strip_html_comments(commented).contains("<style"),
        "剥注释后不应再看到注释块里的 <style>"
    );

    let live = "<html><body><!-- <style>.x{}</style> --><style>.y{}</style></body></html>";
    assert!(
        strip_html_comments(live).contains("<style"),
        "真正生效的内联 <style> 必须留在剥注释后的文本里（否则锁成假阴性）"
    );
}

/// 剥掉 HTML 注释体（保留注释外的全部文本），供上面两条判定共用
fn strip_html_comments(raw: &str) -> String {
    let mut stripped = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(open) = rest.find("<!--") {
        stripped.push_str(&rest[..open]);
        match rest[open + 4..].find("-->") {
            Some(close) => rest = &rest[open + 4 + close + 3..],
            None => return stripped,
        }
    }
    stripped.push_str(rest);
    stripped
}

/// 边界：permissions 提取器不能被非 permissions 字段里的字符串骗到
#[test]
fn permission_extractor_only_reads_the_permissions_array() {
    let json = r#"{
      "identifier": "default",
      "description": "no shell:allow-open here",
      "permissions": ["core:event:default", "os:default"]
    }"#;

    let extracted = extract_permission_strings(json, "边界用例");
    assert_eq!(
        extracted,
        vec!["core:event:default".to_string(), "os:default".to_string()],
        "描述字段里的 'shell:allow-open' 不该被当成已授予权限"
    );
    assert!(
        extract_permission_strings(r#"{"identifier":"x"}"#, "无 permissions 用例").is_empty(),
        "没有 permissions 字段时应返回空 vec（不 panic、不误判）"
    );
}

/// 负例：permissions 里出现非字符串元素必须显性 panic，不许静默跳过
///
/// 静默跳过 = 缩小断言范围，等于给锁开了后门。这里断言 panic 本身，
/// 确保「对象形态」出现时会被强制处理，而不是被无声吞掉。
#[test]
#[should_panic(expected = "非字符串元素")]
fn permission_extractor_rejects_non_string_entries() {
    let _ = extract_permission_strings(
        r#"{"permissions": ["core:event:default", {"identifier": "shell:allow-open"}]}"#,
        "对象形态用例",
    );
}

/// 正例自检：提取器确实认得出禁列前缀（防「锁自身永远绿」的假阴性）
#[test]
fn permission_extractor_detects_forbidden_entries_when_present() {
    let json = r#"{"permissions": ["core:event:default", "shell:allow-open"]}"#;
    let extracted = extract_permission_strings(json, "正例用例");
    assert!(
        extracted.iter().any(|p| p.starts_with("shell:")),
        "提取器必须能认出被禁前缀，否则上面那条锁在真实回接时不会变红（假阴性）"
    );
}

/// 辅助：确认两端 capability 目录确实被扫到了文件（防止路径写错导致锁空跑）
#[test]
fn capability_scan_covers_both_ends() {
    for (end, dir) in capability_dirs() {
        let count = fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("读取 {} 失败：{e}", dir.display()))
            .filter_map(|e| e.ok())
            .filter(|e| Path::new(&e.path()).extension().is_some_and(|ext| ext == "json"))
            .count();
        assert!(count > 0, "{end} 未扫到任何 capability json：{}", dir.display());
    }
}

/// 桌面独立终端窗口的创建权限必须常开（2026-11-04 回归锁）
///
/// bedcode 的「打开终端窗口」由应用前端 `new WebviewWindow()` 发起
/// （应用仓 `useSessionWindows.ts`），走 Tauri `create_webview_window` 命令。
/// `core:webview:default` **不含**该命令（只含 get / position / size / devtools），
/// 必须显式授予 `core:webview:allow-create-webview-window`。
///
/// 2026-11-04 的「能力位收窄」把它随 `dialog:default` / `os:default` 一起删掉，
/// 运行期表现是「终端会话一打开就失败」（ACL 直接拒 invoke），而 JSON 改动不会
/// 让任何既有测试变红。这条锁把该依赖固定下来，下次收窄必须显式裁决。
#[test]
fn desktop_terminal_window_creation_permission_is_granted() {
    let file = desktop_root().join("capabilities/default.json");
    let raw = fs::read_to_string(&file).unwrap_or_else(|e| panic!("读取 {} 失败：{e}", file.display()));
    let permissions = extract_permission_strings(&raw, &file.display().to_string());
    assert!(
        permissions
            .iter()
            .any(|p| p == "core:webview:allow-create-webview-window"),
        "桌面 capability 缺少 core:webview:allow-create-webview-window：\
         bedcode 前端的独立终端窗口（new WebviewWindow）会被 ACL 拒绝，\
         表现为「终端会话打开直接失败」。若确要撤除，先把窗口创建收归宿主命令\
         （发起权归 Rust）并同步应用仓 useSessionWindows。"
    );
}
