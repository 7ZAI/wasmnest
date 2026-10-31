//! 应用启动装配：日志接线、Tauri builder、托盘、插件目录注入
//!
//! 原 lib.rs「Application Setup」整段；`run` / `run_with` 经 lib.rs 再导出，
//! `wasmnest_desktop_lib::run{,_with}` 外部路径不变。

mod context_menu;

#[cfg(all(test, target_os = "linux"))]
mod context_menu_test;

// `run_with` 的插件目录注入单测（私有 fn 只能留 crate 内；不启动 Tauri）
#[cfg(test)]
mod run_with_test;

#[cfg(debug_assertions)]
use crate::bench_channel;
use crate::wasm_core;
use crate::Result;
use crate::{commands, plugin, plugin_updates, server, system};
// 原生右键菜单抑制是 **Linux 专用**（Windows WebView2 / macOS WKWebView 由前端
// capture 阶段 preventDefault 覆盖）：这三个项在 context_menu.rs 里都带
// `#[cfg(target_os = "linux")]`，装配侧的注册与窗口销毁钩子也在同一 cfg 里。
// 少了这一行 cfg，非 Linux 目标会 E0432 unresolved import（首次三平台发布实测）。
#[cfg(target_os = "linux")]
use context_menu::{context_menu_ledger, forget_context_menu_label, native_context_menu_guard};

// ==================== Application Setup ====================

use crate::db::Database;
use std::sync::Arc;
use tauri::Manager;

/// 删除当天已存在的日志文件（仅 dev 构建调用）
///
/// dev 启动频次高，按天追加会让同一天的日志混入多次启动的片段，难以定位；
/// 因此 dev 启动时替换当天日志（删旧建新）。release 保持按天追加轮转。
/// 必须在 RollingFileAppender 构建前调用，确保 appender 首次写入创建全新文件。
/// dev 启动同时重置 `bootstrap.log`（bootstrap 通道先于本函数就绪；重置消息本身
/// 经 bootstrap 落盘即重建该文件，见 system::logging::bootstrap_log）。
#[cfg(debug_assertions)]
fn reset_today_logs(log_dir: &std::path::Path) {
    // bootstrap.log（固定文件名，bootstrap 通道产物、无轮转）：dev 重启替换，
    // 避免多次启动的启动早期片段混叠；消息经 bootstrap 通道写入即重建文件
    let bootstrap_path = log_dir.join("bootstrap.log");
    if bootstrap_path.exists() {
        match std::fs::remove_file(&bootstrap_path) {
            Ok(()) => system::logging::bootstrap_log(
                tracing::Level::INFO,
                format!("[logging] dev reset: replaced {}", bootstrap_path.display()),
            ),
            Err(e) => system::logging::bootstrap_log(
                tracing::Level::ERROR,
                format!(
                    "[logging] dev reset: failed to replace {}: {e}",
                    bootstrap_path.display()
                ),
            ),
        }
    }
    // tracing_appender 的 rolling 文件名日期用 UTC（与本地日期可能错位一天）
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    // 日志重置列表：runtime / error / frontend（前端 console 单独文件，见 init_logging）
    for prefix in ["runtime", "error", "frontend"] {
        let path = log_dir.join(format!("{prefix}.{today}.log"));
        if path.exists() {
            match std::fs::remove_file(&path) {
                Ok(()) => system::logging::bootstrap_log(
                    tracing::Level::INFO,
                    format!("[logging] dev reset: replaced today's log {}", path.display()),
                ),
                Err(e) => system::logging::bootstrap_log(
                    tracing::Level::ERROR,
                    format!("[logging] dev reset: failed to replace {}: {e}", path.display()),
                ),
            }
        }
    }
}

/// 初始化日志系统
///
/// 接受 LogConfig 参数，所有日志行为均可通过配置文件控制
fn init_logging(app_handle: &tauri::AppHandle, log_config: &system::config::LogConfig) -> Result<()> {
    let log_dir = app_handle.path().app_log_dir().expect("Failed to get log directory");

    // bootstrap 通道幂等兜底：setup 早期已初始化（config 复制/加载沿用），此处仅防漏
    system::logging::bootstrap_init(&log_dir)?;
    std::fs::create_dir_all(&log_dir)?;

    // dev 构建替换当天日志（release 保持追加轮转）
    #[cfg(debug_assertions)]
    reset_today_logs(&log_dir);

    // 构建日志订阅器：文件层非阻塞写盘 + 控制台层。
    // 过滤语义与旧实现一致（error 固定 ERROR、runtime 按级别、frontend 仅 dev），
    // 全部收敛于 system::logging::build_logging，便于独立单测（见该模块测试）
    let (setup, subscriber) = system::logging::build_logging(&log_dir, log_config, cfg!(debug_assertions))?;
    install_subscriber(subscriber);

    // 保存句柄到进程级全局：worker guard 存活到进程退出（drop 时 flush 剩余日志）；
    // 级别热调（file_level_reload）与容量裁剪/丢弃告警（writers）由后续模块从此读取
    system::logging::store_setup(setup);

    // 启动后台日志维护任务：容量裁剪（超限删最旧，当前在写文件除外）+ 非阻塞队列丢弃告警（03）
    system::logging::spawn_log_maintenance(
        system::logging::global_setup().expect("logging setup stored before maintenance"),
        log_config.capacity_bytes,
    );

    tracing::info!("Logging initialized. Log directory: {:?}", log_dir);
    tracing::info!(
        "Log config: file_level={}, rotation={}, max_files={}, console_in_release={}",
        log_config.file_level,
        log_config.rotation,
        log_config.max_files,
        log_config.console_in_release,
    );
    tracing::info!("WasmNest Desktop v{} starting...", env!("CARGO_PKG_VERSION"));

    Ok(())
}

