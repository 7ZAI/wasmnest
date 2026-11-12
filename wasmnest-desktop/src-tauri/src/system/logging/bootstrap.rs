//! bootstrap 日志：build_logging 之前进程级启动早期通道（自 logging.rs 拆出）

use super::*;

// ==================== bootstrap 日志（build_logging 之前） ====================

/// bootstrap 文件层日志（进程级启动早期通道）
///
/// `build_logging` 之前（config 复制/加载、dev reset 等启动早期路径）tracing 宏
/// 是 no-op（全局订阅器未安装），消息只走 `eprintln!`——debug 控制台可见，
/// release 完全不落盘。本通道在这段窗口期内把日志写入 `bootstrap.log`
/// （与 runtime.*.log 同目录），release 构建的启动失败证据不再丢失；
/// `init_logging` 完成后启动早期路径不再调用，bootstrap 自然停止增长，
/// 容量裁剪（`.log` 后缀）覆盖该文件不失控。
///
/// 实现：writer 每次写重新打开 `bootstrap.log`（追加模式）——dev reset 删除
/// 该文件后下一次写自动重建，不依赖 appender 持有 fd；外层套
/// `NonBlockingBuilder`（worker 线程 + 有界缓冲），符合文件层异步写盘规范。
const BOOTSTRAP_LOG_FILE: &str = "bootstrap.log";

/// 打开即追加的 bootstrap 文件 writer（每次写重建文件句柄）
struct BootstrapFileWriter {
    log_dir: PathBuf,
}

impl std::io::Write for BootstrapFileWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log_dir.join(BOOTSTRAP_LOG_FILE))?;
        f.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// bootstrap 通道进程级产物（worker guard 存活到进程退出，禁止提前 drop）
pub struct BootstrapLogger {
    _guard: WorkerGuard,
    writer: NonBlocking,
}

/// 进程级 bootstrap 通道（worker guard 存活载体）
static BOOTSTRAP: OnceLock<BootstrapLogger> = OnceLock::new();

/// 初始化 bootstrap 通道：创建日志目录（幂等）+ 打开 `bootstrap.log`（追加）
///
/// 必须在任何启动早期日志（config 复制/加载、dev reset）之前调用一次；
/// 重复调用幂等（首次生效）。失败（目录无法创建）返回错误，由调用方降级：
/// 启动早期日志仍走 `eprintln!`，不阻断启动。
pub fn bootstrap_init(log_dir: &Path) -> crate::Result<()> {
    if BOOTSTRAP.get().is_some() {
        return Ok(());
    }
    std::fs::create_dir_all(log_dir)?;
    let (writer, guard) = NonBlockingBuilder::default().finish(BootstrapFileWriter {
        log_dir: log_dir.to_path_buf(),
    });
    match BOOTSTRAP.set(BootstrapLogger { _guard: guard, writer }) {
        Ok(()) => {
            bootstrap_log(
                Level::INFO,
                format!("[bootstrap] logging channel initialized: {}", log_dir.display()),
            );
            Ok(())
        }
        // 并发初始化竞争：另一线程已就绪，视为成功
        Err(_) => Ok(()),
    }
}

/// 启动早期日志：写 `bootstrap.log`（non_blocking 队列）+ 控制台 eprintln 双写
///
/// 统一由本函数处理控制台输出，调用方不再单独 eprintln；release 构建控制台
/// 本就不启用，双写不会产生多余输出。
pub fn bootstrap_log(level: Level, message: impl AsRef<str>) {
    let message = message.as_ref();
    // 控制台双写（dev 可见；release 控制台关闭，输出为空流）
    eprintln!("{message}");
    let Some(logger) = BOOTSTRAP.get() else {
        return; // 通道未初始化（如测试直接调用）：仅控制台，不落盘
    };
    let ts = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
    // non_blocking 队列满丢弃（同 runtime 文件层语义，丢失有容量告警兜底）
    let mut writer = logger.writer.clone();
    let _ = writeln!(writer, "{ts} {level:>5} {message}");
}
