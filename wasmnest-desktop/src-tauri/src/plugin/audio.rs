//! host-audio 宿主侧适配器（端口实现 + 引擎装配自报）
//!
//! 机制（设备枚举 / 会话 / PCM 归一 / 帧环 / 电平）住能力 crate；本文件只补宿主
//! 才有的那一半：权限门实现、进程级引擎装配、白名单条目与强制引用行。
//!
//! 采集后端采用 cpal（Linux ALSA / Windows WASAPI / Apple CoreAudio / Android
//! AAudio）。Linux 构建需要 `libasound2-dev`；宿主构建环境负责该原生依赖。

use std::any::Any;
use std::sync::Arc;

use wasmnest_audio_engine::cpal_backend::CpalBackend;
use wasmnest_audio_engine::plugin_binding::ports::AudioPorts;
use wasmnest_audio_engine::{AudioHub, AudioLimits};
use wasmnest_host_kit::ports::{downcast_host, HostPorts};
use wasmnest_wasm_core::host_api::check_permission;
use wasmnest_wasm_core::host_api::context::WasmHostContext;

wasmnest_host_kit::expect_host_module!(wasmnest_audio_engine::plugin_binding::MODULE_NAME);
use wasmnest_audio_engine as _;

/// 端口的宿主实现
pub struct HostAudioPorts {
    ctx: Arc<dyn HostPorts>,
}

impl HostAudioPorts {
    fn ctx(&self) -> &WasmHostContext {
        downcast_host::<WasmHostContext>(self.ctx.as_ref())
    }
}

impl AudioPorts for HostAudioPorts {
    fn check_permission(&self, plugin_id: &str, permission: &str, api: &str) -> bool {
        check_permission(self.ctx(), plugin_id, permission, api)
    }
}

/// 装配回调：端口（实例级 + 进程级）与 cpal 引擎各装一次
fn install(host: Arc<dyn HostPorts>) {
    let ctx = downcast_host::<WasmHostContext>(host.as_ref());
    let ports: Arc<dyn AudioPorts> = Arc::new(HostAudioPorts { ctx: Arc::clone(&host) });
    ctx.set_domain_ports(
        wasmnest_audio_engine::plugin_binding::DOMAIN,
        Arc::new(Arc::clone(&ports)) as Arc<dyn Any + Send + Sync>,
    );
    wasmnest_audio_engine::plugin_binding::install_ports(ports);
    wasmnest_audio_engine::plugin_binding::install_hub(Arc::new(AudioHub::new(
        Arc::new(CpalBackend::new()),
        AudioLimits::default(),
    )));
}

/// 端口装配器静态（与白名单条目 / 强制引用行同处）
pub static AUDIO_PORTS_INSTALLER: wasmnest_host_kit::DomainPortsInstaller = wasmnest_host_kit::DomainPortsInstaller {
    name: wasmnest_audio_engine::plugin_binding::MODULE_NAME,
    install,
};

wasmnest_host_kit::submit_domain_ports_installer!(AUDIO_PORTS_INSTALLER);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_module_declaration_matches_capability_domain_desc() {
        let module_name = wasmnest_audio_engine::plugin_binding::MODULE_NAME;
        assert!(
            wasmnest_host_kit::expected_host_modules().contains(&module_name),
            "能力模块白名单缺 {module_name}"
        );
        assert_eq!(
            wasmnest_audio_engine::plugin_binding::MODULE_INTERFACES,
            &["wasmnest:audio@0.0.1/host-audio"],
            "接口路径必须与 WIT 契约逐字一致"
        );
        assert_eq!(
            wasmnest_audio_engine::plugin_binding::MODULE_PERMISSIONS,
            &["audio:capture", "audio:io"],
            "权限位必须与权限词汇表逐字一致"
        );
    }
}
