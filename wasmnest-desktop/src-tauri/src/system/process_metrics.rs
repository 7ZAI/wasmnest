//! 宿主进程 / WebView 进程指标（全量快照段名 `process`）
//!
//! **为什么需要这一段**：`plugins` 段里的 `memory_current_bytes` 只是**单个 wasm
//! 实例的线性内存**（而且只在 limiter 批准增长时记账，只涨不落）。整个 wasmnest
//! 桌面真正占多少内存，取决于「宿主主进程 + WebKitGTK 子进程」的 OS 账，
//! wasm 线性内存只是其中一小块——两者混在一起会把账说错，所以本段与
//! `plugins` 段**分开**，各说各的事实。
//!
//! **归属判据（「这是不是 wasmnest 自己的 WebView」）**：
//! 1. 只统计**本进程的后代**（`sysinfo::get_current_pid()` 起、按 `parent()` 沿
//!    父子链向下走）。同机上另一个 Tauri 应用有它自己的进程树，它的
//!    `WebKitWebProcess` 父指针指向它自己，永远进不了本树——**不靠名字猜**，
//!    名字只在树内做角色分类（渲染 / 网络 / GPU）。单测
//!    `descendants_excludes_other_app_trees` 把这条钉住。
//! 2. 树内没有 WebKit 子进程时，`webview.present = false`（不是报 0 字节冒充
//!    「WebView 不占内存」）。macOS 的 `com.apple.WebKit.WebContent` 由 launchd
//!    经 XPC 拉起，**不在**宿主进程树里，这一端恒为 `present = false`——这是
//!    平台限制，不是 bug，因此前端必须按 present 分支显示，不能当 0 处理。
//!
//! **口径**：
//! - `rssBytes` = 常驻集（sysinfo `Process::memory()`）。多进程应用按进程求和会
//!   重复计共享库页（实测同一棵树 RSS 合计 466 MiB vs PSS 合计 256 MiB）。
//! - `pssBytes` = 按比例分摊的共享页（Linux `/proc/<pid>/smaps_rollup` 的 `Pss`），
//!   **这才是「真占多少」**；非 Linux 端为 `null`（不拿 RSS 冒充 PSS）。
//! - `cpuPercent` = 单核百分比（100 = 占满一核；`cores` 与之并列下发，UI 自行
//!   换算成「占全机 x%」）。sysinfo 需要两次刷新（间隔 ≥
//!   `MINIMUM_CPU_UPDATE_INTERVAL`）才有意义，因此**首次采样 / 间隔过短一律
//!   `null`**，绝不下发 0%。
//! - `self` 段含 wasm 运行时（wasmtime 在宿主进程内），所以 `plugins` 段的内存
//!   是 `self` 的子集，两个口径不可相加。
//!
//! **权限**：本段随 `host-metrics.snapshot` 一起下发，沿用 `metrics:read`——
//! 内容是宿主自身的资源事实（不含任何插件私有数据），头注释写清是为了避免
//! 后来者以为它是「别的应用的进程」面。
//!
//! **成本**：只在监控页轮询时被调用（快照按需生成）；每次一次
//! `refresh_processes(All)` + 本树若干次 `smaps_rollup` 读。

use std::collections::HashMap;
use std::time::Instant;

use serde_json::{json, Value};
use sysinfo::{Pid, ProcessesToUpdate, System};
use wasmnest_wasm_core::monitor::MetricsSource;

/// 进程在本次快照中的角色
///
/// `Host` 只给宿主主进程（本进程本身）；其余由进程名判定，且**只在已被
/// 判定为本进程后代的集合内**使用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    /// 宿主主进程（Tauri / GTK / wasmtime 所在进程）
    Host,
    /// WebView 渲染进程
    Webview,
    /// WebView 网络进程
    Network,
    /// WebView GPU 进程
    Gpu,
    /// 其它子进程（应用自己拉起的 CLI / 脚本等）
    Other,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::Host => "host",
            Role::Webview => "webview",
            Role::Network => "network",
            Role::Gpu => "gpu",
            Role::Other => "other",
        }
    }

    /// 是否属于「WebView 那一坨」（渲染 / 网络 / GPU 同源）
    fn is_webview_family(self) -> bool {
        matches!(self, Role::Webview | Role::Network | Role::Gpu)
    }
}

