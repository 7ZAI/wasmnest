//! Global State Module
//!
//! 全局单例管理器和 Token 存储

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, OnceLock};

use crate::auth::AuthManager;
use crate::connection::manager::ConnectionManager;
use crate::plugin::manager::PluginManager;
use crate::system::info::SystemInfo;

// ==================== Global Token ====================

/// 全局 Token 存储（移动端）
///
/// 前端启动时从 localStorage 读取并设置，发送消息时自动注入
static GLOBAL_TOKEN: std::sync::RwLock<String> = std::sync::RwLock::new(String::new());

/// 设置全局 Token
pub fn set_global_token(token: &str) {
    let mut guard = GLOBAL_TOKEN.write().unwrap();
    *guard = token.to_string();
    tracing::info!("[GlobalToken] Token updated, length={}", token.len());
}

/// 获取全局 Token
pub fn get_global_token() -> String {
    let guard = GLOBAL_TOKEN.read().unwrap();
    guard.clone()
}

/// 清除全局 Token
pub fn clear_global_token() {
    let mut guard = GLOBAL_TOKEN.write().unwrap();
    *guard = String::new();
    tracing::info!("[GlobalToken] Token cleared");
}

// ==================== Manager Singletons ====================

/// 全局连接管理器单例
static CONNECTION_MANAGER: OnceLock<Arc<ConnectionManager>> = OnceLock::new();

/// 全局认证管理器单例
static AUTH_MANAGER: OnceLock<Arc<AuthManager>> = OnceLock::new();

/// 获取连接管理器
pub fn get_connection_manager() -> Arc<ConnectionManager> {
    CONNECTION_MANAGER.get_or_init(|| ConnectionManager::new()).clone()
}

/// 获取认证管理器
pub fn get_auth_manager() -> Arc<AuthManager> {
    AUTH_MANAGER
        .get_or_init(|| {
            let conn = get_connection_manager();
            AuthManager::new(conn)
        })
        .clone()
}

// ==================== System Info ====================

/// 全局系统信息单例
static SYSTEM_INFO: OnceLock<Arc<SystemInfo>> = OnceLock::new();

/// 初始化系统信息（在 lib.rs 启动流程中调用一次）
pub fn init_system_info(info: SystemInfo) -> Arc<SystemInfo> {
    let arc = Arc::new(info);
    let _ = SYSTEM_INFO.set(arc.clone());
    arc
}

/// 尝试获取系统信息（未初始化返回 None）
///
/// 无 panic 版：系统信息在异步启动任务里采集，早于它到达的调用点（连接自愈、
/// peer 预热）都必须能继续跑，故此处**不提供** `expect` 版本。
pub fn try_get_system_info() -> Option<Arc<SystemInfo>> {
    SYSTEM_INFO.get().cloned()
}

// ==================== Plugin Manager ====================

/// 全局插件管理器单例
static PLUGIN_MANAGER: OnceLock<Arc<PluginManager>> = OnceLock::new();

/// 初始化插件管理器（在 lib.rs setup 中调用）
pub fn init_plugin_manager(manager: Arc<PluginManager>) -> Arc<PluginManager> {
    let _ = PLUGIN_MANAGER.set(manager.clone());
    manager
}

/// 尝试获取插件管理器（未初始化返回 None）
///
/// **不要新增会 panic 的 `get_plugin_manager()`**：本模块的 OnceLock 只是
/// Tauri 托管态（`app.manage`）的镜像，两者指向同一个 `Arc`。在拿得到
/// `AppHandle` 的地方一律用 `app_handle.state::<Arc<PluginManager>>()`（命令层
/// 25 处皆如此）；拿不到的地方（`BusPort` 端口 trait 方法等无 AppHandle 的
/// 上下文）才用本函数，且必须容忍 None——启动窗口内管理器尚未就绪是正常情形，
/// 不是错误路径。曾经的 panic 版访问器已被删：它在 spawn 的重连监控任务里被
/// 调用，一次 panic 会连带终止整个自愈循环且不留痕迹。
pub fn try_get_plugin_manager() -> Option<Arc<PluginManager>> {
    PLUGIN_MANAGER.get().cloned()
}

// ==================== Link Crypto Context（issue 09） ====================

/// 链路加密运行期上下文（HTTP 信封加密；WS 帧级加密另由
/// `plugin/host_domains/ws.rs` 的 engine 端口读取同一份主开关/pin/strict 裁决）
///
/// 设置开关与 pin 存于 WebView localStorage（issue 05/06 的 TS 侧），而 HTTP
/// 加密裁决在 Rust 侧（http_proxy）——前端经 `set_link_crypto_context` 命令把
/// 当前态推送到此。缺省全关：未推送前 HTTP 载荷保持明文（与现状一致）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkCryptoContext {
    /// 主开关（对应移动端 trafficEncryption.enabled）
    pub enabled: bool,
    /// 严格模式：加密被拒/失败时断连报错而非明文续跑
    pub strict_mode: bool,
    /// HTTP 通道子开关（对应桌面 encryptHttp；HTTP 代理收束后由 Rust 裁决）
    pub encrypt_http: bool,
    /// 已 pin 的桌面端身份公钥（base64）；None = 未配对/未下发
    pub kd_public_b64: Option<String>,
}

