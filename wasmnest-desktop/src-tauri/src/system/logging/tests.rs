use super::*;
use std::sync::{Arc, Mutex};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;

// ==================== build_logging（01 seam）验收 ====================

/// 每个测试独立临时目录（并行测试互不干扰），测试结束自动清理
fn temp_log_dir(tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "wasmnest-log-test-{}-{}-{}",
        tag,
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).expect("create temp log dir");
    dir
}

/// 读取目录下指定前缀的当天（UTC）日志文件内容；不存在返回空串
fn read_log_file(dir: &Path, prefix: &str) -> String {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let path = dir.join(format!("{prefix}.{today}.log"));
    std::fs::read_to_string(&path).unwrap_or_default()
}

fn log_file_exists(dir: &Path, prefix: &str) -> bool {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    dir.join(format!("{prefix}.{today}.log")).exists()
}

fn test_config(file_level: &str) -> LogConfig {
    LogConfig {
        file_level: file_level.to_string(),
        console_filter: String::new(),
        rotation: "daily".to_string(),
        max_files: 0,
        capacity_bytes: 0, // 测试默认禁用容量裁剪，避免干扰其他断言
        format: "text".to_string(),
        console_in_release: false,
    }
}

#[test]
fn build_logging_release_semantics_filters_by_level() {
    let dir = temp_log_dir("release");
    let config = test_config("info");
    let (setup, subscriber) = build_logging(&dir, &config, false).expect("build logging");
    tracing::subscriber::with_default(subscriber, || {
        tracing::debug!(target: "wasmnest_test", "debug line must not land");
        tracing::info!(target: "wasmnest_test", "info line lands");
        tracing::error!(target: "wasmnest_test", "error line lands");
    });
    drop(setup); // worker guard drop → flush 剩余日志后才断言

    let runtime = read_log_file(&dir, "runtime");
    assert!(
        runtime.contains("info line lands"),
        "runtime should have info: {runtime}"
    );
    assert!(
        runtime.contains("error line lands"),
        "runtime should have error: {runtime}"
    );
    assert!(
        !runtime.contains("debug line must not land"),
        "runtime at info level must not contain debug: {runtime}"
    );
    // release 语义（dev=false）不创建 frontend 文件
    assert!(!log_file_exists(&dir, "frontend"), "no frontend file when dev=false");

    let error_log = read_log_file(&dir, "error");
    assert!(
        error_log.contains("error line lands"),
        "error file should contain error: {error_log}"
    );
    assert!(
        !error_log.contains("info line lands"),
        "error file must not contain info: {error_log}"
    );
    drop_dir(&dir);
}

#[test]
fn build_logging_dev_semantics_forces_debug_and_frontend_file() {
    let dir = temp_log_dir("dev");
    let config = test_config("info"); // dev 强制 debug，应覆盖配置值
    let (setup, subscriber) = build_logging(&dir, &config, true).expect("build logging");
    tracing::subscriber::with_default(subscriber, || {
        tracing::debug!(target: "wasmnest_test", "debug line lands in dev");
        tracing::info!(target: "frontend", "frontend console line lands");
    });
    drop(setup);

    let runtime = read_log_file(&dir, "runtime");
    assert!(
        runtime.contains("debug line lands in dev"),
        "dev forces debug level: {runtime}"
    );
    // frontend target 事件既进 frontend 文件也混入 runtime（既有行为，见 docs/security.md §2 日志节）
    assert!(
        runtime.contains("frontend console line lands"),
        "frontend events also land in runtime (existing behavior): {runtime}"
    );
    let frontend = read_log_file(&dir, "frontend");
    assert!(
        frontend.contains("frontend console line lands"),
        "frontend file should contain console relay line: {frontend}"
    );
    drop_dir(&dir);
}