/// 按进程名判定角色
///
/// 名字来自 `/proc/<pid>/stat` 的 comm（Linux 上被内核**截断到 15 字节**），
/// 实测跑起来是 `WebKitWebProces` / `WebKitNetworkPr` / `WebKitGPUProcess`，
/// 所以判定一律用前缀 + 关键词，不做全名相等。
fn role_of(name: &str) -> Role {
    let lower = name.to_ascii_lowercase();
    // Windows WebView2：`msedgewebview2.exe`（渲染 / GPU 子进程同名前缀）
    if lower.contains("msedgewebview2") {
        return Role::Webview;
    }
    if !name.starts_with("WebKit") && !lower.contains("webkit") {
        return Role::Other;
    }
    if name.contains("Network") {
        return Role::Network;
    }
    if name.contains("GPU") {
        return Role::Gpu;
    }
    Role::Webview
}

/// 选出 `root` 的全部后代 pid（不含 root 自身）
///
/// 纯函数（父指针表入参）便于单测覆盖「两个宿主树互不串台」。
/// `visited` 兼作环保护：异常父指针环（pid 复用 / 采集竞态）不会死循环。
fn descendants_of(root: u32, parents: &HashMap<u32, Option<u32>>) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, parent) in parents {
        if let Some(parent) = parent {
            children.entry(*parent).or_default().push(*pid);
        }
    }
    let mut out = Vec::new();
    let mut visited = std::collections::HashSet::new();
    visited.insert(root);
    let mut stack = vec![root];
    while let Some(current) = stack.pop() {
        if let Some(kids) = children.get(&current) {
            for kid in kids {
                if visited.insert(*kid) {
                    out.push(*kid);
                    stack.push(*kid);
                }
            }
        }
    }
    out.sort_unstable();
    out
}

/// 单进程读数
#[derive(Debug, Clone)]
struct Sample {
    pid: u32,
    name: String,
    role: Role,
    rss_bytes: u64,
    pss_bytes: Option<u64>,
    cpu_percent: Option<f32>,
}

impl Sample {
    fn to_json(&self) -> Value {
        json!({
            "pid": self.pid,
            "name": self.name,
            "role": self.role.as_str(),
            "rssBytes": self.rss_bytes,
            "pssBytes": self.pss_bytes,
            "cpuPercent": self.cpu_percent.map(round2),
        })
    }
}

/// 比例保留两位（CPU 百分比不做美学修饰，只避免浮点噪声进快照）
fn round2(value: f32) -> f64 {
    ((value as f64) * 100.0).round() / 100.0
}

