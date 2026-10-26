//! 桌面宿主测试夹具的构建器（票 08 批次三自能力仓迁入；宿主 e2e 只读产物）
//!
//! 消费者分工（与迁移前能力仓的 keeper 口径一致）：
//! - **构建方** = `src-tauri/tests/fixture_keeper.rs`（本模块的 keeper 用例）；
//! - **读取方** = 各宿主 e2e 二进制经 `support::sdk_fixture_artifact_bytes` /
//!   `support::system_test_artifact_bytes` **只读不建**。
//!
//! 为什么构建器与读取面分家：没有 keeper 时「能力仓测试全绿 + 桌面 e2e 红（产物
//! 缺失）」会各红一半，且那条红指向一条没人负责的重建路径。构建器住在测试面而
//! 不是夹具 crate 里，是因为产物落点（共享 target）与 profile / feature 归档规则
//! 属于测试基建，夹具 crate 只负责源码。

use std::path::{Path, PathBuf};

use wasmnest_desktop_lib::wasm_core::config::plugin_debug_mode;

use super::fixture_target;

/// wasip3 固定 nightly（与平台仓 `scripts/wasip3-toolchain.sh` 的 WASIP3_NIGHTLY
/// 单一事实来源）；stable 1.99 发布后随工具链切换，见 docs 的 wasip3 工具链说明
const WASIP3_NIGHTLY: &str = "nightly-2026-09-16";

/// wasip3 工具链（pinned nightly + wasm32-wasip3 target）是否可用
///
/// CI（stable）无该 target → 返回 false，调用侧测试跳过；本地经
/// `scripts/wasip3-toolchain.sh install` 后为 true。结果惰性缓存。
pub fn wasip3_toolchain_ready() -> bool {
    use std::sync::OnceLock;
    static READY: OnceLock<Option<bool>> = OnceLock::new();
    match READY.get_or_init(|| {
        let out = std::process::Command::new("rustup")
            .args(["run", WASIP3_NIGHTLY, "rustup", "target", "list", "--installed"])
            .output()
            .ok()?;
        Some(
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .any(|l| l == "wasm32-wasip3"),
        )
    }) {
        Some(ready) => *ready,
        None => false,
    }
}

/// 桌面夹具与 SDK 所在的 packages 根（`wasmnest-desktop/packages`）
fn packages_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages")
}

/// 取一组目录下所有源文件的最新 mtime（目录不存在时返回 `UNIX_EPOCH`）
///
/// **按目录树递归扫，不枚举具体文件**。原各夹具 builder 都是手写文件清单
/// （`plugin-sdk-desktop/rust/src/wasm.rs`、`wasm_host.rs`、…），漏一个文件就会
/// “改了不重建”，且症状是**测试全绿但跑的是旧产物**（最难查的一类）。
fn newest_source_mtime(dirs: &[PathBuf]) -> std::time::SystemTime {
    let mut newest = std::time::SystemTime::UNIX_EPOCH;
    let mut stack: Vec<PathBuf> = dirs.to_vec();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            // Cargo.lock / *.wasm 等非源文件不参与（会因构建自我更新而误触发重建）
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if name == "Cargo.lock" || path.extension().is_some_and(|e| e == "wasm") {
                continue;
            }
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                if modified > newest {
                    newest = modified;
                }
            }
        }
    }
    newest
}