#[test]
fn build_logging_exposes_dropped_counters() {
    let dir = temp_log_dir("dropped");
    let config = test_config("debug");
    let (setup, _subscriber) = build_logging(&dir, &config, true).expect("build logging");
    // 丢弃计数接口可用（03 容量任务读取入口基准为 0）
    assert_eq!(setup.error_writer.error_counter().dropped_lines(), 0);
    assert_eq!(setup.runtime_writer.error_counter().dropped_lines(), 0);
    let frontend = setup.frontend_writer.as_ref().expect("dev has frontend writer");
    assert_eq!(frontend.error_counter().dropped_lines(), 0);
    drop_dir(&dir);
}

/// 构造 JSON 格式的测试配置
fn json_config(file_level: &str) -> LogConfig {
    LogConfig {
        format: "json".to_string(),
        ..test_config(file_level)
    }
}

#[test]
fn build_logging_json_format_is_parseable() {
    let dir = temp_log_dir("json");
    let config = json_config("info");
    let (setup, subscriber) = build_logging(&dir, &config, false).expect("build logging");
    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(target: "wasmnest_test", session_id = 42, "json info line lands");
        tracing::error!(target: "wasmnest_test", "json error line lands");
    });
    drop(setup);

    let runtime = read_log_file(&dir, "runtime");
    assert!(!runtime.is_empty(), "runtime json file should be written");
    let first: serde_json::Value =
        serde_json::from_str(runtime.lines().next().unwrap()).expect("runtime line should be valid JSON");
    assert_eq!(first["level"], "INFO", "json should carry level field: {first}");
    assert_eq!(
        first["fields"]["session_id"], 42,
        "json should carry message fields: {first}"
    );
    assert!(
        first["fields"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("json info line lands")),
        "json should carry message text: {first}"
    );

    let error_log = read_log_file(&dir, "error");
    assert!(!error_log.is_empty(), "error json file should be written");
    let err_line: serde_json::Value =
        serde_json::from_str(error_log.lines().next().unwrap()).expect("error line should be valid JSON");
    assert_eq!(err_line["level"], "ERROR", "error file only ERROR: {err_line}");
    drop_dir(&dir);
}

/// 02 验收：json 模式事件行携带 span 链（`with_span_list`），error.json 行
/// 可凭 `span[].fields.request_id/session_id` 按 key 检索（与 text 模式对称）
#[test]
fn json_format_events_carry_span_list() {
    let dir = temp_log_dir("json-span");
    let config = json_config("info");
    let (setup, subscriber) = build_logging(&dir, &config, false).expect("build logging");
    tracing::subscriber::with_default(subscriber, || {
        let parent = tracing::span!(
            tracing::Level::INFO,
            "http_request",
            request_id = "req-span-1",
            method = "POST"
        );
        parent.in_scope(|| {
            tracing::error!(target: "wasmnest_test", session_id = 7, "boom inside span");
        });
    });
    drop(setup);

    // error 文件只收 ERROR 事件（FilterFn 语义不变），且该行带 span 链
    let error_log = read_log_file(&dir, "error");
    let err_line: serde_json::Value =
        serde_json::from_str(error_log.lines().next().unwrap()).expect("error line should be valid JSON");
    assert_eq!(err_line["level"], "ERROR", "error file only ERROR: {err_line}");
    // span 链：json() 全链默认输出 `spans` 数组（root→leaf），并在 `span` 键
    // 带当前 span 对象；断言全链数组内 request_id 可检索
    let spans = err_line["spans"]
        .as_array()
        .unwrap_or_else(|| panic!("error line should carry spans list: {err_line}"));
    let outer = spans
        .iter()
        .find(|s| s["name"] == "http_request")
        .unwrap_or_else(|| panic!("spans should contain http_request: {err_line}"));
    // span 对象里字段平铺（SerializableSpan 把 span 字段写进对象顶层）
    assert_eq!(
        outer["request_id"], "req-span-1",
        "span fields should carry request_id: {err_line}"
    );
    assert_eq!(outer["method"], "POST", "span field method: {err_line}");
    // 既有 json 字段不变（level/target/line_number）
    assert_eq!(err_line["target"], "wasmnest_test", "target field kept: {err_line}");
    assert!(err_line["line_number"].is_number(), "line_number kept: {err_line}");
    drop_dir(&dir);
}

