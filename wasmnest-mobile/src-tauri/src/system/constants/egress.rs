//! Egress Policy 宿主内置静态声明（L2）
//!
//! 宿主进程自身的外网调用声明：更新检查（GitHub API / Release 资产）与插件的
//! 外网声明分开——后者走 plugin manifest `preauthUrls`（见 `crate::egress` 的
//! `register_plugin_urls`）。

/// 宿主内置外网白名单（URL 模式，glob：`[scheme://][*.]host[:port][/path-prefix]`）
///
/// 三组条目同属**官方应用更新链路**（`plugin/updates.rs`，安全审查：该链路必须
/// 与其它出站面一样过 egress 闸门，不允许旁路）：
///
/// - `api.github.com`：releases / latest 取元数据（含 sha256 摘要）；
/// - `github.com`：Release 资产的 `browser_download_url`；
/// - `objects.githubusercontent.com`：资产的实际交付域名（GitHub 会 302 到这里，
///   跳转链由 `egress::redirect_policy()` 逐跳复检）；
/// - `codeload.github.com`：源码归档 zip（部分 Release 若指向 codeload）。
///
/// 路径前缀用 `/` 通配该 host 全部路径。**不放宽到泛化 CDN**：更新包的完整性靠
/// Release 元数据里的 sha256 钉死，再加域名面收窄，两层同时成立。
pub const HOST_BUILTIN_URL_PATTERNS: &[&str] = &[
    "https://api.github.com/*",
    "https://github.com/*",
    "https://objects.githubusercontent.com/*",
    "https://codeload.github.com/*",
];
