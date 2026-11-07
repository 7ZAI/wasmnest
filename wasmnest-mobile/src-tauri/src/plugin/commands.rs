//! Mobile Plugin Commands
//!
//! 暴露插件操作为 Tauri invoke 命令
//!
//! ## 宿主面凭证门（ADR 0058 方案 A，2026-10-24 / issue #21）
//!
//! 管理类命令（plugin_preauthorize / plugin_activate / plugin_deactivate /
//! plugin_approve / plugin_peek_app_package / plugin_download_package /
//! plugin_install_from_file / plugin_uninstall / reload_wasm_plugin + 偏好写面 plugin_set_enabled / plugin_set_autostart +
//! 授权回执 plugin_fs_auth_respond + 终端页面通道登记
//! terminal_page_{subscribe,unsubscribe}）只认宿主前端凭证（loader 会话密钥）：
//! 激活 / 停用 / 安装 / 卸载 / 审批 / 下载 / 热重载 / 偏好写入 / 授权回执 /
//! 通道登记都是宿主职权，凭证判定委托 wasm-core
//! `security::frontend_channel::FrontendChannelRegistry::require_host_identity`
//! （与桌面 lib PluginHost 的 channel 同机制；registry 实例由 lib.rs setup 托管，
//! 命令面独立持有）。
//!
//! ## 插件面身份绑定（ADR 0058 方案 A 续，2026-11-02 / issue #28）
//!
//! 存量缺口收敛：`plugin_invoke` / `plugin_storage_*` 此前**无任何身份绑定**——
//! 移动运行面与宿主壳同 webview，任一应用前端可裸 invoke 驱动他人命令副作用、
//! 跨应用读写私库。现在它们与桌面 `api_bridge` 同口径：
//!
//! 1. **身份**：`plugin_channel_token`（loader 会话 + 运行态 → 通道令牌）签发的令牌
//!    决定调用方身份，`plugin_id` 只作目标；插件令牌只能作用于自己，宿主凭证可作用于
//!    任意目标（`FrontendChannelRegistry::authorize`，fail-closed）；
//! 2. **运行态**：`plugin_storage_*` 还查目标 `is_running`（Activated / Degraded，与
//!    `plugin_invoke` 下游同一道闸）；
//! 3. **能力**：`plugin_storage_*` 再查目标 `storage` 权限（此前移动连这层都没有，
//!    未声明 storage 的应用也能被读写——缺口比桌面宽一层，本次一并补齐）。
//!
//! `plugin_report_ready` / `plugin_mark_error` 是插件自报面（桌面同型命令亦无宿主门）：
//! 走 `authorize` 而非 `require_host_identity`——插件只能自报自己，宿主可代报。
//! 令牌随停用 / 卸载 / 热重载回收（`revoke_plugin`），与桌面 `PluginHost` 一致。
//!
//! **同判据补收的两面（2026-11-02 同一轮）**：`plugin_fs_auth_respond`（授权回执可被
//! 监听事件后自答，等于自批文件访问；桌面早已有门）与 `terminal_page_*`（按 session_id
//! 抢登记他人终端输出通道；插件的合法路径是宿主注入的 `mobileApi.openTerminalStream`，
//! 凭证由宿主层补）。两者都归宿主门。

use crate::plugin::manager::PluginManager;
use crate::plugin::types::MobilePluginInfo;
use crate::Result;
use serde_json::Value;
use std::sync::Arc;
use tauri::Manager;
use wasmnest_wasm_core::security::frontend_channel::FrontendChannelRegistry;

// ==================== Host Surface Credential（ADR 0058 方案 A） ====================

/// 宿主前端 bootstrap：取得本次页面加载的 loader 会话密钥（域内首个调用者生效）
/// （ADR 0058 方案 A：移动宿主面凭证签发；桌面同型命令在 wasm-core api_bridge）
#[tauri::command]
pub async fn plugin_frontend_loader_session(
    webview: tauri::Webview,
    channel: tauri::State<'_, Arc<FrontendChannelRegistry>>,
) -> Result<String> {
    let session = channel.issue_loader_session(webview.label())?;
    tracing::info!(
        webview = %webview.label(),
        "[API] plugin_frontend_loader_session: 宿主面凭证已签发"
    );
    Ok(session)
}