/// 03 验收：bootstrap 通道在 build_logging 之前落盘 `bootstrap.log`，
/// 文件删除（dev reset）后下一次写自动重建；格式带级别与 UTC 时间戳
#[test]
fn bootstrap_channel_writes_file_and_recreates_after_delete() {
    let dir = temp_log_dir("bootstrap");
    bootstrap_init(&dir).expect("bootstrap init");
    // worker 线程异步写盘：短暂等待后读取，保证确定性
    let settle = || std::thread::sleep(std::time::Duration::from_millis(100));

    bootstrap_log(Level::INFO, "bootstrap line one");
    bootstrap_log(Level::ERROR, "bootstrap line two");
    settle();

    let path = dir.join("bootstrap.log");
    let content = std::fs::read_to_string(&path).expect("bootstrap.log written");
    assert!(content.contains("bootstrap line one"), "first line: {content}");
    assert!(content.contains("bootstrap line two"), "second line: {content}");
    // 行结构：UTC 时间戳 + 级别 + 消息
    assert!(
        content.lines().any(|l| l.contains(" INFO bootstrap line one")),
        "level+msg: {content}"
    );
    assert!(
        content.lines().any(|l| l.contains("ERROR bootstrap line two")),
        "level+msg: {content}"
    );

    // dev reset 语义：删除后下一次写重建文件
    std::fs::remove_file(&path).expect("remove bootstrap.log");
    bootstrap_log(Level::INFO, "bootstrap line three");
    settle();
    let content = std::fs::read_to_string(&path).expect("bootstrap.log recreated");
    assert!(
        content.contains("bootstrap line three") && !content.contains("bootstrap line one"),
        "recreated file should only hold post-reset lines: {content}"
    );
    drop_dir(&dir);
}

/// 创建指定名称与字节数的日志文件；`old` 为 true 时把修改时间推到 1 天前
fn write_log_file(dir: &Path, name: &str, bytes: usize, old: bool) {
    let path = dir.join(name);
    std::fs::write(&path, "x".repeat(bytes)).unwrap();
    if old {
        let older = std::time::SystemTime::now() - std::time::Duration::from_secs(86_400);
        let f = std::fs::File::options().write(true).open(&path).unwrap();
        let _ = f.set_modified(older);
    }
}

#[test]
fn trim_log_dir_removes_oldest_files_and_keeps_current() {
    let dir = temp_log_dir("trim-basic");
    // 当前文件最小化关注：c.log 最新（视为在写），a/b 一天前
    write_log_file(&dir, "a.log", 100, true);
    write_log_file(&dir, "b.log", 100, true);
    write_log_file(&dir, "c.log", 100, false);

    // 上限 150：总 300 → 删最旧 a（100 → 剩 200）仍在超限 → 删 b（→ 剩 100）停
    let deleted = trim_log_dir(&dir, 150);
    assert_eq!(deleted.len(), 2, "should delete 2 oldest files");
    assert_eq!(deleted[0].file_name().unwrap().to_str().unwrap(), "a.log");
    assert_eq!(deleted[1].file_name().unwrap().to_str().unwrap(), "b.log");
    assert!(!dir.join("a.log").exists());
    assert!(!dir.join("b.log").exists());
    assert!(dir.join("c.log").exists(), "current (newest) file must be kept");
    drop_dir(&dir);
}

#[test]
fn trim_log_dir_under_capacity_keeps_everything() {
    let dir = temp_log_dir("trim-under");
    write_log_file(&dir, "a.log", 100, true);
    write_log_file(&dir, "b.log", 100, false);
    let deleted = trim_log_dir(&dir, 300); // 总 200 ≤ 300
    assert!(deleted.is_empty(), "no deletion when under capacity: {deleted:?}");
    assert!(dir.join("a.log").exists());
    assert!(dir.join("b.log").exists());
    drop_dir(&dir);
}

