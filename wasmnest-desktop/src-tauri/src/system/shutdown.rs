//! 退出协调器：优雅关闭（有界）→ 正常退出 → 超时强制退出
//!
//! 背景（2026-11-05 用户裁决）：用户确认「仍然退出」后，**先优雅关闭**；实在
//! 无法关闭时再执行强制关闭。旧实现直接在 `RunEvent::ExitRequested` 里
//! `block_on(run_shutdown_hooks())`：
//! - 主线程被同步卡住的 hook 拖死时，异步超时无法生效，进程永远不退出；
//! - 没有总预算，每个 hook 各自 5s 超时，最坏可等数十秒；
//! - 没有任何强制兜底。
//!
//! 现设计：
//! 1. `begin_graceful_shutdown` 幂等启动；hooks 在 async runtime 上执行，不阻塞
//!    主线程/事件循环；`ExitRequested` 用 `api.prevent_exit()` 拦住默认退出。
//! 2. hooks 总预算 [`GRACEFUL_SHUTDOWN_TIMEOUT_SECS`]；单 hook 仍由
//!    `LifecycleRegistry` 的 5s 超时保护。完成后置 `Done` 并再次 `app.exit(0)`，
//!    此时 `ExitRequested` 放行。
//! 3. watchdog 线程在 [`FORCE_EXIT_TIMEOUT_SECS`] 到点后执行：只要进程仍然活着
//!    （主线程被同步 hook 卡死 / async 任务 panic / hooks 已完成但 `app.exit(0)`
//!    没被事件循环处理），直接 `std::process::exit(0)`。这是最后一道硬兜底，
//!    保证进程一定能退出——**不能**因为优雅 hooks 已完成就假定进程已经结束。
//! 4. 强制退出前尽力回收 PTY，避免 agent 子进程成为孤儿；回收本身有 1s 上限，
//!    锁被卡住也不拖住强制退出。
//! 5. 隐式退出（系统关窗 / 托盘）先隐藏主窗口再跑 hooks，避免「点了没反应」的
//!    观感；用户确认退出（前端已有进度面）保留窗口展示进度。

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::Duration;

use futures_util::FutureExt;
use tauri::Manager;

/// 所有 shutdown hooks 的总预算（正常退出远小于此值）。
pub const GRACEFUL_SHUTDOWN_TIMEOUT_SECS: u64 = 10;

/// 从开始优雅关闭到强制退出的硬上限。
///
/// 必须大于 [`GRACEFUL_SHUTDOWN_TIMEOUT_SECS`]：优雅预算用尽后还要给
/// `app.exit(0)` / Tauri 关窗留出收尾窗口；超过此值不再等待。
pub const FORCE_EXIT_TIMEOUT_SECS: u64 = 15;

/// 退出入口的反馈形态：决定 hooks 执行期间主窗口是否保留。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ShutdownFeedback {
    /// 保留窗口：前端已有退出进度面（用户在应用内确认退出）。
    KeepWindow,
    /// 立即隐藏主窗口：系统关窗 / 托盘等隐式退出，先给用户「窗口已关」的即时反馈。
    HideWindow,
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle = 0,
    Graceful = 1,
    Done = 2,
}

/// 退出阶段闸门：收口「hooks 只跑一次 / watchdog 只武装一次 / Done 后放行」。
///
/// 独立成结构（而非散落的 static）是为了语义可单测——退出协调器是用户可见
/// 「到底能不能退出」的最后一道闸门，不能只靠常量大小断言。
struct ShutdownGate {
    phase: AtomicU8,
    watchdog_armed: AtomicBool,
}

impl ShutdownGate {
    const fn new() -> Self {
        Self {
            phase: AtomicU8::new(Phase::Idle as u8),
            watchdog_armed: AtomicBool::new(false),
        }
    }

