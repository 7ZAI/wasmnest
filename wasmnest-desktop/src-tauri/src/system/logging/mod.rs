//! 日志系统：控制台日志格式化器 + 日志构建 seam
//!
//! 两部分职责：
//! - **控制台格式化器**：在 `tracing_subscriber` 的 Pretty 格式基础上做两处优化：
//!   - 时间戳改用本地时间毫秒精度，开发时对时间更直观（如 `2026-08-02 00:56:48.819`）
//!   - 消息中的 `[plugin:...]` 标签用品红加粗渲染，与宿主日志（蓝/绿/黄/红）形成明显区分
//! - **日志构建 seam**（`build_logging`）：纯函数构建完整订阅器（error / runtime / frontend
//!   文件层 + 控制台层），不依赖 Tauri AppHandle，供应用启动与单元测试共用。文件层全部
//!   走非阻塞异步写盘（worker 线程 + 有界缓冲），高频输出不再阻塞调用线程。
//!
//! 文件层保持默认格式（UTC 时间戳 + `ThreadId(N)` 线程 id）以便按时间排序排错、
//! 并发问题按线程维度定位；控制台格式仅用于控制台输出层。

use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use nu_ansi_term::{Color, Style};
use tracing::{Event, Level, Subscriber};
use tracing_appender::non_blocking::{NonBlocking, NonBlockingBuilder, WorkerGuard};
use tracing_subscriber::field::MakeVisitor;
use tracing_subscriber::filter::{EnvFilter, FilterFn, Targets};
use tracing_subscriber::fmt::format::{PrettyFields, Writer};
use tracing_subscriber::fmt::time::FormatTime;
use tracing_subscriber::fmt::writer::BoxMakeWriter;
use tracing_subscriber::fmt::{FmtContext, FormatEvent};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::{LookupSpan, Registry};
use tracing_subscriber::reload;
use tracing_subscriber::Layer;

/// 应用配置的日志段（构建 seam 的输入）
use super::config::LogConfig;

// ==================== 日志系统构建（seam） ====================

/// 日志构建产物：运行时句柄集
///
/// worker guard 必须保持存活到进程退出（drop 时触发 worker flush 剩余日志），
/// 因此由应用启动时存入进程级全局（`store_setup`），禁止提前 drop。
pub struct LoggingSetup {
    _error_guard: WorkerGuard,
    _runtime_guard: WorkerGuard,
    _frontend_guard: Option<WorkerGuard>,
    /// runtime 文件层级别热调句柄（02 `set_log_level` 用）
    pub file_level_reload: reload::Handle<EnvFilter, Registry>,
    /// error 文件层丢弃计数读取（03 容量/告警用）
    pub error_writer: NonBlocking,
    /// runtime 文件层丢弃计数读取（03 容量/告警用）
    pub runtime_writer: NonBlocking,
    /// frontend 文件层丢弃计数读取（03 容量/告警用；仅 dev 存在）
    pub frontend_writer: Option<NonBlocking>,
    /// 日志目录（03 容量裁剪 / 04 打开日志目录用）
    pub log_dir: PathBuf,
}

/// 进程级日志句柄（worker guard 存活载体；02/03 从这里取句柄）
static LOGGING_SETUP: OnceLock<LoggingSetup> = OnceLock::new();

/// 进程级保存日志句柄；重复初始化仅告警不覆盖（正常只会调用一次）
pub fn store_setup(setup: LoggingSetup) {
    if LOGGING_SETUP.set(setup).is_err() {
        eprintln!("[logging] setup already stored; duplicate init ignored");
    }
}

/// 获取全局日志句柄（02/03 用；未初始化返回 None，调用方应静默跳过）
pub fn global_setup() -> Option<&'static LoggingSetup> {
    LOGGING_SETUP.get()
}

/// 日志目录维护任务运行间隔（秒）：启动时立即执行一轮，之后每 10 分钟
const LOG_MAINTENANCE_INTERVAL_SECS: u64 = 600;

