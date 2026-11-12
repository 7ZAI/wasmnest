//! 插件应用更新检查 / 下载（应用版本更新全链路，桌面端）
//!
//! 数据源由应用 manifest 的 `update` 段声明（缺省 = 官方应用仓
//! `7ZAI/wasmnest-apps`，tag `<slug>-v<X.Y.Z>`，资产 `<slug>-desktop-v<X.Y.Z>.zip`
//! + 同名 `.json` 元数据）。纯判定（来源自证 / Release 挑选 / 元数据校验 /
//! 下载参数自证）住在能力仓 `wasmnest_wasm_core::app_update`，与移动宿主共用；
//! 本模块只做「取 manifest → 发 HTTP → 落盘校验」，不再复制一份判定逻辑。
//!
//! 职责边界：
//! - `plugin_check_app_update`：按 manifest 声明查最新 Release → 下载元数据 JSON →
//!   校验身份 / 完整性 → 返回比对所需字段。元数据缺 `compat` 段不报错（返回
//!   `compat: null`）——「缺声明 = 不兼容」的裁决归前端，本层不吞信息。
//! - `plugin_download_update`：只接受**本模块可自证**的参数（tag / 资产名 / 摘要），
//!   URL 一律由 `AppUpdateSource` 拼出，前端传不进任意 URL；流式落临时文件并复算
//!   sha256，不符即删文件报错。
//! - 安装不在本模块：前端持返回路径调既有 `plugin_install_from_file`（升级模式，
//!   wasm-core 宿主面凭证门 + 升级前置裁决在那里；随包内置的可更新应用由内核
//!   按 manifest `update` 声明放行）。
//!
//! 两条命令都过宿主面凭证门（`frontend_channel::require_host_identity`，与
//! api_bridge 的管理命令同判据——插件面令牌不得驱动应用更新）。
//! GitHub API 匿名限流 60 次/h/IP：手动检查频率下可接受，限流响应显性报错。
//!
//! 前端投影（`update`）来自 `HostPluginInfo`：宿主应用管理页与 SDK 默认设置卡
//! 都据此判断「该应用是否参与更新检查」。

use crate::{AppError, Result};
use serde::Serialize;
use sha2::Digest;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use wasmnest_wasm_core::app_update::{
    asset_named, pick_latest_release, resolve_update_source, validate_download_args, validate_release_metadata,
    AppUpdateSource, CompatInfo,
};
use wasmnest_wasm_core::manager::host::PluginHost;

/// 本端标识（Release 资产名 / 元数据 `end` 段的判据）
const END: &str = "desktop";
const USER_AGENT: &str = concat!("wasmnest-desktop/", env!("CARGO_PKG_VERSION"));

/// `plugin_check_app_update` 的返回
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub plugin_id: String,
    /// 当前注册表里的版本（命令前置：插件必须已安装）
    pub current_version: String,
    pub latest_version: String,
    pub tag: String,
    /// zip 资产名（下载命令的 `zip_asset` 参数回传值）
    pub zip_asset: String,
    pub sha256: String,
    pub bytes: u64,
    /// 元数据 `compat` 段；`None` = 发布物缺兼容声明（前端据此判不兼容）
    pub compat: Option<CompatInfo>,
}

/// 取应用 manifest 声明的更新源（缺声明 = 不参与更新检查）
fn update_source_of(plugin: &wasmnest_wasm_core::manager::types::HostPluginInfo) -> Result<AppUpdateSource> {
    resolve_update_source(plugin.update.as_ref(), &plugin.id)?.ok_or_else(|| {
        AppError::InvalidInput(format!(
            "Plugin '{}' does not declare an update source (manifest `update`); cannot check for updates",
            plugin.id
        ))
    })
}

fn github_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| AppError::Internal(format!("HTTP client build failed: {e}")))
}

async fn fetch_text(client: &reqwest::Client, url: &str, what: &str) -> Result<String> {
    let resp = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("{what}: request failed: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let hint = if status.as_u16() == 403 || status.as_u16() == 429 {
            " (GitHub API rate limit likely reached; retry later)"
        } else {
            ""
        };
        return Err(AppError::Internal(format!("{what}: HTTP {status}{hint}")));
    }
    resp.text()
        .await
        .map_err(|e| AppError::Internal(format!("{what}: read body failed: {e}")))
}

