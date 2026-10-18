//! System Information
//!
//! **server-lib-split 迁移**：真源已随 `wasmnest-server-base` 拆出（拆分后为
//! `wasmnest-server-base` crate 的 `info` 模块）；本文件保留模块路径与全部公开
//! 名字，宿主其余代码经 `crate::system::info::*` 引用不受影响。

pub use wasmnest_server_base::info::{local_ipv4_addresses, SystemInfo};