/// 插件前端：为指定插件签发通道令牌（issue #28）
///
/// 与桌面 `api_bridge::plugin_channel_token` 同型：需同窗口 loader 会话密钥 + 插件
/// 处于**运行态**（`Activated` / `Degraded`）——未激活插件没有 granted 集，令牌无意义。
/// 令牌随停用 / 卸载 / 热重载回收；同一窗口内重新签发会作废旧令牌（`issue_token` 覆盖）。
#[tauri::command]
pub async fn plugin_channel_token(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    loader_session: String,
) -> Result<String> {
    let channel = app_handle.state::<Arc<FrontendChannelRegistry>>();
    if !channel.verify_loader_session(webview.label(), &loader_session) {
        tracing::warn!(
            webview = %webview.label(),
            plugin_id = %plugin_id,
            "[API] plugin_channel_token: loader 会话凭证无效"
        );
        return Err(crate::AppError::Plugin(
            "invalid frontend loader session credential".to_string(),
        ));
    }
    let manager = app_handle.state::<Arc<PluginManager>>();
    if !manager.is_running(&plugin_id).await {
        tracing::warn!(plugin_id = %plugin_id, "[API] plugin_channel_token: 插件未运行，拒绝签发");
        return Err(crate::AppError::Plugin(format!(
            "Plugin {} is not running, channel token refused",
            plugin_id
        )));
    }
    let token = channel.issue_token(webview.label(), &loader_session, &plugin_id)?;
    tracing::info!(
        webview = %webview.label(),
        plugin_id = %plugin_id,
        "[API] plugin_channel_token: 插件面令牌已签发"
    );
    Ok(token)
}

/// 宿主面命令门（ADR 0058 方案 A）：管理类命令只认宿主前端凭证
fn require_host_surface(
    channel: &FrontendChannelRegistry,
    webview_label: &str,
    command: &str,
    credential: &str,
    denial: &str,
) -> Result<()> {
    channel
        .require_host_identity(webview_label, credential, command)
        .map_err(|_| crate::AppError::Plugin(denial.to_string()))
}

/// 插件面命令的统一身份校验（issue #28，与桌面 `api_bridge::authorize_plugin_call` 同源）
///
/// 裁决规则在 wasm-core `frontend_channel::authorize`（有单测）：宿主凭证放行任意
/// 目标、插件令牌只能是目标自己、凭证无效 / 跨窗口一律拒绝（fail-closed，绝不落回
/// 「按参数 plugin_id 放行」）。
fn authorize_plugin_call(
    channel: &FrontendChannelRegistry,
    webview_label: &str,
    plugin_id: &str,
    credential: &str,
) -> Result<()> {
    channel.authorize(webview_label, plugin_id, credential)
}

/// 插件存储面的三段校验：身份 → 目标运行态 → 目标 `storage` 权限
///
/// 与桌面 `api_bridge::plugin_storage_*` 同构（身份 → 激活态 → 权限）。第二段取
/// `is_running`（`Activated` / `Degraded`）而非桌面的严格 `is_activated`：与本文件
/// `plugin_invoke` 的下游 `invoke_command` 同一道闸——Degraded 实例是活的、权限集已
/// 授予，存储面不该比命令面更严（否则降级应用的 KV 会突然全线失败）。
/// 第三段是 issue #28 复测补记的缺口：移动此前连「目标是否声明 storage 权限」都不查，
/// 未声明 storage 的应用同样可被读写。
async fn require_storage_access(
    channel: &FrontendChannelRegistry,
    manager: &PluginManager,
    webview_label: &str,
    plugin_id: &str,
    credential: &str,
) -> Result<()> {
    authorize_plugin_call(channel, webview_label, plugin_id, credential)?;
    if !manager.is_running(plugin_id).await {
        return Err(crate::AppError::Plugin(format!("Plugin {} is not running", plugin_id)));
    }
    if !manager.has_permission(plugin_id, "storage").await {
        return Err(crate::AppError::Plugin(format!(
            "Plugin {} has no storage permission",
            plugin_id
        )));
    }
    Ok(())
}

// ==================== Plugin Lifecycle Commands ====================

/// 获取所有已加载插件信息
#[tauri::command]
pub async fn plugin_list_loaded(app_handle: tauri::AppHandle) -> Result<Vec<MobilePluginInfo>> {
    let manager = app_handle.state::<Arc<PluginManager>>();
    Ok(manager.list_loaded().await)
}

