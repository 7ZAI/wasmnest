//! 前端插件通道会话的页面加载钩子（按 webview 重置 loader 会话）
//!
//! 从模块入口拆出；装配在 `run` 里以插件形式注册，故仅对 bootstrap 组合根可见。

use tauri::Manager;

/// 前端插件通道会话的生命周期钩子（审计票 06）
///
/// 页面加载重置**该 webview** 的 loader 会话密钥与全部插件令牌：宿主前端 bootstrap 会在导入
/// 任何插件模块之前重新取得密钥，而插件代码只在模块被导入后才开始运行——「首个调用者生效」
/// 因此恒由宿主前端赢得；dev 下页面刷新也能重新取得（否则刷新后插件前端全部拿不到凭证）。
///
/// **按 webview 分区**（2026-09-26）：本钩子对每个 webview（主窗口 / 终端窗口 / 未来任何
/// 独立窗口）都触发，凭证表按 label 分域——否则终端窗口加载会回收主窗口凭证，使主窗口插件面
/// 命令全数被拒（`缺少有效通道凭证`）。详见 `security::frontend_channel` 模块注释。
pub(super) fn frontend_channel_session_hook() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry>::new("wasmnest-frontend-channel")
        .on_page_load(|webview, payload| {
            // 只认 Started：本钩子对每次页面加载触发两次（Started / Finished），Finished
            // 时本页 JS 已运行——此刻重置会把 bootstrap 刚签发、已进前端模块缓存的密钥
            // 作废（移动端 bootstrap 在页面加载期间签发，2026-10-25 即因此全量拒启）。
            // 桌面当前 activate 懒取凭证不受影响，同守卫保证双端语义一致：新页开始 =
            // 旧域作废，且只发生一次。
            if !matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                return;
            }
            let Some(plugin_host) = webview
                .app_handle()
                .try_state::<std::sync::Arc<crate::wasm_core::manager::host::PluginHost>>()
            else {
                // 页面加载早于 setup 装配 PluginHost（不应发生）：留痕不 panic
                tracing::warn!("[PluginChannel] page load before PluginHost managed, session not reset");
                return;
            };
            tracing::debug!(
                webview = %webview.label(),
                url = %payload.url(),
                "[PluginChannel] 页面加载，重置该窗口的前端通道会话"
            );
            plugin_host.reset_frontend_loader_session(webview.label(), "page-load");
        })
        .build()
}