/// 下载 zip 到临时文件并复算 sha256（不符即删文件报错；返回落盘路径）
async fn download_zip_verified(
    client: &reqwest::Client,
    url: &str,
    dest: PathBuf,
    expected_sha256: &str,
) -> Result<PathBuf> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("download update: request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Internal(format!(
            "download update: HTTP {} for {url}",
            resp.status()
        )));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Internal(format!("download update: create temp dir failed: {e}")))?;
    }
    let mut hasher = sha2::Sha256::new();
    let mut file = std::fs::File::create(&dest)
        .map_err(|e| AppError::Internal(format!("download update: create file failed: {e}")))?;
    let mut stream = resp;
    // reqwest 流式响应按块读取（二进制 zip 不可经文本路径）
    loop {
        let chunk = stream
            .chunk()
            .await
            .map_err(|e| AppError::Internal(format!("download update: stream failed: {e}")));
        let chunk = match chunk {
            Ok(Some(c)) if c.is_empty() => continue,
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                let _ = std::fs::remove_file(&dest);
                return Err(e);
            }
        };
        hasher.update(&chunk);
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(&dest);
            return Err(AppError::Internal(format!("download update: write file failed: {e}")));
        }
    }
    drop(file);
    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        let _ = std::fs::remove_file(&dest);
        return Err(AppError::Plugin(format!(
            "Downloaded update zip sha256 mismatch: expected {expected_sha256}, got {actual}; file removed"
        )));
    }
    Ok(dest)
}

// ==================== Tauri 命令 ====================

/// `plugin_pick_app_zip` 已注销（2026-11-03 审核 P3-2）
///
/// 原用途：`SysAppsView` 里「安装应用（本地 zip）」重复卡片的第一步（原生选包 →
/// 返回路径 → 前端再调 `plugin_install_from_file`）。该卡片在 2026-11-03 的改动中
/// 被删除（与第一张卡片功能重叠，后者 `state.installApp()` 走同一条安装链路），
/// 本命令遂成无前端消费者的 invoke 面。
///
/// **不保留的理由**（仓规「退役面必须 fail-visible / 不留悬空面」）：一个仍被注册
/// 但没人调的 `#[tauri::command]` 是一条对前端开放的选包能力——它的存在本身扩大了
/// 攻击面，而「以后可能要用」不是留在宿主里的理由（宿主薄壳三问第①问：离宿主能
/// 实现吗）。真需要重新开放时，从 git 历史取回即可。
///
/// 选包能力未失效：`state.installApp()` 的链路仍由原生对话框发起，前端依旧不持有
/// fs 权限、不传任意路径。

/// 检查指定应用的最新 Release（宿主前端专用）
#[tauri::command]
pub async fn plugin_check_app_update(
    webview: tauri::Webview,
    plugin_id: String,
    credential: String,
    plugin_host: State<'_, Arc<PluginHost>>,
) -> Result<AppUpdateInfo> {
    plugin_host
        .frontend_channel()
        .require_host_identity(webview.label(), &credential, "plugin_check_app_update")
        .map_err(|_| AppError::Plugin("app update check must be requested by the host frontend".to_string()))?;
    let plugin = plugin_host
        .list_plugins()
        .await
        .into_iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| AppError::Plugin(format!("Plugin not found: {plugin_id}")))?;
    let source = update_source_of(&plugin)?;

    let client = github_client()?;
    let body = fetch_text(&client, &source.releases_api_url(), "check app update").await?;
    let releases: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| AppError::Internal(format!("check app update: bad JSON: {e}")))?;
    let picked = pick_latest_release(&releases, &source)?;
    let version = picked.version.to_string();
    let meta_asset = asset_named(&picked.assets, &source.metadata_asset_name(END, &version))?;
    let meta_body = fetch_text(&client, &meta_asset.url, "check app update").await?;
    let meta: serde_json::Value = serde_json::from_str(&meta_body)
        .map_err(|e| AppError::Internal(format!("check app update: bad metadata JSON: {e}")))?;
    let (zip_asset, sha256, bytes, compat) = validate_release_metadata(&meta, &plugin.id, END, &version, &source)?;

    Ok(AppUpdateInfo {
        plugin_id: plugin.id,
        current_version: plugin.version,
        latest_version: version,
        tag: picked.tag,
        zip_asset,
        sha256,
        bytes,
        compat,
    })
}

