//! 对等网络（peer-net）宿主模块：装配 / 端口 / 平台缝 / 选源 / 迁移。
//!
//! 引擎控制面真源在共享能力域 `../wasmnest-lib/wasmnest-server-peer-net`（双端同引，
//! ADR 0048）；`host-peer` 的 WIT 实现也在该 crate 的 `common-host` 绑定层，宿主
//! **零 peer 原语代码**。本模块只保留 lib 要求的平台差异面：
//!
//! - [`net`]：装配（`peer_ctx` 是宿主唯一认识 `AppHandle` 的引擎装配点）+
//!   节点身份初始化 + 四个引擎状态再导出；
//! - [`ports`]：宿主端口实现（插件总线 / 前端事件 / 路径 / 系统信息 / mDNS）
//!   + 平台资源预热缓存；
//! - [`seam`]：平台缝（Android SAF 共享访问 / MediaStore 落点提升 / 内置共享条目）；
//! - [`transfer`]：发送源选择平台缝（SAF 多选 → 直读 / 中转复制）；
//! - [`migration`]：旧引擎数据 → 插件存储键一次性幂等迁移（随引擎停写收尾删除）。
//!
//! 原 `receive` / `remote` 两个纯委托模块已随 host-peer 脱绑删除（19 条原语的
//! `Host` impl 在 lib，直接调 crate 域函数，宿主中转层零消费者）。
//!
//! 边界：宿主不持传输任务 / 设置 / 历史真源（在 file-transfer 插件共享核）；
//! 适配模块零 Tauri 命令面（防回接锁
//! `tests/retired_mobile_peer_transfer_command_face_lock.rs`），引擎控制面不得
//! 回流宿主（防回接锁 `tests/peer_engine_consolidation_lock.rs`）。

pub mod migration;
pub mod net;
pub mod ports;
pub mod seam;
pub mod transfer;