/// 安装 tracing 全局订阅器（容忍 log→tracing 桥已被抢占）
///
/// debug 构建下 tauri-plugin-wdio 的 `.setup()` 会先 `log::set_boxed_logger`
/// 抢占 log 全局 logger（其 setup 早于应用 setup 执行），使 `try_init()` 在
/// `LogTracer::init()` 阶段返回 `SetLoggerError` 并 panic。拆成两步：桥安装
/// 失败仅忽略（log 记录由 wdio 自带 logger 承接），tracing 全局默认仍须设置
/// （与 `try_init` 第二步 `set_global_default` 等价）。
fn install_subscriber<S>(subscriber: S)
where
    S: tracing::Subscriber + Send + Sync + 'static,
{
    let _ = tracing_log::LogTracer::init();
    tracing::subscriber::set_global_default(subscriber).expect("Failed to set tracing subscriber");
}

/// 应用启动时间，用于计算启动耗时
pub struct AppStartTime(pub(crate) std::time::Instant);

/// 前端插件通道会话的生命周期钩子（审计票 06）
///
/// 页面加载重置**该 webview** 的 loader 会话密钥与全部插件令牌：宿主前端 bootstrap 会在导入
/// 任何插件模块之前重新取得密钥，而插件代码只在模块被导入后才开始运行——「首个调用者生效」
/// 因此恒由宿主前端赢得；dev 下页面刷新也能重新取得（否则刷新后插件前端全部拿不到凭证）。
///
/// **按 webview 分区**（2026-09-26）：本钩子对每个 webview（主窗口 / 终端窗口 / 未来任何
/// 独立窗口）都触发，凭证表按 label 分域——否则终端窗口加载会回收主窗口凭证，使主窗口插件面
/// 命令全数被拒（`缺少有效通道凭证`）。详见 `security::frontend_channel` 模块注释。
fn frontend_channel_session_hook() -> tauri::plugin::TauriPlugin<tauri::Wry> {
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

/// 宿主读取插件目录的环境变量名（启动流程的唯一读取点，`run_with` 也写它）
pub(crate) const PLUGINS_DIR_ENV: &str = "WASMNEST_PLUGINS_DIR";

/// 把外部插件目录写进宿主启动环境，返回写入的目录。
///
/// 空路径必须显性失败：启动流程把空字符串与「未设置」同等对待（回退内置插件目录），
/// 静默回退会让调用方误以为自己的目录已生效（AGENTS「不静默降级」口径）。
pub(crate) fn apply_plugins_dir_env(plugins_dir: impl Into<std::path::PathBuf>) -> std::path::PathBuf {
    let dir = plugins_dir.into();
    assert!(
        !dir.as_os_str().is_empty(),
        "run_with: plugins_dir 不能为空（空值会被宿主当作未设置而回退内置插件目录）"
    );
    std::env::set_var(PLUGINS_DIR_ENV, &dir);
    dir
}

/// 以指定插件目录启动宿主（通用 runtime crate 的注入入口）。
///
/// 与 [`run`] 的唯一差别：启动前把 `plugins_dir` 写入 `WASMNEST_PLUGINS_DIR`；
/// 宿主其余行为（内置目录回退、asset scope 动态放行、发布链路）逐字不变。
/// 每个进程只应调用一次（Tauri 事件循环只能初始化一次）。
pub fn run_with(plugins_dir: impl Into<std::path::PathBuf>) {
    apply_plugins_dir_env(plugins_dir);
    run();
}

pub fn run() {
    use tauri::Emitter;

    let app_start = AppStartTime(std::time::Instant::now());
    let start = app_start.0;

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(frontend_channel_session_hook());

    // Linux：正式版抑制 WebView 原生右键菜单的页面加载钩子（dev 注册但空转）
    #[cfg(target_os = "linux")]
    {
        builder = builder.plugin(native_context_menu_guard());
        // 窗口销毁即丢弃其去重记录：同一会话关窗后重开得到的是全新 webview 实例，
        // 但 label 复用（`terminal-${session.id}`），不清理则新窗口永不被连接信号。
        builder = builder.on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                forget_context_menu_label(context_menu_ledger(), window.label());
            }
        });
    }

    // WDIO 测试插件仅 debug 构建注册（release 不编译该依赖、不注册该插件）
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_wdio::init());
    }

    let app = builder
        .setup(move |app| {
            app.manage(app_start);

            // 平台条件默认窗口尺寸：tauri.conf.json 全局默认 1300×900 适配
            // Windows/macOS（字符渲染密度与 DPI 匹配），Linux（WebKitGTK）在
            // 此放大到 1560×1080（曾全局改大导致 Windows 默认窗口过大，见
            // b33e5d99 反例，改为仅 Linux 生效）。set_size 失败仅降级为全局
            // 默认小窗，不阻断启动。
            #[cfg(target_os = "linux")]
            {
                if let Some(win) = app.get_webview_window("main") {
                    // 目标窗口尺寸（逻辑像素）：Linux 下才放大，Windows/macOS 沿用全局默认
                    let target = tauri::LogicalSize::new(1560.0f64, 1080.0f64);
                    // 居中位置用目标尺寸一次性原子计算，替代 set_size 后 center()：
                    // center() 内部读 outer_size() 缓存，在 set_size 异步请求（tao
                    // window_requests 通道）执行前仍是旧值 1300×900，且 GTK resize
                    // 左上角锚定，导致窗口扩大后中心点偏向右下、补偿失效。
                    // 位置与尺寸同源于 target，与请求执行顺序无关。
                    let monitor = win
                        .current_monitor()
                        .ok()
                        .flatten()
                        .or_else(|| win.primary_monitor().ok().flatten());
                    if let Some(monitor) = monitor {
                        let scale = monitor.scale_factor();
                        let work_area = *monitor.work_area();
                        // 物理像素计算，语义与 tauri 内部 calculate_window_center_position
                        // 一致（work_area 居中，避开 Dock / 任务栏）
                        let target_phys = target.to_physical::<u32>(scale);
                        let x = (work_area.size.width as i32 - target_phys.width as i32) / 2 + work_area.position.x;
                        let y = (work_area.size.height as i32 - target_phys.height as i32) / 2 + work_area.position.y;
                        if let Err(e) = win.set_size(target) {
                            tracing::warn!(error = %e, "Linux 默认窗口尺寸调整失败，沿用全局默认");
                        }
                        if let Err(e) = win.set_position(tauri::PhysicalPosition::new(x, y)) {
                            // 定位失败不阻断启动：仅记录，窗口回落 WM 默认放置
                            tracing::warn!(error = %e, "Linux 默认窗口居中定位失败，沿用窗口管理器默认位置");
                        }
                    } else {
                        // 无显示器信息（极端环境）：仅调整尺寸，位置交给窗口管理器
                        if let Err(e) = win.set_size(target) {
                            tracing::warn!(error = %e, "Linux 默认窗口尺寸调整失败，沿用全局默认");
                        }
                    }
                }
            }

            // 注：正式版禁用右键原生菜单（Linux WebKitGTK context-menu 信号）由
            // native_context_menu_guard 插件的页面加载钩子统一处理，覆盖每个 webview。

            let app_handle = app.handle();

            // 启动早期日志通道：build_logging 之前（config 复制/加载、dev reset）的日志
            // 写入 bootstrap.log（release 构建启动失败证据不丢），init_logging 之后由
            // runtime 文件接管；初始化失败仅降级为控制台（eprintln），不阻断启动
            let log_dir = app_handle.path().app_log_dir().expect("Failed to get log directory");
            if let Err(e) = system::logging::bootstrap_init(&log_dir) {
                eprintln!("[logging] bootstrap channel init failed: {e}");
            }

            let config_path = app_handle
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir")
                .join("config.properties");

            // 首次启动时从打包资源复制默认配置到 AppData
            // 后续启动直接使用 AppData 中的配置，用户修改不会丢失
            if !config_path.exists() {
                if let Ok(resource_path) = app_handle
                    .path()
                    .resolve("resources/config.properties", tauri::path::BaseDirectory::Resource)
                {
                    if resource_path.exists() {
                        if let Some(parent) = config_path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        match std::fs::copy(&resource_path, &config_path) {
                            Ok(_) => system::logging::bootstrap_log(
                                tracing::Level::INFO,
                                format!("Default config copied from resource to {}", config_path.display()),
                            ),
                            Err(e) => system::logging::bootstrap_log(
                                tracing::Level::ERROR,
                                format!("Failed to copy default config: {e}, using built-in defaults"),
                            ),
                        }
                    }
                }
            }

            // 先加载配置，再初始化日志系统，使日志行为可配置
            let app_config = crate::system::config::AppConfig::load(&config_path).unwrap_or_else(|e| {
                system::logging::bootstrap_log(
                    tracing::Level::ERROR,
                    format!("Failed to load config, using defaults: {e}"),
                );
                crate::system::config::AppConfig::default()
            });

            // 初始化日志系统（依赖已加载的 LogConfig）
            init_logging(app.handle(), &app_config.log)?;

            // 初始化全局配置单例
            crate::system::config::AppConfig::init(app_config.clone());

            // 开屏首帧的深浅色：静态首屏（public/splash.css）早于任何 JS，只认
            // prefers-color-scheme，读不到 AppConfig.ui.theme。这里趁 webview 还没绘制，
            // 把设置翻译成窗口主题（Linux = GTK prefer-dark-theme）让媒体查询直接对上，
            // 三段开屏（静态首帧 → SplashLoading → 壳）才是同一套深浅色。
            // 机制与调用时序见 system::appearance 文件头注。
            if let Some(window) = app.get_webview_window("main") {
                system::appearance::apply_window_appearance(&window, &app_config.ui.theme);
            }

            // 同步 PowerManager 开关状态到配置值
            crate::system::power::power_manager().set_enabled(app_config.network.prevent_sleep);

            // 启动电源唤醒监听：Windows 显示器长时间熄灭/锁屏后，WebView2 可能黑屏且不自愈，
            // 系统唤醒时强制窗口重绘（详见 system::power_wake 模块文档）
            crate::system::power_wake::spawn_wake_monitor(app_handle.clone());

            // 保存 resource_dir 供 AppContext 与插件资源加载使用
            let resource_dir = app_handle.path().resource_dir().expect("Failed to get resource dir");

            // 解析桌面端插件目录
            // dev 模式下 resolve 指向 target/debug/resources/...（Tauri 不自动复制资源）
            // 生产模式下 resolve 指向安装目录的 resources/...（打包时已包含）
            // 因此 dev 模式回退到源码目录
            let plugins_dir = {
                // 外部指定优先（wasm-app 工程 dev：`WASMNEST_PLUGINS_DIR`）
                //
                // 宿主以**构建产物**（`tauri build --debug` 的可运行 app image）分发时，
                // 不再有「平台仓源码目录」可 fallback：各 wasm-app 把自己的产物写进
                // 该目录（`<dir>/<appId>/…`），宿主侧 PluginDevWatcher 监听它触发热重载。
                // 未设置本变量时行为**逐字不变**（发布链路与平台仓 dev 均不受影响）。
                let from_env = std::env::var(PLUGINS_DIR_ENV)
                    .ok()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .map(std::path::PathBuf::from);
                match from_env {
                    Some(dir) => {
                        if dir.exists() {
                            tracing::info!("Plugin dir from WASMNEST_PLUGINS_DIR: {:?}", dir);
                        } else {
                            // fail-visible：拼错路径会得到一个空应用列表，必须喊出来
                            tracing::error!(
                                "WASMNEST_PLUGINS_DIR 指向的目录不存在，内置应用将为空: {:?}",
                                dir
                            );
                        }
                        dir
                    }
                    None => {
                        let resolved = app_handle
                            .path()
                            .resolve("resources/plugins/desktop", tauri::path::BaseDirectory::Resource)
                            .expect("Failed to resolve plugins directory");
                        if resolved.exists() {
                            resolved
                        } else {
                            // dev 模式 fallback：使用源码目录
                            let manifest_dir =
                                std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");
                            let fallback = std::path::PathBuf::from(manifest_dir)
                                .join("resources")
                                .join("plugins")
                                .join("desktop");
                            tracing::info!(
                                "Plugin resolved path not found, falling back to source dir: {:?}",
                                fallback
                            );
                            fallback
                        }
                    }
                }
            };

            // ==================== 应用整包目录进 asset protocol 作用域 ====================
            //
            // 壳前端装载应用前端（ADR 0057 机制 B）经 asset 协议取件，两处同源：
            //   - 挂载包：动态 `import(convertFileSrc(<plugins_dir>/<appId>/index.js))`
            //   - 应用图标：`<img src=convertFileSrc(<plugins_dir>/<appId>/icon.svg)>`
            // 路径不在 asset 协议的允许作用域内 → 一律 403，且两种表现都很隐蔽：
            //   动态 import 失败 → 挂载槽转错误面（「应用界面加载失败，可重试」）；
            //   图片加载失败   → 图标回退成壳内通用 glyph（BedCode 落到 transfer 图形）。
            //
            // `tauri.conf.json` 的静态作用域只有 `$RESOURCE` / `$APPCONFIG` / `$APPDATA`
            // 三族，覆盖的是「插件目录在 resource 基目录之下」那一种形态（平台仓 dev 的
            // `target/debug/resources/plugins/desktop`、打包安装后的 `resources/plugins`）。
            // 而 `WASMNEST_PLUGINS_DIR` 允许把插件目录指到**任意**路径（应用仓
            // `apps/<slug>/desktop/.dev-host/plugins` 就是这种），那类路径落在静态作用域
            // 之外 → 403（2026-10-21 实测：dev:host 起宿主后点 app 即报
            // 「Importing a module script failed.」+ 图标回退）。
            //
            // 故这里按解析出的**真源目录**动态放行：scope 的 pattern 集合是 Arc 共享，
            // 运行时追加对已创建的 webview 同样生效（asset 处理器持的是同一份 Scope 的
            // 克隆）。放行范围 = 插件目录子树 = 应用整包（index.js / icon.svg / 随包资源），
            // 不扩大到宿主其它资源面。
            //
            // 目录先 canonicalize：作用域匹配时请求路径也会被 canonicalize（解符号链接），
            // 模式串必须用同一形态才匹配得上（路径含符号链接时不 canonicalize 会 403）。
            let asset_scope_dir = plugins_dir
                .canonicalize()
                .unwrap_or_else(|_| plugins_dir.clone());
            if let Err(e) = app
                .asset_protocol_scope()
                .allow_directory(&asset_scope_dir, true)
            {
                // fail-visible：放行失败 = 应用前端与图标必然 403，必须喊出来
                tracing::error!(
                    "asset protocol scope: failed to allow plugins dir {:?}: {e}",
                    asset_scope_dir
                );
            } else {
                tracing::info!(
                    "asset protocol scope: plugins dir allowed {:?}",
                    asset_scope_dir
                );
            }

            let ws_port = app_config.network.port;

            // 检查端口可用性
            let ws_port = match server::host_port::check_and_resolve_port(&app_handle, ws_port) {
                Ok(port) => port,
                Err(e) => {
                    tracing::error!("Port check failed: {}", e);
                    ws_port // 使用原端口，服务器启动会失败并记录日志
                }
            };

            let db_path = app_handle
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir")
                .join("wasmnest.db");

            if let Some(parent) = db_path.parent() {
                std::fs::create_dir_all(parent)?;
            }

            // 对等网络节点身份：目录与 DB 同源解析自 app_data_dir（决策 D3 宿主只
            // 注入目录），node_identity.json 与 wasmnest.db 并列存放；错误经 ? 上抛
            // 走既有启动失败路径——静默换身份会让对端可信列表全部失效（D3）
            let peer_net_data_dir = app_handle.path().app_data_dir().expect("Failed to get app data dir");
            wasmnest_server_peer_net::init_node_identity(&peer_net_data_dir)?;

            // 对等网络节点状态容器（ticket 03）：节点生命周期由应用作用域服务租约
            // 驱动——插件经 host-peer.start-node / stop-node 按插件 id 记账，首个
            // 引用拉起、最后一个引用关停（见 `net.peer-node` 服务）；宿主不再按
            // 产品 id 驱动，也没有无属主的启动命令面。
            // 状态以 Arc 托管（server-lib-split）：peer-net 引擎派生任务需要
            // 克隆句柄跨 await 存活（drive_gate / session_watch / 入站桥 /
            // 发现刷新订阅）；命令壳与 host_api 经 peer_ctx 一次装配
            app.manage(Arc::new(wasmnest_server_peer_net::PeerNetState::default()));
            // peer-engine 状态仅保存当前引擎会话控制句柄与事件快照，不是业务持久化真源；
            // 任务、历史、设置均由 file-transfer 插件私有库持有。
            app.manage(Arc::new(wasmnest_server_peer_net::peer_engine_transfer::PeerTransferState::default()));
            app.manage(Arc::new(wasmnest_server_peer_net::peer_engine_receive::PeerReceiveState::default()));
            app.manage(Arc::new(wasmnest_server_peer_net::peer_engine_remote::PeerRemoteState::default()));

            let db = Database::new(&db_path)?;
            db.init_schema()?;

            let db = Arc::new(std::sync::Mutex::new(db));

            // v33（ADR 0033）：宿主**不再持有**入场签发密钥（签发/验签均在认证
            // 中心），故此处无密钥预生成。旧的 `plugin_secrets` 属主 `host` 行
            // （`('host','jwt.key')`）由 `db::run_migrations` 幂等清理（见
            // migrations 的 v33 条目）——那是不可达的旧密钥材料，留着只是白给的面。

            // ==================== 创建所有全局单实例 ====================

            // 采集系统基本信息（OS / 设备名称 / IP），挂载到 AppContext 供全局引用
            let system_info = Arc::new(system::info::SystemInfo::collect());

            let resource_dir_arc = Arc::new(resource_dir);
            // 票 11：内核会话管理器 / 配置管理器不再装配——会话真源在
            // `com.wasmnest.bedcode` 登记域，宿主只保留 `session_gateway`
            // 窄转发层（互调 api + `host-pty` 引擎）。
            // app_handle_arc 需在 plugin_host 之前创建，因为 PluginHost::new() 需要它构建 HostContextFns
            let app_handle_arc = Arc::new(app_handle.clone());

            // mDNS 广播句柄：**必须早于 `PluginHost::new` 创建并托管**——传输面
            // 服务可能在 L1/L2 角色组件激活期（new 内部）被 acquire，supervisor
            // start 的广播登记经 Tauri managed state 解析它（早于 AppContext 注册）。
            let mdns_advertiser = Arc::new(tokio::sync::RwLock::new(
                wasmnest_discovery_engine::advertiser::MdnsAdvertiser::new(),
            ));
            // 提前托管：链路加密启动装配与 server 端口面在 `PluginHost::new` 之前
            // 就需要 DB / 广播句柄（激活期 acquire 会真正拉起服务）
            app.manage(db.clone());
            app.manage(mdns_advertiser.clone());

            // 链路加密先于任何服务启动装配：第一条流量就要被开关裁决（spec §6）；
            // 身份损坏时强制回退全关，不阻断启动。
            tauri::async_runtime::block_on(server::composition::init_link_crypto_at_startup(&app_handle));

            // WS 管理器纯内存装配（不监听）：传输面由服务租约按需 start
            tauri::async_runtime::block_on(wasmnest_server_websocket::WebSocketManager::global().init())
                .expect("Failed to initialize WebSocketManager");

            // server-lib-split：装配服务器端口（宿主壳实现注入；supervisor /
            // ws / http / peer-net 的「无 AppContext」保守分支依赖本注册表）。
            // **必须早于 `PluginHost::new`**：L1/L2 角色组件在 new 内激活；激活期
            // 的 peer 节点请求（file-transfer）会 acquire 服务，且界面租约随后
            // 启动传输面——两者都需要本注册表 + 托管状态。
            // 句柄直传：本注册表早于 AppContext 注册，路径面靠它解析（2026-10-07 修）。
            crate::server::composition::install_server_ports_with(Some(app_handle_arc.clone()));

            // 服务器端口只记录配置，不启动（启停由 net.transport 服务租约决定）
            let supervisor = wasmnest_server_core::supervisor::ServerSupervisor::global();
            tauri::async_runtime::block_on(supervisor.init_config(ws_port));

            // 应用作用域服务注册表：传输面 + 对等网络节点。必须在 `PluginHost::new`
            // 之前完成注册与注入——角色驱动组件 / 应用 activate 可能请求 peer 节点
            // 服务（acquire），内核生命周期回收也需要同一份注册表。
            // 传输面 boot 不无条件启动：端点注册只预登记；界面租约（普通应用）在
            // 挂载时才 acquire，服务端型应用（manifest `backgroundTransport`）由内核
            // 在各自启动成功后 acquire（含 `PluginHost::new` 内角色激活的 L1/L2）。
            let service_registry = Arc::new(wasmnest_server_base::service::ServiceRegistry::new());
            wasmnest_server_core::service::TransportService::register(&service_registry)
                .expect("register net.transport service (duplicate key = assembly bug)");
            wasmnest_server_peer_net::service::PeerNodeService::register(
                &service_registry,
                crate::server::peer_net_cmds::peer_ctx(&app_handle),
            )
            .expect("register net.peer-node service (duplicate key = assembly bug)");

            // 用户插件目录（app_data_dir/plugins）：zip 安装的插件所在地（可卸载），
            // 与只读的内置目录（resource_dir/resources/plugins/desktop）分离
            let user_plugins_dir = app_handle
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir")
                .join("plugins");
            // PluginHost::new 返回 Arc<Self>（属主失败回报端口需要宿主弱引用）
            // 整核抽出 §3.3：对等网络上下文装配端口由 lib 注入（peer_net_cmds::peer_ctx
            // 读 tauri managed state + server 端口装配；无头 harness 不传 → HEADLESS_UNAVAILABLE）
            let peer_ctx_provider: Option<Arc<crate::wasm_core::host_api::context::PeerCtxProvider>> =
                Some(Arc::new(crate::server::peer_net_cmds::peer_ctx));
            // 票 08/P0-2：第一方免弹窗归属清单（产品数据）由 lib 装配时注入——
            // 判定逻辑在 wasm-core（机制），清单真源在本文件即可（first_party_dirs.rs）
            let first_party_dirs = crate::first_party_dirs::first_party_dirs();
            // **必须在 PluginHost::new 之前**：wasm-core 会按系统分区 `activation_state`
            // 跑 `auto_activate_from_persisted_state`，把上次运行过的 L3 应用复活。
            // 桌面「打开」是会话级动作（persist=false），boot 启动唯一来源是
            // `plugin.autostart.{id}`（见 plugin/lifecycle.rs 模块头契约）；清掉历史
            // 快照后，升级前留下的「没打开却运行中」状态也不会再出现。
            let plugin_storage = wasm_core::storage::PluginStorage::new(db.clone());
            tauri::async_runtime::block_on(
                plugin::lifecycle::clear_persisted_activation_snapshot(&plugin_storage),
            )?;
            let plugin_host = tauri::async_runtime::block_on(wasm_core::PluginHost::new(
                db.clone(),
                &plugins_dir,
                &user_plugins_dir,
                Some(app_handle_arc.clone()),
                peer_ctx_provider,
                first_party_dirs,
                // 桌面 ABI 规格（端事实由宿主注入：wasm-core 零端 ABI 知识，
                // 版本上限 + abi-form 要求来自桌面 SDK 组装后的契约）
                wasm_core::manager::runtime::AbiPolicy {
                    form: Some(wasm_core::manager::runtime::FORM_COMPONENT),
                },
                // 桌面端事实（平台标识 / 入站服务器端口；单形态收口后从 wasm-core
                // 迁出的端差异实现——file-transfer 在激活期经 platform() 探测端值）
                std::sync::Arc::new(crate::plugin::host_facts::DesktopHostFacts),
                // 桌面平台选择器（host-platform.pick-* 的桌面对话框实现；同样从
                // 内核迁出的端差异——移动侧是 SAF 端口，经 EnginePortsPlatformPicker
                // 在 `new_with_ports` 装配）
                Some(std::sync::Arc::new(crate::plugin::platform_picker::DesktopPlatformPicker::new(
                    (*app_handle_arc).clone(),
                ))),
                // 应用作用域服务注册表：new 内 L1/L2 激活期即可 acquire
                Some(service_registry.clone()),
            ));
            // 注入消息总线 dispatcher（两阶段初始化）
            tauri::async_runtime::block_on(plugin_host.init_message_bus());

            // 终端同步事件通道已随 websocket 业务下沉票 08 删除（插件事件改 bus+emit，
            // 宿主不再持有 HostSyncEvent / broadcast-sync 广播面）

            // ==================== guest 事件派发器注入（票 03 / ADR 0022） ====================
            // `events` 导出的调用契约是端专属事实（桌面 on-message / on-process-done），
            // 机制留 wasm-core、契约面由本宿主用自有绑定实现——与 peer_ctx_provider /
            // domain_ports 同范式（`&self` + RwLock，宿主只拿到不可变 Arc）。
            // 装配期注入即可（晚绑定共享槽）：`PluginHost::new` 扫描期已实例化的插件
            // 在派发时实时读取本槽位，注入对它同样生效；漏注入则事件派发
            // fail-visible 报错（不是静默丢消息）。
            plugin_host.wasm_runtime().set_guest_events(std::sync::Arc::new(
                crate::plugin::guest_events::DesktopGuestEvents,
            ));

            // ==================== 注册到 AppContext 全局容器 ====================

            let _ctx = system::app_context::AppContextBuilder::new()
                .db(db.clone())
                .plugin_host(plugin_host.clone())
                .mdns_advertiser(mdns_advertiser.clone())
                .app_handle(Some(app_handle_arc.clone()))
                .resource_dir(resource_dir_arc.clone())
                .system_info(system_info.clone())
                .build_and_init();

            // 注册到 Tauri State（前端 invoke 可用）；db / mdns_advertiser 已在
            // `PluginHost::new` 之前托管（激活期服务启动需要）
            app.manage(plugin_host.clone());
            // 应用整包目录（ADR 0057 机制 B）：启动装配已解析出唯一的 `plugins_dir`
            // （dev 回退到源码目录的逻辑也在这里），壳前端装载挂载包时只消费这条事实，
            // 不再自己拼 `resources/plugins/desktop`——少写一层 `resources` 就是
            // 2026-10-17 实机验证 P0-1 的 404 根因。
            app.manage(plugin::assets::AppAssetsDir(plugins_dir.clone()));
            // 宿主侧插件生命周期编排层（2026-10-17 lifecycle-sync）：壳动作经它驱动
            // 真实启停/审批/卸载 + enabled/autostart 偏好持久化；boot 装配在其后跑
            // `apply_autostart`（业务应用按 `plugin.autostart.{id}` 补激活；系统服务
            // 被用户显式关闭自启时停用本会话实例）。历史「上次运行快照」已在上方创建
            // `PluginHost` 之前清空，故这里是 L3 业务应用唯一的 boot 启动源（用户
            // 2026-10-20 裁决）。
            let lifecycle = Arc::new(plugin::lifecycle::PluginLifecycleManager::new(plugin_host.clone()));
            app.manage(lifecycle.clone());
            tauri::async_runtime::block_on(lifecycle.apply_autostart());
            app.manage(plugin_host.wasm_runtime().fs_auth().clone());
            // 网络出站授权应答通道（票 05）：与 fs 应答同一形态——前端弹窗经
            // 宿主面凭证代答，故应答器必须是进程级单例（与事件广播的询问一一对应）
            app.manage(plugin_host.wasm_host_ctx().net_auth().clone());
            // peer-net 节点的启动不再需要 boot 对账：节点由插件在自己的 activate 里
            // 调 `host-peer.start-node` 经服务租约请求，宿主只按插件 id 记账；那条
            // 按硬编码产品 id 的 boot 对账连同它的产品耦合一起退役
            // ==================== 开发模式：启动插件文件监听 ====================
            // 仅 debug 构建启用，监听插件产物变化触发热重载
            // notify 回调在非 Tokio 线程中运行，必须通过 Handle::spawn 而非 tokio::spawn
            // setup 闭包不在 Tokio runtime 上下文中，需通过 block_on 获取 Handle
            #[cfg(debug_assertions)]
            {
                let runtime_handle = tauri::async_runtime::block_on(async { tokio::runtime::Handle::current() });
                let _dev_watcher = wasm_core::watcher::PluginDevWatcher::start(
                    plugins_dir.to_path_buf(),
                    runtime_handle,
                    // 整核抽出：watcher 不再经 AppContext::global() 取宿主，改由
                    // bootstrap 注入弱引用（plugin_host 在此处已创建，见上）
                    Arc::downgrade(&plugin_host),
                );
                // dev_watcher 需要 hold 住生命周期，存入 AppContext 或 leak
                // 使用 Box::leak 使 watcher 生命周期与进程一致（开发模式可接受）
                Box::leak(Box::new(_dev_watcher));
                tracing::info!("Plugin dev watcher enabled (debug build)");
            }

            // ==================== 传输面按需启动 ====================
            //
            // 不再在此永久启动 server：应用调 `host-http-endpoint.register-endpoint` /
            // `host-websocket-server.register-endpoint` 时经服务租约 acquire
            // `net.transport`，首个引用拉起（Actix + mDNS 广播 + 防休眠 + 指标采样），
            // 最后一个引用释放关停。零应用 = 零监听 / 零广播（Q1/Q2）。
            //
            // 链路加密装配、WS 管理器 init、端口注册表、服务注册表均已在上方
            // `PluginHost::new` 之前完成（激活期 acquire 需要）。

            // 写入端口文件
            let app_handle_clone = app_handle.clone();
            let ws_port_copy = ws_port;
            tauri::async_runtime::spawn(async move {
                let port_file = app_handle_clone
                    .path()
                    .app_data_dir()
                    .ok()
                    .map(|p| p.join("wasmnest-port.txt"));

                if let Some(port_file) = port_file {
                    if let Some(parent) = port_file.parent() {
                        let _ = tokio::fs::create_dir_all(parent).await;
                    }
                    if let Err(e) = tokio::fs::write(&port_file, ws_port_copy.to_string()).await {
                        tracing::warn!("Failed to write port file: {}", e);
                    } else {
                        tracing::info!("Wrote port file: {}", port_file.display());
                    }
                }
            });

            // 票 09：原先在这里启动的「SessionManager 状态事件 → 前端
            // `session-status-changed`」转发器已退役（订阅源对插件会话无流量、
            // 前端零消费方），见 `events.rs` 模块头。

            setup_tray(app_handle)?;

            let window = app_handle
                .get_webview_window("main")
                .expect("Failed to get main window");
            let close_window = window.clone();
            let close_app_handle = app_handle.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // 始终先阻止默认关闭，避免 block_on 死锁
                    // 在同步回调中使用 block_on 会在 Tokio 运行时繁忙时死锁，
                    // 因此改为先阻止关闭，再 spawn 异步任务检查钩子
                    api.prevent_close();

                    let win = close_window.clone();
                    let ah = close_app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let should_close = system::lifecycle::lifecycle_registry().run_window_close_hooks().await;

                        if should_close {
                            // 无运行中会话，直接关闭
                            if let Err(e) = win.destroy() {
                                tracing::error!("Failed to destroy window: {}", e);
                            }
                        } else {
                            // 有运行中会话，通知前端弹窗确认。payload = 插件登记域视图
                            // 数组原样透传（`session-list {filter:"running"}`）——「哪些状态
                            // 算运行中需要确认」的判据在插件会话域（`ops::needs_close_confirmation`，
                            // 2026-09-25 下沉），宿主零字段读取只取 `sessions` 数组做 emit；
                            // **失败回退空列表**——关闭路径不能被插件异步调用阻塞
                            // （2026-09-23 用户定案）
                            let ctx = system::app_context::AppContext::global();
                            let host_ctx = ctx.plugin_host().wasm_host_ctx();
                            let running = match crate::utils::session_gateway::running_views(host_ctx).await {
                                Ok(reply) => reply.get("sessions").and_then(|s| s.as_array()).cloned().unwrap_or_else(|| {
                                    tracing::warn!(error = %reply, "window close payload: reply missing sessions array, fallback to empty list");
                                    Vec::new()
                                }),
                                Err(e) => {
                                    tracing::warn!(
                                        error = %e,
                                        "window close payload: plugin running list unavailable, fallback to empty list"
                                    );
                                    Vec::new()
                                }
                            };

                            tracing::info!(
                                count = running.len(),
                                "Window close requested with {} running session(s), emitting to frontend",
                                running.len()
                            );

                            if let Err(e) = ah.emit(system::constants::WINDOW_CLOSE_REQUESTED, &running) {
                                tracing::error!(error = %e, "Failed to emit window-close-requested");
                            }
                        }
                    });
                }
            });

            let init_elapsed = start.elapsed();
            tracing::info!(
                "WasmNest Desktop initialized - WebSocket server on port {} (后端初始化耗时: {}ms)",
                ws_port,
                init_elapsed.as_millis()
            );

            // 注册核心模块的生命周期钩子（Shutdown/WindowClose）
            system::lifecycle::register_core_lifecycle_hooks();
            system::lifecycle::register_window_close_hooks();

            // 触发 Startup 钩子
            tauri::async_runtime::spawn(async move {
                system::lifecycle::lifecycle_registry().run_startup_hooks().await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Session / PTY Input：**会话命令面已整体注销**（票 08）——
            // 列表 / 单查 / 尺寸 / 写入 / 特殊键五条连壳删除，消费方改指插件
            // 命令面（`session.list` / `session.get` / `session.action.resize` /
            // `session.input`），见 commands.rs 会话命令节头部注释
            // 终端输出面（票 05 摘除）：旧 Channel 传输命令
            // （subscribe_terminal_channel / unsubscribe_terminal_channel /
            // terminal_channel_ack，commands/terminal_stream.rs）已随宿主前端
            // 消费方摘除——插件输出改经 host-session.output-ring-fetch 原语
            // （插件命令面 session.output.pull）拉取，宿主不留降级输出传输
            // 配对 / QR / 连接历史命令面已注销：产品面归 com.wasmnest.bedcode 插件的
            // session.pairing.* / session.qr.* / session.devices.* / session.history.*
            // （凭据签发与 `pairings` 表仍在内核 auth 模块，宿主只留原语与记录面；
            // 见 .scratch/2026-09-21-host-rust-residue/issues/05）
            commands::set_log_level,
            commands::save_log_settings,
            commands::open_log_dir,
            commands::open_external_url,
            // Updater（外壳命令：updater:default 权限已撤除，发起权收归 Rust）
            commands::check_for_update,
            commands::install_update,
            // Settings
            commands::get_app_settings,
            commands::save_app_settings,
            commands::set_terminal_bg_image,
            // 壳自定义壁纸：Rust 侧取图 + 复制到 app_data（前端无 fs 权限）
            commands::pick_custom_wallpaper,
            commands::clear_custom_wallpaper,
            // Utility
            commands::ping,
            commands::get_app_version,
            commands::confirm_window_close,
            // Dev Console Relay（仅 dev：前端 console 日志转发，写 runtime.*.log + frontend.*.log 单独文件，见 commands.rs Dev Console Log Relay 节）
            #[cfg(debug_assertions)]
            commands::report_frontend_log,
            // 桥接基准 · Channel 传输面（仅 debug：AGENTS §5.1 的 debug-only 测试面，
            // 零业务语义、不碰既有能力；见 src/bench_channel.rs 头注释与 bench/README.md）
            #[cfg(debug_assertions)]
            bench_channel::bench_channel_stream_bytes,
            #[cfg(debug_assertions)]
            bench_channel::bench_channel_stream_text,
            #[cfg(debug_assertions)]
            bench_channel::bench_channel_stream_raw,
            // Plugin
            commands::plugin_list_loaded,
            commands::plugin_get_info,
            // 应用整包目录（ADR 0057 机制 B：壳装载独立构建的 app 前端，路径真源在宿主）
            plugin::assets::plugin_get_asset_dir,
            // 外部应用包选取与识别（安装前半程：原生对话框 + peek plugin.json id；
            // 安装本体 = plugin_install_from_file，宿主面凭证门在 api_bridge）
            plugin::install_picker::plugin_pick_app_package,
            // app 前端 env.invoke 白名单查询（ADR 0058 方案 A；真源 = commands.rs
            // APP_FRONTEND_INVOKE_WHITELIST，前端白名单代理启动时取用）
            commands::plugin_frontend_invoke_whitelist,
            commands::plugin_preauthorize,
            commands::plugin_activate,
            commands::plugin_deactivate,
            commands::plugin_approve,
            commands::plugin_frontend_loader_session,
            commands::plugin_channel_token,
            commands::plugin_install_from_file,
            commands::plugin_uninstall,
            // 应用更新链路（plugin_updates.rs：GitHub Release 检查 + 校验下载；
            // 安装复用 plugin_install_from_file 升级模式，兼容判断在壳前端）
            plugin_updates::plugin_check_app_update,
            plugin_updates::plugin_download_update,
            plugin_updates::plugin_pick_app_zip,
            commands::plugin_mark_error,
            commands::plugin_frontend_load_report,
            // 生命周期偏好/状态（D3：桌面补移动端同款缺失臂，语义逐字一致；编排层在
            // plugin/lifecycle.rs，与 api_bridge 的清单/启停/审批/卸载臂并存）
            plugin::lifecycle::plugin_is_enabled,
            plugin::lifecycle::plugin_set_enabled,
            plugin::lifecycle::plugin_is_autostart,
            plugin::lifecycle::plugin_set_autostart,
            plugin::lifecycle::plugin_is_running,
            plugin::lifecycle::plugin_is_activated,
            commands::plugin_storage_get,
            commands::plugin_storage_set,
            commands::plugin_storage_delete,
            // `plugin_terminal_send_input` 随票 08 注销：终端输入改走插件
            // 命令通道 `session.input`（宿主不再替插件导流输入）
            commands::plugin_invoke,
            commands::plugin_fs_auth_respond,
            commands::plugin_network_auth_respond,
            commands::plugin_auth_overview,
            commands::plugin_auth_set_strategy,
            commands::plugin_auth_revoke,
            commands::plugin_auth_remove_record,
            // Server（启停 / 重启 / 自启动命令已退役：服务由应用引用记账驱动，
            // 命令面不得创建无属主服务；保留只读与纯配置）
            commands::get_server_status,
            commands::get_server_metrics,
            commands::get_server_network_config,
            commands::update_server_port,
            commands::update_server_network_config,
            commands::get_traffic_encryption_config,
            commands::set_traffic_encryption_config,
            commands::get_link_crypto_fingerprint,
            commands::reset_server_network_config,
            // 应用界面租约（service-leases）：外壳挂载 / 卸载应用整包时驱动
            // net.transport 的 acquire / release
            commands::plugin_surface_open,
            commands::plugin_surface_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // 使用 .build() + .run() 替代 .run()，以接入 Tauri RunEvent 循环
    // RunEvent::ExitRequested 是执行优雅关闭的最后时机
    app.run(move |_app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            tracing::info!("WasmNest Desktop exit requested, running shutdown hooks...");
            tauri::async_runtime::block_on(async {
                system::lifecycle::lifecycle_registry().run_shutdown_hooks().await;
            });
        }
        tauri::RunEvent::Exit { .. } => {
            tracing::info!("WasmNest Desktop exited");
        }
        _ => {}
    });
}
/// Setup system tray
fn setup_tray(app: &tauri::AppHandle) -> Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "隐藏窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => {
                // 尝试关闭主窗口（触发 CloseRequested → 生命周期钩子 → 确认弹窗）
                // 如果窗口已隐藏，先显示再关闭
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.close();
                } else {
                    // 无窗口时直接退出
                    app.exit(0);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    tracing::info!("System tray initialized");
    Ok(())
}