/// 获取单个插件信息
#[tauri::command]
pub async fn plugin_get_info(app_handle: tauri::AppHandle, plugin_id: String) -> Result<Option<MobilePluginInfo>> {
    let manager = app_handle.state::<Arc<PluginManager>>();
    Ok(manager.get_info(&plugin_id).await)
}

/// 预授权（启用前置，独立命令供前端先行调用）
///
/// 前端 toggle 时序：先调本命令（此阶段**不显示** LoadingDialog，授权弹窗
/// 可正常交互）→ 通过后再显示 loading 调 `plugin_activate`；拒绝则直接失败，
/// 不进入激活流程。`activate` 内部的 preauthorize 保留为兜底（启动
/// auto-activate 无头场景 + 已授权路径短路无二次弹窗）。
#[tauri::command]
pub async fn plugin_preauthorize(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    credential: String,
) -> Result<()> {
    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "plugin_preauthorize",
        &credential,
        "plugin preauthorization must be requested by the host frontend",
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    manager.preauthorize_plugin(&plugin_id).await
}

/// 激活插件
#[tauri::command]
pub async fn plugin_activate(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    credential: String,
) -> Result<()> {
    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "plugin_activate",
        &credential,
        "plugin activation must be requested by the host frontend",
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    // 前端 toggle 已先行调 plugin_preauthorize（无遮罩弹窗），此处跳过 step 0.5
    // 重复预授权弹窗，避免授权弹窗与 loading 遮罩同现（activate_after_preauth）
    manager.activate_after_preauth(&plugin_id).await
}

/// 停用插件
#[tauri::command]
pub async fn plugin_deactivate(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    credential: String,
) -> Result<()> {
    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "plugin_deactivate",
        &credential,
        "plugin deactivation must be requested by the host frontend",
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    manager.deactivate(&plugin_id).await
}

// ==================== Plugin State Commands ====================

/// 查询插件启用状态
#[tauri::command]
pub async fn plugin_is_enabled(app_handle: tauri::AppHandle, plugin_id: String) -> Result<bool> {
    let manager = app_handle.state::<Arc<PluginManager>>();
    Ok(manager.is_enabled(&plugin_id).await)
}

/// 设置插件启用状态（应用「已启用 / 可用」偏好，不触发激活）
///
/// 属于宿主偏好写面（壳 UI 调用）：issue #28 归宿主门——跨应用篡改他人启用态无正当场景。
#[tauri::command]
pub async fn plugin_set_enabled(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    enabled: bool,
    credential: String,
) -> Result<()> {
    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "plugin_set_enabled",
        &credential,
        "plugin enabled preference must be changed by the host frontend",
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    manager.set_enabled(&plugin_id, enabled).await
}

/// 查询插件「启动时自动激活」偏好（缺省 false = 不自动启动）
#[tauri::command]
pub async fn plugin_is_autostart(app_handle: tauri::AppHandle, plugin_id: String) -> Result<bool> {
    let manager = app_handle.state::<Arc<PluginManager>>();
    Ok(manager.is_autostart(&plugin_id).await)
}

/// 设置插件「启动时自动激活」偏好（只改偏好，下次启动生效）
///
/// 宿主偏好写面（壳 UI 调用）：issue #28 归宿主门——自启动是设备级配置，
/// 应用不得自行决定「重启后自动运行」。
#[tauri::command]
pub async fn plugin_set_autostart(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    autostart: bool,
    credential: String,
) -> Result<()> {
    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "plugin_set_autostart",
        &credential,
        "plugin autostart preference must be changed by the host frontend",
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    manager.set_autostart(&plugin_id, autostart).await
}

