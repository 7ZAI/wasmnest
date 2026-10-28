//! 插件应用更新检查 / 下载（应用版本更新全链路，桌面端）
//!
//! 数据源 = 应用仓 GitHub Release（`7ZAI/wasmnest-apps`，tag `<slug>-v<X.Y.Z>`，
//! 资产 `<slug>-desktop-v<X.Y.Z>.zip` + 同名 `.json` 元数据）。元数据 `compat` 段
//! 携带构建时的宿主兼容声明（应用仓 `scripts/lib/host-compat.mjs` 盖章），**兼容
//! 判断在前端**（它持有 `MOUNT_CONTRACT` 与宿主自身版本，见
//! `shell/composables/useAppUpdates.ts`）——本模块只负责取数、校验身份与完整性、
//! 下载，不做兼容裁决。
//!
//! 职责边界：
//! - `plugin_check_app_update`：GitHub 查该应用最新 Release → 下载元数据 JSON →
//!   校验（schema / plugin.id / end / 版本一致 / sha256 形态）→ 返回比对所需字段。
//!   元数据缺 `compat` 段不报错（返回 `compat: null`）——「缺声明 = 不兼容」的
//!   裁决归前端，本层不吞信息也不替前端下结论。
//! - `plugin_download_update`：只接受**本模块可自证**的参数（tag / 资产名 / 摘要），
//!   URL 一律由 Rust 侧拼接（`releases/download/<tag>/<资产名>`），前端传不进任意
//!   URL；流式落临时文件并复算 sha256，不符即删文件报错。
//! - 安装不在本模块：前端持返回路径调既有 `plugin_install_from_file`（升级模式，
//!   wasm-core 宿主面凭证门 + 升级前置裁决在那里）。
//!
//! 两条命令都过宿主面凭证门（`frontend_channel::require_host_identity`，与
//! api_bridge 的管理命令同判据——插件面令牌不得驱动应用更新）。
//! GitHub API 匿名限流 60 次/h/IP：手动检查频率下可接受，限流响应显性报错。

use crate::{AppError, Result};
use serde::Serialize;
use sha2::Digest;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use wasmnest_wasm_core::manager::host::PluginHost;

/// 应用仓 Release 列表 API（匿名可读；限流 60 次/h/IP）
const APPS_RELEASES_API: &str = "https://api.github.com/repos/7ZAI/wasmnest-apps/releases?per_page=100";
/// 应用仓 Release 资产下载基址（下载 URL 只从这里拼，前端传不进任意地址）
const APPS_RELEASE_DOWNLOAD_BASE: &str = "https://github.com/7ZAI/wasmnest-apps/releases/download";
/// 应用插件 id 家族前缀（ADR 0056；`com.wasmnest.<slug>` ↔ Release tag `<slug>-v*`）
const PLUGIN_ID_PREFIX: &str = "com.wasmnest.";
const USER_AGENT: &str = concat!("wasmnest-desktop/", env!("CARGO_PKG_VERSION"));

// ==================== 返回形状（camelCase 对齐前端） ====================

/// 元数据 `compat` 段（应用仓 host-runtime.lock.json 的构建时盖章）
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompatInfo {
    pub host_runtime: String,
    pub mount_contract: String,
    pub sdk_version: String,
    pub wit_version: String,
}

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

// ==================== 纯函数（单测钉行为） ====================

/// 插件 id → 应用 slug（`com.wasmnest.<slug>`；非本家族 id 无更新源 → None）
pub fn slug_of_plugin_id(plugin_id: &str) -> Option<&str> {
    plugin_id.strip_prefix(PLUGIN_ID_PREFIX).filter(|s| !s.is_empty())
}

