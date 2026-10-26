//! peer-net Tauri 命令壳 + 上下文装配（宿主壳；server-lib-split）
//!
//! peer-net 拆 lib 后不再持有 `AppHandle`（引擎函数一律 `&PeerCtx` / `Arc<PeerCtx>`）：
//! 本模块是唯一还认识 `AppHandle` 的薄壳——[`peer_ctx`] 从 `AppHandle` 装配
//! [`PeerCtx`]（端口 + 四个引擎状态），供 `PeerCtxProvider` 端口注入（lib 装配）
//! 与节点引擎消费。前端命令面已整体退役：首连确认走插件命令（file-transfer
//! respond-consent + 互调会话中心），信任列表/撤销与节点启停走 host-peer 原语
//! （service-leases §7.2）。拆分前命令壳与引擎同文件，
//! 本模块是拆分产物；库函数本身不再标注 `#[tauri::command]`。

use std::sync::Arc;
use tauri::{AppHandle, Manager};
use wasmnest_server_peer_net::{
    peer_engine_receive::PeerReceiveState, peer_engine_remote::PeerRemoteState,
    peer_engine_transfer::PeerTransferState, PeerCtx, PeerNetState,
};

/// 从 AppHandle 装配 peer-net 操作上下文
///
/// 生产运行期四个状态均已 `app.manage(Arc::new(..))`；端口缺失只可能出现在
/// 「插件激活早于端口装配」的窗口（激活发生在 `PluginHost::new` 内部）——此时按
/// 句柄就地装配一份等价端口面（late-bound 总线 + 句柄直取的路径面），而不是装一份
/// 只会静默失效的端口：这份 `PeerCtx` 会被节点引擎**长期持有**（2026-10-07 实机：
/// 此前窗口内装配的端口既无句柄（`peer_start_node` 报 `resolve app data dir failed:
/// no runtime context`）又钉死了占位总线）。
pub fn peer_ctx(app: &AppHandle) -> Arc<PeerCtx> {
    let ports = match wasmnest_server_base::ports::get().cloned() {
        Some(ports) => ports,
        None => {
            tracing::warn!("server ports not installed yet; assembling an equivalent instance for peer ctx");
            Arc::new(crate::server::ports_impl::assemble(Some(Arc::new(app.clone()))))
        }
    };
    // 窄端口装配（能力域自持端口面）：peer 引擎只消费 bus / event_sink /
    // paths / system_info / mdns 五个端口，从全量 `ServerPorts` 取子集
    let engine_ports = Arc::new(wasmnest_server_peer_net::engine_ports::PeerEnginePorts {
        bus: Arc::clone(&ports.bus),
        event_sink: Arc::clone(&ports.event_sink),
        paths: Arc::clone(&ports.paths),
        system_info: Arc::clone(&ports.system_info),
        mdns: Arc::clone(&ports.mdns),
        // 桌面无平台缝（默认路径直读 / 无落点提升 / 无内置条目）——行为逐字不变
        platform: None,
    });
    Arc::new(PeerCtx {
        ports: engine_ports,
        state: app.state::<Arc<PeerNetState>>().inner().clone(),
        transfer: app.state::<Arc<PeerTransferState>>().inner().clone(),
        receive: app.state::<Arc<PeerReceiveState>>().inner().clone(),
        remote: app.state::<Arc<PeerRemoteState>>().inner().clone(),
    })
}

// ==================== 前端命令面（薄壳，引擎实现见 peer_net） ====================
//