/// 标记插件错误（插件自报面 + 宿主代报面）
///
/// 走 `authorize` 而非宿主门：插件只能报自己的错，宿主可代报任意目标（桌面
/// `plugin_mark_error` 同口径）。不在此处回收令牌——`report_ready` 的
/// Error → Activated 自愈路径需要令牌仍然有效，运行态门禁由各命令自查。
#[tauri::command]
pub async fn plugin_mark_error(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    error: String,
    credential: String,
) -> Result<()> {
    authorize_plugin_call(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        &plugin_id,
        &credential,
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    manager.mark_error(&plugin_id, error).await;
    Ok(())
}

/// 插件显式上报启动成功（Error → Activated 自愈；插件自报面，身份 = 自己）
#[tauri::command]
pub async fn plugin_report_ready(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    credential: String,
) -> Result<()> {
    authorize_plugin_call(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        &plugin_id,
        &credential,
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    manager.report_ready(&plugin_id).await
}

/// 批准插件权限（人工审批：记录权限清单 + 目录内容哈希钉扎）
///
/// 仅用户安装插件（file-install / remote-download）需要审批；
/// 内置插件（apk-asset）调用返回错误。批准成功后状态 NeedsApproval → Loaded。
#[tauri::command]
pub async fn plugin_approve(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    credential: String,
) -> Result<()> {
    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "plugin_approve",
        &credential,
        "plugin permission approval must be granted by the host frontend",
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    manager.approve(&plugin_id).await
}

// ==================== Plugin Storage Commands ====================
//
// 三段校验见 [`require_storage_access`]：身份（令牌决定调用方，`plugin_id` 只作目标）
// → 目标激活态 → 目标 `storage` 权限。此前三条命令零校验，任一应用前端可读写他人
// 私库（issue #28）。

/// 获取插件存储值
#[tauri::command]
pub async fn plugin_storage_get(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    key: String,
    credential: String,
) -> Result<Option<Value>> {
    require_storage_access(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        &app_handle.state::<Arc<PluginManager>>(),
        webview.label(),
        &plugin_id,
        &credential,
    )
    .await?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    manager.storage().get(&plugin_id, &key).await
}

/// 设置插件存储值
#[tauri::command]
pub async fn plugin_storage_set(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    key: String,
    value: Value,
    credential: String,
) -> Result<()> {
    require_storage_access(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        &app_handle.state::<Arc<PluginManager>>(),
        webview.label(),
        &plugin_id,
        &credential,
    )
    .await?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    manager.storage().set(&plugin_id, &key, value).await
}

/// 删除插件存储值
#[tauri::command]
pub async fn plugin_storage_delete(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    key: String,
    credential: String,
) -> Result<()> {
    require_storage_access(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        &app_handle.state::<Arc<PluginManager>>(),
        webview.label(),
        &plugin_id,
        &credential,
    )
    .await?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    manager.storage().delete(&plugin_id, &key).await
}

// ==================== Plugin Download & Install Commands ====================

/// 应用包预读结果（壳层安装前裁决：新装 / 已装 / 是否需要询问恢复旧数据）
///
/// 与桌面 `PickedPackage` 同口径（`has_retained_data` 只被 fresh install 消费），
/// 多一个 `installed`：移动端本地包入口没有桌面那套「就地升级确认」分支，
/// 壳层必须自己区分「已装（其自身数据不算旧数据）」与「残留」。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeekedAppPackage {
    /// 包路径（本地包原样回传；远程包 = 已下载的临时文件，供随后安装使用）
    pub path: String,
    /// 包内 `plugin.json` 的 `id`（反向域名）
    pub plugin_id: String,
    /// 该 id 是否留有可恢复的旧数据（keep-data 卸载的私有库 / 主库 KV）
    pub has_retained_data: bool,
    /// 该 id 当前是否已安装
    pub installed: bool,
}

/// 预读本地应用包（只读：不解压落盘、不改注册表）
///
/// 安装↔卸载闭环的前置：壳层先拿到 id / 已装 / 旧数据三项事实，才能在真正
/// 安装前询问「是否恢复旧应用数据」（默认不恢复）。识别失败 fail-visible。
#[tauri::command]
pub async fn plugin_peek_app_package(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    path: String,
    credential: String,
) -> Result<PeekedAppPackage> {
    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "plugin_peek_app_package",
        &credential,
        "plugin package inspection must be requested by the host frontend",
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    let plugin_id = crate::plugin::downloader::PluginDownloader::peek_plugin_id(std::path::Path::new(&path))?;
    let installed = manager.get_info(&plugin_id).await.is_some();
    let has_retained_data = manager.has_retained_data(&plugin_id).await?;
    tracing::info!(
        path = %path,
        plugin_id = %plugin_id,
        installed,
        has_retained_data,
        "[API] plugin_peek_app_package"
    );
    Ok(PeekedAppPackage {
        path,
        plugin_id,
        has_retained_data,
        installed,
    })
}

/// 下载远程应用包到本地临时目录（两相安装的第一相：不落插件目录、不改注册表）
///
/// 一相「下载即安装」无法在落盘前知道包 id，也就无法询问「是否恢复旧数据」；
/// 拆成两相后与本地包入口同一条裁决链：预读 → 壳层询问 → `plugin_install_from_file`。
/// 出站仍过 egress 闸门（`PluginDownloader::download_package` 内）。
#[tauri::command]
pub async fn plugin_download_package(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    zip_url: String,
    credential: String,
) -> Result<PeekedAppPackage> {
    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "plugin_download_package",
        &credential,
        "plugin download must be requested by the host frontend",
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    let plugins_dir = manager.plugins_dir().clone();
    let path =
        crate::plugin::downloader::PluginDownloader::download_package(&app_handle, &zip_url, &plugins_dir).await?;
    let path_str = match path.to_str() {
        Some(p) => p.to_string(),
        None => {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(crate::AppError::Plugin(format!(
                "Downloaded package path is not valid UTF-8: {}",
                path.display()
            )));
        }
    };
    // 预读失败不把临时包留在磁盘上（壳层拿不到 id 就无法进入安装相）
    let plugin_id = match crate::plugin::downloader::PluginDownloader::peek_plugin_id(&path) {
        Ok(id) => id,
        Err(e) => {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(e);
        }
    };
    let installed = manager.get_info(&plugin_id).await.is_some();
    let has_retained_data = manager.has_retained_data(&plugin_id).await?;
    tracing::info!(
        url = %zip_url,
        plugin_id = %plugin_id,
        installed,
        has_retained_data,
        "[API] plugin_download_package"
    );
    Ok(PeekedAppPackage {
        path: path_str,
        plugin_id,
        has_retained_data,
        installed,
    })
}

/// 从本地 zip 插件包安装
///
/// `upgrade = true`（应用版本更新链路）：同 id 就地升级——只允许可更新应用
/// （manifest 声明 `update`），运行中 / 系统服务一律拒绝；插件 KV 保留，目录内容
/// 换新后审批哈希失配 → 下次激活需要重新批准（升级保数据，不保信任）。
///
/// `restoreData` 只对 fresh install 生效：keep-data 卸载留下的旧数据是否恢复。
/// 缺省 false = 丢弃（壳层在存在旧数据时先询问，默认也是不恢复）。
#[tauri::command]
pub async fn plugin_install_from_file(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    path: String,
    credential: String,
    upgrade: Option<bool>,
    restore_data: Option<bool>,
) -> Result<String> {
    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "plugin_install_from_file",
        &credential,
        "plugin installation must be requested by the host frontend",
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    let plugins_dir = manager.plugins_dir().clone();
    let upgrade = upgrade.unwrap_or(false);
    let restore_data = restore_data.unwrap_or(false);

    if upgrade {
        // 先解出目标 id（任何落盘动作之前），再按真实状态裁决。
        let plugin_id = crate::plugin::downloader::PluginDownloader::peek_plugin_id(std::path::Path::new(&path))?;
        let info = manager.get_info(&plugin_id).await.ok_or_else(|| {
            crate::AppError::Plugin(format!(
                "Plugin '{}' is not installed; use install instead of upgrade.",
                plugin_id
            ))
        })?;
        if matches!(
            info.kind,
            crate::plugin::types::PluginKind::BasicService | crate::plugin::types::PluginKind::InternalBusiness
        ) {
            return Err(crate::AppError::Plugin(format!(
                "Plugin '{}' is a system service; system services are updated with the host release.",
                plugin_id
            )));
        }
        if matches!(
            &info.state,
            crate::plugin::types::PluginState::Activated
                | crate::plugin::types::PluginState::Activating
                | crate::plugin::types::PluginState::Degraded { .. }
        ) {
            return Err(crate::AppError::Plugin(format!(
                "Plugin '{}' is running, deactivate it before upgrading.",
                plugin_id
            )));
        }
        // 随包内置的 APK asset 插件只有声明了更新源才允许被用户副本覆盖；
        // 用户安装（file-install / remote-download）本就是可替换面。
        if info.source == "apk-asset" && info.update.is_none() {
            return Err(crate::AppError::Plugin(format!(
                "Plugin '{}' (source: apk-asset) does not declare an update source; builtin apps are updated with the host release.",
                plugin_id
            )));
        }
    }

    let mode = if upgrade {
        crate::plugin::downloader::InstallMode::Upgrade
    } else {
        crate::plugin::downloader::InstallMode::FreshInstall { restore_data }
    };
    // 远程安装是两相：第一相把包下到 `plugins/_download_tmp/`（`plugin_download_package`），
    // 第二相回本命令安装。按路径落点保留来源标记 `remote-download`——否则远程安装会被
    // 记成 file-install，来源事实在壳层（官方/用户副本判定、排障）就丢了。
    let from_download = std::path::Path::new(&path)
        .starts_with(plugins_dir.join(crate::system::constants::plugin::PLUGIN_DOWNLOAD_TEMP_DIR));
    let plugin_id = if from_download {
        crate::plugin::downloader::PluginDownloader::install_downloaded_file(&path, &plugins_dir, mode).await?
    } else {
        crate::plugin::downloader::PluginDownloader::install_from_file(&path, &plugins_dir, mode).await?
    };
    if from_download {
        // 包装完就不再有用；删失败只留一次 warn（临时目录下次下载会清）。
        if let Err(e) = tokio::fs::remove_file(&path).await {
            tracing::warn!(path = %path, error = %e, "Failed to remove downloaded package after install");
        }
    }

    // fresh install 且用户选择「不恢复」：主库 KV 也是旧数据，必须一并清掉。
    // 失败只告警（不把安装判失败），但必须留痕——静默留下旧 KV 等于「不恢复」失效。
    if !upgrade && !restore_data {
        if let Err(e) = manager.storage().clear_all(&plugin_id).await {
            tracing::warn!(
                plugin_id = %plugin_id,
                error = %e,
                "Failed to clear retained plugin storage after fresh install"
            );
        }
    }

    // 重装：清「已卸载」覆盖，否则下次启动解压器仍会跳过该 id。清除失败不把安装
    // 判失败（包已落地，与桌面 `installFromZip` 同口径），但必须留痕。
    if let Err(e) = manager.clear_uninstalled_marker(&plugin_id).await {
        tracing::warn!(
            plugin_id = %plugin_id,
            error = %e,
            "Failed to clear uninstall marker after install"
        );
    }

    // 重新扫描并加载（新目录 / 新版本进入注册表）
    manager.scan_and_load().await;

    Ok(plugin_id)
}

/// 卸载应用（L3；系统服务拒绝）。`keepData` 缺省 = 删除应用数据
#[tauri::command]
pub async fn plugin_uninstall(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    credential: String,
    keep_data: Option<bool>,
) -> Result<()> {
    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "plugin_uninstall",
        &credential,
        "plugin uninstallation must be requested by the host frontend",
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    manager.uninstall(&plugin_id, keep_data.unwrap_or(false)).await
}

/// 重新加载 WASM 插件（热重载）
#[tauri::command]
pub async fn reload_wasm_plugin(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    credential: String,
) -> Result<()> {
    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "reload_wasm_plugin",
        &credential,
        "plugin reload must be requested by the host frontend",
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();

    // 先停用
    manager.deactivate(&plugin_id).await?;

    // 重新扫描
    manager.scan_and_load().await;

    // 重新激活
    manager.activate(&plugin_id).await
}

// ==================== File System Auth Commands ====================

/// 回复文件访问授权请求
///
/// 前端契约（`FsAuthDialog.vue`）保持 `(requestId, allowed, remember)` 三参不变——
/// 判定链收敛到 wasm-core `security::fs_auth` 后，宿主在此把「允许 + 是否记住」
/// 映射成该实现的四种决策（`allow_once` / `allow_remember` / `deny`）。「拒绝并
/// 永久记住」（`deny_always`）无前端入口，不在此伪造。
///
/// **宿主门（ADR 0058 F3 的六条授权管理面之一，2026-11-02 补）**：桌面同型命令
/// 早已过 `require_host_surface`，移动侧此前无门——同 webview 内任一应用前端可监听
/// `plugin:fs-auth-request` 事件拿到 `request_id` 后自行回执，等于替用户批准自己的
/// 文件访问。询问事件是广播的，回执必须只认宿主前端。
#[tauri::command]
pub async fn plugin_fs_auth_respond(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    request_id: String,
    allowed: bool,
    remember: bool,
    credential: String,
) -> Result<()> {
    use wasmnest_wasm_core::security::fs_auth::FsDecision;

    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "plugin_fs_auth_respond",
        &credential,
        "file system authorization must be answered by the host frontend",
    )?;

    let decision = match (allowed, remember) {
        (true, true) => FsDecision::AllowRemember,
        (true, false) => FsDecision::AllowOnce,
        // allowed=false 时 remember 无意义（前端恒传 false）——一律按一次拒绝
        (false, _) => FsDecision::Deny,
    };
    let manager = app_handle.state::<Arc<PluginManager>>();
    manager.fs_auth().respond(&request_id, decision).await;
    Ok(())
}