/// SDK 夹具产物是否需要重建（产物比任一依赖源文件旧则重建）
///
/// **必须包含 SDK 自身的源文件**：缓存命中时本函数短路返回，**根本不会调用 cargo**，
/// 所以「cargo 的依赖指纹会发现 SDK 变了」不成立——只盯夹具自身文件会让 SDK 改动
/// 被静默忽略（测试全绿但跑的是旧产物）。
pub fn fixture_needs_rebuild(module_path: &Path) -> bool {
    let packages = packages_dir();
    let watched = [
        // 合集 crate 自身
        packages.join("plugin-sdk-fixtures/src"),
        packages.join("plugin-sdk-fixtures/Cargo.toml"),
        // SDK 全部源文件（rust/src 递归 + wit + 过程宏 crate）
        packages.join("plugin-sdk-desktop/rust/src"),
        packages.join("plugin-sdk-desktop/rust/wit"),
        packages.join("plugin-sdk-desktop/rust-macros/src"),
    ];
    let newest = newest_source_mtime(&watched);
    let module_modified = std::fs::metadata(module_path)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    newest > module_modified
}

/// SDK 绑定夹具合集（`packages/plugin-sdk-fixtures`）按 feature + profile 的产物路径
///
/// 合集 crate 各 feature 编译出的 wasm 同名（都是 `wasmnest_plugin_sdk_fixtures.wasm`），
/// 后构建的会覆盖先构建的——故按 feature（+profile）加后缀另存一份，原地产物只当
/// 中间步骤。依赖图仍在共享 target 目录里复用（实测切 feature 仅重编夹具本体 ~3s，
/// 不重编 SDK）。
pub fn sdk_fixture_artifact(feature: &str, profile: &str) -> PathBuf {
    fixture_target::dir()
        .join("wasm32-wasip3")
        .join(profile)
        .join(format!("wasmnest_plugin_sdk_fixtures.{feature}.{profile}.wasm"))
}

/// SDK 夹具构建互斥锁
///
/// 夹具产物必须互斥：cargo 对各 feature 编出的 wasm **同名**，而测试用例并行跑。
/// 若不串行，A 线程 build 完 feature=pty、还没来得及归档，B 线程的 build=ws 就把
/// 同名产物覆写了——A 归档到的是 B 的内容（实测表现为
/// `failed to parse WebAssembly module`，读到的是另一个线程半写完的文件）。
///
/// 只锁"build + 归档"这一段：命中缓存的快路径不取锁。
static SDK_FIXTURE_BUILD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// SDK 夹具构建互斥锁的守卫（中毒后取回内部值继续）
fn lock_sdk_fixture_build() -> std::sync::MutexGuard<'static, ()> {
    SDK_FIXTURE_BUILD_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 构建 SDK 绑定夹具合集的单个夹具（feature 互斥，一次一个）
///
/// `feature` 取 `http` / `task` / `pty` / `sdk` / `ws` / `wasip3` / `crypto`
/// （crypto 夹具消费者 = 宿主 e2e `host_crypto_e2e`）。
///
/// `WASMNEST_PLUGIN_DEBUG=1`（dev 构建下）走 **debug** profile——保留 DWARF 行号，
/// 供 debug 模式 trap 行号断言。产物名含 profile，两者可共存不互相覆盖。
pub fn build_sdk_fixture(feature: &str) -> Vec<u8> {
    let plugin_dir = packages_dir().join("plugin-sdk-fixtures");

    let profile = if plugin_debug_mode() { "debug" } else { "release" };
    let module_path = sdk_fixture_artifact(feature, profile);

    // 命中缓存的快路径不取锁
    if module_path.exists() && !fixture_needs_rebuild(&module_path) {
        return std::fs::read(&module_path).expect("read cached sdk fixture component");
    }

    // build + 归档必须与其它 feature 串行：各 feature 产物同名，见锁的注释
    let _guard = lock_sdk_fixture_build();
    // 取锁后重新确认一次缓存：等锁期间可能已有别的线程编好了同一个 feature
    if module_path.exists() && !fixture_needs_rebuild(&module_path) {
        return std::fs::read(&module_path).expect("read cached sdk fixture component");
    }

    let mut args = vec!["build", "--target", "wasm32-wasip3"];
    if profile == "release" {
        args.push("--release");
    }
    let manifest = plugin_dir.join("Cargo.toml");
    args.extend([
        "--no-default-features",
        "--features",
        feature,
        "--manifest-path",
        manifest.to_str().unwrap(),
    ]);
    let status = std::process::Command::new("cargo")
        .env("RUSTUP_TOOLCHAIN", WASIP3_NIGHTLY)
        .env("CARGO_TARGET_DIR", fixture_target::dir())
        .args(args)
        .status()
        .expect("run cargo build for sdk fixture component");
    assert!(
        status.success(),
        "sdk fixture ({feature}/{profile}) component WASM build failed"
    );

    // cargo 产出的固定名拷贝一份到 feature+profile 专属名：下一轮构建别的 feature
    // 会覆写固定名，但不会动已归档的产物
    let built = fixture_target::artifact("wasm32-wasip3", profile, "wasmnest_plugin_sdk_fixtures");
    std::fs::copy(&built, &module_path)
        .unwrap_or_else(|e| panic!("archive sdk fixture {feature}/{profile} artifact: {e}"));
    std::fs::read(&module_path).expect("read sdk fixture component after build")
}

