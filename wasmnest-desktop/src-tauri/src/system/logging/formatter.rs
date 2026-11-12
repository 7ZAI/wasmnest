//! 控制台格式化器：本地时间毫秒精度 + [plugin:...] 标签品红渲染（自 logging.rs 拆出）

use super::*;

/// 控制台时间格式：本地时间毫秒精度（示例：`2026-08-02 00:56:48.819`）
const CONSOLE_TIME_FORMAT: &str = "%Y-%m-%d %H:%M:%S%.3f";

/// 自定义 `FormatTime`：输出本地时间毫秒精度
struct LocalMsTimer;

impl FormatTime for LocalMsTimer {
    fn format_time(&self, w: &mut Writer<'_>) -> fmt::Result {
        write!(w, "{}", chrono::Local::now().format(CONSOLE_TIME_FORMAT))
    }
}

/// 控制台事件格式化器
///
/// 输出结构与 Pretty 格式一致（两空格缩进、`at file:line` 定位行、事件间空行），
/// 仅消息体中的 `[plugin:...]` 标签改为品红加粗。
pub struct ConsoleFormatter {
    /// 是否显示源文件定位行（`at file:line`）
    display_location: bool,
}

impl ConsoleFormatter {
    /// 创建默认控制台格式化器
    pub fn new() -> Self {
        Self { display_location: true }
    }
}

impl Default for ConsoleFormatter {
    fn default() -> Self {
        Self::new()
    }
}

impl<S> FormatEvent<S, PrettyFields> for ConsoleFormatter
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn format_event(
        &self,
        _ctx: &FmtContext<'_, S, PrettyFields>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let meta = event.metadata();
        let ansi = writer.has_ansi_escapes();

        // 与 Pretty 相同的两空格缩进
        write!(&mut writer, "  ")?;

        // 时间戳：本地时间毫秒精度
        LocalMsTimer.format_time(&mut writer)?;

        // 时间戳与级别之间保留空格，避免输出形如 `...27.869DEBUG` 粘连
        writer.write_char(' ')?;

        let level = meta.level();
        let style = level_style(level);

        // 级别（颜色方案与 Pretty 一致）
        write!(writer, "{} ", styled_level(level, ansi))?;

        // 模块 target（加粗级别色）
        if ansi {
            let target_style = style.bold();
            write!(
                writer,
                "{}{}{}:",
                target_style.prefix(),
                meta.target(),
                target_style.infix(style),
            )?;
        } else {
            write!(writer, "{}:", meta.target())?;
        }
        writer.write_char(' ')?;

        // 消息与字段：先用 PrettyFields 渲染为纯文本，再对插件标签着色
        let fields = render_fields(event);
        if ansi {
            if let Some((tag, rest)) = split_plugin_tag(&fields) {
                // 插件标签品红加粗，与宿主日志形成明显区分
                let plugin_style = Style::new().fg(Color::Magenta).bold();
                write!(writer, "{}", plugin_style.paint(tag))?;
                write!(writer, "{}", style.paint(rest))?;
            } else {
                write!(writer, "{}", style.paint(&fields))?;
            }
        } else {
            writer.write_str(&fields)?;
        }
        writer.write_char('\n')?;

        // 源文件定位行（at file:line），与 Pretty 一致
        if self.display_location {
            if let Some(file) = meta.file() {
                let dimmed = if ansi {
                    Style::new().dimmed().italic()
                } else {
                    Style::new()
                };
                write!(writer, "    {} {}", dimmed.paint("at"), file)?;
                if let Some(line) = meta.line() {
                    write!(writer, ":{}", line)?;
                }
                writer.write_char('\n')?;
            }
        }

        // 事件间空行，与 Pretty 一致
        writer.write_char('\n')
    }
}

/// 按级别返回前景色样式（与 Pretty 的颜色方案一致）
fn level_style(level: &Level) -> Style {
    match *level {
        Level::TRACE => Style::new().fg(Color::Purple),
        Level::DEBUG => Style::new().fg(Color::Blue),
        Level::INFO => Style::new().fg(Color::Green),
        Level::WARN => Style::new().fg(Color::Yellow),
        Level::ERROR => Style::new().fg(Color::Red),
    }
}

/// 渲染级别文本；`ansi=false` 时返回纯文本
fn styled_level(level: &Level, ansi: bool) -> String {
    let (color, text) = match *level {
        Level::TRACE => (Color::Purple, "TRACE"),
        Level::DEBUG => (Color::Blue, "DEBUG"),
        Level::INFO => (Color::Green, " INFO"),
        Level::WARN => (Color::Yellow, " WARN"),
        Level::ERROR => (Color::Red, "ERROR"),
    };
    if ansi {
        format!("{}", color.paint(text))
    } else {
        text.to_string()
    }
}

/// 使用 PrettyFields 将事件的字段渲染为纯文本字符串
///
/// 复用 Pretty 的字段访问器而非手写解析，保证非插件事件的字段输出与 Pretty 一致；
/// 渲染时关闭 ANSI，得到纯文本后再统一着色，避免对转义码做字符串手术。
fn render_fields(event: &Event<'_>) -> String {
    let mut buf = String::new();
    {
        let mut visitor = PrettyFields::new().make_visitor(Writer::new(&mut buf));
        event.record(&mut visitor);
        // visitor 在此作用域结束时释放对 buf 的可变借用
    }
    buf
}

/// 拆分消息中的插件标签前缀
///
/// 消息以 `[plugin:` 开头时返回 `(标签, 剩余部分)`，否则返回 `None`。
/// 标签包含完整 `[plugin:...]`，剩余部分保留起始空格（属消息体）。
pub(super) fn split_plugin_tag(message: &str) -> Option<(&str, &str)> {
    let rest = message.strip_prefix("[plugin:")?;
    let end = rest.find(']')?;
    let tag_end = "[plugin:".len() + end + 1;
    Some(message.split_at(tag_end))
}
