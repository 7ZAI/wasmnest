//! 应用更新检查 / 下载（应用版本更新全链路，移动端）
//!
//! 数据源由应用 manifest 的 `update` 段声明（缺省 = 官方应用仓
//! `7ZAI/wasmnest-apps`，tag `<slug>-v<X.Y.Z>`，资产
//! `<slug>-mobile-v<X.Y.Z>.zip` + 同名 `.json` 元数据）。纯判定住在能力仓
//! `wasmnest_wasm_core::app_update`，与桌面宿主共用；本模块只做
//! 「取 manifest → 发 HTTP → 落盘校验」。
//!
//! 命令面分两类：
//! - `plugin_check_app_update` / `plugin_download_update`：宿主前端凭证（应用管理
//!   页使用；**任意目标**，与桌面同口径）；
//! - `plugin_check_self_update`：插件通道令牌（应用设置页使用；**只能查自己**，
//!   由 `FrontendChannelRegistry::resolve` 解析出插件 id，参数里没有可伪造的目标）。
//!   它返回已归一化的状态（up-to-date / available / incompatible），兼容裁决在本层
//!   完成——移动端没有 mountContract 概念，只按 `compat.hostRuntime` 与宿主版本比较。
//!
//! 安装不在本模块：下载命令返回本地 zip 路径后，宿主前端调
//! `plugin_install_from_file`（`upgrade = true`，先停用应用；升级保数据，目录换新，
//! 内容哈希变化使审批失效——新代码必须重新批准）。
//! GitHub API 匿名限流 60 次/h/IP：手动检查频率下可接受，限流响应显性报错。

use crate::plugin::manager::PluginManager;
use crate::plugin::types::MobilePluginInfo;
use crate::Result;
use serde::Serialize;
use sha2::Digest;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tokio::io::AsyncWriteExt;
use wasmnest_wasm_core::app_update::{
    asset_named, parse_version, pick_latest_release, resolve_update_source, validate_download_args,
    validate_release_metadata, AppUpdateSource, CompatInfo,
};
use wasmnest_wasm_core::security::frontend_channel::{ChannelIdentity, FrontendChannelRegistry};

/// 本端标识（Release 资产名 / 元数据 `end` 段的判据）
const END: &str = "mobile";
const USER_AGENT: &str = concat!("wasmnest-mobile/", env!("CARGO_PKG_VERSION"));

/// `plugin_check_app_update` 的返回（宿主应用管理页）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub plugin_id: String,
    pub current_version: String,
    pub latest_version: String,
    pub tag: String,
    pub zip_asset: String,
    pub sha256: String,
    pub bytes: u64,
    pub compat: Option<CompatInfo>,
    /// 与当前移动宿主的兼容裁决（宿主运行时轴；mountContract 是桌面概念）
    pub compatible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compat_reason: Option<AppUpdateReason>,
}

/// 检查失败 / 不兼容原因（展示层按 key 翻译）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateReason {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// `plugin_check_self_update` 的归一化返回（应用设置页 SDK 默认卡片消费）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheckResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<AppUpdateReason>,
}

fn require_host_surface(
    channel: &FrontendChannelRegistry,
    webview_label: &str,
    command: &str,
    credential: &str,
) -> Result<()> {
    channel
        .require_host_identity(webview_label, credential, command)
        .map_err(|_| crate::AppError::Plugin(format!("{command} must be requested by the host frontend")))
}

fn update_source_of(plugin: &MobilePluginInfo) -> Result<AppUpdateSource> {
    resolve_update_source(plugin.update.as_ref(), &plugin.id)?.ok_or_else(|| {
        crate::AppError::Plugin(format!(
            "Plugin '{}' does not declare an update source (manifest `update`); cannot check for updates",
            plugin.id
        ))
    })
}

/// 更新链路唯一出站客户端
///
/// 与其它出站面同判据（安全审查：不允许存在不经 egress 的出站路径）：
/// - 客户端装 `egress::redirect_policy()`——`github.com` 资产会 302 到
///   `objects.githubusercontent.com`，首跳放行不代表跳转链放行，必须逐跳复检；
/// - 每次请求先过 `EgressPolicy::decide`（`source = "host"`）：L2 内置声明覆盖
///   api / 资产 / codeload 四个域名，其余目标按三档策略走（未声明即 NeedConsent，
///   无人应答则 fail-closed）。
fn github_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(crate::egress::redirect_policy())
        .build()
        .map_err(|e| crate::AppError::Internal(format!("HTTP client build failed: {e}")))
}

/// egress 裁决（宿主内置更新链路；拒绝即 fail-visible，不降级继续发请求）
fn gate_update_url(url: &str) -> Result<()> {
    use crate::egress::EgressDecision;
    match crate::egress::policy().decide(url, "host") {
        EgressDecision::Allow(_) => Ok(()),
        EgressDecision::Deny(e) => Err(crate::AppError::Egress(format!("{}: {}", e.code, e.url))),
        EgressDecision::NeedConsent(req) => {
            // 更新链路是宿主内置行为，没有弹窗渠道：未声明目标一律拒绝
            Err(crate::AppError::Egress(format!(
                "{}: {url}（host-initiated update flow cannot prompt for consent）",
                crate::egress::ERROR_URL_DENIED
            )))
        }
    }
}

