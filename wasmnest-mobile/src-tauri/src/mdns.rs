//! mDNS 模块：局域网 WasmNest 设备发现（browse 宿主薄壳）
//!
//! 广播面已随能力域集中化退役——引擎广播走共享守护
//! `wasmnest-discovery-engine::engine`，宿主零自建广播实例。底层是 mdns-sd 的
//! 纯 Rust 实现。

pub mod discovery;
pub mod types;
