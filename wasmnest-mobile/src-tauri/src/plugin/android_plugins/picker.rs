//! SAF 目录/文件选择（SafPickerPlugin + SafTransferPlugin）
//!
//! 从 android_plugins.rs 拆分。

use std::sync::OnceLock;
use tauri::plugin::{Builder, PluginHandle};

/// 已注册的 SafPickerPlugin 句柄（仅 Android 平台使用）
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
static SAF_PICKER_HANDLE: OnceLock<PluginHandle<tauri::Wry>> = OnceLock::new();

/// 已注册的 SafTransferPlugin 句柄（仅 Android 平台使用）
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(super) static SAF_TRANSFER_HANDLE: OnceLock<PluginHandle<tauri::Wry>> = OnceLock::new();

/// 注册 SafPickerPlugin（SAF 文件/目录选择器，免存储权限）
///
/// gen/android 重建恢复清单：SafPickerPlugin.kt 须恢复
pub fn saf_picker_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    Builder::new("saf-picker")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.wasmnest.mobile", "SafPickerPlugin")?;
                let _ = SAF_PICKER_HANDLE.set(handle);
            }
            #[cfg(not(target_os = "android"))] // 非 Android 平台消除 unused 警告
            let _ = api;
            Ok(())
        })
        .build()
}

/// 注册 SafTransferPlugin（SAF 存储传输后端：目录树遍历 / 中转复制 / 授权检测）
///
/// 对应宿主 Rust SafIo trait（saf_io.rs）的 Kotlin 实现，转发经本文件
/// saf_* 函数（run_mobile_plugin_async 模式）。
/// gen/android 重建恢复清单：SafTransferPlugin.kt 须恢复
pub fn saf_transfer_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    Builder::new("saf-transfer")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.wasmnest.mobile", "SafTransferPlugin")?;
                let _ = SAF_TRANSFER_HANDLE.set(handle);
            }
            #[cfg(not(target_os = "android"))] // 非 Android 平台消除 unused 警告
            let _ = api;
            Ok(())
        })
        .build()
}

/// 弹系统目录树选择器，返回真实路径（用户取消返回 None）
///
/// Kotlin 侧只提取 SAF Uri 元数据，真实路径由 saf_path::resolve_saf_path 解析
/// （主存储/SD 卡/downloads raw: 支持；解析失败返回明确错误供插件降级手动输入）。
#[cfg(target_os = "android")]
pub async fn pick_directory_android() -> crate::Result<Option<String>> {
    let handle = SAF_PICKER_HANDLE
        .get()
        .ok_or_else(|| crate::AppError::Plugin("SafPickerPlugin not registered".to_string()))?;
    let response: serde_json::Value = handle
        .run_mobile_plugin_async("pickDirectory", serde_json::json!({}))
        .await
        .map_err(|e| crate::AppError::Plugin(format!("Failed to invoke pickDirectory: {}", e)))?;
    saf_response_to_path(&response, "directory")
}

/// SAF 文件选择原始元数据（content URI 读授权凭据 + 展示名 + `_data` 直读路径）
///
/// 一次多选返回多项（`pick_files_android_meta`）；上传方向须保留 content URI：
/// 分区存储下 `_data` 直读路径（/storage/emulated/0/...）经 std::fs::open 会
/// EACCES（真机实证），而 content URI 持持久化读授权，可经 ContentResolver
/// （SafIo 中转复制/流直传）读取。
#[derive(Debug)]
pub struct PickedFileMeta {
    /// SAF content URI（`takePersistableUriPermission` 已取；读内容须经 ContentResolver）
    pub uri: String,
    /// 原始文件名（OpenableColumns.DISPLAY_NAME；可能为空）
    pub display_name: String,
    /// `_data` 列直读路径（Downloads/Media 等 provider 提供；分区存储下可能不可读）
    pub data_path: String,
}

