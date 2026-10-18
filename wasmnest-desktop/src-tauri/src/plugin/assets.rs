//! 应用前端挂载包目录（ADR 0057 机制 B：壳按路由装载独立构建的 app 整包）
//!
//! **为什么目录口径由宿主给出、前端不自己拼**：
//! `<resource>/resources/plugins/desktop/<appId>/index.js` 这个落点叠了两层语义——
//! `resource_dir()` 基目录 + `tauri.conf.json` 的 `bundle.resources = "resources/plugins/"`
//! 前缀。dev 下 resource_dir 是 `src-tauri/target/debug`，产物却在
//! `target/debug/resources/plugins/desktop/`（tauri dev 会把 bundle resources 复制进去）。
//! 前端若用 `join(resourceDir(), 'plugins', 'desktop', …)` 自己拼，就少了 `resources`
//! 这一层：asset URL 404 → 动态 import 失败 → 所有挂载面报错（2026-10-17 实机验证
//! P0-1）。路径已由启动装配（lib.rs 的 `plugins_dir`，含 dev 回退到源码目录）解析成
//! 唯一事实，前端只消费结果，同一份路径约定不再在 Rust / TS 各写一遍。
//!
//! 落点是否在 asset protocol 允许范围内由 `tauri.conf.json` 的
//! `security.assetProtocol.scope`（`$RESOURCE/**/*`）保证：本目录就是 resource 基目录下
//! 的子路径，dev / prod 同语义。

use std::path::PathBuf;

use tauri::State;

/// 启动装配解析出的内置插件（= 应用整包）根目录
///
/// 由 `lib.rs` 在插件装配处 `app.manage` 注册；只在宿主内部使用，无业务语义。
pub struct AppAssetsDir(pub PathBuf);

/// 应用整包根目录（前端按 `<dir>/<appId>/index.js` 组成挂载包入口）
///
/// 目录缺失时**显性报错**（fail-visible，AGENTS §5.1.4）：此时任何挂载都必然 404，
/// 静默返回一个不存在的路径只会把「没构建产物」伪装成「应用本身坏了」。
#[tauri::command]
pub fn plugin_get_asset_dir(dir: State<'_, AppAssetsDir>) -> crate::Result<String> {
    let path = &dir.0;
    if !path.is_dir() {
        return Err(crate::AppError::Plugin(format!(
            "app bundle dir not found: {} (run `pnpm run plugins:build` first)",
            path.display()
        )));
    }
    Ok(path.to_string_lossy().into_owned())
}