impl Default for LinkCryptoContext {
    fn default() -> Self {
        Self {
            enabled: false,
            strict_mode: false,
            encrypt_http: true,
            kd_public_b64: None,
        }
    }
}

static LINK_CRYPTO_CONTEXT: std::sync::RwLock<LinkCryptoContext> = std::sync::RwLock::new(LinkCryptoContext {
    enabled: false,
    strict_mode: false,
    encrypt_http: true,
    kd_public_b64: None,
});

/// 读取链路加密运行期上下文快照
pub fn get_link_crypto_context() -> LinkCryptoContext {
    LINK_CRYPTO_CONTEXT.read().unwrap().clone()
}

/// 更新链路加密运行期上下文（前端 set_link_crypto_context 命令调用）
pub fn set_link_crypto_context(ctx: LinkCryptoContext) {
    *LINK_CRYPTO_CONTEXT.write().unwrap() = ctx;
}

/// 更新已 pin 的桌面端身份公钥（认证成功时随 auth 响应落地，issue：修复 pin 断链）
///
/// 仅在有值时覆盖：None 不清除既有 pin——防主动降级攻击抹除信任锚
/// （与前端 notePin 的语义一致：协商失败不清 pin）。
pub fn update_link_crypto_pin(kd_public_b64: Option<String>) {
    if let Some(kd) = kd_public_b64 {
        LINK_CRYPTO_CONTEXT.write().unwrap().kd_public_b64 = Some(kd);
    }
}

/// HTTP 通道是否应加密（HTTP 代理收束后由 Rust 裁决）：主开关 ∧ HTTP 子开关
/// ∧ 已持有 pin——对齐前端 `isChannelEncryptionActive('http')` 的判定。
pub fn is_http_encryption_active() -> bool {
    let ctx = get_link_crypto_context();
    ctx.enabled && ctx.encrypt_http && ctx.kd_public_b64.is_some()
}

/// 对端桌面链路加密能力快照（`/api/health` 的只读字段）
///
/// 移动端只有一个全局开关，无法预知每个应用在对端的策略；健康探测是连接流程的
/// 必经一步，这里缓存「过滤器是否在链上 + 已登记的应用策略」，供应用发起的
/// HTTP 决定是否加信封（`off` / 未登记 = 明文；`preferred` / `required` = 加密）。
#[derive(Debug, Clone, Default)]
pub struct ServerLinkCrypto {
    /// 对端流量链上是否装着链路加密过滤器（全 off 时为 false）
    pub active: bool,
    /// 已登记的应用策略（plugin id → wire 字面量；未登记 = off）
    pub policies: HashMap<String, String>,
}

static LINK_CRYPTO_SERVERS: LazyLock<std::sync::RwLock<HashMap<(String, u16), ServerLinkCrypto>>> =
    LazyLock::new(|| std::sync::RwLock::new(HashMap::new()));

/// 记录对端链路加密能力快照（健康探测响应解析后调用；覆盖旧值）
pub fn set_link_crypto_server(host: &str, port: u16, active: bool, policies: HashMap<String, String>) {
    let key = (host.to_lowercase(), port);
    LINK_CRYPTO_SERVERS
        .write()
        .unwrap()
        .insert(key, ServerLinkCrypto { active, policies });
}

/// 读取对端能力快照（未探测 = None）
pub fn link_crypto_server(host: &str, port: u16) -> Option<ServerLinkCrypto> {
    LINK_CRYPTO_SERVERS
        .read()
        .unwrap()
        .get(&(host.to_lowercase(), port))
        .cloned()
}

/// 对端过滤器是否在链上（未知 = None → 调用方按明文处理）
pub fn link_crypto_server_active(host: &str, port: u16) -> Option<bool> {
    link_crypto_server(host, port).map(|state| state.active)
}

/// 某应用在对端的策略（未探测 / 未登记 / 旧宿主缺字段 = None → 按明文处理）
pub fn link_crypto_app_policy(host: &str, port: u16, plugin_id: &str) -> Option<String> {
    link_crypto_server(host, port)?.policies.get(plugin_id).cloned()
}

/// 清空对端能力快照（测试隔离 / 切换目标）
pub fn clear_link_crypto_servers() {
    LINK_CRYPTO_SERVERS.write().unwrap().clear();
}
