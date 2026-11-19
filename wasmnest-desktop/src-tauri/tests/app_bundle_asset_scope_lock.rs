//! 应用整包目录的 asset protocol 作用域锁（桌面 · 2026-10-21）
//!
//! 背景：壳前端装载应用前端（ADR 0057 机制 B）经 asset 协议取两样东西——挂载包
//! `<plugins_dir>/<appId>/index.js`（动态 import）与应用图标
//! `<plugins_dir>/<appId>/icon.svg`（`<img>`）。两者都要求路径落在 asset 协议的
//! **允许作用域**内，否则一律 403，且两种表现都很隐蔽：
//!
//! - 动态 import 失败 → 挂载槽转错误面（「应用界面加载失败，可重试」）；
//! - 图片加载失败   → 图标回退成壳内通用 glyph（BedCode 落到 transfer 图形）。
//!
//! `tauri.conf.json` 的静态作用域只有 `$RESOURCE` / `$APPCONFIG` / `$APPDATA` 三族，
//! 覆盖的是「插件目录在 resource 基目录之下」那一种形态（平台仓 dev 的
//! `target/debug/resources/plugins/desktop`、打包安装后的 `resources/plugins`）。
//! 而 `WASMNEST_PLUGINS_DIR` 允许把插件目录指到**任意**路径（应用仓
//! `apps/<slug>/desktop/.dev-host/plugins` 就是这种），落在静态作用域之外 → 403。
//!
//! 修法在启动装配（`bootstrap/run.rs`）：按解析出的 `plugins_dir` 动态放行。本锁钉住这件事
//! 没被静默改回——改错了不编译失败、测试不红，只在运行期悄悄 403。

use std::path::{Path, PathBuf};

fn src_tauri_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn read_file(rel: &str) -> String {
    std::fs::read_to_string(src_tauri_root().join(rel)).expect("read source file")
}

#[test]
fn resolved_plugins_dir_is_allowed_in_asset_protocol_scope() {
    let lib = read_file("src/bootstrap/run.rs");

    let resolved_at = lib
        .find("let plugins_dir")
        .unwrap_or_else(|| panic!("bootstrap/run.rs 必须解析出 plugins_dir（应用整包根目录）"));
    let scope_at = lib.find("asset_protocol_scope()").unwrap_or_else(|| {
        panic!(
            "bootstrap/run.rs 启动装配必须按解析出的 plugins_dir 动态放行 asset protocol 作用域：\n\
             静态作用域（tauri.conf.json 的 $RESOURCE/$APPCONFIG/$APPDATA）覆盖不到\n\
             WASMNEST_PLUGINS_DIR 指向的任意目录 → asset 协议 403 → 挂载包动态 import\n\
             失败（「应用界面加载失败，可重试」）+ 应用图标回退成壳内通用 glyph。\n\
             修法：app.asset_protocol_scope().allow_directory(&plugins_dir, true)"
        )
    });

    assert!(
        resolved_at < scope_at,
        "asset protocol 作用域放行必须发生在 plugins_dir 解析之后（放行对象是解析结果，不是别的路径）"
    );

    assert!(
        lib.contains("allow_directory("),
        "asset protocol 作用域放行必须真的调用 allow_directory（只拿 scope 不放行 = 没修）"
    );
}

/// #44（2026-11-19）：`$APPDATA` 不得再整目录放行给 asset 协议。
///
/// 收窄前 `$APPDATA/**/*` = 「应用数据目录整目录可渲染」——任一应用前端只要能把
/// 任意图片搬进 appdata（当时 `set_terminal_bg_image` 还接受前端传入的绝对路径），
/// 就能经 asset 协议读回，绕过 `fs:read` 与授权弹窗。作用域现在只保留两个真实
/// 消费面：自定义壁纸目录与终端背景图。
#[test]
fn appdata_asset_scope_is_narrowed_to_wallpaper_and_terminal_bg() {
    let conf: serde_json::Value =
        serde_json::from_str(&read_file("tauri.conf.json")).expect("tauri.conf.json 必须是合法 JSON");
    let allow = conf["app"]["security"]["assetProtocol"]["scope"]["allow"]
        .as_array()
        .expect("assetProtocol.scope.allow 必须是数组")
        .iter()
        .filter_map(|v| v.as_str())
        .collect::<Vec<_>>();

    assert!(
        !allow.iter().any(|s| *s == "$APPDATA/**/*" || *s == "$APPDATA/**"),
        "asset 作用域不得再整目录放行 $APPDATA（#44）：{allow:?}"
    );
    assert!(
        allow.iter().any(|s| s.starts_with("$APPDATA/wallpapers")),
        "自定义壁纸目录必须仍在作用域内，否则壁纸渲染 403：{allow:?}"
    );
    assert!(
        allow.iter().any(|s| s.contains("terminal_bg")),
        "终端背景图必须仍在作用域内，否则背景渲染 403：{allow:?}"
    );
}

/// #44（2026-11-19）：终端背景图命令不得再接受前端传入的路径。
///
/// 改回 `source_path: Option<String>`（无论是否再做扩展名校验）= 路径即权限，
/// 单测不会红、运行期也不报错，只会让任意应用前端重新获得「复制本机图片进
/// appdata」的能力——正是 #44 的问题形态。
#[test]
fn terminal_bg_command_takes_no_frontend_path() {
    let commands = read_file("src/commands.rs");
    let sig_at = commands
        .find("pub async fn set_terminal_bg_image")
        .expect("set_terminal_bg_image 必须是 async 命令（内部走原生对话框）");
    let head = &commands[sig_at..];
    let sig_end = head
        .find('{')
        .map(|i| sig_at + i)
        .expect("找不到 set_terminal_bg_image 函数体起点");
    let signature = &commands[sig_at..sig_end];
    assert!(
        !signature.contains("source_path") && !signature.contains("String"),
        "set_terminal_bg_image 不得接受前端路径参数（#44）：{signature}"
    );
    assert!(
        commands.contains("fn clear_terminal_bg_image"),
        "清除背景图必须是独立命令（不接受路径），移除语义不能退回 set(None)"
    );
}

#[test]
fn assets_command_doc_does_not_claim_static_scope_guarantees_serving() {
    // `plugin_get_asset_dir` 的模块注释曾断言「落点在 asset protocol 允许范围内由
    // tauri.conf.json 的静态作用域保证」——该断言对 WASMNEST_PLUGINS_DIR 形态不成立
    // （正是本锁钉住的坑）。注释与实现漂移会让下一个读代码的人以为静态作用域够用。
    let assets = read_file("src/plugin/assets.rs");
    let claims_static_guarantee =
        assets.contains("assetProtocol.scope`（`$RESOURCE/**/*`）保证") || assets.contains("由 `tauri.conf.json` 的");
    assert!(
        !claims_static_guarantee,
        "plugin/assets.rs 的模块注释不得再声称落点由 tauri.conf.json 的静态作用域保证——\n\
         WASMNEST_PLUGINS_DIR 形态不在静态作用域内（放行在 bootstrap/run.rs 启动装配里动态做）"
    );
}