/// 一组进程的合计
///
/// 缺项口径：`pssBytes` / `cpuPercent` 只要有一条子进程读不到就是 `null`
/// （部分求和会被读成「总量就是这个数」，比缺失更具误导性）。
fn summarize(samples: &[&Sample]) -> Value {
    let rss_bytes: u64 = samples.iter().map(|s| s.rss_bytes).sum();
    let pss_bytes = if !samples.is_empty() && samples.iter().all(|s| s.pss_bytes.is_some()) {
        Some(samples.iter().filter_map(|s| s.pss_bytes).sum::<u64>())
    } else {
        None
    };
    let cpu_percent = if !samples.is_empty() && samples.iter().all(|s| s.cpu_percent.is_some()) {
        Some(round2(samples.iter().filter_map(|s| s.cpu_percent).sum::<f32>()))
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

/// 组装快照段（纯函数：进程读数 + 时间窗 → JSON）
fn build_snapshot(self_pid: u32, samples: Vec<Sample>, cpu_window_ms: Option<u64>, cores: usize) -> Value {
    let self_sample = samples.iter().find(|s| s.pid == self_pid);
    let webview: Vec<&Sample> = samples.iter().filter(|s| s.role.is_webview_family()).collect();
    let others: Vec<&Sample> = samples
        .iter()
        .filter(|s| s.pid != self_pid && !s.role.is_webview_family())
        .collect();
    let all: Vec<&Sample> = samples.iter().collect();

    let webview_scope = {
        let mut scope = summarize(&webview);
        let object = scope.as_object_mut().expect("summarize returns an object");
        object.insert("present".to_string(), Value::Bool(!webview.is_empty()));
        if webview.is_empty() {
            // fail-visible：说明「没有」而不是「是 0」，前端据此改文案
            object.insert(
                "reason".to_string(),
                Value::String("no-webview-child-process".to_string()),
            );
        }
        object.insert(
            "processes".to_string(),
            Value::Array(webview.iter().map(|s| s.to_json()).collect()),
        );
        scope
    };

    let mut other_children = summarize(&others);
    if let Some(object) = other_children.as_object_mut() {
        object.insert(
            "processes".to_string(),
            Value::Array(others.iter().map(|s| s.to_json()).collect()),
        );
    }

    json!({
        "available": true,
        "sampledAtUnixMs": now_unix_ms(),
        "cpuWindowMs": cpu_window_ms,
        "cores": cores,
        "self": self_sample.map(|s| s.to_json()).unwrap_or(Value::Null),
        "webview": webview_scope,
        "otherChildren": other_children,
        "tree": summarize(&all),
    })
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// PSS（按比例分摊的共享页；Linux 专属，其它端 `None`）
///
/// 只读本进程树（同一 uid），不需要额外权限；读取失败（老内核无
/// `smaps_rollup` / 进程刚退出）返回 `None`，不拿 RSS 顶替。
#[cfg(target_os = "linux")]
fn pss_bytes(pid: u32) -> Option<u64> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup")).ok()?;
    raw.lines().find_map(|line| {
        let rest = line.strip_prefix("Pss:")?;
        let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
        Some(kb * 1024)
    })
}

#[cfg(not(target_os = "linux"))]
fn pss_bytes(_pid: u32) -> Option<u64> {
    None
}

/// 跨两次采样的状态（CPU 需要「上次刷新点」做差分窗口）
struct SourceState {
    system: System,
    last_sample: Option<Instant>,
}

/// 快照段 `process` 的数据源
///
/// 装配点：桌面宿主 bootstrap（`PluginHost::new` 之后、
/// `MetricsRegistry::register_source("process", ...)`）。**注册名固定为
/// `process`**：与应用侧 Monitor 的 `process` 段解析（`utils/process.ts`）成对。
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
                system: System::new(),
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
        // 首次采样没有基线；间隔过短时 sysinfo 的 cpu_usage 会读出 0 或噪声
        let cpu_window = window.filter(|w| *w >= sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        let cpu_valid = cpu_window.is_some();

        state.system.refresh_processes(ProcessesToUpdate::All, true);

        let self_pid = match sysinfo::get_current_pid() {
            Ok(pid) => pid,
            Err(reason) => {
                return json!({
                    "available": false,
                    "reason": format!("current pid unavailable: {reason}"),
                })
            }
        };

        let parents: HashMap<u32, Option<u32>> = state
            .system
            .processes()
            .iter()
            // **线程必须剔掉**：sysinfo 在 Linux/Android 上把 `/proc/<pid>/task/*` 的
            // 每条线程也当成 `Process` 列出来（同名同 RSS），不滤就会把宿主 120 条
            // 线程算成 120 个子进程，整棵树的 RSS / PSS 被放大到荒谬量级
            // （实测 8.4 GiB → 28.9 GiB）。`thread_kind()` 是 sysinfo 给判据：
            // 线程有值、真进程为 None。
            .filter(|(_, process)| process.thread_kind().is_none())
            .map(|(pid, process)| (pid.as_u32(), process.parent().map(|p| p.as_u32())))
            .collect();
        let mut pids = descendants_of(self_pid.as_u32(), &parents);
        pids.push(self_pid.as_u32());
        pids.sort_unstable();
        pids.dedup();

        let samples: Vec<Sample> = pids
            .iter()
            .filter_map(|pid| {
                let process = state.system.process(Pid::from_u32(*pid))?;
                // 同上：线程行不计账（名字 / 内存都是进程的，会重复求和）
                if process.thread_kind().is_some() {
                    return None;
                }
                let name = process.name().to_string_lossy().to_string();
                let role = if *pid == self_pid.as_u32() {
                    Role::Host
                } else {
                    role_of(&name)
                };
                Some(Sample {
                    pid: *pid,
                    rss_bytes: process.memory(),
                    // 名字留着给 UI 区分（角色之外仍显示进程名，便于排查）
                    pss_bytes: pss_bytes(*pid),
                    cpu_percent: cpu_valid.then(|| process.cpu_usage()),
                    role,
                    name,
                })
            })
            .collect();

        build_snapshot(
            self_pid.as_u32(),
            samples,
            cpu_window.map(|w| w.as_millis() as u64),
            std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        )
    }
}

#[cfg(test)]
mod tests {
    //! 归属判据与口径的机器判：树隔离（别的 Tauri 应用串不进来）、名字截断、
    //! 缺项不伪造、真快照自检。
    use super::*;

    fn sample(pid: u32, name: &str, role: Role, rss: u64, pss: Option<u64>) -> Sample {
        Sample {
            pid,
            name: name.to_string(),
            role,
            rss_bytes: rss,
            pss_bytes: pss,
            cpu_percent: Some(1.0),
        }
    }

    /// Linux 内核把 comm 截断到 15 字节（实测 `WebKitWebProces`），
    /// 判定必须容忍；否则真实宿主里 role 会全落 Other。
    #[test]
    fn role_of_tolerates_truncated_process_names() {
        assert_eq!(role_of("WebKitWebProces"), Role::Webview);
        assert_eq!(role_of("WebKitWebProcess"), Role::Webview);
        assert_eq!(role_of("WebKitNetworkPr"), Role::Network);
        assert_eq!(role_of("WebKitNetworkProcess"), Role::Network);
        assert_eq!(role_of("WebKitGPUProcess"), Role::Gpu);
        assert_eq!(role_of("msedgewebview2"), Role::Webview);
        assert_eq!(role_of("msedgewebview2.exe"), Role::Webview);
        assert_eq!(role_of("bash"), Role::Other);
        assert_eq!(role_of("node"), Role::Other);
        // 只有 WebKit 前缀才算：名字里带 webkit 但形态不同（macOS XPC）也归 WebView
        assert_eq!(role_of("com.apple.WebKit.WebContent"), Role::Webview);
    }

    /// 两个宿主各自一棵树：本树只有自己的 WebView，**别的 Tauri 应用永不入账**。
    /// 变异判据：把 parent 过滤放宽成「全系统同名进程」⇒ 转红。
    #[test]
    fn descendants_excludes_other_app_trees() {
        let mut parents = HashMap::new();
        parents.insert(1000, None); // 本宿主（wasmnest）
        parents.insert(1001, Some(1000)); // 本宿主的 WebKitWebProcess
        parents.insert(1002, Some(1000)); // 本宿主的 WebKitNetworkProcess
        parents.insert(2000, None); // 另一个 Tauri 应用
        parents.insert(2001, Some(2000)); // 它的 WebKitWebProcess

        let mut got = descendants_of(1000, &parents);
        got.sort_unstable();
        assert_eq!(got, vec![1001, 1002]);
        assert_eq!(descendants_of(2000, &parents), vec![2001]);
    }

    /// 父子链成环 / 自指（pid 复用竞态）不得死循环
    #[test]
    fn descendants_survives_parent_cycles() {
        let mut parents = HashMap::new();
        parents.insert(10, Some(11));
        parents.insert(11, Some(10));
        let got = descendants_of(10, &parents);
        assert_eq!(got, vec![11]);
    }

    #[test]
    fn summarize_nulls_partial_pss_and_cpu() {
        let a = sample(1, "host", Role::Host, 100, Some(60));
        let b = sample(2, "WebKitWebProces", Role::Webview, 200, Some(120));
        let full = summarize(&[&a, &b]);
        assert_eq!(full["rssBytes"], 300);
        assert_eq!(full["pssBytes"], 180);
        assert_eq!(full["cpuPercent"], 2.0);
        assert_eq!(full["processCount"], 2);

        let mut no_pss = b.clone();
        no_pss.pss_bytes = None;
        let partial = summarize(&[&a, &no_pss]);
        assert_eq!(partial["pssBytes"], Value::Null, "缺项不得部分求和");
    }

    /// 没有 WebView 子进程时必须显式说「没有」，不能报 0 字节冒充
    #[test]
    fn webview_absent_is_explicit() {
        let host = sample(1, "wasmnest-desktop", Role::Host, 100, Some(60));
        let snap = build_snapshot(1, vec![host], Some(1000), 8);
        assert_eq!(snap["webview"]["present"], false);
        assert_eq!(snap["webview"]["reason"], "no-webview-child-process");
        assert_eq!(snap["webview"]["processes"], json!([]));
        assert_eq!(snap["tree"]["processCount"], 1);
    }

    /// 有 WebView 时，渲染 / 网络 / GPU 归 WebView，其它子进程单列，不进 WebView 账
    #[test]
    fn webview_scope_excludes_other_children() {
        let host = sample(1, "wasmnest-desktop", Role::Host, 100, Some(60));
        let web = sample(2, "WebKitWebProces", Role::Webview, 300, Some(200));
        let net = sample(3, "WebKitNetworkPr", Role::Network, 50, Some(20));
        let cli = sample(4, "claude", Role::Other, 70, Some(40));
        let snap = build_snapshot(1, vec![host, web, net, cli], Some(1000), 8);
        assert_eq!(snap["webview"]["present"], true);
        assert_eq!(snap["webview"]["rssBytes"], 350);
        assert_eq!(snap["webview"]["pssBytes"], 220);
        assert_eq!(snap["otherChildren"]["rssBytes"], 70);
        assert_eq!(snap["tree"]["rssBytes"], 520);
        assert_eq!(snap["self"]["role"], "host");
    }

    /// 真快照自检：至少统计到本进程，且测试进程（无 GTK）没有 WebView 子进程
    #[test]
    fn real_snapshot_reports_self() {
        let source = ProcessMetricsSource::new();
        let snap = source.snapshot();
        assert_eq!(snap["available"], true);
        let self_pid = std::process::id();
        assert_eq!(snap["self"]["pid"], self_pid);
        assert_eq!(snap["self"]["role"], "host");
        assert!(
            snap["self"]["rssBytes"].as_u64().unwrap_or(0) > 0,
            "宿主自身 RSS 必须 > 0：{}",
            snap["self"]
        );
        // PSS 是「真占多少」的口径（Linux）；读不到时是 null，不得用 RSS 顶替
        if cfg!(target_os = "linux") {
            assert!(
                snap["self"]["pssBytes"].as_u64().unwrap_or(0) > 0,
                "Linux 上自身 PSS 必须可读：{}",
                snap["self"]
            );
        } else {
            assert_eq!(snap["self"]["pssBytes"], Value::Null);
        }
        assert_eq!(snap["webview"]["present"], false);
        assert!(snap["tree"]["processCount"].as_u64().unwrap_or(0) >= 1);
    }

    /// 线程不得计成子进程：真宿主主进程有一百多条线程，算进去会把整棵树的
    /// RSS / PSS 放大到荒谬量级（实测 8.4 GiB → 28.9 GiB）。
    /// 变异判据：去掉 `thread_kind` 过滤 ⇒ 本用例转红。
    ///
    /// 判据不用「树里只有 1 个进程」：同进程的其它用例可能起真子进程（测试并行）；
    /// 这里直接对着 `/proc` 验——快照里的每个 pid 都必须是**顶层进程**，且本进程的
    /// 线程 id 一个都不许出现（线程的 tid 在 `/proc` 顶层不存在）。
    #[cfg(target_os = "linux")]
    #[test]
    fn threads_are_not_counted_as_processes() {
        fn ids(dir: &str) -> Vec<u32> {
            std::fs::read_dir(dir)
                .map(|entries| {
                    entries
                        .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
                        .collect()
                })
                .unwrap_or_default()
        }

        // 故意起几条线程：未过滤时它们会以子节点身份出现在树里
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut handles = Vec::new();
        for _ in 0..3 {
            let stop = stop.clone();
            handles.push(std::thread::spawn(move || {
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }));
        }

        let source = ProcessMetricsSource::new();
        let snap = source.snapshot();

        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        for handle in handles {
            let _ = handle.join();
        }

        // /proc/self/task 含主线程（tid == pid），主线程本身是进程，要剔掉
        let self_pid = std::process::id();
        let thread_ids: Vec<u32> = ids("/proc/self/task")
            .into_iter()
            .filter(|tid| *tid != self_pid)
            .collect();
        assert!(thread_ids.len() >= 3, "测试进程应有多条线程：{thread_ids:?}");

        let mut row_pids: Vec<u32> = Vec::new();
        for scope in ["self", "otherChildren"] {
            for row in snap[scope]["processes"].as_array().cloned().unwrap_or_default() {
                row_pids.push(row["pid"].as_u64().unwrap_or(0) as u32);
            }
        }
        if let Some(pid) = snap["self"]["pid"].as_u64() {
            row_pids.push(pid as u32);
        }
        assert!(!row_pids.is_empty());

        // 注意：不能断言「每个 pid 在 /proc 顶层仍存在」——同进程其它用例起的真子进程
        // 可能在快照之后退出（并行测试的竞态），退出 ≠ 曾是一条线程。只判线程 id。
        for pid in &row_pids {
            assert!(
                !thread_ids.contains(pid),
                "线程 {pid} 被计成了进程：{row_pids:?} / threads={thread_ids:?}"
            );
        }
    }

    /// 真子进程必须落进 `otherChildren`（不进 WebView 账）：验证 sysinfo 的父指针
    /// 链与角色分类在真实进程上成立，而不只是合成数据上成立
    #[cfg(unix)]
    #[test]
    fn spawned_child_lands_in_other_children() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let source = ProcessMetricsSource::new();
        let snap = source.snapshot();
        let pid = child.id();
        let found = snap["otherChildren"]["processes"]
            .as_array()
            .map(|rows| rows.iter().any(|r| r["pid"] == pid))
            .unwrap_or(false);
        let _ = child.kill();
        let _ = child.wait();
        assert!(found, "子进程 {pid} 应计入 otherChildren：{}", snap["otherChildren"]);
        assert_eq!(snap["webview"]["present"], false);
    }

    /// 首次采样无 CPU 基线 → null（不下发 0%）；两次采样间隔足够后才有值
    #[test]
    fn cpu_is_null_without_baseline() {
        let source = ProcessMetricsSource::new();
        let first = source.snapshot();
        assert_eq!(first["cpuWindowMs"], Value::Null);
        assert_eq!(first["self"]["cpuPercent"], Value::Null);

        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL + std::time::Duration::from_millis(50));
        let second = source.snapshot();
        assert!(second["cpuWindowMs"].as_u64().unwrap_or(0) >= 200);
        assert!(
            second["self"]["cpuPercent"].is_number(),
            "第二次采样应给出数值：{}",
            second["self"]
        );
    }
}