/// Release tag → 语义化版本（`{slug}-v<X.Y.Z>` 严格形态；其余 None）
pub fn parse_release_tag(tag: &str, slug: &str) -> Option<semver::Version> {
    let version = tag.strip_prefix(slug)?.strip_prefix("-v")?;
    semver::Version::parse(version).ok()
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// zip 资产名（发布链 `build-app.mjs` 的 `<slug>-<end>-v<version>` 命名）
fn zip_asset_name(slug: &str, version: &str) -> String {
    format!("{slug}-desktop-v{version}.zip")
}

fn metadata_asset_name(slug: &str, version: &str) -> String {
    format!("{slug}-desktop-v{version}.json")
}

#[derive(Debug)]
struct ReleaseAsset {
    name: String,
    url: String,
    size: u64,
}

#[derive(Debug)]
struct PickedRelease {
    tag: String,
    version: semver::Version,
    assets: Vec<ReleaseAsset>,
}

/// 从 GitHub `/releases` 响应挑该 slug 的最新正式 Release
///
/// 跳过 draft / prerelease；同 slug 多版本取语义化版本最大者。没有任何命中 →
/// 显性错误（点名 slug，不返回空）。
fn pick_latest_release(releases: &serde_json::Value, slug: &str) -> Result<PickedRelease> {
    let arr = releases
        .as_array()
        .ok_or_else(|| AppError::Internal("GitHub releases response is not an array".to_string()))?;
    let mut best: Option<(semver::Version, String, Vec<ReleaseAsset>)> = None;
    for release in arr {
        let obj = match release.as_object() {
            Some(o) => o,
            None => continue,
        };
        if obj.get("draft").and_then(serde_json::Value::as_bool) == Some(true)
            || obj.get("prerelease").and_then(serde_json::Value::as_bool) == Some(true)
        {
            continue;
        }
        let tag = obj
            .get("tag_name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let Some(version) = parse_release_tag(tag, slug) else {
            continue;
        };
        if best.as_ref().is_some_and(|(v, _, _)| *v >= version) {
            continue;
        }
        let assets = obj
            .get("assets")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|a| {
                        let name = a.get("name")?.as_str()?.to_string();
                        let url = a.get("browser_download_url")?.as_str()?.to_string();
                        let size = a.get("size").and_then(serde_json::Value::as_u64).unwrap_or(0);
                        Some(ReleaseAsset { name, url, size })
                    })
                    .collect()
            })
            .unwrap_or_default();
        best = Some((version, tag.to_string(), assets));
    }
    let (version, tag, assets) = best.ok_or_else(|| {
        AppError::Plugin(format!(
            "No release found for app '{slug}' in 7ZAI/wasmnest-apps (tag form '<slug>-v<X.Y.Z>')"
        ))
    })?;
    Ok(PickedRelease { tag, version, assets })
}

fn asset_named<'a>(assets: &'a [ReleaseAsset], name: &str) -> Result<&'a ReleaseAsset> {
    assets.iter().find(|a| a.name == name).ok_or_else(|| {
        AppError::Plugin(format!(
            "Release is missing asset '{name}' (dist incomplete; re-publish the app release)"
        ))
    })
}

/// 元数据 JSON 校验 + 字段提取（身份 / 完整性裁决都在这里，命令层不重复实现）
///
/// 校验口径（任一不过 = 显性错误，点名期望与实际）：
/// - `schema == 1`；`plugin.id == 目标插件 id`；`end == "desktop"`
/// - `plugin.version == tag 解析出的版本`（tag 与包内容不一致 = 发布链被破坏）
/// - `artifact.file == 期望 zip 资产名`；`artifact.sha256` 为 64 位 hex
/// - `compat` 段**缺省合法**（旧发布物）：返回 None，由前端判不兼容
fn validate_release_metadata(
    meta: &serde_json::Value,
    plugin_id: &str,
    expected_version: &str,
) -> Result<(String, String, u64, Option<CompatInfo>)> {
    let obj = meta
        .as_object()
        .ok_or_else(|| AppError::Plugin("Release metadata is not a JSON object".to_string()))?;
    let get_str = |key: &str| -> Result<&str> {
        obj.get(key)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| AppError::Plugin(format!("Release metadata missing field '{key}'")))
    };
    if obj.get("schema").and_then(serde_json::Value::as_i64) != Some(1) {
        return Err(AppError::Plugin(format!(
            "Release metadata schema {:?} is not supported (expected 1)",
            obj.get("schema")
        )));
    }
    let (Some(plugin), Some(artifact)) = (
        obj.get("plugin").and_then(serde_json::Value::as_object),
        obj.get("artifact").and_then(serde_json::Value::as_object),
    ) else {
        return Err(AppError::Plugin(
            "Release metadata missing 'plugin' or 'artifact' section".to_string(),
        ));
    };
    let meta_id = plugin
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| AppError::Plugin("Release metadata missing 'plugin.id'".to_string()))?;
    if meta_id != plugin_id {
        return Err(AppError::Plugin(format!(
            "Release metadata plugin.id '{meta_id}' does not match requested '{plugin_id}'"
        )));
    }
    if get_str("end")? != "desktop" {
        return Err(AppError::Plugin(format!(
            "Release metadata end '{}' is not 'desktop'",
            get_str("end")?
        )));
    }
    let meta_version = plugin
        .get("version")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| AppError::Plugin("Release metadata missing 'plugin.version'".to_string()))?;
    if meta_version != expected_version {
        return Err(AppError::Plugin(format!(
            "Release metadata version '{meta_version}' does not match release tag version '{expected_version}'"
        )));
    }
    let expect_zip = zip_asset_name(
        plugin_id.strip_prefix(PLUGIN_ID_PREFIX).unwrap_or(plugin_id),
        expected_version,
    );
    let artifact_file = artifact
        .get("file")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| AppError::Plugin("Release metadata missing 'artifact.file'".to_string()))?;
    if artifact_file != expect_zip {
        return Err(AppError::Plugin(format!(
            "Release metadata artifact.file '{artifact_file}' does not match expected '{expect_zip}'"
        )));
    }
    let sha256 = artifact
        .get("sha256")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| AppError::Plugin("Release metadata missing 'artifact.sha256'".to_string()))?;
    if !is_hex64(sha256) {
        return Err(AppError::Plugin(format!(
            "Release metadata artifact.sha256 is not a 64-hex digest: '{sha256}'"
        )));
    }
    let bytes = artifact.get("bytes").and_then(serde_json::Value::as_u64).unwrap_or(0);
    let compat = obj.get("compat").and_then(|c| {
        Some(CompatInfo {
            host_runtime: c.get("hostRuntime")?.as_str()?.to_string(),
            mount_contract: c.get("mountContract")?.as_str()?.to_string(),
            sdk_version: c.get("sdkVersion")?.as_str()?.to_string(),
            wit_version: c.get("witVersion")?.as_str()?.to_string(),
        })
    });
    Ok((expect_zip, sha256.to_string(), bytes, compat))
}