    /// Idle → Graceful；只有首个调用者拿到 true（hooks 只执行一次）。
    fn try_begin(&self) -> bool {
        self.phase
            .compare_exchange(
                Phase::Idle as u8,
                Phase::Graceful as u8,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }

    /// hooks 结束（成功 / 超时 / panic）后置 Done；`ExitRequested` 从此放行。
    ///
    /// Done 是终态：重复调用不回退阶段，避免 `app.exit(0)` 触发的
    /// `ExitRequested` 被再次拦截。
    fn mark_done(&self) {
        self.phase.store(Phase::Done as u8, Ordering::SeqCst);
    }

    /// 优雅关闭是否已完成（`ExitRequested` 可以放行）。
    fn should_allow_exit(&self) -> bool {
        self.phase.load(Ordering::SeqCst) == Phase::Done as u8
    }

    /// 武装 watchdog；只有首个调用者拿到 true。
    fn try_arm_watchdog(&self) -> bool {
        !self.watchdog_armed.swap(true, Ordering::SeqCst)
    }
}

static GATE: ShutdownGate = ShutdownGate::new();

/// 优雅关闭是否已完成（`ExitRequested` 可以放行）。
pub fn should_allow_exit() -> bool {
    GATE.should_allow_exit()
}

/// 启动优雅关闭（幂等）。完成后请求 Tauri 正常退出。
///
/// 只应由「用户已确认退出」或「关窗守卫已允许关闭」的路径调用；
/// 通用的 `app.exit(0)` 仍由 `RunEvent::ExitRequested` 兜底转入本函数。
pub fn begin_graceful_shutdown(app_handle: &tauri::AppHandle, feedback: ShutdownFeedback) {
    arm_force_exit_watchdog();

    // Idle → Graceful；已在跑 / 已完成则直接返回，保证 hooks 只执行一次。
    if !GATE.try_begin() {
        return;
    }

    // 旧实现直接 destroy 主窗口；改为有界优雅关闭后窗口会存活到 hooks 结束。
    // 隐式退出路径先隐藏，给用户即时反馈；确认退出路径保留窗口展示进度。
    if feedback == ShutdownFeedback::HideWindow {
        if let Some(window) = app_handle.get_webview_window("main") {
            if let Err(e) = window.hide() {
                tracing::warn!(error = %e, "Failed to hide main window before graceful shutdown");
            }
        }
    }

    tracing::info!(
        timeout_secs = GRACEFUL_SHUTDOWN_TIMEOUT_SECS,
        "Graceful shutdown started"
    );

    let app = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        // catch_unwind：单个 hook panic 不得让协调任务消失（否则只剩 watchdog
        // 硬杀）。timeout：总预算内跑完全部 hooks；单 hook 仍有 5s 超时。
        let outcome = AssertUnwindSafe(tokio::time::timeout(
            Duration::from_secs(GRACEFUL_SHUTDOWN_TIMEOUT_SECS),
            crate::system::lifecycle::lifecycle_registry().run_shutdown_hooks(),
        ))
        .catch_unwind()
        .await;

        match outcome {
            Ok(Ok(())) => tracing::info!("Graceful shutdown hooks completed"),
            Ok(Err(_)) => tracing::error!(
                timeout_secs = GRACEFUL_SHUTDOWN_TIMEOUT_SECS,
                "Graceful shutdown hooks timed out; requesting app exit"
            ),
            Err(_) => tracing::error!("Graceful shutdown hooks panicked; requesting app exit"),
        }

        // 先置 Done 再请求退出：即便上面超时/panic，`ExitRequested` 也不应再次
        // 拦截。主线程若被卡死，watchdog 会在 FORCE_EXIT_TIMEOUT_SECS 硬兜底。
        GATE.mark_done();
        tracing::info!("Requesting app exit after graceful shutdown");
        app.exit(0);
    });
}

/// 强制退出兜底：watchdog 超时后调用；不返回。
fn force_exit(reason: &str) -> ! {
    tracing::error!(reason, "Forcing WasmNest Desktop process exit");
    // 双写 stderr：non_blocking 日志队列在 process::exit 时可能来不及刷盘。
    eprintln!("WasmNest Desktop: forcing exit ({reason})");

    // 强制退出前尽力回收 PTY（带 1s 上限，避免锁被卡住时反而拖死退出）。
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let reclaimed = wasmnest_pty_engine::plugin_binding::kill_all_registered();
        let _ = tx.send(reclaimed);
    });
    match rx.recv_timeout(Duration::from_secs(1)) {
        Ok(reclaimed) => tracing::warn!(reclaimed, "PTY reclaimed before forced exit"),
        Err(_) => tracing::warn!("PTY reclaim timed out before forced exit"),
    }

    // 给 non_blocking 日志一点刷盘时间，然后结束进程（所有线程随进程终止）。
    std::thread::sleep(Duration::from_millis(100));
    std::process::exit(0);
}

/// 武装强制退出 watchdog（幂等）。
fn arm_force_exit_watchdog() {
    if !GATE.try_arm_watchdog() {
        return;
    }

    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(FORCE_EXIT_TIMEOUT_SECS));
        // 到这里进程仍然活着，就说明退出没有真正落地：可能是优雅 hooks 卡死、
        // 主线程被同步 hook 拖死，也可能是 hooks 已完成但 `app.exit(0)` 没有被
        // 事件循环处理。无论哪种，硬超时都必须兜底——不能因为 Phase=Done 就
        // 假定进程已经退出（Done 只代表 hooks 跑完，不代表进程结束）。
        force_exit("graceful shutdown watchdog timeout");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn force_timeout_leaves_room_after_graceful_budget() {
        assert!(
            FORCE_EXIT_TIMEOUT_SECS > GRACEFUL_SHUTDOWN_TIMEOUT_SECS,
            "强制退出兜底必须晚于优雅关闭总预算，否则正常退出会被误杀"
        );
    }

    #[test]
    fn gate_runs_hooks_once() {
        let gate = ShutdownGate::new();
        assert!(gate.try_begin(), "首次启动应拿到执行权");
        assert!(!gate.try_begin(), "已启动 / 已完成不得重复执行 hooks");
    }

    #[test]
    fn gate_blocks_exit_until_hooks_done() {
        let gate = ShutdownGate::new();
        assert!(!gate.should_allow_exit(), "Idle 阶段必须拦住退出，先跑 hooks");
        assert!(gate.try_begin());
        assert!(!gate.should_allow_exit(), "hooks 执行中必须继续拦住 ExitRequested");
        gate.mark_done();
        assert!(gate.should_allow_exit());
    }

    #[test]
    fn gate_done_is_terminal() {
        let gate = ShutdownGate::new();
        assert!(gate.try_begin());
        gate.mark_done();
        // 超时 / panic 后也会 mark_done：再次 begin 不得把阶段拉回 Graceful，
        // 否则 app.exit(0) 触发的 ExitRequested 会被再次拦截，进程卡住。
        assert!(!gate.try_begin());
        assert!(gate.should_allow_exit());
    }

    #[test]
    fn watchdog_arms_once() {
        let gate = ShutdownGate::new();
        assert!(gate.try_arm_watchdog(), "首次启动应武装 watchdog");
        assert!(!gate.try_arm_watchdog(), "重复 begin 不得重复开线程");
    }
}