// ==================== 系统组件夹具（plugin-system-test） ====================

/// 系统组件夹具（`wasmnest-desktop/packages/plugin-system-test`）产物是否需要重建
///
/// 与 [`fixture_needs_rebuild`] 同判据，但 watch 的是**本夹具自身 + 桌面 SDK 的 WIT
/// 生成物目录**（夹具的 wit-bindgen 绑定直接吃 `plugin-sdk-desktop/rust/wit/`，
/// WIT 变了必须重建，否则「能力仓全绿 + 宿主 e2e 用旧产物」）。
fn system_test_fixture_needs_rebuild(module_path: &Path) -> bool {
    let packages = packages_dir();
    let watched = [
        packages.join("plugin-system-test/src"),
        packages.join("plugin-system-test/Cargo.toml"),
        packages.join("plugin-sdk-desktop/rust/wit"),
    ];
    let newest = newest_source_mtime(&watched);
    let module_modified = std::fs::metadata(module_path)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    newest > module_modified
}

/// 构建系统组件夹具并返回产物字节（consumer = 桌面 `tests/system_component_test.rs`）
///
/// 与 [`build_sdk_fixture`] 分开的理由：它是**独立 crate**（不走
/// `plugin-sdk-fixtures` 的 feature 合集），产物名固定（无 feature/profile 后缀），
/// 但同样只由 keeper 用例构建、其它宿主测试只读——构建方与消费方分离，
/// 「谁负责产出产物」必须有单一答案，否则产物缺失时那条红无人认领。
pub fn build_system_test_fixture() -> Vec<u8> {
    let plugin_dir = packages_dir().join("plugin-system-test");
    // 该夹具固定 release profile（见其 Cargo.toml `[profile.release]`），无 debug 分支
    let module_path = fixture_target::artifact("wasm32-wasip3", "release", "wasmnest_plugin_system_test");

    if module_path.exists() && !system_test_fixture_needs_rebuild(&module_path) {
        return std::fs::read(&module_path).expect("read cached system-test fixture component");
    }

    // 与 SDK 夹具共用互斥锁：两者写同一 target 目录的相邻路径，且 cargo 会争同一把
    // 目录锁；显式串行避免"读到别的线程半写完的文件"。
    let _guard = lock_sdk_fixture_build();

    let manifest = plugin_dir.join("Cargo.toml");
    let status = std::process::Command::new("cargo")
        .env("RUSTUP_TOOLCHAIN", WASIP3_NIGHTLY)
        .env("CARGO_TARGET_DIR", fixture_target::dir())
        .args([
            "build",
            "--target",
            "wasm32-wasip3",
            "--release",
            "--manifest-path",
            manifest.to_str().unwrap(),
        ])
        .status()
        .expect("run cargo build for system-test fixture component");
    assert!(status.success(), "system-test fixture component WASM build failed");

    std::fs::read(&module_path).expect("read system-test fixture component after build")
}
