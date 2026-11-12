//! 应用常量定义
//!
//! **server-lib-split 迁移**：真源已随 `wasmnest-server-base` 拆出（拆分后为
//! `wasmnest-server-base` crate 的 `constants` 模块）；本文件保留模块路径与全部
//! 公开名字（`pub use ...::*`），宿主其余代码经 `crate::system::constants::*`
//! 引用不受影响。常量本身只含字面量，零依赖，纯搬迁。

pub use wasmnest_server_base::constants::*;
