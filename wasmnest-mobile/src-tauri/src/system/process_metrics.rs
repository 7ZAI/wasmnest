//! 宿主进程指标（全量快照段名 `process`）——移动端
//!
//! **与桌面同名段同口径、不同能力边界**：桌面能按进程树把 WebKitGTK 子进程一起
//! 算进「整个 wasmnest」，移动端做不到——Android 的 WebView 渲染进程是
//! `com.google.android.webview:sandboxed_process0`（独立 uid），父进程是
//! `webview_zygote` 而不是本应用（真机实测），既不在本进程树内、`/proc/<pid>`
//! 也跨 uid 不可读。所以本段只覆盖**本进程**（宿主 Rust + wasm 运行时）：
//!
//! - `self` = 本进程：PSS（`/proc/self/smaps_rollup`，真占用）/ RSS
//!   （`/proc/self/status` 的 `VmRSS`，上界）/ CPU；
//! - `webview` = `present: false` + `reason: "not-a-child-process"`（**显式**：
//!   「测不到」不是「不占内存」）；
//! - `otherChildren` = 本进程派生的子进程（移动宿主平时不派生；有则如实计入，
//!   按 `/proc` 的 ppid 归属，读不到的（别的 uid）直接跳过，不猜）；
//! - `tree` = `self + otherChildren`，**不含** WebView 渲染进程——前端文案必须
//!   写明，别让「进程树合计」被读成「整个 app」。
//!
//! **CPU 用 `/proc/<pid>/schedstat` 的 ns 运行时差分**，不用 `utime+stime`：
//! 后者要 `sysconf(_SC_CLK_TCK)`（USER_HZ），为一个数字引入 libc 不值得，
//! schedstat 直接给纳秒（真机已验证存在）。schedstat 缺失（内核未开
//! CONFIG_SCHEDSTATS）→ `cpuPercent: null`（不猜 0%）。
//!
//! iOS 无 procfs → `available: false` 并带原因（fail-visible）。
//!
//! 成本：只在监控页轮询时执行；每次一次 `/proc` 扫描（Android 上其它 uid 的
//! `stat` 读失败快速返回）+ 本树若干次小文件读。

use std::collections::HashMap;
use std::time::Instant;

use serde_json::{json, Value};
use wasmnest_wasm_core::monitor::MetricsSource;

/// 单进程读数
#[derive(Debug, Clone)]
struct Sample {
    pid: u32,
    name: String,
    role: &'static str,
    rss_bytes: u64,
    pss_bytes: Option<u64>,
    cpu_percent: Option<f64>,
}

/// 一次采样的原始读数（cpu 差分在 `build_snapshot` 里换算成百分比）
#[derive(Debug, Clone)]
struct RawSample {
    pid: u32,
    name: String,
    role: &'static str,
    rss_bytes: u64,
    pss_bytes: Option<u64>,
    /// `schedstat` 第一列（on-cpu 纳秒）；读取失败为 None
    cpu_ns: Option<u64>,
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ==================== /proc 读取（Android / Linux） ====================

/// `/proc/<pid>/stat` 的 pid + comm + ppid（comm 可能含空格 / 括号，按最后一个
/// `)` 切分后取 `state` 之后的第一个字段）
#[cfg(any(target_os = "linux", target_os = "android"))]
fn stat_head(pid: u32) -> Option<(u32, String, u32)> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let open = raw.find('(')?;
    let close = raw.rfind(')')?;
    let name = raw.get(open + 1..close)?.to_string();
    let rest: Vec<&str> = raw.get(close + 1..)?.split_whitespace().collect();
    // rest[0] = state, rest[1] = ppid
    let ppid: u32 = rest.get(1)?.parse().ok()?;
    Some((pid, name, ppid))
}

/// RSS 与 PSS **从同一次 `smaps_rollup` 读取**里取
///
/// 两次分别读（`status` 的 VmRSS + `smaps_rollup` 的 Pss）会在增长中的进程上得到
/// 互相矛盾的一组值——真机实测出现过 PSS 241 MiB > RSS 192 MiB（读 RSS 之后进程又
/// 长了 50 MB）。同一份文件里的 `Rss:` / `Pss:` 是同一时刻的账，口径才自洽。
///
/// 老内核无 `smaps_rollup` 时回退到 `status` 的 VmRSS，此时 PSS 为 `None`（不猜）。
#[cfg(any(target_os = "linux", target_os = "android"))]
fn smaps_rss_pss(pid: u32) -> Option<(u64, Option<u64>)> {
    fn kb(rest: &str) -> Option<u64> {
        rest.split_whitespace().next()?.parse::<u64>().ok().map(|kb| kb * 1024)
    }
    if let Ok(raw) = std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup")) {
        let mut rss = None;
        let mut pss = None;
        for line in raw.lines() {
            if let Some(rest) = line.strip_prefix("Rss:") {
                rss = kb(rest);
            } else if let Some(rest) = line.strip_prefix("Pss:") {
                pss = kb(rest);
            }
        }
        if let Some(rss) = rss {
            return Some((rss, pss));
        }
    }
    let raw = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let rss = raw.lines().find_map(|line| kb(line.strip_prefix("VmRSS:")?))?;
    Some((rss, None))
}