// 路径 / 插件白名单管理命令（`plugin_fs_{add,remove,get}_{path,plugin}_whitelist`）
// 随移动自实现退役（用户裁决 2026-10-11「fs 授权统一到桌面判定链，移动自实现
// 已退役」）：统一判定链的授权真源 = 授权记录表 + 弹窗记忆，没有「全局路径 /
// 插件白名单」这一层；前端无调用点（grep 实证），删除即零回归。

// ==================== Plugin Logging Commands ====================

/// 插件日志输出（TS SDK 调用，统一到宿主 tracing）
#[tauri::command]
pub fn plugin_log(plugin_id: String, level: String, message: String) {
    match level.as_str() {
        "debug" => tracing::debug!("[plugin:{}] {}", plugin_id, message),
        "warn" => tracing::warn!("[plugin:{}] {}", plugin_id, message),
        "error" => tracing::error!("[plugin:{}] {}", plugin_id, message),
        _ => tracing::info!("[plugin:{}] {}", plugin_id, message),
    }
}

// ==================== Plugin Command Invoke ====================

/// 调用 WASM 插件命令（前端 context.commands.execute 的回退桥）
///
/// 身份由 `credential` 绑定（issue #28）：插件令牌只能驱动**自己**的 command，
/// 宿主凭证（loader 会话）可驱动任意目标。此前该命令零身份、零来源校验，同 webview
/// 内任一应用前端都能以他人 plugin_id 触发其命令副作用。
#[tauri::command]
pub async fn plugin_invoke(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    plugin_id: String,
    command: String,
    args: Value,
    credential: String,
) -> Result<Value> {
    authorize_plugin_call(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        &plugin_id,
        &credential,
    )?;
    let manager = app_handle.state::<Arc<PluginManager>>();
    // WASM 命令接受字符串参数（JSON 序列化），invoke_command 返回的是命令结果字符串
    let args_str = args.to_string();
    let result = manager.invoke_command(&plugin_id, &command, &args_str).await?;
    // 还原为 JSON 对象返回前端（任务数组 / {ok:true} 等）
    let value: Value = serde_json::from_str(&result).map_err(|e| {
        crate::AppError::Plugin(format!(
            "plugin_invoke: invalid result JSON from plugin {}: {}",
            plugin_id, e
        ))
    })?;
    // 插件 invoke_command 的 Err 经 SDK 宏序列化为 {"error": "..."} 的**成功** JSON，
    // 此处还原为真正错误（与桌面端同口径，见 host/commands.rs）
    if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
        if !err.is_empty() {
            return Err(crate::AppError::Plugin(err.to_string()));
        }
    }
    Ok(value)
}