#[test]
fn trim_log_dir_zero_capacity_disables() {
    let dir = temp_log_dir("trim-off");
    write_log_file(&dir, "a.log", 100, true);
    write_log_file(&dir, "b.log", 100, false);
    let deleted = trim_log_dir(&dir, 0);
    assert!(deleted.is_empty(), "capacity 0 must disable trimming");
    assert!(dir.join("a.log").exists());
    assert!(dir.join("b.log").exists());
    drop_dir(&dir);
}

#[test]
fn trim_log_dir_single_current_file_is_untouched() {
    let dir = temp_log_dir("trim-single");
    write_log_file(&dir, "runtime.log", 500, false);
    // 唯一文件且超限：视为当前在写文件，不删
    let deleted = trim_log_dir(&dir, 100);
    assert!(deleted.is_empty(), "single current file must survive: {deleted:?}");
    assert!(dir.join("runtime.log").exists());
    drop_dir(&dir);
}

/// 05 验收：文本文件层事件行携带 span 链（Full 格式默认），error 文件带 span 路径
#[test]
fn runtime_logs_carry_span_chain_in_text_mode() {
    let dir = temp_log_dir("span-chain");
    let config = test_config("info");
    let (setup, subscriber) = build_logging(&dir, &config, false).expect("build logging");
    tracing::subscriber::with_default(subscriber, || {
        // 注意：子 span 必须在父 span 的 in_scope 内创建，否则父链不绑定
        let parent = tracing::span!(
            tracing::Level::INFO,
            "http_request",
            request_id = "req-1",
            method = "POST"
        );
        parent.in_scope(|| {
            let child = tracing::span!(tracing::Level::INFO, "session_create", session_id = "s-100");
            child.in_scope(|| {
                tracing::info!(target: "wasmnest_test", "msg inside nested spans");
                tracing::error!(target: "wasmnest_test", "boom inside nested spans");
            })
        });
    });
    drop(setup);

    let runtime = read_log_file(&dir, "runtime");
    // Full 文本格式默认打印当前 span 链（含名称与字段）
    assert!(
        runtime.contains("http_request"),
        "runtime should show outer span: {runtime}"
    );
    assert!(
        runtime.contains("session_create"),
        "runtime should show inner span: {runtime}"
    );
    assert!(runtime.contains("req-1"), "span fields should be printed: {runtime}");

    // ErrorLayer + span 上下文：error 行携带所属 span 链，可定位请求/会话
    let error_log = read_log_file(&dir, "error");
    assert!(
        error_log.contains("session_create") && error_log.contains("http_request"),
        "error file should carry span path: {error_log}"
    );
    drop_dir(&dir);
}

#[test]
fn runtime_level_reload_takes_effect_without_restart() {
    let dir = temp_log_dir("reload");
    let config = test_config("info");
    let (setup, subscriber) = build_logging(&dir, &config, false).expect("build logging");
    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(target: "wasmnest_test", "before reload: info lands");
        tracing::debug!(target: "wasmnest_test", "before reload: debug must not land");

        // 热调到 debug：新写 debug 落盘
        setup
            .file_level_reload
            .reload(EnvFilter::new("debug"))
            .expect("reload to debug");
        tracing::debug!(target: "wasmnest_test", "after reload: debug lands");

        // 热调到 error：warn 不再落盘
        setup
            .file_level_reload
            .reload(EnvFilter::new("error"))
            .expect("reload to error");
        tracing::warn!(target: "wasmnest_test", "after reload: warn must not land");
        tracing::error!(target: "wasmnest_test", "after reload: error lands");
    });
    drop(setup);

    let runtime = read_log_file(&dir, "runtime");
    assert!(
        runtime.contains("before reload: info lands"),
        "info at initial level: {runtime}"
    );
    assert!(
        !runtime.contains("before reload: debug must not land"),
        "debug filtered at info level: {runtime}"
    );
    assert!(
        runtime.contains("after reload: debug lands"),
        "debug after reload to debug: {runtime}"
    );
    assert!(
        !runtime.contains("after reload: warn must not land"),
        "warn filtered after reload to error: {runtime}"
    );
    assert!(
        runtime.contains("after reload: error lands"),
        "error after reload to error: {runtime}"
    );
    drop_dir(&dir);
}