/// `schedstat` 第一列 = 累计 on-cpu 纳秒（不需要 USER_HZ）
#[cfg(any(target_os = "linux", target_os = "android"))]
fn schedstat_cpu_ns(pid: u32) -> Option<u64> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/schedstat")).ok()?;
    raw.split_whitespace().next()?.parse().ok()
}

/// 枚举 `/proc` 里所有**本进程可见**的 pid（其它 uid 的目录读 stat 会失败）
#[cfg(any(target_os = "linux", target_os = "android"))]
fn visible_pids() -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .collect()
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn visible_pids() -> Vec<u32> {
    Vec::new()
}

/// 采集本进程 + 后代（只认 `stat` 可读的，别的 uid 直接跳过）
#[cfg(any(target_os = "linux", target_os = "android"))]
fn collect_tree(self_pid: u32) -> Vec<RawSample> {
    let heads: HashMap<u32, (String, u32)> = visible_pids()
        .into_iter()
        .filter_map(|pid| {
            let (_, name, ppid) = stat_head(pid)?;
            Some((pid, (name, ppid)))
        })
        .collect();

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, (_, ppid)) in &heads {
        children.entry(*ppid).or_default().push(*pid);
    }

    let mut ordered = vec![self_pid];
    let mut visited = std::collections::HashSet::new();
    visited.insert(self_pid);
    let mut stack = vec![self_pid];
    while let Some(current) = stack.pop() {
        if let Some(kids) = children.get(&current) {
            for kid in kids {
                if visited.insert(*kid) {
                    ordered.push(*kid);
                    stack.push(*kid);
                }
            }
        }
    }

    ordered
        .into_iter()
        .filter_map(|pid| {
            let (name, _) = heads.get(&pid)?.clone();
            let role = if pid == self_pid { "host" } else { "other" };
            let (rss_bytes, pss_bytes) = smaps_rss_pss(pid).unwrap_or((0, None));
            Some(RawSample {
                pid,
                name,
                role,
                rss_bytes,
                pss_bytes,
                cpu_ns: schedstat_cpu_ns(pid),
            })
        })
        .collect()
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn collect_tree(_self_pid: u32) -> Vec<RawSample> {
    Vec::new()
}

// ==================== 快照组装 ====================

/// 一组进程的合计（缺项口径与桌面一致：`pssBytes` / `cpuPercent` 有一条缺就整体
/// `null`，不做部分求和）
fn summarize(samples: &[&Sample]) -> Value {
    let rss_bytes: u64 = samples.iter().map(|s| s.rss_bytes).sum();
    let pss_bytes = if !samples.is_empty() && samples.iter().all(|s| s.pss_bytes.is_some()) {
        Some(samples.iter().filter_map(|s| s.pss_bytes).sum::<u64>())
    } else {
        None
    };
    let cpu_percent = if !samples.is_empty() && samples.iter().all(|s| s.cpu_percent.is_some()) {
        Some(round2(samples.iter().filter_map(|s| s.cpu_percent).sum::<f64>()))
    } else {
        None
    };
    json!({
        "processCount": samples.len(),
        "rssBytes": rss_bytes,
        "pssBytes": pss_bytes,
        "cpuPercent": cpu_percent,
    })
}

fn sample_json(sample: &Sample) -> Value {
    json!({
        "pid": sample.pid,
        "name": sample.name,
        "role": sample.role,
        "rssBytes": sample.rss_bytes,
        "pssBytes": sample.pss_bytes,
        "cpuPercent": sample.cpu_percent.map(round2),
    })
}

