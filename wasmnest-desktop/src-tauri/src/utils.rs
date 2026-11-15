//! 宿主工具面：认证桥接、加密与会话互调窄转发
//!
//! - `auth::auth_center` / `auth::test_tokens` 与 `session_gateway` **住本仓**：
//!   它们分别是认证中心桥接（宿主薄壳）和会话插件互调的唯一收口点，随
//!   wasm-core 纯净性收口从内核迁回/留在宿主；
//! - `auth::identity` / `crypto` 是真源在 `wasmnest-server-base` /
//!   `wasmnest-crypto-engine` 的路径 shim，保留 `crate::utils::*` 旧路径零改动。

pub mod auth;
pub mod crypto;
pub mod session_gateway;