/// 清理临时目录（断言失败时保留目录便于排查）
fn drop_dir(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn split_plugin_tag_recognizes_plugin_prefix() {
    let msg = "[plugin:com.wasmnest.bedcode] task-status body: {\"status\":\"idle\"}";
    let (tag, rest) = split_plugin_tag(msg).expect("should split plugin tag");
    assert_eq!(tag, "[plugin:com.wasmnest.bedcode]");
    assert_eq!(rest, " task-status body: {\"status\":\"idle\"}");
}

#[test]
fn split_plugin_tag_returns_none_for_host_logs() {
    assert!(split_plugin_tag("Session created: abc").is_none());
    assert!(split_plugin_tag("").is_none());
}

/// 将 fmt layer 输出收集到内存缓冲的 MakeWriter
struct SharedWriter(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct SharedWriterMaker(Arc<Mutex<Vec<u8>>>);

impl<'a> MakeWriter<'a> for SharedWriterMaker {
    type Writer = SharedWriter;
    fn make_writer(&'a self) -> Self::Writer {
        SharedWriter(self.0.clone())
    }
}

#[test]
fn console_formatter_uses_local_time_and_colors_plugin_tag() {
    let buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));

    let layer = tracing_subscriber::fmt::layer()
        .with_writer(SharedWriterMaker(buf.clone()))
        .with_ansi(true)
        .fmt_fields(PrettyFields::new())
        .event_format(ConsoleFormatter::new());

    let subscriber = tracing_subscriber::registry().with(layer);
    tracing::subscriber::with_default(subscriber, || {
        tracing::debug!(
            target: "test::log",
            "[plugin:com.wasmnest.bedcode] task-status body: {}",
            "{\"status\":\"idle\"}",
        );
        tracing::info!("Session created: test");
    });

    let out = String::from_utf8(buf.lock().unwrap().clone()).unwrap();

    // 时间戳为本地时间毫秒精度
    let ts_re = regex::Regex::new(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}").expect("valid timestamp regex");
    assert!(ts_re.is_match(&out), "timestamp should be local ms format, got:\n{out}");

    // 时间戳与级别之间必须有空格（修复日志粘连：`27.869DEBUG`）
    // 级别可能被 ANSI 颜色码包裹（\x1b[34mDEBUG\x1b[0m），正则允许颜色码穿插
    let ts_level_re = regex::Regex::new(
        r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} (?:\x1b\[[0-9;]*m)?(DEBUG| INFO| WARN|ERROR|TRACE)",
    )
    .expect("valid timestamp-level regex");
    assert!(
        ts_level_re.is_match(&out),
        "timestamp should be followed by a space then level, got:\n{out}"
    );

    // 插件标签出现且被品红着色
    assert!(
        out.contains("[plugin:com.wasmnest.bedcode]"),
        "plugin tag should be present, got:\n{out}"
    );
    // 品红（35m）仅出现一次：只用于插件标签，宿主日志不被染成品红
    assert_eq!(
        out.matches(";35m").count(),
        1,
        "magenta should only wrap the plugin tag, got:\n{out}"
    );

    // 保留源文件定位行（"at" 被格式化器渲染为 ANSI 斜体样式，字面量 "at " 不出现，
    // 改为断言定位行内容本身）
    assert!(out.contains("tests.rs:"), "location line should be kept, got:\n{out}");
}