/// 弹系统文件选择器（支持多选），返回全部选中项的 SAF 原始元数据
///
/// 不再在 Kotlin 侧解析真实路径——解析结果（`_data` / externalstorage raw:）
/// 在分区存储下不可直读，交由调用方按「可读路径优先、否则 SAF 中转」兜底。
/// 用户取消返回空数组。
#[cfg(target_os = "android")]
pub async fn pick_files_android_meta() -> crate::Result<Vec<PickedFileMeta>> {
    let handle = SAF_PICKER_HANDLE
        .get()
        .ok_or_else(|| crate::AppError::Plugin("SafPickerPlugin not registered".to_string()))?;
    let response: serde_json::Value = handle
        .run_mobile_plugin_async("pickFile", serde_json::json!({}))
        .await
        .map_err(|e| crate::AppError::Plugin(format!("Failed to invoke pickFile: {}", e)))?;
    parse_picked_files(&response)
}

/// 解析 Kotlin `pickFile` 响应：取消 → 空数组；成功 → `files[]` 全量元数据。
///
/// 缺 `files` 数组或任一条目缺 uri 一律显性报错：静默丢一个用户选中的文件
/// 比整次失败更难排查。纯函数，跨平台单测覆盖。
#[cfg(any(target_os = "android", test))]
fn parse_picked_files(response: &serde_json::Value) -> crate::Result<Vec<PickedFileMeta>> {
    if response.get("cancelled").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(Vec::new());
    }
    let Some(files) = response.get("files").and_then(|v| v.as_array()) else {
        return Err(crate::AppError::Plugin(
            "pickFile response missing files array".to_string(),
        ));
    };
    let mut metas = Vec::with_capacity(files.len());
    for (index, file) in files.iter().enumerate() {
        let uri = file.get("uri").and_then(|v| v.as_str()).unwrap_or("");
        if uri.is_empty() {
            return Err(crate::AppError::Plugin(format!(
                "pickFile response files[{index}] missing uri"
            )));
        }
        metas.push(PickedFileMeta {
            uri: uri.to_string(),
            display_name: file
                .get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            data_path: file.get("dataPath").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        });
    }
    Ok(metas)
}

/// 非 Android 平台 SAF 选择器不可用（iOS 走系统文档选择器，另行实现）
#[cfg(not(target_os = "android"))]
pub async fn pick_directory_android() -> crate::Result<Option<String>> {
    Err(crate::AppError::Plugin(
        "SAF picker unavailable on this platform".to_string(),
    ))
}

#[cfg(not(target_os = "android"))]
pub async fn pick_files_android_meta() -> crate::Result<Vec<PickedFileMeta>> {
    Err(crate::AppError::Plugin(
        "SAF picker unavailable on this platform".to_string(),
    ))
}

/// 把 Kotlin SAF 选择结果（authority/documentId/primaryDir）解析为真实路径
///
/// 用户取消（cancelled=true）返回 Ok(None)；不支持的 provider 返回明确错误。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn saf_response_to_path(response: &serde_json::Value, kind: &str) -> crate::Result<Option<String>> {
    if response.get("cancelled").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(None);
    }
    let authority = response.get("authority").and_then(|v| v.as_str()).unwrap_or("");
    let document_id = response.get("documentId").and_then(|v| v.as_str()).unwrap_or("");
    let primary_dir = response
        .get("primaryDir")
        .and_then(|v| v.as_str())
        .unwrap_or("/storage/emulated/0");
    let path = crate::plugin::saf_path::resolve_saf_path(authority, document_id, primary_dir).ok_or_else(|| {
        crate::AppError::Plugin(format!(
            "SAF {} not resolvable to a real path (authority={}, documentId={}); fall back to manual path input",
            kind, authority, document_id
        ))
    })?;
    Ok(Some(path))
}