// ==================== System Open（历史「打开所在文件夹」真机路径） ====================

/// 按文件名打开接收文件所在目录（历史记录「打开所在文件夹」真实设备路径）
///
/// wire 不携带接收落盘路径，仅凭文件名经 Kotlin DownloadsDirPlugin
/// openFileLocationByName（MediaStore 公共下载按名命中 → 打开 primary:Download
/// 目录——查询与写入同源 external_primary、EXTERNAL_CONTENT_URI 兑底；未命中回退
/// app 私有下载目录按名查找，顶层优先 + 子目录递归兑底）。需 system:open 权限，
/// 前端 requireSystemOpenPermission 已校验（与 plugin_open_file* 回调链同模式）。
#[tauri::command]
pub async fn plugin_reveal_received_file(plugin_id: String, file_name: String) -> Result<()> {
    if file_name.trim().is_empty() {
        return Err(crate::AppError::Plugin(
            "plugin_reveal_received_file: file_name is required".to_string(),
        ));
    }
    tracing::debug!(plugin_id = %plugin_id, file_name = %file_name, "reveal received file location");
    crate::plugin::android_plugins::open_download_file_location_by_name(&file_name).await
}

/// 引导开启「所有文件访问」权限（打开系统公共 Download 目录所需）
///
/// 经 Kotlin AllFilesAccessPlugin.openAllFilesAccessSettings 查询
/// isExternalStorageManager，未授权时跳转系统授权页（无该页面的 ROM 兑底
/// 应用详情页）；返回跳转前的授权状态。授权后用户重新点击「打开所在文件夹」
/// 即达（MediaStore 命中可重复查询）。需 system:open 权限，前端
/// requireSystemOpenPermission 已校验（与 plugin_reveal_* 回调链同模式）。
#[tauri::command]
pub async fn plugin_open_all_files_access(plugin_id: String) -> Result<bool> {
    tracing::debug!(plugin_id = %plugin_id, "open all files access settings");
    crate::plugin::android_plugins::open_all_files_settings_android().await
}

