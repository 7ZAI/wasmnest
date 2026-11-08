//! host-tunnel 宿主侧适配器（T06：端口实现 + 对等面启动器 + 装配自报）
//!
//! 域机制（首帧 / 票据 / 准入 / 面登记 / 本地代理 / 单一引用计数）在能力仓
//! `wasmnest-server-peer-net::tunnel`；本文件是**宿主侧的另一半**：
//!
//! - [`HostTunnelPorts`]：权限门（复用 wasm-core 的 `check_permission`，同一份
//!   PermissionManager）、隧道管理器句柄、同步↔异步桥、应用作用域服务注册表；
//! - [`DesktopPeerFaceStarter`]：在**独立 Actix 线程**里起对等 HTTP/WS 面
//!   （`127.0.0.1:0`，端口由系统分配），把实际地址与停机句柄交回管理器；
//! - 装配自报：白名单条目 + 强制引用行 + 端口装配器静态（与 peer / pty 同款，
//!   漏一处即装载期 unlisted / missing 方向点名）。
//!
//! ## 为什么管理器是进程级 OnceLock
//!
//! 管理器在 boot 期（`PluginHost::new` 之前）构造，而端口对象由内核装配链在
//! `PluginHost::new` 内创建——两者中间没有可传参的通道。端口对象持管理器需要
//! 一个「开机装一次、之后只读」的槽位；与 `tunnel::plugin_binding::ports()`
//! 的进程级装配同向。重复装配被忽略（首次装配者胜出），不运行期替换。
//!
//! ## 对等面端口
//!
//! 对等面**只绑 127.0.0.1**（不变量 1 的同源约束），端口 `0` 由系统分配；
//! 实际地址经 `serve_peer_face_on` 返回后写回 `TunnelPolicy` 的管理端口黑名单。
//! 移动端没有这个面，`expose` / `issue-pairing-ticket` 会得到 `tunnel-unavailable`
//! （由能力域定义，宿主不另写文案）。

use std::any::Any;
use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use wasmnest_host_kit::ports::{downcast_host, HostPorts};
use wasmnest_server_base::config::NetworkConfig;
use wasmnest_server_base::face::PeerFaceResolver;
use wasmnest_server_base::service::ServiceRegistry;
use wasmnest_server_core::TransportFace;
use wasmnest_server_peer_net::tunnel::plugin_binding::{BoxedBlocked, TunnelPorts};
use wasmnest_server_peer_net::tunnel::{
    PeerFaceListener, PeerFaceStarter, TunnelError, TunnelManager, CODE_PROXY_BIND_FAILED, CODE_TUNNEL_UNAVAILABLE,
};
use wasmnest_wasm_core::host_api::check_permission;
use wasmnest_wasm_core::host_api::context::WasmHostContext;

// 能力模块白名单条目与强制引用行**必须同处**（本文件），两者不漂移。
wasmnest_host_kit::expect_host_module!(wasmnest_server_peer_net::tunnel::plugin_binding::MODULE_NAME);
use wasmnest_server_peer_net as _;

/// 进程级隧道管理器（boot 期装配；端口对象只读）
static MANAGER: OnceLock<Arc<TunnelManager>> = OnceLock::new();

/// boot 期装配管理器（`PluginHost::new` 之前；重复装配被忽略）
pub fn install_manager(manager: Arc<TunnelManager>) {
    let _ = MANAGER.set(manager);
}

/// 端口实现取管理器；未装配 = None（无头 / 测试），域内显性报错，不静默空转
fn manager() -> Option<Arc<TunnelManager>> {
    MANAGER.get().cloned()
}

/// 端口实现（每插件实例取回本实例的宿主上下文，权限判定落在本实例的
/// PermissionManager 上）
pub struct HostTunnelPorts {
    ctx: Arc<dyn HostPorts>,
}

impl HostTunnelPorts {
    fn ctx(&self) -> &WasmHostContext {
        downcast_host::<WasmHostContext>(self.ctx.as_ref())
    }
}

impl TunnelPorts for HostTunnelPorts {
    fn check_permission(&self, plugin_id: &str, permission: &str, api: &str) -> bool {
        check_permission(self.ctx(), plugin_id, permission, api)
    }

    fn tunnel_manager(&self) -> Option<Arc<TunnelManager>> {
        manager()
    }

    fn block_on_any(&self, fut: BoxedBlocked) -> Box<dyn Any + Send> {
        wasmnest_wasm_core::runtime_util::block_on_async(fut)
    }

    fn service_registry(&self) -> Option<Arc<ServiceRegistry>> {
        self.ctx().service_registry()
    }
}

/// 对等 HTTP/WS 面启动器（桌面）：独立 Actix 线程 + 系统分配端口
pub struct DesktopPeerFaceStarter {
    config: NetworkConfig,
    faces: Vec<Arc<dyn TransportFace>>,
}

impl DesktopPeerFaceStarter {
    pub fn new(config: NetworkConfig, faces: Vec<Arc<dyn TransportFace>>) -> Self {
        Self { config, faces }
    }
}

