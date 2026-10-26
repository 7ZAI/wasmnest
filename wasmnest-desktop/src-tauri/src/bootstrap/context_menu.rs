//! 原生右键菜单抑制（正式版 Linux）：每 webview 一次性连接信号 + 窗口销毁清理

/// 页面加载钩子每 webview 只应连接一次右键抑制信号
///
/// WebView 一旦创建，后续每次导航（刷新、路由跳转）都会再次触发页面加载钩子，而
/// `connect_context_menu` 是**追加**信号处理器，重复连接会在同一 WebView 上叠加。
/// 返回 `true` 表示首次见到该 label（应由本次调用去连接信号），`false` 表示已连过。
///
/// **去重键只能是 label，且必须随窗口销毁清理**：会话终端窗口的 label 是
/// `terminal-${session.id}`（`src/composables/useSessionWindows.ts`）——同一会话关窗后
/// 重开得到的是**全新 WebView 实例**，但 label 一模一样。若不随销毁清理，重开的窗口会被
/// 判成「已连过」而永不连接信号，Linux 正式版的原生右键菜单就在该窗口上复活。
/// 清理入口是 [`forget_context_menu_label`]（挂 `WindowEvent::Destroyed`）。
///
/// 锁中毒（其它线程 panic 时持有）按「未见过」处理并取回内部值：页面加载钩子跑在主线程，
/// 此处 panic 会连带拖垮窗口加载，而「抑制失败」只是退回默认右键行为，不该成为崩溃源。
#[cfg(target_os = "linux")]
pub(super) fn mark_first_context_menu_connect(
    connected: &std::sync::Mutex<std::collections::HashSet<String>>,
    label: &str,
) -> bool {
    match connected.lock() {
        Ok(mut seen) => seen.insert(label.to_string()),
        Err(poisoned) => poisoned.into_inner().insert(label.to_string()),
    }
}

/// 窗口销毁 → 丢弃该 label 的去重记录（见 [`mark_first_context_menu_connect`]）
///
/// 只丢弃该 label 的条目，其他窗口（主窗口 / 其余终端窗口）不受影响。
/// 锁中毒时同样取回内部值继续清理，不 panic。
#[cfg(target_os = "linux")]
pub(super) fn forget_context_menu_label(connected: &std::sync::Mutex<std::collections::HashSet<String>>, label: &str) {
    match connected.lock() {
        Ok(mut seen) => {
            seen.remove(label);
        }
        Err(poisoned) => {
            poisoned.into_inner().remove(label);
        }
    }
}

/// 右键抑制去重表：进程内单例（页面加载钩子与窗口销毁钩子共用一份）
#[cfg(target_os = "linux")]
static CONTEXT_MENU_CONNECTED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();

/// 取去重表（首次调用时初始化）
#[cfg(target_os = "linux")]
pub(super) fn context_menu_ledger() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    CONTEXT_MENU_CONNECTED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// 正式版（release）抑制 WebView 原生右键菜单 —— **Linux 专用**
///
/// Windows（WebView2）/ macOS（WKWebView）由前端 `src/main.ts` 在 capture 阶段
/// `preventDefault` 即可覆盖所有窗口；Linux 的 WebKitGTK 在 DOM `contextmenu` 的默认动作里
/// 弹原生菜单，JS `preventDefault` 拦不住（wry#30），只能连接 `context-menu` 信号并返回
/// `true` 阻止默认弹出。
///
/// **覆盖每个 webview**：钩子挂在页面加载上，主窗口与会话终端窗口（前端运行时创建的独立
/// `WebviewWindow`，见 `src/composables/useSessionWindows.ts`）等每次页面加载都会触发；
/// 早期实现只在 setup 里给 `main` 连一次信号，运行期新建的窗口仍会弹原生菜单。
///
/// dev 构建保留右键菜单（调试需要「检查元素」），故闭包内按 `debug_assertions` 提前返回；
/// 插件在 Linux 上照常注册，好让 debug 构建也做类型检查（release-only 代码路径不该是
/// 「只有发版才编译过」的黑盒）。
#[cfg(target_os = "linux")]
pub(super) fn native_context_menu_guard() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use webkit2gtk::WebViewExt;

    let connected = context_menu_ledger();

    tauri::plugin::Builder::<tauri::Wry>::new("wasmnest-native-context-menu-guard")
        .on_page_load(move |webview, _payload| {
            // dev 构建保留原生右键菜单，便于开发调试（检查元素等）
            if cfg!(debug_assertions) {
                return;
            }
            let label = webview.label().to_string();
            if !mark_first_context_menu_connect(&connected, &label) {
                return;
            }
            if let Err(e) = webview.with_webview(|platform_webview| {
                platform_webview.inner().connect_context_menu(|_, _, _, _| true);
            }) {
                // 仅释放开关功能失败，不影响启动；失败时该窗口保持默认右键行为
                tracing::warn!(error = %e, window = %label, "禁用右键菜单失败（WebKitGTK context-menu 信号连接失败）");
            }
        })
        .build()
}