/// 下载命令的参数自证：tag / 资产名 / 摘要必须两两吻合（URL 只由本模块拼接）
fn validate_download_args(slug: &str, tag: &str, zip_asset: &str, sha256: &str) -> Result<(String, String)> {
    let version = parse_release_tag(tag, slug).ok_or_else(|| {
        AppError::InvalidInput(format!(
            "Release tag '{tag}' does not match expected form '{slug}-v<X.Y.Z>'"
        ))
    })?;
    let expect_zip = zip_asset_name(slug, &version.to_string());
    if zip_asset != expect_zip {
        return Err(AppError::InvalidInput(format!(
            "Asset name '{zip_asset}' does not match expected '{expect_zip}'"
        )));
    }
    if !is_hex64(sha256) {
        return Err(AppError::InvalidInput(format!(
            "sha256 is not a 64-hex digest: '{sha256}'"
        )));
    }
    Ok((tag.to_string(), version.to_string()))
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

/// 原生选包对话框（Rust 侧发起：前端不持有 fs 权限，也不传任意路径给命令）
///
/// 「安装应用（本地 zip）」入口的第一步：返回 None = 用户取消。拿到路径后前端
/// 再调 `plugin_install_from_file`（安装 / 升级模式由调用方定），路径来源是原生
/// 对话框而不是前端拼串。
#[tauri::command]
pub async fn plugin_pick_app_zip(app_handle: tauri::AppHandle) -> Result<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app_handle
        .dialog()
        .file()
        .add_filter("Plugin package", &["zip"])
        .pick_file(move |selection| {
            if tx.send(selection).is_err() {
                tracing::debug!("plugin_pick_app_zip: receiver dropped before dialog completed");
            }
        });
    match rx.await {
        Ok(Some(file_path)) => file_path
            .into_path()
            .map(|p| Some(p.to_string_lossy().to_string()))
            .map_err(|e| AppError::InvalidInput(format!("安装包路径转换失败: {e}"))),
        // 用户取消（与失败可区分：None，不回错误）
        Ok(None) => Ok(None),
        Err(e) => Err(AppError::Internal(format!(
            "plugin_pick_app_zip: dialog channel closed: {e}"
        ))),
    }
}

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
    let slug = slug_of_plugin_id(&plugin_id).ok_or_else(|| {
        AppError::InvalidInput(format!(
            "Plugin '{plugin_id}' is not a first-party app ({PLUGIN_ID_PREFIX}<slug>); no update source"
        ))
    })?;
    let current_version = plugin_host
        .list_plugins()
        .await
        .into_iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| AppError::Plugin(format!("Plugin not found: {plugin_id}")))?
        .version;

    let client = github_client()?;
    let body = fetch_text(&client, APPS_RELEASES_API, "check app update").await?;
    let releases: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| AppError::Internal(format!("check app update: bad JSON: {e}")))?;
    let picked = pick_latest_release(&releases, slug)?;
    let version = picked.version.to_string();
    let meta_asset = asset_named(&picked.assets, &metadata_asset_name(slug, &version))?;
    let meta_body = fetch_text(&client, &meta_asset.url, "check app update").await?;
    let meta: serde_json::Value = serde_json::from_str(&meta_body)
        .map_err(|e| AppError::Internal(format!("check app update: bad metadata JSON: {e}")))?;
    let (zip_asset, sha256, bytes, compat) = validate_release_metadata(&meta, &plugin_id, &version)?;

    Ok(AppUpdateInfo {
        plugin_id,
        current_version,
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
    let slug = slug_of_plugin_id(&plugin_id).ok_or_else(|| {
        AppError::InvalidInput(format!(
            "Plugin '{plugin_id}' is not a first-party app ({PLUGIN_ID_PREFIX}<slug>); no update source"
        ))
    })?;
    let (_tag, version) = validate_download_args(slug, &tag, &zip_asset, &sha256)?;
    let url = format!("{APPS_RELEASE_DOWNLOAD_BASE}/{tag}/{zip_asset}");
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
    use serde_json::json;

    #[test]
    fn slug_of_plugin_id_strips_first_party_prefix_only() {
        assert_eq!(slug_of_plugin_id("com.wasmnest.agent-hub"), Some("agent-hub"));
        assert_eq!(slug_of_plugin_id("com.wasmnest.bedcode"), Some("bedcode"));
        assert_eq!(slug_of_plugin_id("com.wasmnest."), None);
        assert_eq!(slug_of_plugin_id("com.other.app"), None);
        assert_eq!(slug_of_plugin_id("wasmnest.app"), None);
    }

    #[test]
    fn parse_release_tag_is_strict() {
        assert_eq!(
            parse_release_tag("agent-hub-v0.0.2", "agent-hub"),
            Some(semver::Version::new(0, 0, 2))
        );
        // 其他应用的同形 tag 不算命中
        assert_eq!(parse_release_tag("bedcode-v0.0.2", "agent-hub"), None);
        // 非法形态
        assert_eq!(parse_release_tag("agent-hub-v1", "agent-hub"), None);
        assert_eq!(parse_release_tag("agent-hub-0.0.2", "agent-hub"), None);
        assert_eq!(parse_release_tag("agent-hub-v0.0.2-rc.1", "agent-hub").is_some(), true);
    }

    fn release(tag: &str, draft: bool, prerelease: bool, assets: &[(&str, u64)]) -> serde_json::Value {
        json!({
            "tag_name": tag,
            "draft": draft,
            "prerelease": prerelease,
            "assets": assets.iter().map(|(n, s)| json!({
                "name": n, "browser_download_url": format!("https://example.com/{n}"), "size": s
            })).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn pick_latest_release_takes_highest_version_and_skips_drafts() {
        let releases = json!([
            release("agent-hub-v0.0.1", false, false, &[]),
            release("bedcode-v9.9.9", false, false, &[]),  // 其他应用不算
            release("agent-hub-v0.0.9", true, false, &[]), // draft 不算
            release("agent-hub-v0.0.8", false, true, &[]), // prerelease 不算
            release(
                "agent-hub-v0.0.3",
                false,
                false,
                &[("agent-hub-desktop-v0.0.3.zip", 123)]
            ),
            release("apps-v1.0.0", false, false, &[]), // 整仓 tag 不算
        ]);
        let picked = pick_latest_release(&releases, "agent-hub").unwrap();
        assert_eq!(picked.tag, "agent-hub-v0.0.3");
        assert_eq!(picked.version, semver::Version::new(0, 0, 3));
        assert_eq!(picked.assets.len(), 1);
        assert_eq!(picked.assets[0].name, "agent-hub-desktop-v0.0.3.zip");
    }

    #[test]
    fn pick_latest_release_names_slug_when_nothing_matches() {
        let releases = json!([release("bedcode-v0.0.1", false, false, &[])]);
        let err = pick_latest_release(&releases, "agent-hub").unwrap_err();
        assert!(err.to_string().contains("agent-hub"), "实际: {err}");
    }

    fn metadata(plugin_id: &str, version: &str, compat: serde_json::Value) -> serde_json::Value {
        let slug = plugin_id.strip_prefix("com.wasmnest.").unwrap();
        json!({
            "schema": 1,
            "app": slug,
            "end": "desktop",
            "plugin": { "id": plugin_id, "name": "X", "version": version, "pluginType": "rust-ts", "rustLibrary": "x" },
            "compat": compat,
            "artifact": { "file": format!("{slug}-desktop-v{version}.zip"), "bytes": 42, "sha256": "a".repeat(64) },
        })
    }

    #[test]
    fn validate_release_metadata_accepts_wellformed_with_compat() {
        let meta = metadata(
            "com.wasmnest.agent-hub",
            "0.0.2",
            json!({ "hostRuntime": "0.0.1", "mountContract": "1", "sdkVersion": "0.0.1", "witVersion": "0.0.1" }),
        );
        let (zip, sha, bytes, compat) = validate_release_metadata(&meta, "com.wasmnest.agent-hub", "0.0.2").unwrap();
        assert_eq!(zip, "agent-hub-desktop-v0.0.2.zip");
        assert_eq!(sha, "a".repeat(64));
        assert_eq!(bytes, 42);
        assert_eq!(
            compat,
            Some(CompatInfo {
                host_runtime: "0.0.1".into(),
                mount_contract: "1".into(),
                sdk_version: "0.0.1".into(),
                wit_version: "0.0.1".into(),
            })
        );
    }

    /// 旧发布物缺 compat 段 → 合法但 compat=None（不兼容裁决归前端，本层不吞信息）
    #[test]
    fn validate_release_metadata_allows_missing_compat_as_none() {
        let meta = metadata("com.wasmnest.agent-hub", "0.0.1", serde_json::Value::Null);
        // 上面 helper 里 compat 显式 null；这里再验一个完全没有 compat 键的形态
        let mut raw = metadata("com.wasmnest.agent-hub", "0.0.1", serde_json::Value::Null);
        raw.as_object_mut().unwrap().remove("compat");
        for meta in [meta, raw] {
            let (_, _, _, compat) = validate_release_metadata(&meta, "com.wasmnest.agent-hub", "0.0.1").unwrap();
            assert_eq!(compat, None);
        }
    }

    #[test]
    fn validate_release_metadata_rejects_identity_and_integrity_drift() {
        let base = metadata(
            "com.wasmnest.agent-hub",
            "0.0.2",
            json!({ "hostRuntime": "0.0.1", "mountContract": "1", "sdkVersion": "0.0.1", "witVersion": "0.0.1" }),
        );
        // id 冒名
        let mut m = base.clone();
        m["plugin"]["id"] = json!("com.wasmnest.bedcode");
        assert!(validate_release_metadata(&m, "com.wasmnest.agent-hub", "0.0.2").is_err());
        // 端不符
        let mut m = base.clone();
        m["end"] = json!("mobile");
        assert!(validate_release_metadata(&m, "com.wasmnest.agent-hub", "0.0.2").is_err());
        // tag 版本与元数据版本不一致
        assert!(validate_release_metadata(&base, "com.wasmnest.agent-hub", "0.0.3").is_err());
        // schema 不支持
        let mut m = base.clone();
        m["schema"] = json!(2);
        assert!(validate_release_metadata(&m, "com.wasmnest.agent-hub", "0.0.2").is_err());
        // 摘要形态
        let mut m = base.clone();
        m["artifact"]["sha256"] = json!("deadbeef");
        assert!(validate_release_metadata(&m, "com.wasmnest.agent-hub", "0.0.2").is_err());
    }

    #[test]
    fn validate_download_args_self_certifies() {
        let (tag, version) = validate_download_args(
            "agent-hub",
            "agent-hub-v0.0.2",
            "agent-hub-desktop-v0.0.2.zip",
            &"a".repeat(64),
        )
        .unwrap();
        assert_eq!(tag, "agent-hub-v0.0.2");
        assert_eq!(version, "0.0.2");
        // 资产名与 tag 不吻合 → 拒（URL 只由 Rust 拼，前端传不进任意值）
        assert!(validate_download_args("agent-hub", "agent-hub-v0.0.2", "evil.zip", &"a".repeat(64)).is_err());
        // 非法 tag → 拒
        assert!(validate_download_args(
            "agent-hub",
            "https://evil.example/x.zip",
            "agent-hub-desktop-v0.0.2.zip",
            &"a".repeat(64)
        )
        .is_err());
        // 摘要形态 → 拒
        assert!(validate_download_args("agent-hub", "agent-hub-v0.0.2", "agent-hub-desktop-v0.0.2.zip", "zz").is_err());
    }
}