// ==================== 控制台过滤器（dev 兜底） ====================

/// 只记录事件 target 的 layer：验证控制台过滤器「谁能进控制台」，不关心格式
struct TargetRecorder(Arc<Mutex<Vec<&'static str>>>);

impl<S> tracing_subscriber::Layer<S> for TargetRecorder
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        self.0.lock().unwrap().push(event.metadata().target());
    }
}

/// 用真实订阅器（target 记录器 + 给定 EnvFilter）跑一遍探针事件，返回被放行的 target
fn dispatch_through(filter: &str, emit: impl FnOnce()) -> Vec<&'static str> {
    let hits = Arc::new(Mutex::new(Vec::new()));
    let subscriber = tracing_subscriber::registry()
        .with(TargetRecorder(hits.clone()))
        .with(EnvFilter::new(filter));
    tracing::subscriber::with_default(subscriber, emit);
    let recorded = hits.lock().unwrap().clone();
    recorded
}

#[test]
fn console_filter_string_dev_adds_fallback_for_target_only_config() {
    // 宿主默认配置是纯 target 指令（EnvFilter 的默认指令为 OFF），dev 必须补全局兜底
    let widened = console_filter_string(true, "wasmnest_desktop_lib=debug,actix_web=info");
    assert_eq!(
        widened, "wasmnest_desktop_lib=debug,actix_web=info,debug",
        "dev 应在 target-only 配置后补全局 debug 兜底"
    );
}

#[test]
fn console_filter_string_keeps_existing_global_directive() {
    // 配置已含全局级别：尊重开发者意图，不追加（否则会覆盖其全局级别）
    assert_eq!(
        console_filter_string(true, "debug,actix_web=info"),
        "debug,actix_web=info"
    );
}

#[test]
fn console_filter_string_release_keeps_config_verbatim() {
    assert_eq!(
        console_filter_string(false, "wasmnest_desktop_lib=debug"),
        "wasmnest_desktop_lib=debug"
    );
    // 空配置在 release 保持空（EnvFilter 空串 = 仅 ERROR），不改写语义
    assert_eq!(console_filter_string(false, ""), "");
}

#[test]
fn console_filter_string_normalizes_separators() {
    // 尾随逗号 / 空白不应产生 `,,` 空指令
    assert_eq!(
        console_filter_string(true, " wasmnest_desktop_lib=debug , "),
        "wasmnest_desktop_lib=debug,debug"
    );
}

/// 回归锁：启动完成后 dev 控制台必须继续滚动——能力仓 / 插件日志 / 前端 relay 此前
/// 全被 OFF 丢弃（只剩启动那几行宿主日志），表现为「dev 控制台日志失效、不滚动」
#[test]
fn dev_console_filter_lets_engine_plugin_and_frontend_logs_through() {
    let default_console_filter = LogConfig::default().console_filter;
    let hits = dispatch_through(&console_filter_string(true, &default_console_filter), || {
        tracing::info!(target: "wasmnest_wasm_core::bus", "engine info");
        tracing::info!(
            target: "wasmnest_host_api_core::plugin_log",
            "[plugin:com.wasmnest.bedcode] plugin info"
        );
        tracing::error!(target: "frontend", "frontend error");
        tracing::debug!(target: "frontend", "frontend debug");
        tracing::debug!(target: "wasmnest_wasm_core::bus", "engine debug");
        tracing::debug!(target: "wasmnest_desktop_lib::bootstrap", "host debug");
    });

    assert_eq!(
        hits,
        vec![
            "wasmnest_wasm_core::bus",
            "wasmnest_host_api_core::plugin_log",
            "frontend",
            "frontend",
            "wasmnest_wasm_core::bus",
            "wasmnest_desktop_lib::bootstrap",
        ],
        "dev 控制台应放行能力仓 / 插件日志 / 前端 relay（含 debug）与宿主 debug"
    );
}