/// 组装快照段（纯函数：本进程 pid + 原始读数 + 上次 CPU 基线 + 时间窗）
fn build_snapshot(
    self_pid: u32,
    raws: Vec<RawSample>,
    previous_cpu_ns: &HashMap<u32, u64>,
    cpu_window_ms: Option<u64>,
    cores: usize,
) -> Value {
    let window_ns = cpu_window_ms.map(|ms| ms as f64 * 1_000_000.0);
    let samples: Vec<Sample> = raws
        .into_iter()
        .map(|raw| {
            // 无窗口（首次采样）/ 无基线 / 无 schedstat → null，不猜 0%
            let cpu_percent = match (raw.cpu_ns, previous_cpu_ns.get(&raw.pid), window_ns) {
                (Some(current), Some(previous), Some(window)) if current >= *previous && window > 0.0 => {
                    Some((current - previous) as f64 / window * 100.0)
                }
                _ => None,
            };
            Sample {
                pid: raw.pid,
                name: raw.name,
                role: raw.role,
                rss_bytes: raw.rss_bytes,
                pss_bytes: raw.pss_bytes,
                cpu_percent,
            }
        })
        .collect();

    let self_sample = samples.iter().find(|s| s.pid == self_pid);
    let others: Vec<&Sample> = samples.iter().filter(|s| s.pid != self_pid).collect();

    let mut other_children = summarize(&others);
    if let Some(object) = other_children.as_object_mut() {
        object.insert(
            "processes".to_string(),
            Value::Array(others.iter().map(|s| sample_json(s)).collect()),
        );
    }

    json!({
        "available": true,
        "sampledAtUnixMs": now_unix_ms(),
        "cpuWindowMs": cpu_window_ms,
        "cores": cores,
        "self": self_sample.map(sample_json).unwrap_or(Value::Null),
        "webview": {
            "present": false,
            "reason": "not-a-child-process",
            "processCount": 0,
            "rssBytes": 0,
            "pssBytes": Value::Null,
            "cpuPercent": Value::Null,
            "processes": [],
        },
        "otherChildren": other_children,
        "tree": summarize(&samples.iter().collect::<Vec<_>>()),
    })
}

/// 跨两次采样的 CPU 基线
struct SourceState {
    cpu_ns: HashMap<u32, u64>,
    last_sample: Option<Instant>,
}

/// 快照段 `process` 的数据源（移动端）
///
/// 装配点：`plugin/manager/loading.rs` 的 `init_wasm_runtime`（`host_ctx` 注入
/// 快照源之前）——与应用侧 Monitor 的 `process` 段解析成对。
pub struct ProcessMetricsSource {
    state: std::sync::Mutex<SourceState>,
}

impl Default for ProcessMetricsSource {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessMetricsSource {
    pub fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(SourceState {
                cpu_ns: HashMap::new(),
                last_sample: None,
            }),
        }
    }
}

impl MetricsSource for ProcessMetricsSource {
    fn snapshot(&self) -> Value {
        let mut state = match self.state.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                tracing::warn!("process metrics lock poisoned, recovering");
                poisoned.into_inner()
            }
        };

        let now = Instant::now();
        let window = state.last_sample.map(|prev| now.duration_since(prev));
        state.last_sample = Some(now);
        // 首次采样没有基线；间隔过短时差分噪声大，宁可不下发
        let window_ms = window.filter(|w| w.as_millis() >= 200).map(|w| w.as_millis() as u64);

        let self_pid = std::process::id();
        let raws = collect_tree(self_pid);
        // 取不到自身读数 ⇒ 该端没有可用的 procfs（iOS）/ 被裁剪：
        // 显式声明不可用，而不是下发一棵空树让页面读成「0 占用」。
        if !raws.iter().any(|raw| raw.pid == self_pid) {
            return json!({
                "available": false,
                "reason": "procfs unavailable: cannot read /proc/self",
            });
        }

        let previous = state.cpu_ns.clone();
        state.cpu_ns = raws
            .iter()
            .filter_map(|raw| raw.cpu_ns.map(|ns| (raw.pid, ns)))
            .collect();

        build_snapshot(
            self_pid,
            raws,
            &previous,
            window_ms,
            std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        )
    }
}

#[cfg(test)]
mod tests {
    //! 判据：本进程必在；WebView 显式「不可归属」而不是 0；CPU 首次为 null；
    //! 线程不会混进来（本实现按 pid 目录枚举，天然不含线程，用例把这条钉住）。
    use super::*;

    fn raw(pid: u32, name: &str, role: &'static str, rss: u64, pss: Option<u64>) -> RawSample {
        RawSample {
            pid,
            name: name.to_string(),
            role,
            rss_bytes: rss,
            pss_bytes: pss,
            cpu_ns: Some(1_000_000),
        }
    }

