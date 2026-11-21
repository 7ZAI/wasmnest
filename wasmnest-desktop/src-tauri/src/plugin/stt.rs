//! host-stt 宿主侧适配器（端口实现 + 引擎装配自报）
//!
//! 机制（模型目录 / PCM 会话 / 异步任务 / 结果）住能力 crate；本文件补宿主才有的
//! 那一半：权限门、本地模型导入的路径授权、模型目录与 whisper 后端装配。
//!
//! 模型目录放在宿主应用数据目录下的 `speech-models/`（宿主共享、跨插件复用）；
//! 无头上下文回落临时目录（只用于测试 / 无 AppHandle 的装配）。
//! 下载源只来自能力 crate 的 catalog；`WASMNEST_STT_MIRROR` 可替换目录前缀。

use std::any::Any;
use std::path::Path;
use std::sync::Arc;

use tauri::Manager;
use wasmnest_host_kit::ports::{downcast_host, HostPorts};
use wasmnest_stt_engine::model_store::{HttpFetcher, ModelStore};
use wasmnest_stt_engine::plugin_binding::ports::SttPorts;
use wasmnest_stt_engine::whisper_backend::WhisperBackend;
use wasmnest_stt_engine::{SessionLimits, SttHub};
use wasmnest_wasm_core::host_api::check_permission;
use wasmnest_wasm_core::host_api::context::WasmHostContext;
use wasmnest_wasm_core::security::fs_auth::FsOps;

wasmnest_host_kit::expect_host_module!(wasmnest_stt_engine::plugin_binding::MODULE_NAME);
use wasmnest_stt_engine as _;

/// 端口的宿主实现
pub struct HostSttPorts {
    ctx: Arc<dyn HostPorts>,
}

impl HostSttPorts {
    fn ctx(&self) -> &WasmHostContext {
        downcast_host::<WasmHostContext>(self.ctx.as_ref())
    }
}

impl SttPorts for HostSttPorts {
    fn check_permission(&self, plugin_id: &str, permission: &str, api: &str) -> bool {
        check_permission(self.ctx(), plugin_id, permission, api)
    }

    fn authorize_import_path(&self, plugin_id: &str, path: &Path) -> Result<(), String> {
        let canonical = std::fs::canonicalize(path)
            .map_err(|err| format!("model import path is not readable: {}: {err}", path.display()))?;
        if !canonical.is_file() {
            return Err(format!(
                "model import path is not a regular file: {}",
                canonical.display()
            ));
        }
        let text = canonical
            .to_str()
            .ok_or_else(|| "model import path is not valid UTF-8".to_string())?;
        let checker = self.ctx().fs_auth_checker();
        let granted =
            wasmnest_wasm_core::runtime_util::block_on_async(checker.is_granted(plugin_id, text, FsOps::READ));
        if granted {
            Ok(())
        } else {
            Err(format!(
                "model import path is not authorized for plugin {plugin_id}: {}",
                canonical.display()
            ))
        }
    }
}

#[cfg(target_os = "linux")]
fn gsettings_get(schema_key: &str) -> Option<String> {
    let (schema, key) = schema_key.split_once(' ')?;
    let output = std::process::Command::new("gsettings")
        .args(["get", schema, key])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(any(target_os = "linux", test))]
fn unquote(value: String) -> String {
    value.trim().trim_matches('\'').trim_matches('"').trim().to_string()
}

fn proxy_from_env(get: impl Fn(&str) -> Option<String>) -> Option<String> {
    [
        "WASMNEST_STT_PROXY",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ]
    .into_iter()
    .filter_map(get)
    .map(|value| value.trim().to_string())
    .find(|value| !value.is_empty())
}

#[cfg(any(target_os = "linux", test))]
fn gnome_proxy_from(get: impl Fn(&str) -> Option<String>) -> Option<String> {
    let mode = get("org.gnome.system.proxy mode").map(unquote)?;
    if mode != "manual" {
        return None;
    }
    let endpoint = |scheme: &str| -> Option<(String, Option<String>)> {
        let host = unquote(get(&format!("org.gnome.system.proxy.{scheme} host"))?);
        if host.is_empty() {
            return None;
        }
        let port = get(&format!("org.gnome.system.proxy.{scheme} port"))
            .map(unquote)
            .filter(|port| !port.is_empty() && port != "0");
        Some((host, port))
    };
    let (host, port) = endpoint("https").or_else(|| endpoint("http"))?;
    Some(match port {
        Some(port) => format!("http://{host}:{port}"),
        None => format!("http://{host}"),
    })
}

