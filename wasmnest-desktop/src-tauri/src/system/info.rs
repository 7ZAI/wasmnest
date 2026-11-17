//! 系统基本信息（OS / 设备名 / IP）：启动时采集一次，挂到全局单例供各域引用
//!
//! 真源已拆到 `wasmnest-server-base::info`；本文件只保留 shim 路径。

pub use wasmnest_server_base::info::{local_ipv4_addresses, SystemInfo};
