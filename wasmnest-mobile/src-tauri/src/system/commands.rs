//! 双端共享的系统命令（设置读写 / ping）
//!
//! 本地配对码命令（生成 / 读取 / 校验 / 清除）已随 `connection::pairing_service`
//! 一并退役：移动端不是配对码颁发方（配对码由桌面端生成），提交与编排在
//! `com.wasmnest.bedcode` 插件。

use tauri::Manager;

// ==================== 设置命令 ====================

/// 获取应用设置
#[tauri::command]
pub async fn get_app_settings(app_handle: tauri::AppHandle) -> crate::Result<crate::system::config::AppConfig> {
    let config_path = app_handle
        .path()
        .app_data_dir()
        .map(|p| p.join("config.json"))
        .map_err(|e: tauri::Error| crate::AppError::Config(e.to_string()))?;

    crate::system::config::AppConfig::load(&config_path).map_err(|e| crate::AppError::Config(e.to_string()))
}

/// 保存应用设置
#[tauri::command]
pub async fn save_app_settings(
    webview: tauri::Webview,
    app_handle: tauri::AppHandle,
    settings: crate::system::config::AppConfig,
    credential: String,
) -> crate::Result<()> {
    let channel = crate::commands::host_gate::channel_registry(&app_handle)?;
    crate::commands::host_gate::require_host_surface(
        &channel,
        webview.label(),
        "save_app_settings",
        &credential,
        "command 'save_app_settings' must be requested by the host frontend",
    )?;
    let config_path = app_handle
        .path()
        .app_data_dir()
        .map(|p| p.join("config.json"))
        .map_err(|e: tauri::Error| crate::AppError::Config(e.to_string()))?;

    settings.save(&config_path)?;

    tracing::info!("App settings saved to {:?}", config_path);
    Ok(())
}

// ==================== 通用工具 ====================

/// 测试命令
#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}
