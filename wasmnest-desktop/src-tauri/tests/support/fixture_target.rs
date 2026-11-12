//! 桌面宿主夹具编译产物的**共享 target 目录**（票 08 批次三自能力仓迁入）
//!
//! # 为什么存在
//!
//! 桌面夹具 crate（`wasmnest-desktop/packages/plugin-sdk-fixtures` /
//! `plugin-system-test`）各自独立 workspace。`cargo build --manifest-path` 未指定
//! target 目录时，cargo 把产物写进该夹具 crate 根下的 `target/` —— 依赖图被重复
//! 编译 N 遍（SDK → wit-bindgen + macros + serde…，同一份依赖）。
//!
//! 改为共享 `wasmnest-desktop/target/fixtures` 后，同 triple + 同 profile + 同
//! feature 集下 cargo 按产物指纹复用，依赖图只编译一次。
//!
//! # 为什么不并进宿主 `src-tauri/target`
//!
//! 1. `cargo clean` 与 `check-target-size.js` 的 15G 阈值都只针对 `src-tauri/target`，
//!    混在一起会让统计失真，且清宿主缓存时连带清掉夹具缓存。
//! 2. 夹具的 `[profile.release]`（`opt-level = "s"` / `lto = true`）与宿主不同，
//!    放一起会产生两套产物、掩盖去重效果。
//!
//! # 为什么不与 wasm 应用共享目录
//!
//! wasm 应用 crate **没有** `[profile.*]`（用 cargo 默认值），与夹具的 profile 不同；
//! profile 参与产物指纹 → 同目录内同一份依赖图会产出两份产物。故两者分目录。
//!
//! # 安全性
//!
//! `cargo test` 运行测试期间**不持有** target 目录锁（2026-09-26 探针实测：测试睡眠
//! 期间并发 `cargo build` 真实重编译 0.04s 完成，无 `Blocking waiting for file lock`），
//! 因此夹具构建与父 `cargo test` 共用目录不会死锁。

use std::path::PathBuf;

/// 夹具共享 target 根目录：`wasmnest-desktop/target/fixtures`
///
/// 由 `CARGO_MANIFEST_DIR`（= `wasmnest-desktop/src-tauri`）进 `../target/fixtures`
/// 定位，不依赖 cwd，因此测试以任意 cwd 启动都能命中同一目录。
///
/// 基准对齐平台仓装配：宿主 `src-tauri/target` 与夹具 `target/fixtures` 是两个桶
/// （profile 不同）；手工 / 工具链探针构建夹具时也要显式
/// `CARGO_TARGET_DIR=<wasmnest-desktop>/target/fixtures`，否则「测试内构建的夹具」
/// 与「手工构建的夹具」会分裂成两个落点。
pub fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/fixtures")
}

/// 夹具产物路径：`<dir>/<target>/<profile>/<lib_name>.wasm`
///
/// `lib_name` 用 crate 名（`[lib] name` / `package.name` 的下划线形式），例如
/// `wasmnest_plugin_ws_test`；`target` 与 `profile` 分别是 cargo 的 `--target` 与
/// release/debug。
///
/// 共享目录后产物名仍由各夹具自己的 crate 名决定 → 不同夹具不会互相覆盖。
pub fn artifact(target: &str, profile: &str, lib_name: &str) -> PathBuf {
    dir().join(target).join(profile).join(format!("{lib_name}.wasm"))
}
