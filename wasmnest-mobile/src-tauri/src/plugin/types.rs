//! Mobile Plugin Types (Host)
//!
//! **manifest 词汇真源 = `wasmnest_wasm_core::manifest`**（与桌面宿主同源）。
//! 移动 SDK 的 `wasmnest-plugin-api-mobile::types` 是 guest 面 wire 镜像，
//! 编到 wasm32 时不能依赖 wasm-core；宿主侧不再消费它。

pub use wasmnest_wasm_core::manifest::{
    CommandContribution, ConfigProperty, LifecycleContribution, NavTabContribution,
    PluginConfiguration, PluginContributes, PluginKind, PluginManifest, PluginPlatform,
    PluginState, PluginType, SettingsContribution, TerminalContribution, ViewContribution,
};

use serde::{Deserialize, Serialize};

/// 插件来源
#[derive(Debug, Clone, PartialEq)]
pub enum PluginSource {
    /// APK assets 内置插件
    ApkAsset,
    /// 远程下载插件
    RemoteDownload,
    /// 本地文件安装插件
    FileInstall,
    /// 仅前端注册（无 WASM 模块）
    FrontendOnly,
}

/// 已加载插件的内部表示
pub struct LoadedPlugin {
    pub manifest: PluginManifest,
    pub state: PluginState,
    /// 插件来源
    pub source: PluginSource,
    /// 插件目录路径（包含 plugin.json 的目录）
    pub extension_path: String,
}

/// 插件生命周期事件（真源 = fork crate `manager::types`，批次 2b 迁入；
/// 此处 re-export 保 `crate::plugin::types::PluginLifecycleEvent` 路径——
/// handler/auth.rs 与 connection/manager.rs 的分发面零改动）
pub use wasmnest_wasm_core::manager::types::PluginLifecycleEvent;

/// 返回给前端的插件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub main: String,
    pub plugin_type: PluginType,
    /// 装配角色（L1 基础服务 / L2 内部业务 / L3 应用）；缺省 = L3。
    /// 与桌面 `HostPluginInfo.kind` 同形，系统服务区 / 服务监控的唯一判据。
    pub kind: PluginKind,
    pub permissions: Vec<String>,
    pub state: PluginState,
    pub contributes: PluginContributes,
    /// 插件来源
    pub source: String,
    /// 插件目录路径（含 plugin.json 的目录），前端经 asset protocol 加载前端模块
    pub extension_path: String,
    /// 插件图标：emoji 或相对插件目录的图片路径，缺省时前端生成字母头像回退
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// 插件目录总大小（字节），目录不存在时为 0
    pub size_bytes: u64,
    /// 安装时间（unix 毫秒），取 plugin.json 的 mtime；无法获取时为 null
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<i64>,
}

/// 递归统计目录总大小（字节），路径不存在或不可读时返回已累计部分
fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_file() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        } else if file_type.is_dir() {
            total += dir_size(&entry.path());
        }
    }
    total
}

/// 以 plugin.json 的 mtime 近似安装时间（unix 毫秒）
fn manifest_installed_at(extension_path: &str) -> Option<i64> {
    let manifest = std::path::Path::new(extension_path).join("plugin.json");
    let mtime = std::fs::metadata(&manifest).ok()?.modified().ok()?;
    let since_epoch = mtime.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since_epoch.as_millis() as i64)
}

impl From<&LoadedPlugin> for MobilePluginInfo {
    fn from(p: &LoadedPlugin) -> Self {
        let source_str = match &p.source {
            PluginSource::ApkAsset => "apk-asset",
            PluginSource::RemoteDownload => "remote-download",
            PluginSource::FileInstall => "file-install",
            PluginSource::FrontendOnly => "frontend-only",
        };
        MobilePluginInfo {
            id: p.manifest.id.clone(),
            name: p.manifest.name.clone(),
            version: p.manifest.version.clone(),
            description: p.manifest.description.clone(),
            author: p.manifest.author.clone(),
            main: p.manifest.main.clone(),
            plugin_type: p.manifest.plugin_type.clone(),
            kind: p.manifest.kind,
            permissions: p.manifest.permissions.clone(),
            state: p.state.clone(),
            contributes: p.manifest.contributes.clone(),
            source: source_str.to_string(),
            extension_path: p.extension_path.clone(),
            icon: p.manifest.icon.clone(),
            size_bytes: dir_size(std::path::Path::new(&p.extension_path)),
            installed_at: manifest_installed_at(&p.extension_path),
        }
    }
}