/// 弹系统目录树选择器，返回 SAF 树元数据（共享目录条目用，不做真实路径解析）
///
/// 共享目录条目存储 content://tree URI + documentId + 展示名（spec：
/// 共享目录 = SAF URI 存储）；真实路径解析仅旧选路需要，SAF 化后废除。
/// 用户取消返回 Ok(None)；持久化授权由 Kotlin 侧 takePersistableUriPermission
/// 完成（重启仍有效）。
#[cfg(target_os = "android")]
pub async fn pick_shared_directory_android() -> crate::Result<Option<(String, String, String)>> {
    let handle = SAF_PICKER_HANDLE
        .get()
        .ok_or_else(|| crate::AppError::Plugin("SafPickerPlugin not registered".to_string()))?;
    let response: serde_json::Value = handle
        .run_mobile_plugin_async("pickDirectory", serde_json::json!({}))
        .await
        .map_err(|e| crate::AppError::Plugin(format!("Failed to invoke pickDirectory: {}", e)))?;
    if response.get("cancelled").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(None);
    }
    let uri = response.get("uri").and_then(|v| v.as_str()).unwrap_or("");
    let document_id = response.get("documentId").and_then(|v| v.as_str()).unwrap_or("");
    let display_name = response.get("displayName").and_then(|v| v.as_str()).unwrap_or("");
    if uri.is_empty() || document_id.is_empty() {
        return Err(crate::AppError::Plugin(format!(
            "pickDirectory returned incomplete SAF metadata (uri={}, documentId={})",
            uri, document_id
        )));
    }
    Ok(Some((
        uri.to_string(),
        document_id.to_string(),
        display_name.to_string(),
    )))
}

/// 非 Android 平台无 SAF 目录树选择器（共享目录功能仅 Android 可用）
#[cfg(not(target_os = "android"))]
pub async fn pick_shared_directory_android() -> crate::Result<Option<(String, String, String)>> {
    Err(crate::AppError::Plugin(
        "SAF directory picker unavailable on this platform".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::parse_picked_files;
    use serde_json::json;

    /// 多选：files[] 全部保留，顺序与选择一致
    #[test]
    fn parse_picked_files_keeps_every_selected_item() {
        let response = json!({
            "files": [
                { "uri": "content://p/a.txt", "displayName": "a.txt", "dataPath": "/sdcard/a.txt" },
                { "uri": "content://p/b.bin", "displayName": "b.bin", "dataPath": "" }
            ]
        });
        let metas = parse_picked_files(&response).expect("multi payload");
        assert_eq!(metas.len(), 2);
        assert_eq!(metas[0].uri, "content://p/a.txt");
        assert_eq!(metas[0].display_name, "a.txt");
        assert_eq!(metas[0].data_path, "/sdcard/a.txt");
        assert_eq!(metas[1].uri, "content://p/b.bin");
        assert_eq!(metas[1].data_path, "");
    }

    /// 取消：空结果（不是错误）
    #[test]
    fn parse_picked_files_treats_cancel_as_empty() {
        let metas = parse_picked_files(&json!({ "cancelled": true })).expect("cancel");
        assert!(metas.is_empty());
    }

    /// 缺 files 载荷：显性报错而非静默返回空（空会让调用方误判为用户取消）
    #[test]
    fn parse_picked_files_rejects_missing_files_payload() {
        let err = parse_picked_files(&json!({})).expect_err("missing files must fail");
        assert!(err.to_string().contains("files array"), "got: {err}");
    }

    /// 任一条目缺 uri：整次失败并点名下标（不静默丢用户选中的文件）
    #[test]
    fn parse_picked_files_rejects_item_without_uri() {
        let response = json!({
            "files": [
                { "uri": "content://p/a.txt" },
                { "displayName": "broken" }
            ]
        });
        let err = parse_picked_files(&response).expect_err("missing uri must fail");
        assert!(err.to_string().contains("files[1]"), "got: {err}");
    }

    /// 可选字段缺失按空串归一（displayName/dataPath 在部分 provider 上可能没有）
    #[test]
    fn parse_picked_files_defaults_optional_fields() {
        let metas = parse_picked_files(&json!({
            "files": [{ "uri": "content://p/x" }]
        }))
        .expect("minimal payload");
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].display_name, "");
        assert_eq!(metas[0].data_path, "");
    }
}