/// 模型下载代理：显式环境变量 > 标准代理环境变量 > Linux 桌面系统代理。
pub(crate) fn resolve_download_proxy() -> Option<String> {
    if let Some(proxy) = proxy_from_env(|key| std::env::var(key).ok()) {
        return Some(proxy);
    }
    #[cfg(target_os = "linux")]
    {
        gnome_proxy_from(gsettings_get)
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// 装配回调：端口（实例级 + 进程级）与 whisper 引擎
fn install(host: Arc<dyn HostPorts>) {
    let ctx = downcast_host::<WasmHostContext>(host.as_ref());
    let ports: Arc<dyn SttPorts> = Arc::new(HostSttPorts { ctx: Arc::clone(&host) });
    ctx.set_domain_ports(
        wasmnest_stt_engine::plugin_binding::DOMAIN,
        Arc::new(Arc::clone(&ports)) as Arc<dyn Any + Send + Sync>,
    );
    wasmnest_stt_engine::plugin_binding::install_ports(ports);

    let base = ctx
        .app_handle()
        .and_then(|app| app.path().app_data_dir().ok())
        .unwrap_or_else(|| std::env::temp_dir().join("wasmnest"));
    let models_dir = base.join("speech-models");
    let mirror = std::env::var("WASMNEST_STT_MIRROR")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let proxy = resolve_download_proxy();
    let fetcher = HttpFetcher::with_proxy(proxy.as_deref());
    if let Some(err) = fetcher.configuration_error() {
        tracing::error!(
            error = %err,
            "host-stt: model download proxy configuration invalid"
        );
    }
    let proxy_active = proxy.is_some() && fetcher.configuration_error().is_none();
    let store = match ModelStore::new(models_dir.clone(), Some(Arc::new(fetcher)), mirror) {
        Ok(store) => store,
        Err(err) => {
            tracing::error!(
                dir = %models_dir.display(),
                error = %err,
                "host-stt: model store init failed; engine stays uninstalled"
            );
            return;
        }
    };
    let hub = SttHub::new(
        Arc::new(WhisperBackend::new()),
        Arc::new(store),
        SessionLimits::default(),
    );
    wasmnest_stt_engine::plugin_binding::install_hub(Arc::new(hub));
    tracing::info!(
        dir = %models_dir.display(),
        proxy = proxy_active,
        "host-stt: engine installed"
    );
}

/// 端口装配器静态（与白名单条目 / 强制引用行同处）
pub static STT_PORTS_INSTALLER: wasmnest_host_kit::DomainPortsInstaller = wasmnest_host_kit::DomainPortsInstaller {
    name: wasmnest_stt_engine::plugin_binding::MODULE_NAME,
    install,
};

wasmnest_host_kit::submit_domain_ports_installer!(STT_PORTS_INSTALLER);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_module_declaration_matches_capability_domain_desc() {
        let module_name = wasmnest_stt_engine::plugin_binding::MODULE_NAME;
        assert!(
            wasmnest_host_kit::expected_host_modules().contains(&module_name),
            "能力模块白名单缺 {module_name}"
        );
        assert_eq!(
            wasmnest_stt_engine::plugin_binding::MODULE_INTERFACES,
            &["wasmnest:stt@0.0.1/host-stt"],
            "接口路径必须与 WIT 契约逐字一致"
        );
        assert_eq!(
            wasmnest_stt_engine::plugin_binding::MODULE_PERMISSIONS,
            &["stt:infer", "stt:model"],
            "权限位必须与权限词汇表逐字一致"
        );
    }

    #[test]
    fn proxy_env_skips_blank_and_prefers_explicit() {
        let get = |key: &str| match key {
            "WASMNEST_STT_PROXY" => Some("   ".to_string()),
            "HTTPS_PROXY" => Some(" http://127.0.0.1:10811 ".to_string()),
            _ => None,
        };
        assert_eq!(proxy_from_env(get).as_deref(), Some("http://127.0.0.1:10811"));
    }

    #[test]
    fn gnome_proxy_requires_manual_mode() {
        let get = |key: &str| match key {
            "org.gnome.system.proxy mode" => Some("'none'".to_string()),
            _ => Some("'127.0.0.1'".to_string()),
        };
        assert_eq!(gnome_proxy_from(get), None);
    }

    #[test]
    fn gnome_proxy_falls_back_to_http_host() {
        let get = |key: &str| match key {
            "org.gnome.system.proxy mode" => Some("'manual'".to_string()),
            "org.gnome.system.proxy.https host" => Some("''".to_string()),
            "org.gnome.system.proxy.http host" => Some("'127.0.0.1'".to_string()),
            "org.gnome.system.proxy.http port" => Some("10811".to_string()),
            _ => None,
        };
        assert_eq!(gnome_proxy_from(get).as_deref(), Some("http://127.0.0.1:10811"));
    }
}
