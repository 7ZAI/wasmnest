//! Error Boundary
//!
//! **server-lib-split 迁移**：真源已随 `wasmnest-server-base` 拆出（拆分后为
//! `wasmnest-server-base` crate 的 `error_boundary` 模块）；本文件保留模块路径与
//! 全部公开名字，宿主其余代码经 `crate::system::error_boundary::*` 引用不受影响。

pub use wasmnest_server_base::error_boundary::{
    spawn_os_thread, spawn_with_error_boundary, spawn_with_error_boundary_on,
};
