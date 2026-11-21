//! host-browser 宿主侧适配器（端口实现 + 引擎装配自报）
//!
//! 机制（协议闸门 / 固定提取脚本 / 上限收敛 / 稳定错误码）住能力 crate
//! `wasmnest-server-browser`；本文件补宿主才有的那一半：权限门、出站授权复用、
//! 审计事件与 sidecar 装配。
//!
//! 四件同处（与 http / stt / pty 样板一致）：端口实现 / `install` 装配自报 /
//! 白名单声明 + 强制引用行 / 装配器静态。
//!
//! `render` 的授权复用既有站点授权记录库（与 `network:http` 同库）：同一 origin
//! 已由用户允许过，则浏览器访问直接放行；不新造第二套授权。

use std::any::Any;
use std::sync::Arc;

use wasmnest_host_kit::ports::{downcast_host, HostPorts};
use wasmnest_server_browser::error::{BrowserError, BrowserErrorKind};
use wasmnest_server_browser::ports::{BrowserPorts, RenderRequest, RenderedPage};
use wasmnest_wasm_core::host_api::check_permission;
use wasmnest_wasm_core::host_api::context::WasmHostContext;

use crate::browser_runtime::{BrowserRenderService, BrowserRuntime};

/// 进程级运行时句柄：供宿主退出时统一回收 sidecar 与临时 profile。
static BROWSER_RUNTIME: std::sync::OnceLock<Arc<BrowserRuntime>> = std::sync::OnceLock::new();

wasmnest_host_kit::expect_host_module!(wasmnest_server_browser::MODULE_NAME);
use wasmnest_server_browser as _;

/// 宿主闸门：权限判定与出站授权。
///
/// 抽成 trait 只为一件事：端口层的拒绝 / 放行分支可以脱离完整宿主上下文单测；
/// 生产实现仍然复用同一份 `PermissionManager` 与 `NetworkAuthChecker`。
trait BrowserGate: Send + Sync + 'static {
    fn check_permission(&self, plugin_id: &str, permission: &str, api: &str) -> bool;
    fn authorize_outbound(&self, plugin_id: &str, url: &str) -> bool;
    fn authorize_private_network(&self, plugin_id: &str, origin: &str) -> bool;
}

/// 生产闸门：擦除后的宿主上下文。
struct HostGate {
    ctx: Arc<dyn HostPorts>,
}

impl HostGate {
    fn ctx(&self) -> &WasmHostContext {
        downcast_host::<WasmHostContext>(self.ctx.as_ref())
    }
}

impl BrowserGate for HostGate {
    fn check_permission(&self, plugin_id: &str, permission: &str, api: &str) -> bool {
        // 权限门留宿主（安全闸门——闸门不应可插拔）。复用既有
        // `host_api::check_permission`：同一份 PermissionManager、同一条拒绝 warn 路径。
        check_permission(self.ctx(), plugin_id, permission, api)
    }

    fn authorize_outbound(&self, plugin_id: &str, url: &str) -> bool {
        let checker = self.ctx().net_auth();
        let verdict = wasmnest_wasm_core::runtime_util::block_on_async(async {
            checker.authorize_outbound(plugin_id, url).await
        });
        matches!(verdict, Ok(verdict) if verdict.is_allowed())
    }

    fn authorize_private_network(&self, plugin_id: &str, origin: &str) -> bool {
        // 私网通道只认已有记录，绝不弹窗：本期应用侧恒传 `allow_private_network=false`，
        // 走到这里说明调用方显式申请，宿主只能查记录。
        let checker = self.ctx().net_auth();
        wasmnest_wasm_core::runtime_util::block_on_async(async { checker.is_granted(plugin_id, origin).await })
    }
}

/// 端口的宿主实现。
pub struct HostBrowserPorts {
    gate: Arc<dyn BrowserGate>,
    backend: Arc<dyn BrowserRenderService>,
}

impl BrowserPorts for HostBrowserPorts {
    fn check_permission(&self, plugin_id: &str, permission: &str, api: &str) -> bool {
        self.gate.check_permission(plugin_id, permission, api)
    }

    fn authorize_private_network(&self, plugin_id: &str, origin: &str) -> bool {
        self.gate.authorize_private_network(plugin_id, origin)
    }