#[async_trait]
impl PeerFaceStarter for DesktopPeerFaceStarter {
    async fn start(&self, resolver: PeerFaceResolver) -> wasmnest_server_peer_net::tunnel::Result<PeerFaceListener> {
        type Bound = std::io::Result<(std::net::SocketAddr, actix_web::dev::ServerHandle)>;
        let (tx, rx) = tokio::sync::oneshot::channel::<Bound>();
        let config = self.config.clone();
        let faces = self.faces.clone();

        // actix-web-actors 的 WS actor 需要 actix system context；与现役
        // `WebSocketManager::start` 同一条「独立线程 + actix_rt Runtime」路径。
        std::thread::spawn(move || {
            let rt = match actix_web::rt::Runtime::new() {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())));
                    return;
                }
            };
            rt.block_on(async move {
                let listener = match std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)) {
                    Ok(listener) => listener,
                    Err(e) => {
                        let _ = tx.send(Err(e));
                        return;
                    }
                };
                if let Err(e) = listener.set_nonblocking(true) {
                    let _ = tx.send(Err(e));
                    return;
                }
                match wasmnest_server_core::app::serve_peer_face_on(listener, &config, faces, Some(resolver)).await {
                    Ok((addr, handle, server)) => {
                        let _ = tx.send(Ok((addr, handle)));
                        if let Err(e) = server.await {
                            tracing::warn!("tunnel peer face stopped: {e}");
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e));
                    }
                }
            });
        });

        let (addr, handle) = rx
            .await
            .map_err(|_| {
                TunnelError::new(
                    CODE_TUNNEL_UNAVAILABLE,
                    "peer face starter thread panicked before returning handle",
                )
            })?
            .map_err(|e| TunnelError::new(CODE_PROXY_BIND_FAILED, format!("启动对等 HTTP/WS 面失败：{e}")))?;
        tracing::info!(%addr, "tunnel peer face listening on loopback");
        Ok(PeerFaceListener::new(addr, move || {
            // actix 2.x 的 `stop` 返回 future，必须被驱动；服务 stop 在 tokio
            // 上下文里调用，无 ambient runtime 时退回短命线程（不静默不停止）。
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let handle = handle.clone();
                runtime.spawn(async move {
                    handle.stop(true).await;
                });
            } else {
                std::thread::spawn(move || {
                    if let Ok(rt) = actix_web::rt::Runtime::new() {
                        rt.block_on(handle.stop(true));
                    }
                });
            }
        }))
    }
}

/// 装配回调（host-kit 自报）：开机期装本域端口
///
/// 双登记（实例级 + 进程级）与 peer / pty 同款：实例级供插件实例取回，
/// 进程级供非实例路径使用。
fn install(host: Arc<dyn HostPorts>) {
    let ctx = downcast_host::<WasmHostContext>(host.as_ref());
    let ports: Arc<dyn TunnelPorts> = Arc::new(HostTunnelPorts { ctx: Arc::clone(&host) });
    ctx.set_domain_ports(
        wasmnest_server_peer_net::tunnel::plugin_binding::MODULE_NAME,
        Arc::new(Arc::clone(&ports)) as Arc<dyn Any + Send + Sync>,
    );
    wasmnest_server_peer_net::tunnel::plugin_binding::install_ports(ports);
}

/// 端口装配器静态（与白名单条目 / 强制引用行同处；内核装配链遍历本自报表）
pub static TUNNEL_PORTS_INSTALLER: wasmnest_host_kit::DomainPortsInstaller = wasmnest_host_kit::DomainPortsInstaller {
    name: wasmnest_server_peer_net::tunnel::plugin_binding::MODULE_NAME,
    install,
};

wasmnest_host_kit::submit_domain_ports_installer!(TUNNEL_PORTS_INSTALLER);

#[cfg(test)]
mod tests {
    /// 白名单声明、接口路径、权限位三件与能力域描述符逐字一致
    #[test]
    fn host_module_declaration_matches_capability_domain_desc() {
        let module_name = wasmnest_server_peer_net::tunnel::plugin_binding::MODULE_NAME;
        assert!(
            wasmnest_host_kit::expected_host_modules().contains(&module_name),
            "能力模块白名单缺 {module_name}（expect_host_module! 行被删 / 未收集）"
        );
        assert_eq!(module_name, "tunnel");
        assert_eq!(
            wasmnest_server_peer_net::tunnel::plugin_binding::MODULE_INTERFACES,
            &["wasmnest:tunnel@0.0.1/host-tunnel"],
            "接口路径必须与 WIT 契约逐字一致（改错即 guest import 失配）"
        );
        assert_eq!(
            wasmnest_server_peer_net::tunnel::plugin_binding::MODULE_PERMISSIONS,
            &["tunnel:serve", "tunnel:connect"],
            "权限位必须与 wasm-core 真源 / SDK 权限表逐字一致"
        );
    }

    /// 装配器静态被内核装配链遍历到（自报 → 装 → 取回，三段闭环）
    #[test]
    fn submitted_installer_is_wired_into_the_boot_chain() {
        let (_runtime, _ctx) = wasmnest_wasm_core::test_support::setup_wasm_runtime();
        let ports = wasmnest_server_peer_net::tunnel::plugin_binding::ports();
        assert!(
            ports.tunnel_manager().is_none(),
            "测试装配没有管理器（无头），端口必须显性返回 None，而不是空转的占位管理"
        );
        assert!(
            wasmnest_host_kit::expected_host_modules()
                .contains(&wasmnest_server_peer_net::tunnel::plugin_binding::MODULE_NAME),
            "白名单条目与安装器必须同处（漏引用 ⇒ 装载期 missing）"
        );
    }
}
