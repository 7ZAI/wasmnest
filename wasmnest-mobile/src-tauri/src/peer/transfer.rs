//! 发送源选择平台缝（Android SAF 多选 → 可读直读 / 中转复制）。
//!
//! 属 `host-platform.pick-files` 的**端差异实现**，不是 peer 引擎适配层：
//! 桌面走系统原生选择器，移动走 SAF + 分区存储兜底。能力 lib 只定义端口
//! （`HostEnginePorts::platform_pick_files`），底层实现留宿主——这正是
//! 「宿主只做 lib 扩展点的差异化实现」的形态。
//!
//! 发送 / 暂停 / 恢复 / 取消 / 收集 / 活跃批投影的委托入口已随 host-peer 脱绑
//! 删除：19 条原语的 `Host` impl 在能力 lib 的 `common-host` 绑定层，直接调
//! crate 域函数，不再经宿主中转（原 `host_domains/peer.rs` + 本文件委托段）。

use tauri::{AppHandle, Manager};

/// 多选上传源：逐个解析「`_data` 可读直读 → 否则 SAF 中转复制」，返回全部路径。
///
/// 任一中转失败即显性报错——静默跳过会少传文件且用户无从察觉；已复制的缓存
/// 残留可经 `SafIo::cleanup_stale_copies` 清扫。用户取消返回空数组。
///
/// 真入口 = host-platform `pick-files`（票 10 起无前端命令面）
pub(crate) async fn peer_pick_files(app_handle: AppHandle) -> crate::Result<Vec<String>> {
    let metas = crate::plugin::android_plugins::pick_files_android_meta().await?;
    let mut paths = Vec::with_capacity(metas.len());
    for meta in metas {
        // 快速路径：`_data` 直读路径可打开（All Files Access 已授权等场景）→ 零复制
        if !meta.data_path.is_empty() && std::fs::File::open(&meta.data_path).is_ok() {
            paths.push(meta.data_path);
            continue;
        }
        // 分区存储兜底：content URI → app 私有 cache 中转复制（保留原始文件名）
        let dest_name = relay_upload_dest_name(&meta.display_name);
        paths.push(relay_copy_upload_source(&app_handle, &meta.uri, &dest_name).await?);
    }
    Ok(paths)
}

async fn relay_copy_upload_source(app: &AppHandle, uri: &str, dest_name: &str) -> crate::Result<String> {
    let saf = app.state::<crate::plugin::saf_io::SafIoState>();
    let handle = saf
        .read_to_cache(uri, dest_name)
        .map_err(|e| crate::AppError::Plugin(format!("upload relay copy start failed: {e}")))?;
    loop {
        let status = saf
            .copy_status(&handle.copy_id)
            .map_err(|e| crate::AppError::Plugin(format!("upload relay copy poll failed: {e}")))?;
        if status.finished {
            if status.cancelled {
                return Err(crate::AppError::Plugin("upload relay copy cancelled".to_string()));
            }
            if let Some(err) = status.error {
                return Err(crate::AppError::Plugin(format!("upload relay copy failed: {err}")));
            }
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    Ok(handle.dest_path)
}

/// 上传源中转副本文件名：保留原始名；空/含路径分隔符兜底为安全名
fn relay_upload_dest_name(display_name: &str) -> String {
    let name: String = display_name
        .chars()
        .map(|c| if c == '/' || c == '\\' { '_' } else { c })
        .collect();
    let name = name.trim().to_string();
    if name.is_empty() || name == "." || name == ".." {
        "upload-file".to_string()
    } else {
        name
    }
}