    fn render(&self, plugin_id: &str, request: &RenderRequest<'_>) -> Result<RenderedPage, BrowserError> {
        let origin = normalized_origin(request.url.as_str());
        let started = std::time::Instant::now();
        tracing::info!(
            plugin_id = %plugin_id,
            origin = %origin,
            wait_until = request.wait_until.as_str(),
            timeout_ms = request.timeout_ms,
            outcome = "start",
            "browser render"
        );

        if !self.gate.authorize_outbound(plugin_id, request.url.as_str()) {
            tracing::warn!(
                plugin_id = %plugin_id,
                origin = %origin,
                outcome = "browser.denied",
                "browser render denied before dispatch"
            );
            return Err(BrowserError::new(
                BrowserErrorKind::Denied,
                "origin is not authorized for browser rendering",
            ));
        }

        let result = self.backend.render(plugin_id, request);
        let duration_ms = started.elapsed().as_millis() as u64;
        match &result {
            Ok(page) => tracing::info!(
                plugin_id = %plugin_id,
                origin = %origin,
                wait_until = request.wait_until.as_str(),
                timeout_ms = request.timeout_ms,
                status = page.status,
                content_bytes = page.payload.len(),
                duration_ms,
                outcome = "ok",
                "browser render finished"
            ),
            Err(error) => tracing::info!(
                plugin_id = %plugin_id,
                origin = %origin,
                wait_until = request.wait_until.as_str(),
                timeout_ms = request.timeout_ms,

                duration_ms,
                outcome = error.code(),
                "browser render failed"
            ),
        }
        result
    }
}

/// 审计用的 origin：只保留协议、主机与非默认端口，去掉 path / query / fragment。
fn normalized_origin(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(url) => url.origin().ascii_serialization(),
        Err(_) => "<invalid-url>".to_string(),
    }
}

/// 装配回调：端口（实例级 + 进程级）与浏览器运行时。
fn install(host: Arc<dyn HostPorts>) {
    let ctx = downcast_host::<WasmHostContext>(host.as_ref());
    let runtime = BrowserRuntime::from_app(ctx.app_handle());
    let _ = BROWSER_RUNTIME.set(Arc::clone(&runtime));
    let backend: Arc<dyn BrowserRenderService> = runtime;
    let ports: Arc<dyn BrowserPorts> = Arc::new(HostBrowserPorts {
        gate: Arc::new(HostGate { ctx: Arc::clone(&host) }),
        backend,
    });
    ctx.set_domain_ports(
        wasmnest_server_browser::MODULE_NAME,
        Arc::new(Arc::clone(&ports)) as Arc<dyn Any + Send + Sync>,
    );
    wasmnest_server_browser::install_ports(ports);
}

/// 端口装配器静态：内核装配链在任何插件实例化前遍历调用。
pub static BROWSER_PORTS_INSTALLER: wasmnest_host_kit::DomainPortsInstaller = wasmnest_host_kit::DomainPortsInstaller {
    name: wasmnest_server_browser::MODULE_NAME,
    install,
};

wasmnest_host_kit::submit_domain_ports_installer!(BROWSER_PORTS_INSTALLER);