/// 下载指定应用的更新包到临时文件（sha256 校验通过后返回路径；安装走
/// `plugin_install_from_file` 升级模式，不在本命令内）
#[tauri::command]
pub async fn plugin_download_update(
    webview: tauri::Webview,
    plugin_id: String,
    tag: String,
    zip_asset: String,
    sha256: String,
    credential: String,
    plugin_host: State<'_, Arc<PluginHost>>,
) -> Result<String> {
    plugin_host
        .frontend_channel()
        .require_host_identity(webview.label(), &credential, "plugin_download_update")
        .map_err(|_| AppError::Plugin("app update download must be requested by the host frontend".to_string()))?;
    let plugin = plugin_host
        .list_plugins()
        .await
        .into_iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| AppError::Plugin(format!("Plugin not found: {plugin_id}")))?;
    let source = update_source_of(&plugin)?;
    let (_tag, version) = validate_download_args(&source, END, &tag, &zip_asset, &sha256)?;
    let url = source.release_download_url(&tag, &zip_asset);
    let dest = std::env::temp_dir()
        .join("wasmnest-plugin-updates")
        .join(&plugin_id)
        .join(&zip_asset);
    let client = github_client()?;
    let path = download_zip_verified(&client, &url, dest, &sha256).await?;
    tracing::info!(
        plugin_id = %plugin_id,
        tag = %tag,
        version = %version,
        path = %path.display(),
        "[plugin_updates] update package downloaded and verified"
    );
    Ok(path.to_string_lossy().to_string())
}

// ==================== Tests（纯函数面；网络交互不在单测内） ====================

#[cfg(test)]
mod tests {
    use super::*;
    use wasmnest_wasm_core::app_update::PluginUpdateDecl;
    // `PluginState` / `PluginType` 只在 `manifest` 公开；`manager::types` 是私有
    // `use` 转发（不可经该路径导入）——测试模块按真源路径取
    use wasmnest_wasm_core::manager::types::HostPluginInfo;
    use wasmnest_wasm_core::manifest::{PluginState, PluginType};

    fn plugin_with(update: Option<PluginUpdateDecl>) -> HostPluginInfo {
        HostPluginInfo {
            id: "com.wasmnest.file-transfer".to_string(),
            name: "File Transfer".to_string(),
            version: "0.0.1".to_string(),
            description: String::new(),
            author: String::new(),
            main: String::new(),
            plugin_type: PluginType::Full,
            kind: Default::default(),
            background_transport: false,
            update,
            rust_library: String::new(),
            permissions: vec![],
            state: PluginState::Loaded,
            extension_path: String::new(),
            contributes: Default::default(),
            icon: None,
            source: "wasm".to_string(),
            size_bytes: 0,
            installed_at: None,
        }
    }

    #[test]
    fn update_source_is_read_from_manifest() {
        let default_decl = PluginUpdateDecl {
            provider: Default::default(),
            repo: None,
            tag_prefix: None,
            slug: None,
        };
        let source = update_source_of(&plugin_with(Some(default_decl))).unwrap();
        assert_eq!(source.repo, "7ZAI/wasmnest-apps");
        assert_eq!(source.slug, "file-transfer");
        assert_eq!(source.tag_prefix, "file-transfer-");

        let err = update_source_of(&plugin_with(None)).unwrap_err();
        assert!(
            err.to_string().contains("does not declare an update source"),
            "实际: {err}"
        );
    }

    #[test]
    fn update_source_honors_custom_repo_and_prefix() {
        let decl = PluginUpdateDecl {
            provider: Default::default(),
            repo: Some("acme/widgets".to_string()),
            tag_prefix: Some("release-".to_string()),
            slug: Some("widgets".to_string()),
        };
        let source = update_source_of(&plugin_with(Some(decl))).unwrap();
        assert_eq!(source.repo, "acme/widgets");
        assert_eq!(source.slug, "widgets");
        assert_eq!(source.tag_prefix, "release-");
    }
}