/// 打开公共下载目录（设置页「下载目录」区打开按钮，核对文件是否落盘）
///
/// 经 Kotlin DownloadsDirPlugin.openDownloadDir 打开 primary:Download 文档树
/// 目录；未授予「所有文件访问」时以 needs_all_files_access 前缀 reject，前端
/// 据此弹引导跳系统设置。需 system:open 权限，前端 requireSystemOpenPermission
/// 已校验（与 plugin_reveal_* 回调链同模式）。
#[tauri::command]
pub async fn plugin_open_download_dir(plugin_id: String) -> Result<()> {
    tracing::debug!(plugin_id = %plugin_id, "open system download dir");
    crate::plugin::android_plugins::open_download_dir().await
}

// ==================== 终端输出流窄转发登记（票 12 · 批次 2b 命令薄壳） ====================
//
// 表本体就在同仓 `plugin/terminal_stream.rs`（[`TerminalStreamGateway`]，纯机制）；
// Channel 是 Tauri IPC 机制，WASM 插件无法持有——命令薄壳留宿主，转调 crate
// 全局单例（与 WIT `host-terminal-stream.forward-output` 共用同一张表）。
//
// **宿主门（2026-11-02 补）**：这是「宿主代前端创建 Channel」的传输登记面，插件
// 合法的消费路径是宿主注入的窄 API（`mobileApi.openTerminalStream` →
// `plugin/terminal-stream.ts`，凭证由宿主层补），不是裸 invoke。裸命令若可调，
// 任一应用前端能按 session_id 抢登记他人会话的输出通道（输出按会话键控，
// 后登记覆盖前登记）——既窃听又静默顶掉正常页面。通道归属 = 宿主，故只认宿主门。

