//! 外部应用包安装的选取与识别（宿主面 · desktop-only）
//!
//! 「安装外部 wasm 应用」的前半程：用户经原生文件对话框选定 zip 应用包后，在
//! Rust 侧立刻识别包内 `plugin.json` 的应用 id（`PluginDownloader::peek_plugin_id`），
//! 一次性返回 `{ path, pluginId }`。合成一条命令而非「前端传任意路径来识别」：
//! 文件选择的发起权留在 Rust（能力面口径，同 `platform_picker.rs`），识别对象
//! 天然限定为「用户刚选中的那个包」，前端不经手任意路径读取面。
//!
//! 安装本体不在这里：`plugin_install_from_file`（wasm-core api_bridge）带宿主面
//! 凭证门。前端拿到识别结果后按注册表现状裁决：新 id 直接安装；同 id 已装且
//! 可升级（user-installed、未运行）经壳确认弹窗走 `upgrade = true` 的就地升级
//! （升级保数据，安装清数据，两条语义不混用——宿主 install.rs 头注释）。
//!
//! 门控口径：desktop 本地命令臂（同 `plugin/lifecycle.rs` 六臂）不带凭证门——
//! 本命令只开一个对话框、读用户刚选的包，并查询该 id 是否留有旧数据（只读判定）；
//! 有安全边界的安装 / 卸载仍在 api_bridge 凭证门内。

use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use wasmnest_wasm_core::manager::host::PluginHost;

/// 一次成功的应用包选取（zip 路径 + 包内清单识别出的应用 id）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedPackage {
    /// zip 包绝对路径（原样回传给 `plugin_install_from_file` 的 `path` 参数）
    pub path: String,
    /// 包内 `plugin.json` 的 `id`（反向域名；壳据此查注册表现状决定 安装 / 升级 / 拒绝）
    pub plugin_id: String,
    /// 该 id 是否留有可恢复的旧数据（keep-data 卸载的私有库 / 主库 KV）
    ///
    /// 仅 fresh install 消费：壳据此提示“是否恢复旧应用数据”，默认不恢复。
    /// 已安装同 id 走升级链路（升级恒保数据），该字段不参与裁决。
    pub has_retained_data: bool,
}

/// 打开原生文件对话框选一个 zip 应用包，识别其应用 id 后一并返回
///
/// 用户取消返回 `Ok(None)`（与「包损坏」可区分——后者 fail-visible 报错，
/// 不静默当成取消）。
#[tauri::command]
pub async fn plugin_pick_app_package(
    app_handle: tauri::AppHandle,
    plugin_host: State<'_, Arc<PluginHost>>,
) -> crate::Result<Option<PickedPackage>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app_handle
        .dialog()
        .file()
        .add_filter("zip", &["zip"])
        .pick_file(move |selection| {
            if tx.send(selection).is_err() {
                tracing::debug!("plugin_pick_app_package: receiver dropped before dialog completed");
            }
        });
    let selection = rx
        .await
        .map_err(|e| crate::AppError::Plugin(format!("plugin_pick_app_package: dialog channel closed: {e}")))?;
    let Some(file_path) = selection else {
        return Ok(None); // 用户取消选择（与「被拒」可区分：None，不回错误）
    };
    let path = super::platform_picker::path_to_string(file_path)?;
    let plugin_id =
        wasmnest_wasm_core::manager::downloader::PluginDownloader::peek_plugin_id(std::path::Path::new(&path))?;
    let has_retained_data = plugin_host.has_retained_data(&plugin_id).await?;
    tracing::info!(path = %path, plugin_id = %plugin_id, has_retained_data, "[API] plugin_pick_app_package");
    Ok(Some(PickedPackage {
        path,
        plugin_id,
        has_retained_data,
    }))
}