/// 容量裁剪：日志目录总大小超限时按修改时间删除最旧文件（当前在写文件除外），
/// 直至总大小 ≤ 上限；返回被删除的文件路径列表。`max_total_bytes = 0` 表示禁用。
///
/// 纯函数（外部行为可测）：不依赖全局状态，删除失败的文件跳过不阻断（下轮重试）。
pub fn trim_log_dir(log_dir: &Path, max_total_bytes: usize) -> Vec<PathBuf> {
    if max_total_bytes == 0 {
        return Vec::new();
    }
    // 收集 *.log 文件（修改时间、路径、大小）；元数据读取失败的文件跳过
    let mut files: Vec<(std::time::SystemTime, PathBuf, u64)> = Vec::new();
    let mut total: u64 = 0;
    let Ok(entries) = std::fs::read_dir(log_dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        total += meta.len();
        files.push((mtime, path, meta.len()));
    }
    if total <= max_total_bytes as u64 || files.len() <= 1 {
        return Vec::new();
    }
    // 按修改时间升序（最旧在前）；最后一项（最新，当前在写）跳过
    files.sort_by_key(|(mtime, _, _)| *mtime);
    let mut remaining = total;
    let mut deleted = Vec::new();
    for (_, path, size) in files.iter().take(files.len() - 1) {
        if remaining <= max_total_bytes as u64 {
            break;
        }
        match std::fs::remove_file(path) {
            Ok(()) => {
                remaining -= size;
                deleted.push(path.clone());
            }
            Err(e) => {
                // 删除失败（如 Windows 下文件被占用）：不阻断流程，下轮维护再试
                tracing::debug!("[logging] trim skip {}: {e}", path.display());
            }
        }
    }
    deleted
}

/// 启动后台日志维护任务（容量裁剪 + 非阻塞队列丢弃告警）
///
/// - 容量裁剪：按进程级配置的容量上限执行，需重启后生效（04 设置页保存即改配置）
/// - 丢弃告警：non_blocking 有界缓冲溢出丢弃日志时输出带数量的 warn，避免静默丢失
///
/// 由应用启动时调用一次（`init_logging`，位于 tauri setup 回调）；setup 必需为
/// 进程级全局存活实例（`global_setup`）。
///
/// 调用上下文容错：setup 闭包运行在 tauri 事件循环线程，不在 Tokio runtime
/// 上下文中（`Handle::try_current` 失败），直接 `tokio::spawn` 会 panic
/// "no reactor running"。此时经 `tauri::async_runtime::block_on` 进入其内部
/// tokio runtime 取 Handle 再 spawn（与 lib.rs PluginDevWatcher 启动同惯例）
pub fn spawn_log_maintenance(setup: &'static LoggingSetup, capacity_bytes: usize) {
    let maintenance = async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(LOG_MAINTENANCE_INTERVAL_SECS));
        let mut last_dropped: usize = 0;
        loop {
            interval.tick().await;

            // 容量裁剪
            let deleted = trim_log_dir(&setup.log_dir, capacity_bytes);
            if !deleted.is_empty() {
                tracing::warn!(
                    count = deleted.len(),
                    max_bytes = capacity_bytes,
                    "[logging] trimmed old log files to stay under capacity",
                );
            }

            // 非阻塞队列丢弃告警（自上次检查有新增则提示）
            let dropped = setup.error_writer.error_counter().dropped_lines()
                + setup.runtime_writer.error_counter().dropped_lines()
                + setup
                    .frontend_writer
                    .as_ref()
                    .map_or(0, |w| w.error_counter().dropped_lines());
            if dropped > last_dropped {
                tracing::warn!(
                    dropped_since_last_check = dropped - last_dropped,
                    "[logging] non-blocking log queue dropped lines (buffer overflow)",
                );
            }
            last_dropped = dropped;
        }
    };

    let handle = match tokio::runtime::Handle::try_current() {
        Ok(h) => h,
        Err(_) => {
            // setup 阶段（lib.rs::init_logging 在 tauri setup 回调）不在 Tokio 上下文
            tauri::async_runtime::block_on(async { tokio::runtime::Handle::current() })
        }
    };
    // 在 tokio 工作线程上执行 error boundary 包装的任务（inner tokio::spawn 此刻有 reactor）
    handle.spawn(async move {
        crate::system::error_boundary::spawn_with_error_boundary("log-maintenance", maintenance)
            .await
            .ok();
    });
}

/// 非阻塞写盘缓冲行数（有界；队列满时 worker 丢弃并计数，见 03 告警）
const NON_BLOCKING_BUFFER_LINES: usize = 20_000;