async fn fetch_text(client: &reqwest::Client, url: &str, what: &str) -> Result<String> {
    gate_update_url(url)?;
    let resp = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| crate::AppError::Internal(format!("{what}: request failed: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let hint = if status.as_u16() == 403 || status.as_u16() == 429 {
            " (GitHub API rate limit likely reached; retry later)"
        } else {
            ""
        };
        return Err(crate::AppError::Internal(format!("{what}: HTTP {status}{hint}")));
    }
    resp.text()
        .await
        .map_err(|e| crate::AppError::Internal(format!("{what}: read body failed: {e}")))
}

async fn download_zip_verified(
    client: &reqwest::Client,
    url: &str,
    dest: PathBuf,
    expected_sha256: &str,
) -> Result<PathBuf> {
    gate_update_url(url)?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| crate::AppError::Internal(format!("download update: request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(crate::AppError::Internal(format!(
            "download update: HTTP {} for {url}",
            resp.status()
        )));
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| crate::AppError::Internal(format!("download update: create temp dir failed: {e}")))?;
    }
    let mut hasher = sha2::Sha256::new();
    let mut file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| crate::AppError::Internal(format!("download update: create file failed: {e}")))?;
    let mut stream = resp;
    loop {
        let chunk = stream
            .chunk()
            .await
            .map_err(|e| crate::AppError::Internal(format!("download update: stream failed: {e}")));
        let chunk = match chunk {
            Ok(Some(c)) if c.is_empty() => continue,
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                let _ = tokio::fs::remove_file(&dest).await;
                return Err(e);
            }
        };
        hasher.update(&chunk);
        if let Err(e) = file.write_all(&chunk).await {
            let _ = tokio::fs::remove_file(&dest).await;
            return Err(crate::AppError::Internal(format!(
                "download update: write file failed: {e}"
            )));
        }
    }
    // 落盘完成再复算摘要：flush 失败按 IO 错误报（不把半截文件当成功）
    file.flush()
        .await
        .map_err(|e| crate::AppError::Internal(format!("download update: flush file failed: {e}")))?;
    drop(file);
    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        let _ = tokio::fs::remove_file(&dest).await;
        return Err(crate::AppError::Plugin(format!(
            "Downloaded update zip sha256 mismatch: expected {expected_sha256}, got {actual}; file removed"
        )));
    }
    Ok(dest)
}

/// 取最新 Release + 元数据（两条检查命令共用的取数段）
async fn fetch_update_info(
    source: &AppUpdateSource,
    plugin_id: &str,
    current_version: &str,
) -> Result<(AppUpdateInfo, Option<CompatInfo>)> {
    let client = github_client()?;
    let body = fetch_text(&client, &source.releases_api_url(), "check app update").await?;
    let releases: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| crate::AppError::Internal(format!("check app update: bad JSON: {e}")))?;
    let picked = pick_latest_release(&releases, source)?;
    let version = picked.version.to_string();
    let meta_asset = asset_named(&picked.assets, &source.metadata_asset_name(END, &version))?;
    let meta_body = fetch_text(&client, &meta_asset.url, "check app update").await?;
    let meta: serde_json::Value = serde_json::from_str(&meta_body)
        .map_err(|e| crate::AppError::Internal(format!("check app update: bad metadata JSON: {e}")))?;
    let (zip_asset, sha256, bytes, compat) = validate_release_metadata(&meta, plugin_id, END, &version, source)?;
    let compat_reason = evaluate_compat(compat.as_ref());
    let info = AppUpdateInfo {
        plugin_id: plugin_id.to_string(),
        current_version: current_version.to_string(),
        latest_version: version,
        tag: picked.tag,
        zip_asset,
        sha256,
        bytes,
        compat: compat.clone(),
        compatible: compat_reason.is_none(),
        compat_reason,
    };
    Ok((info, compat))
}

/// 兼容裁决（移动端只有宿主运行时轴；mountContract 是桌面挂载契约，移动不解释）
fn evaluate_compat(compat: Option<&CompatInfo>) -> Option<AppUpdateReason> {
    let Some(compat) = compat else {
        return Some(AppUpdateReason {
            key: "shell.apps.update.reason.noCompat".to_string(),
            params: None,
        });
    };
    let host_version = env!("CARGO_PKG_VERSION");
    let (Some(required), Some(current)) = (parse_version(&compat.host_runtime), parse_version(host_version)) else {
        return Some(AppUpdateReason {
            key: "shell.apps.update.reason.hostRuntimeInvalid".to_string(),
            params: Some(serde_json::json!({
                "required": compat.host_runtime,
                "current": host_version,
            })),
        });
    };
    if required > current {
        return Some(AppUpdateReason {
            key: "shell.apps.update.reason.hostRuntime".to_string(),
            params: Some(serde_json::json!({
                "required": compat.host_runtime,
                "current": host_version,
            })),
        });
    }
    None
}

