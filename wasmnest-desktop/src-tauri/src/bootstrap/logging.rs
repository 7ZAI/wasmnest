//! 启动期日志接线：dev 日志重置、tracing 订阅器构建与安装
//!
//! 从模块入口拆出（入口只放声明与再导出）；`init_logging` 仅对 bootstrap 组合根可见，
//! 调用时序（build_logging 之前先 bootstrap_init）不变。

use crate::system;
use crate::Result;
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
pub(super) fn init_logging(app_handle: &tauri::AppHandle, log_config: &system::config::LogConfig) -> Result<()> {
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