/// 构建日志系统（主 seam，纯函数不依赖 Tauri AppHandle）
///
/// 返回 `(LoggingSetup, 订阅器)`：订阅器由调用方安装（`set_global_default`
/// 或测试的 `with_default`）；setup 由调用方保存（guard 存活 + 后续热调/告警）。
///
/// dev 语义与启动初始化的既有约定保持一致：dev 构建强制 runtime 落盘 debug +
/// 附加 frontend 文件层；级别热调（02）只影响本次运行，重启回落到持久化配置。
pub fn build_logging(
    log_dir: &Path,
    log_config: &LogConfig,
    dev: bool,
) -> crate::Result<(LoggingSetup, Box<dyn Subscriber + Send + Sync + 'static>)> {
    let rotation = match log_config.rotation.as_str() {
        "hourly" => tracing_appender::rolling::Rotation::HOURLY,
        "never" => tracing_appender::rolling::Rotation::NEVER,
        _ => tracing_appender::rolling::Rotation::DAILY,
    };

    // ---- 文件 appender：error / runtime / frontend(仅 dev)，沿用按天命名 ----
    let error_appender = rolling_appender("error", &rotation, log_config.max_files, log_dir)?;
    let runtime_appender = rolling_appender("runtime", &rotation, log_config.max_files, log_dir)?;

    // ---- 非阻塞包装：worker 线程写盘 + 有界缓冲 + 满则丢（计数可读） ----
    let (error_writer, error_guard) = NonBlockingBuilder::default()
        .buffered_lines_limit(NON_BLOCKING_BUFFER_LINES)
        .finish(error_appender);
    let (runtime_writer, runtime_guard) = NonBlockingBuilder::default()
        .buffered_lines_limit(NON_BLOCKING_BUFFER_LINES)
        .finish(runtime_appender);

    // error 层：固定 ERROR 及以上（与既有语义一致）
    // 注意：fmt::layer 的 S 泛型必须在嵌套链中自由推断（悬挂），故逐层内联、不封装帮助函数

    // runtime 层 filter：级别可热调（reload handle 存入 setup，02 使用）
    let file_level = if dev { "debug" } else { log_config.file_level.as_str() };
    let (runtime_filter, file_level_reload) = reload::Layer::new(EnvFilter::new(file_level));
    // json 模式事件行带完整 span 链（`with_span_list`，json() 默认已开）：
    // error.json 行可凭 `spans[].fields.request_id/session_id` 按 key 检索（与
    // text 模式对称）。span 字段必须由 json 层自己的 `JsonFields` 格式化（默认
    // DefaultFields 产生 ANSI 文本，span 序列化会 panic）——两处 json 层都要配。
    let json_event_format = tracing_subscriber::fmt::format::json().with_span_list(true);

    // frontend 层（仅 target=`frontend`，前端 console 中继日志）：
    // 层永远存在，dev 时写 frontend 文件，非 dev 时写丢弃 writer（配合 target 过滤，事件零进入）
    let (frontend_writer_opt, frontend_guard_opt) = if dev {
        let frontend_appender = rolling_appender("frontend", &rotation, log_config.max_files, log_dir)?;
        let (frontend_writer, frontend_guard) = NonBlockingBuilder::default()
            .buffered_lines_limit(NON_BLOCKING_BUFFER_LINES)
            .finish(frontend_appender);
        (Some(frontend_writer), Some(frontend_guard))
    } else {
        (None, None)
    };
    let frontend_writer = frontend_writer_opt
        .clone()
        .map(BoxMakeWriter::new)
        .unwrap_or_else(|| BoxMakeWriter::new(DiscardMakeWriter));

    // 控制台层：dev 或配置开启；关闭时 filter=off + 丢弃 writer 双保险
    let console_on = dev || log_config.console_in_release;
    let console_writer = if console_on {
        BoxMakeWriter::new(std::io::stdout)
    } else {
        BoxMakeWriter::new(DiscardMakeWriter)
    };
    // RUST_LOG 环境变量优先级最高，其次使用配置值；关闭时 "off" 全关
    let console_filter = if console_on {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&log_config.console_filter))
    } else {
        EnvFilter::new("off")
    };

    // runtime/error 文件层格式按配置切换（E 泛型不同无法运行时替换，双分支各自返回 Box 统一）；
    // frontend / 控制台层始终 text（前端 relay 人类可读；控制台是开发通道）
    // ErrorLayer（链尾）在 error 事件注入 span 上下文（05，tracing-error）
    let json_mode = log_config.format.eq_ignore_ascii_case("json");
    // error 层过滤：span 全放行（error 行需要完整 span 链定位请求/会话），事件仅 ERROR 及以上。
    // 不能用 EnvFilter::new("error")——它会把 INFO 级 span 一并过滤，导致 error 行丢失 span 前缀
    let error_filter = FilterFn::new(|meta: &tracing::Metadata<'_>| {
        if meta.is_span() {
            true // span 全放行：error 事件行需要完整 span 链（含 INFO 级父 span）
        } else {
            *meta.level() <= Level::ERROR
        }
    });
    let subscriber: Box<dyn Subscriber + Send + Sync + 'static> = if json_mode {
        Box::new(
            tracing_subscriber::registry()
                // runtime 层（链首：reload filter 的 S 解析为 Registry，句柄类型才能存入 LoggingSetup）
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(runtime_writer.clone())
                        .fmt_fields(tracing_subscriber::fmt::format::JsonFields::new())
                        .event_format(json_event_format.clone())
                        .with_target(true)
                        .with_thread_ids(true)
                        .with_line_number(true)
                        .with_filter(runtime_filter),
                )
                // error 层：固定 ERROR 及以上（json 格式）
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(error_writer.clone())
                        .fmt_fields(tracing_subscriber::fmt::format::JsonFields::new())
                        .event_format(json_event_format.clone())
                        .with_target(true)
                        .with_thread_ids(true)
                        .with_line_number(true)
                        .with_filter(error_filter.clone()),
                )
                // frontend 层（仅 target=`frontend`，text）
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(frontend_writer)
                        .with_ansi(false)
                        .with_target(true)
                        .with_thread_ids(true)
                        .with_line_number(true)
                        .with_filter(Targets::new().with_target("frontend", Level::DEBUG)),
                )
                // 控制台层
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(console_writer)
                        .with_ansi(true)
                        .fmt_fields(PrettyFields::new())
                        .event_format(ConsoleFormatter::new())
                        .with_filter(console_filter),
                )
                // error 事件注入 span 路径（05）
                .with(tracing_error::ErrorLayer::default()),
        )
    } else {
        Box::new(
            tracing_subscriber::registry()
                // runtime 层（链首，见 json 分支注释）
                // 文本 Full 格式默认在事件行打印当前 span 链（05 调用链），无需额外配置
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(runtime_writer.clone())
                        .with_ansi(false)
                        .with_target(true)
                        .with_thread_ids(true)
                        .with_line_number(true)
                        .with_filter(runtime_filter),
                )
                // error 层：固定 ERROR 及以上
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(error_writer.clone())
                        .with_ansi(false)
                        .with_target(true)
                        .with_thread_ids(true)
                        .with_line_number(true)
                        .with_filter(error_filter.clone()),
                )
                // frontend 层（仅 target=`frontend`，前端 console 中继日志）
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(frontend_writer)
                        .with_ansi(false)
                        .with_target(true)
                        .with_thread_ids(true)
                        .with_line_number(true)
                        .with_filter(Targets::new().with_target("frontend", Level::DEBUG)),
                )
                // 控制台层
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(console_writer)
                        .with_ansi(true)
                        .fmt_fields(PrettyFields::new())
                        .event_format(ConsoleFormatter::new())
                        .with_filter(console_filter),
                )
                // error 事件注入 span 路径（05）
                .with(tracing_error::ErrorLayer::default()),
        )
    };

    let setup = LoggingSetup {
        _error_guard: error_guard,
        _runtime_guard: runtime_guard,
        _frontend_guard: frontend_guard_opt,
        file_level_reload,
        error_writer: error_writer.clone(),
        runtime_writer: runtime_writer.clone(),
        frontend_writer: frontend_writer_opt,
        log_dir: log_dir.to_path_buf(),
    };

    Ok((setup, subscriber))
}