/// 宿主退出回收：终止 sidecar 并删除每插件 profile。
pub async fn shutdown_browser_runtime() {
    if let Some(runtime) = BROWSER_RUNTIME.get() {
        runtime.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use wasmnest_server_browser::model::WaitUntil;

    struct MockGate {
        permission: bool,
        outbound: bool,
        private: bool,
    }

    impl BrowserGate for MockGate {
        fn check_permission(&self, _plugin_id: &str, _permission: &str, _api: &str) -> bool {
            self.permission
        }

        fn authorize_outbound(&self, _plugin_id: &str, _url: &str) -> bool {
            self.outbound
        }

        fn authorize_private_network(&self, _plugin_id: &str, _origin: &str) -> bool {
            self.private
        }
    }

    struct MockBackend {
        calls: AtomicUsize,
        result: Result<RenderedPage, BrowserErrorKind>,
    }

    impl BrowserRenderService for MockBackend {
        fn render(&self, _plugin_id: &str, _request: &RenderRequest<'_>) -> Result<RenderedPage, BrowserError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.result
                .as_ref()
                .map(|page| page.clone())
                .map_err(|kind| BrowserError::new(*kind, "mock backend"))
        }
    }

    fn ports(gate: MockGate, backend: Arc<MockBackend>) -> HostBrowserPorts {
        HostBrowserPorts {
            gate: Arc::new(gate),
            backend,
        }
    }

    fn request<'a>(url: &'a url::Url) -> RenderRequest<'a> {
        RenderRequest {
            url,
            wait_until: WaitUntil::DomContentLoaded,
            timeout_ms: 30_000,
            script: "() => null",
        }
    }

    /// 白名单声明、接口路径、权限位三件与能力域描述符逐字一致。
    #[test]
    fn host_module_declaration_matches_capability_domain_desc() {
        assert!(
            wasmnest_host_kit::expected_host_modules().contains(&wasmnest_server_browser::MODULE_NAME),
            "能力模块白名单缺 browser（expect_host_module! 行被删 / 未收集）"
        );
        assert_eq!(wasmnest_server_browser::MODULE_NAME, "browser");
        assert_eq!(
            wasmnest_server_browser::MODULE_INTERFACES,
            &["wasmnest:browser@0.0.1/host-browser"],
            "接口路径必须与 WIT 契约逐字一致"
        );
        assert_eq!(
            wasmnest_server_browser::MODULE_PERMISSIONS,
            &["network:browser"],
            "权限位必须与契约 / SDK 权限表逐字一致"
        );
    }

    /// 授权拒绝时不触达渲染后端，并返回稳定的 `browser.denied` 前缀。
    #[test]
    fn denied_outbound_does_not_reach_the_backend() {
        let backend = Arc::new(MockBackend {
            calls: AtomicUsize::new(0),
            result: Ok(RenderedPage {
                status: 200,
                final_url: "https://example.com/".to_string(),
                payload: "{}".to_string(),
            }),
        });
        let ports = ports(
            MockGate {
                permission: false,
                outbound: false,
                private: false,
            },
            Arc::clone(&backend),
        );
        let url = url::Url::parse("https://example.com/article?token=secret").expect("url");
        let error = ports.render("com.wasmnest.news", &request(&url)).expect_err("denied");
        assert_eq!(error.kind(), BrowserErrorKind::Denied);
        assert!(error.code().starts_with("browser.denied"));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    }

    /// 授权放行时端口把请求原样转给后端。
    #[test]
    fn allowed_outbound_forwards_to_the_backend() {
        let backend = Arc::new(MockBackend {
            calls: AtomicUsize::new(0),
            result: Ok(RenderedPage {
                status: 200,
                final_url: "https://example.com/".to_string(),
                payload: "{\"title\":\"x\"}".to_string(),
            }),
        });
        let ports = ports(
            MockGate {
                permission: true,
                outbound: true,
                private: false,
            },
            Arc::clone(&backend),
        );
        let url = url::Url::parse("https://example.com/article").expect("url");
        let page = ports.render("com.wasmnest.news", &request(&url)).expect("render");
        assert_eq!(page.status, 200);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    }

    /// 权限门与私网授权原样转发（端口不做第二套判定）。
    #[test]
    fn permission_and_private_network_are_forwarded() {
        let backend = Arc::new(MockBackend {
            calls: AtomicUsize::new(0),
            result: Err(BrowserErrorKind::Unsupported),
        });
        let ports = ports(
            MockGate {
                permission: true,
                outbound: false,
                private: true,
            },
            backend,
        );
        assert!(ports.check_permission("p", "network:browser", "test"));
        assert!(ports.authorize_private_network("p", "http://127.0.0.1:8080"));
    }

    /// 审计 origin 去掉 path / query / fragment。
    #[test]
    fn audit_origin_drops_path_and_query() {
        assert_eq!(
            normalized_origin("https://example.com/a/b?token=secret#part"),
            "https://example.com"
        );
        assert_eq!(
            normalized_origin("http://example.com:8080/a"),
            "http://example.com:8080"
        );
    }

    /// 装配器静态被内核装配链遍历到（自报 → 装 → 取回）。
    #[test]
    fn submitted_installer_is_wired_into_the_boot_chain() {
        let (_, ctx) = wasmnest_wasm_core::test_support::setup_wasm_runtime();
        let ports = wasmnest_server_browser::ports::ports();
        let raw = ctx
            .domain_ports(wasmnest_server_browser::MODULE_NAME)
            .expect("宿主 adapter 必须在实例上下文上登记端口");
        assert!(
            wasmnest_host_kit::ports::downcast_domain_ports::<Arc<dyn BrowserPorts>>(raw).is_some(),
            "实例级通道里装的必须是 `Arc<dyn BrowserPorts>` 容器"
        );
        assert!(
            !ports.check_permission("com.wasmnest.never-granted", "network:browser", "browser.test"),
            "未授权插件必须被权限门拒绝"
        );
    }
}