/// 检查指定应用的最新 Release（宿主前端凭证；应用管理页）
#[tauri::command]
pub async fn plugin_check_app_update(
    webview: tauri::Webview,
    plugin_id: String,
    credential: String,
    channel: State<'_, Arc<FrontendChannelRegistry>>,
    manager: State<'_, Arc<PluginManager>>,
) -> Result<AppUpdateInfo> {
    require_host_surface(&channel, webview.label(), "plugin_check_app_update", &credential)?;
    let plugin = manager
        .get_info(&plugin_id)
        .await
        .ok_or_else(|| crate::AppError::Plugin(format!("Plugin not found: {plugin_id}")))?;
    let source = update_source_of(&plugin)?;
    let (info, _) = fetch_update_info(&source, &plugin.id, &plugin.version).await?;
    Ok(info)
}

/// 检查**本插件**的更新（插件通道令牌；应用设置页 SDK 默认实现）
#[tauri::command]
pub async fn plugin_check_self_update(
    webview: tauri::Webview,
    credential: String,
    channel: State<'_, Arc<FrontendChannelRegistry>>,
    manager: State<'_, Arc<PluginManager>>,
) -> Result<AppUpdateCheckResult> {
    let plugin_id =
        match channel.resolve(webview.label(), &credential) {
            Some(ChannelIdentity::Plugin(id)) => id,
            Some(ChannelIdentity::Host) => return Err(crate::AppError::Plugin(
                "plugin_check_self_update requires a plugin channel token; the host must request a target explicitly"
                    .to_string(),
            )),
            None => {
                return Err(crate::AppError::Plugin(
                    "Missing or invalid channel credential for plugin self update check".to_string(),
                ))
            }
        };
    let plugin = manager
        .get_info(&plugin_id)
        .await
        .ok_or_else(|| crate::AppError::Plugin(format!("Plugin not found: {plugin_id}")))?;
    let source = update_source_of(&plugin)?;
    let (info, compat) = fetch_update_info(&source, &plugin.id, &plugin.version).await?;

    let current = parse_version(&info.current_version);
    let latest = parse_version(&info.latest_version);
    if let (Some(current), Some(latest)) = (current.as_ref(), latest.as_ref()) {
        if latest <= current {
            return Ok(AppUpdateCheckResult {
                status: "up-to-date".to_string(),
                latest_version: Some(info.latest_version),
                current_version: Some(info.current_version),
                reason: None,
            });
        }
    }
    if let Some(reason) = evaluate_compat(compat.as_ref()) {
        return Ok(AppUpdateCheckResult {
            status: "incompatible".to_string(),
            latest_version: Some(info.latest_version),
            current_version: Some(info.current_version),
            reason: Some(reason),
        });
    }
    Ok(AppUpdateCheckResult {
        status: "available".to_string(),
        latest_version: Some(info.latest_version),
        current_version: Some(info.current_version),
        reason: None,
    })
}

/// 下载指定应用的更新包到临时文件（宿主前端凭证；安装走 `plugin_install_from_file`）
#[tauri::command]
pub async fn plugin_download_update(
    webview: tauri::Webview,
    plugin_id: String,
    tag: String,
    zip_asset: String,
    sha256: String,
    credential: String,
    channel: State<'_, Arc<FrontendChannelRegistry>>,
    manager: State<'_, Arc<PluginManager>>,
) -> Result<String> {
    require_host_surface(&channel, webview.label(), "plugin_download_update", &credential)?;
    let plugin = manager
        .get_info(&plugin_id)
        .await
        .ok_or_else(|| crate::AppError::Plugin(format!("Plugin not found: {plugin_id}")))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn compat(host_runtime: &str) -> CompatInfo {
        CompatInfo {
            host_runtime: host_runtime.to_string(),
            mount_contract: "1".to_string(),
            sdk_version: "0.0.1".to_string(),
            wit_version: "0.0.2".to_string(),
        }
    }

    #[test]
    fn compat_missing_is_incompatible() {
        let reason = evaluate_compat(None).expect("缺 compat 段必须拒绝");
        assert!(reason.key.ends_with("noCompat"));
    }

    #[test]
    fn compat_newer_host_runtime_is_incompatible() {
        let reason = evaluate_compat(Some(&compat("9.9.9"))).expect("要求更高宿主必须拒绝");
        assert!(reason.key.ends_with("hostRuntime"));
        let params = reason.params.expect("必须携带 required / current");
        assert_eq!(params["required"], "9.9.9");
    }

    #[test]
    fn compat_invalid_version_is_incompatible() {
        let reason = evaluate_compat(Some(&compat("not-semver"))).expect("非法版本必须拒绝");
        assert!(reason.key.ends_with("hostRuntimeInvalid"));
    }

    #[test]
    fn compat_equal_or_older_is_accepted() {
        assert!(evaluate_compat(Some(&compat(env!("CARGO_PKG_VERSION")))).is_none());
        assert!(evaluate_compat(Some(&compat("0.0.1"))).is_none());
    }
}
