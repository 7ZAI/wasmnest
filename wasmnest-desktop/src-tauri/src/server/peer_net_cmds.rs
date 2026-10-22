//! peer-net Tauri 命令壳 + 上下文装配（宿主壳；server-lib-split）
//!
//! peer-net 拆 lib 后不再持有 `AppHandle`（引擎函数一律 `&PeerCtx` / `Arc<PeerCtx>`）：
//! 本模块是唯一还认识 `AppHandle` 的薄壳——[`peer_ctx`] 从 `AppHandle` 装配
//! [`PeerCtx`]（端口 + 四个引擎状态），三条前端命令（首连应答 / 信任列表 / 撤销）
//! 在此保持 `#[tauri::command]` 签名并把调用转给引擎实现。节点启停命令已随
//! service-leases 退役（改由 host-peer 原语按引用记账）。拆分前命令壳与引擎同文件，
//! 本模块是拆分产物；库函数本身不再标注 `#[tauri::command]`。

use std::sync::Arc;
use tauri::{AppHandle, Manager};
use wasmnest_server_peer_net::{
    peer_engine_receive::PeerReceiveState, peer_engine_remote::PeerRemoteState,
    peer_engine_transfer::PeerTransferState, PeerCtx, PeerNetState, TrustedPeerDto,
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
// `start_peer_node` / `stop_peer_node` 已退役（service-leases §7.2）：节点生命周期
// 由应用经 `host-peer.start-node` / `stop-node` 的引用记账驱动，宿主命令面不得
// 创建无属主服务。

/// 应答首连确认弹窗（issue 04 命令面）
#[tauri::command]
pub async fn respond_peer_consent(app: AppHandle, request_id: String, accepted: bool) -> crate::Result<bool> {
    wasmnest_server_peer_net::respond_peer_consent(peer_ctx(&app), request_id, accepted).await
}

/// 可信对端列表（设置面管理用；节点未启动仍可读——句柄独立于运行时存活）
#[tauri::command]
pub async fn list_trusted_peers(app: AppHandle) -> crate::Result<Vec<TrustedPeerDto>> {
    wasmnest_server_peer_net::list_trusted_peers(peer_ctx(&app)).await
}

/// 撤销可信对端（返回该 ID 原本是否存在；撤销后对端重连重新走首连确认）
#[tauri::command]
pub async fn revoke_trusted_peer(app: AppHandle, node_id: String) -> crate::Result<bool> {
    wasmnest_server_peer_net::revoke_trusted_peer(peer_ctx(&app), node_id).await
}
