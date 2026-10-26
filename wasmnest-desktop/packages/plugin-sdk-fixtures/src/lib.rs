//! 宿主测试夹具合集（SDK 绑定形态） —— 由原 `plugin-{http,task,pty,sdk,ws,wasip3,bench}-test`
//! 七个独立 crate 合并而来。
//!
//! # 为什么合并
//!
//! 七个夹具同构（`WasmPlugin` impl + `wasm_entry!`），拆成七份的收益只是"一个夹具一个
//! 目录"，代价是：ABI 提升要同步改七处 `const ID` / `abi::version()`、七份 `plugin.json`
//! 各自漂移、宿主侧七个几乎逐字重复的 fixture builder。合并后 ABI 真源回到一处。
//!
//! # feature 互斥约束（改之前先读）
//!
//! 一次构建只启用一个夹具 feature。**理由不是"多开会编译失败"**——spike 实测两个
//! feature 同时开也能编译通过（`wasm_entry!` / `export!` 在各自 module 内生成不冲突
//! 的符号，产物体积约 4 倍，两个夹具都编进去了）。真正理由是**产物歧义**：宿主侧
//! `build_sdk_fixture(feature)` 按 feature 名归档产物，一个产物必须能无歧义地
//! 对应一个夹具；多开时无法判断产物是哪个夹具。
//!
//! Cargo 不表达"至多一个"，该约束靠下方 `compile_error!` 兜底，不靠注释。
//!
//! # 范围
//!
//! 本合集只收 **SDK 绑定形态**夹具（经 `wasm_entry!` 宏）。下列夹具**不**在此列：
//!
//! - `plugin-bench-test`——749 行 / 29 命令的性能基准夹具，与功能闭环夹具性质不同，
//!   独立 crate；
//! - `plugin-system-test`——手写 wit-bindgen 绑定形态（`plugin-system` world），
//!   机制不同，独立 crate；
//! - `plugin-wasi-test` / `plugin-p3-async-host-import-test`——随三仓拆分票 08 批次三
//!   **迁能力仓自持夹具**（`wasmnest-wasm-core/fixtures/`，绑定能力仓自己的
//!   `wit/core.wit`，零 SDK 依赖），不在平台仓。
//!
//! # 迁移自
//!
//! - `plugin-http-test` → `feature = "http"`（ABI v29 host-http 服务端域下沉）
//! - `plugin-task-test` → `feature = "task"`（ABI v20 host-task 并发任务域）

// ==================== feature ====================

// 互斥约束兜底：cargo 无法表达"至多一个"，编译期显式拒绝多开。
#[cfg(all(
    feature = "http",
    any(
        feature = "task",
        feature = "pty",
        feature = "sdk",
        feature = "ws",
        feature = "wasip3",
        feature = "crypto"
    )
))]
compile_error!(
    "夹具 feature 互斥：每次构建只能启用一个——一个产物必须无歧义地对应一个夹具，\
     否则宿主侧 build_sdk_fixture(feature) 按 feature 名归档时无从判断产物是哪个。\
     请一次只传一个。"
);

#[cfg(not(any(
    feature = "http",
    feature = "task",
    feature = "pty",
    feature = "sdk",
    feature = "ws",
    feature = "wasip3",
    feature = "crypto"
)))]
compile_error!(
    "至少启用一个夹具 feature：http / task / pty / sdk / ws / wasip3 / crypto\
     （bench 性能基准夹具是独立 crate，不在本合集内）"
);

// ==================== http（ABI v29 host-http 服务端域） ====================

/// host-http 服务端域（ABI v29）fixture 插件
#[cfg(feature = "http")]
pub mod http;

// ==================== task（ABI v20 host-task 并发任务域） ====================

/// host-task（ABI v20）fixture 插件 —— 宿主并发任务域闭环载体
#[cfg(feature = "task")]
pub mod task;

// ==================== wasip3（编译链 + async 宿主原语闭环） ====================

///    `wasi:clocks` 的解析/实例化闭环。
#[cfg(feature = "wasip3")]
pub mod wasip3;

// ==================== crypto（host-crypto 端到端探针；票 02 批次 04 自 wasip3 夹具拆出） ====================

/// （AEAD 往返 + 未知名 fail-visible + X25519 双端共享 + KDF 派生）。
#[cfg(feature = "crypto")]
pub mod crypto_probe;

// ==================== pty（ABI v16 host-pty 真 PTY 域） ====================

///   线程读空，故用静态 Mutex）。
#[cfg(feature = "pty")]
pub mod pty;

// ==================== sdk（真实 SDK 链路 + 互调） ====================

/// 经组件 import 的往返，以及插件互调（ADR 0017 `#[plugin_api]`）。
#[cfg(feature = "sdk")]
pub mod sdk;

// ==================== ws（ABI v14 host-websocket 双向域） ====================

/// host-websocket（ABI v14）fixture 插件
///
/// 覆盖出站连接域（`ws-connect` / `ws-send-text` / `ws-send-binary` / `ws-close` /
/// `ws-is-connected`）与服务端入站端点域（register / unregister / send-to-client /
/// broadcast / close-client / list-clients / list-endpoints），以及 `events-ws`
/// 两个帧回调的收集与回显。
///
/// 帧与总线事件都存实例级全局（wasm32-wasip3 的 thread_local 是真 TLS，按宿主
/// 调用线程隔离，「投递线程记录 / 查询线程读取」跨线程会读空；故用静态 Mutex）。
#[cfg(feature = "ws")]
pub mod ws;