/// 段2 订阅（进入终端页）：登记页面通道并开启输出推送。幂等
#[tauri::command]
pub async fn terminal_page_subscribe(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    session_id: String,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    credential: String,
) -> Result<()> {
    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "terminal_page_subscribe",
        &credential,
        "terminal page channel must be registered by the host frontend",
    )?;
    if session_id.is_empty() {
        return Err(crate::AppError::Plugin("session_id is empty".to_string()));
    }
    crate::plugin::terminal_stream::terminal_stream_gateway().page_subscribe(&session_id, channel);
    Ok(())
}

/// 段2 取消订阅（退出终端页）：清空页面通道并停止推送
///
/// 同样只认宿主门：注销是「摘掉别人的通道」的破坏面，不能由任意前端触发。
#[tauri::command]
pub async fn terminal_page_unsubscribe(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    session_id: String,
    credential: String,
) -> Result<()> {
    require_host_surface(
        &app_handle.state::<Arc<FrontendChannelRegistry>>(),
        webview.label(),
        "terminal_page_unsubscribe",
        &credential,
        "terminal page channel must be unregistered by the host frontend",
    )?;
    if session_id.is_empty() {
        return Err(crate::AppError::Plugin("session_id is empty".to_string()));
    }
    crate::plugin::terminal_stream::terminal_stream_gateway().page_unsubscribe(&session_id);
    Ok(())
}