/// 构建按天轮转的 rolling appender（文件名前缀 + `.log` 后缀，max_files=0 时不限数量）
fn rolling_appender(
    prefix: &str,
    rotation: &tracing_appender::rolling::Rotation,
    max_files: usize,
    log_dir: &Path,
) -> crate::Result<tracing_appender::rolling::RollingFileAppender> {
    let mut builder = tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(rotation.clone())
        .filename_prefix(prefix)
        .filename_suffix("log");
    if max_files > 0 {
        builder = builder.max_log_files(max_files);
    }
    builder.build(log_dir).map_err(|e| {
        // InitError 非 io::Error，包装为带上下文的 Io 错误，保留“创建日志文件失败”语义
        crate::AppError::Io(std::io::Error::other(format!(
            "create log appender '{prefix}' failed: {e}"
        )))
    })
}

// 日志文件层（固定 4 层之一）的通用属性：无 ANSI、带 target 与行号。
// 不封装成帮助函数：fmt::Layer 的 S 泛型必须在 `with` 嵌套链中自由推断，
// 提前固定（如 `Layer<Registry, ...>`）会使后续嵌套层类型无法满足约束。
// 各层直接使用 `tracing_subscriber::fmt::layer()` 并配置相同属性即可。

/// 丢弃全部输出的占位 writer（非 dev / 控制台关闭时的 frontend/console 层兜底；
/// 对应 filter 已 off，此处仅保证层可组装，不产生任何 I/O）
struct DiscardMakeWriter;

struct DiscardWriter;

impl std::io::Write for DiscardWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for DiscardMakeWriter {
    type Writer = DiscardWriter;
    fn make_writer(&'a self) -> Self::Writer {
        DiscardWriter
    }
}

mod bootstrap;
mod formatter;

#[cfg(test)]
mod tests;

pub use bootstrap::*;
pub use formatter::*;