    #[test]
    fn webview_is_explicitly_unattributable() {
        let snap = build_snapshot(
            1,
            vec![raw(1, "wasmnest-mobile", "host", 100, Some(60))],
            &HashMap::new(),
            Some(1000),
            8,
        );
        assert_eq!(snap["webview"]["present"], false);
        assert_eq!(snap["webview"]["reason"], "not-a-child-process");
        assert_eq!(snap["webview"]["processes"], json!([]));
        // 树不含 WebView：合计 == 自身
        assert_eq!(snap["tree"]["rssBytes"], 100);
    }

    #[test]
    fn cpu_needs_baseline_and_window() {
        let raws = vec![raw(1, "host", "host", 100, Some(60))];
        // 无基线（previous 为空）→ null
        let no_baseline = build_snapshot(1, raws.clone(), &HashMap::new(), Some(1000), 8);
        assert_eq!(no_baseline["self"]["cpuPercent"], Value::Null);

        // 有基线无窗口（首次采样）→ null
        let mut previous = HashMap::new();
        previous.insert(1, 0u64);
        let no_window = build_snapshot(1, raws.clone(), &previous, None, 8);
        assert_eq!(no_window["self"]["cpuPercent"], Value::Null);

        // 1 s 窗口内跑了 0.5 s → 50%
        let mut fast = raws;
        fast[0].cpu_ns = Some(500_000_000);
        let measured = build_snapshot(1, fast, &previous, Some(1000), 8);
        assert_eq!(measured["self"]["cpuPercent"], 50.0);
    }

    #[test]
    fn children_aggregate_separately() {
        let snap = build_snapshot(
            1,
            vec![
                raw(1, "host", "host", 100, Some(60)),
                raw(2, "helper", "other", 50, Some(20)),
            ],
            &HashMap::new(),
            Some(1000),
            8,
        );
        assert_eq!(snap["otherChildren"]["processCount"], 1);
        assert_eq!(snap["otherChildren"]["rssBytes"], 50);
        assert_eq!(snap["tree"]["rssBytes"], 150);
        assert_eq!(snap["tree"]["pssBytes"].is_null(), false);
    }

    /// 真快照自检：本进程在、RSS > 0；测试进程没有 WebView 子进程
    /// （真机上渲染进程也在 `webview_zygote` 下，故这条对 Android 同样成立）
    #[test]
    fn real_snapshot_reports_self() {
        let source = ProcessMetricsSource::new();
        let snap = source.snapshot();
        assert_eq!(snap["available"], true);
        assert_eq!(snap["self"]["pid"], std::process::id());
        assert_eq!(snap["self"]["role"], "host");
        assert!(
            snap["self"]["rssBytes"].as_u64().unwrap_or(0) > 0,
            "自身 RSS 必须 > 0：{}",
            snap["self"]
        );
        assert_eq!(snap["webview"]["present"], false);
        assert_eq!(snap["self"]["cpuPercent"], Value::Null, "首次采样无 CPU 基线");

        // RSS 与 PSS 必须来自同一份 smaps_rollup：PSS 是共享页按比例分摊后的份额，
        // 数学上不会大于 RSS。分开读会拿到自相矛盾的一组（真机曾出现 PSS 241 > RSS 192）。
        #[cfg(target_os = "linux")]
        {
            let rss = snap["self"]["rssBytes"].as_u64().unwrap_or(0);
            let pss = snap["self"]["pssBytes"].as_u64().unwrap_or(0);
            assert!(pss > 0, "Linux 上自身 PSS 必须可读：{}", snap["self"]);
            assert!(pss <= rss, "PSS({pss}) 不得大于 RSS({rss})：{}", snap["self"]);
        }
    }

    /// 线程不是子进程：本进程的线程 id 不得出现在子进程行里
    #[cfg(target_os = "linux")]
    #[test]
    fn threads_are_not_listed_as_children() {
        let source = ProcessMetricsSource::new();
        let snap = source.snapshot();
        let thread_ids: Vec<u32> = std::fs::read_dir("/proc/self/task")
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
                    .collect()
            })
            .unwrap_or_default();
        let self_pid = std::process::id();
        for row in snap["otherChildren"]["processes"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            let pid = row["pid"].as_u64().unwrap_or(0) as u32;
            assert_ne!(pid, self_pid);
            assert!(
                !thread_ids.contains(&pid),
                "线程 {pid} 被计成子进程：{}",
                snap["otherChildren"]
            );
        }
    }
}
