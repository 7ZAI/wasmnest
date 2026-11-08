//! HTTP 代理命令面（ticket 03）：`http_request` / `http_cancel`
//!
//! 移动端前端只负责 UI 渲染，所有 HTTP 经本代理由 Rust 发出（spec §3）：
//! - 共享 `reqwest::Client`（连接池复用；`no_proxy()`——系统代理会劫持局域网目标，
//!   与 AuthHttpClient 同策略）
//! - Egress Policy 校验（ticket 02）：`kind="desktop"` 走 L1 桌面端目标校验（方案 a：
//!   调用方声明 + Rust 校验在途/已连接目标，阻止任意外网 URL 借 desktop 逃逸）；
//!   `kind="external"`（默认）走 L1/L2/L3 全层判定，未命中弹授权窗（fail-closed）
//! - JWT 注入（`/api/auth/*` 白名单除外，spec §5 第 4 条）
//! - 链路加密信封（wasmnest-link-crypto；`enabled ∧ encrypt_http ∧ 已 pin` 且非 auth
//!   路径；GET/HEAD 无 body 仍带协商头；失败 fail-closed）
//! - 超时默认 30s（D5）+ `http_cancel(request_id)`（oneshot + tokio::select!，
//!   handoff §5.5 结论 2.2）
//! - 报文对齐（§5 第 5 条）：forbidden 头丢弃、POST/PUT 无 body 补 `Content-Length: 0`、
//!   Range 头补 `Accept-Encoding: identity`（桌面端实测 `allow_any_origin`，无需伪造
//!   Origin；reqwest 默认 UA 桌面端不校验）
//! - 结构化日志带 `request_id` 字段（§8 日志红线）

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Manager;

use crate::egress::{EgressDecision, ERROR_URL_NOT_DECLARED};
use crate::state::is_http_encryption_active;
use crate::AppError;
use crate::Result;

// ==================== 常量 ====================

/// 默认请求超时（D5：30s）
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// JWT 注入白名单前缀：`/api/auth/*` 不带 Bearer（与现状一致，spec §5 第 4 条）
pub(crate) const AUTH_PATH_PREFIX: &str = "/api/auth/";

/// 桌面端 HTTP 为局域网明文（单端口自定义），https 外网不得借 kind=desktop 逃逸
const DESKTOP_REQUIRED_SCHEME: &str = "http";

/// 请求头黑名单：浏览器禁止前端设置的 forbidden headers（对齐 Web fetch 语义，
/// §5.5 结论 2.3）——大小写不敏感
const FORBIDDEN_HEADERS_EXACT: &[&str] = &[
    "connection",
    "cookie",
    "host",
    "origin",
    "referer",
    "upgrade",
    "keep-alive",
];
const FORBIDDEN_HEADER_PREFIXES: &[&str] = &["proxy-", "sec-"];

/// HTTP 无 body 方法（加密信封不填充 body，仍带协商头）
fn has_request_body(method: &str) -> bool {
    let m = method.to_uppercase();
    m != "GET" && m != "HEAD"
}

// ==================== 请求/响应形状 ====================

/// http_request 命令参数（camelCase；kind 缺省 external）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpProxyRequest {
    /// 调用方生成的 UUID（D3）：日志/追踪/取消标识，多路复用响应路由
    pub request_id: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// 原始请求体（字符串；无 body 为 None）
    #[serde(default)]
    pub body: Option<String>,
    /// 超时毫秒（缺省 30000）
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// "desktop" = 桌面端目标（L1 校验）；"external"（缺省）= 外网全层判定
    #[serde(default)]
    pub kind: Option<String>,
}

/// http_request 响应形状（前端 request() 归一化为 ApiResult）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpProxyResponse {
    pub status: u16,
    pub status_text: String,
    /// 响应头（已过滤 hop-by-hop；value 合并逗号）
    pub headers: HashMap<String, String>,
    /// 响应体文本（已解密；UTF-8 尽力解码）
    pub body_text: String,
}

// ==================== 全局代理状态 ====================

/// 共享 reqwest Client（连接池复用；无全局超时——每请求显式设置）
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// 在途请求取消通道：request_id → oneshot（完成/取消/超时后 remove 防泄漏）
static PENDING_REQUESTS: OnceLock<tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> =
    OnceLock::new();

fn client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // 移动端只直连局域网桌面端/指定外网；系统代理会把局域网目标劫持走
            // （实测回环被代理返回 502，AuthHttpClient 同策略）
            .no_proxy()
            // 跳转重校验：外网 302 → 内网/云元数据不经 L1/L2/L3（SSRF 面），
            // 私有跳转仅放行已声明桌面端目标 / 同源 / 私网链（egress::redirect_policy）
            .redirect(crate::egress::redirect_policy())
            .build()
            .expect("reqwest client build failed")
    })
}

fn pending_requests() -> &'static tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>> {
    PENDING_REQUESTS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

// ==================== 报文对齐（纯函数，可单测） ====================

/// 过滤 forbidden headers（浏览器语义）：exact 黑名单 + 前缀黑名单，大小写不敏感
pub fn sanitize_headers(headers: &HashMap<String, String>) -> HashMap<String, String> {
    headers
        .iter()
        .filter(|(k, _)| {
            let lower = k.to_lowercase();
            !FORBIDDEN_HEADERS_EXACT.contains(&lower.as_str())
                && !FORBIDDEN_HEADER_PREFIXES.iter().any(|p| lower.starts_with(p))
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// 报文对齐补充头（§5.5 结论 2.3 / §5 第 5 条）：
/// - POST/PUT 无 body → `Content-Length: 0`（桌面端按报文语义解析）
/// - Range 头存在 → `Accept-Encoding: identity`（部分服务器对 Range 分段响应拒绝
///   压缩；reqwest 无 gzip feature 本就发 identity，这里显式对齐）
/// - 不伪造 Origin（桌面端 `allow_any_origin`，实测不校验）
///
/// 判空按**字节**而非 UTF-8 文本：链路加密开启后 body 是 AES-GCM 密文，
/// 按 `from_utf8` 判空会失败并误补 `Content-Length: 0`，与真实密文 body
/// 冲突（reqwest 不覆盖显式 header）。
pub fn align_wire_headers(headers: &mut HashMap<String, String>, method: &str, body: Option<&[u8]>) {
    let m = method.to_uppercase();
    if (m == "POST" || m == "PUT") && body.map_or(true, |b| b.is_empty()) {
        headers.insert("Content-Length".to_string(), "0".to_string());
    }
    if headers.keys().any(|k| k.to_lowercase() == "range") {
        headers.insert("Accept-Encoding".to_string(), "identity".to_string());
    }
}

/// JWT 注入判定
///
/// 三个条件同时成立才附带 Bearer：
/// - 请求由**宿主**发起（`host_request`）——JWT 是宿主机密，应用发起的请求不得带；
/// - 路径不在 `/api/auth/*` 白名单（该项为免认证路径，带 token 反而会被拒）；
/// - 宿主内存里真有 token。
pub fn should_inject_jwt(path: &str, token: &str, host_request: bool) -> bool {
    host_request && !path.starts_with(AUTH_PATH_PREFIX) && !token.is_empty()
}

/// 链路加密判定：主开关 ∧ HTTP 子开关 ∧ 已 pin（state.rs），且非明文白名单路径
///
/// auth 路径要明文响应（pin 刷新），health 路径在桌面端被过滤器豁免——两者加
/// 信封只会得到「对端不参与」的 400 或明文降级警告。
pub fn should_encrypt(path: &str) -> bool {
    is_http_encryption_active() && !path.starts_with(AUTH_PATH_PREFIX) && path != "/api/health" && path != "/health"
}

/// 对端显式拒绝的稳定码（`X-WasmNest-Crypto-Error`，内网穿透 T07）
///
/// 响应头名大小写不敏感（reqwest 归一小写）；值只认共享 crate 登记的两个码，
/// 其他字符串返回 `None`——对端自报的任意值不得变成本地错误分类。
pub fn crypto_refusal_code(headers: &HashMap<String, String>) -> Option<&'static str> {
    headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(wasmnest_link_crypto::ERROR_HEADER))
        .and_then(|(_, value)| wasmnest_link_crypto::parse_code(value))
}

// ==================== 核心命令 ====================

/// 统一 HTTP 代理命令（D1：invoke promise 路由回调用方）
///
/// ## 身份（安全审查 #43，2026-11-02）
///
/// 调用方必须附前端通道凭证（宿主 loader 会话 / 应用自己的通道令牌）：
///
/// - **宿主**：`source = "host"`——宿主内置外网面（更新检查）与宿主页面请求，
///   可按宿主记账并附带全局 JWT；
/// - **应用**：`source = "plugin:{id}"`——egress 按**真实发起应用**记账与分档，
///   并要求该应用声明并获准 `network:http`；**不注入宿主 JWT**（宿主机密不出 Rust）；
/// - **无凭证 / 凭证无效**：直接拒绝（fail-visible）。应用前端与宿主同 webview，
///   裸 invoke 不得被当成宿主。
#[tauri::command]
pub async fn http_request(
    request: HttpProxyRequest,
    app: tauri::AppHandle,
    webview: tauri::Webview,
    credential: String,
) -> Result<HttpProxyResponse> {
    let channel = crate::commands::host_gate::channel_registry(&app)?;
    let caller = crate::commands::host_gate::resolve_caller(
        &channel,
        webview.label(),
        "http_request",
        &credential,
    )?;

    // 应用发起：先过 `network:http` 权限位（该位在 wasm 侧只门控 guest host fn，
    // 前端面此前无任何仲裁 ⇒ 声明与审批形同虚设）
    if let crate::commands::host_gate::CallerIdentity::Plugin(ref plugin_id) = caller {
        let manager = app.state::<std::sync::Arc<crate::plugin::manager::PluginManager>>();
        if !manager.has_permission(plugin_id, wasmnest_wasm_core::permission::PERMISSION_NETWORK_HTTP).await
        {
            tracing::warn!(
                plugin_id = %plugin_id,
                url = %request.url,
                "egress: app frontend has no network:http permission, denying"
            );
            return Err(AppError::Plugin(format!(
                "Plugin {plugin_id} has no network:http permission"
            )));
        }
    }

    execute_proxy(request, Some(&app), &caller).await
}

/// 代理核心执行（命令与集成测试共用；`app` 为 None 时 L3 弹窗路径 fail-closed 拒绝）
///
/// `caller` 决定 egress 记账主体与是否附带全局 JWT——绝不在内部默认为宿主身份。
pub async fn execute_proxy(
    request: HttpProxyRequest,
    app: Option<&tauri::AppHandle>,
    caller: &crate::commands::host_gate::CallerIdentity,
) -> Result<HttpProxyResponse> {
    use crate::commands::host_gate::CallerIdentity;
    use tauri::Emitter;

    let request_id = request.request_id.clone();
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT.as_millis() as u64));
    let kind = request.kind.as_deref().unwrap_or("external");
    // 记账与分档主体：宿主 `host`，应用 `plugin:{id}`（与 wasm 侧 agent 口径一致）
    let source = match caller {
        CallerIdentity::Host => "host".to_string(),
        CallerIdentity::Plugin(plugin_id) => format!("plugin:{plugin_id}"),
    };
    // JWT 是宿主机密：只随宿主发起的请求出 Rust，应用请求不得附带
    let host_request = matches!(caller, CallerIdentity::Host);

    // ---------- URL 解析 + Egress 校验 ----------
    let parsed = crate::egress::parse_url_lite(&request.url)
        .ok_or_else(|| AppError::Egress(format!("{ERROR_URL_NOT_DECLARED}: malformed url {}", request.url)))?;

    if kind == "desktop" {
        // 方案 a（L1 时序落地）：desktop 类请求必须命中桌面端目标集合
        // （前端 setApiBaseUrl 时经 egress_declare_desktop_target 声明，
        // 覆盖 httpProbe 先于 ws_connect 的时序缺口），且仅允许 http 明文
        if parsed.scheme != DESKTOP_REQUIRED_SCHEME {
            return Err(AppError::Egress(format!(
                "{ERROR_URL_NOT_DECLARED}: desktop kind requires http://, got {}",
                request.url
            )));
        }
        if !crate::egress::policy().is_desktop_target(&parsed.host, parsed.port) {
            tracing::warn!(
                request_id = %request_id,
                host = %parsed.host,
                port = ?parsed.port,
                "egress: desktop target not declared, denying"
            );
            return Err(AppError::Egress(format!(
                "{ERROR_URL_NOT_DECLARED}: host:port not a declared desktop target: {}",
                request.url
            )));
        }
    } else {
        // external：Egress 全层判定（L1/L2/L3），记账主体 = 真实调用方
        match crate::egress::policy().decide(&request.url, &source) {
            EgressDecision::Allow(_) => {}
            EgressDecision::Deny(e) => {
                tracing::warn!(
                    request_id = %request_id,
                    url = %request.url,
                    code = %e.code,
                    "egress: url denied"
                );
                return Err(AppError::Egress(format!("{}: {}", e.code, e.url)));
            }
            EgressDecision::NeedConsent(mut req) => {
                req.id = request_id.clone();
                // app 为 None（测试）或 emit 失败 → fail-closed 拒绝
                let allowed = match app {
                    Some(handle) => crate::egress::policy()
                        .request_consent(handle, req)
                        .await
                        .map_err(|e| AppError::Egress(format!("consent flow failed: {e}")))?,
                    None => {
                        tracing::warn!(
                            request_id = %request_id,
                            url = %request.url,
                            "egress: consent required but no app handle (test), denying"
                        );
                        false
                    }
                };
                if !allowed {
                    return Err(AppError::Egress(format!(
                        "{}: {}",
                        crate::egress::ERROR_URL_DENIED,
                        request.url
                    )));
                }
            }
        }
    }

    // ---------- 构建请求（报文对齐 + JWT + 加密信封） ----------
    let method = reqwest::Method::from_bytes(request.method.to_uppercase().as_bytes())
        .map_err(|e| AppError::Egress(format!("unsupported method {}: {e}", request.method)))?;

    let mut headers = sanitize_headers(&request.headers);
    let path = parsed.path.clone();

    // JWT 只随宿主发起的请求外发（`host_request`）；应用请求即使命中路径白名单
    // 也不得附带宿主机密
    if host_request && should_inject_jwt(&path, &crate::state::get_global_token(), host_request) {
        headers.insert(
            "Authorization".to_string(),
            format!("Bearer {}", crate::state::get_global_token()),
        );
    }

    // 链路加密信封（非 auth 且开关开且已 pin）
    //
    // 触发面 = 宿主请求 ∪ 目标为已声明桌面端的应用请求：信封密钥是宿主与桌面端
    // 协商的会话密钥，只有“对端就是那台桌面”时才成立（外部 URL 加信封只会让
    // 对端解不开）。应用请求还要求健康探测已报告「对端链上有加密过滤器」——
    // 对端全 off 时加信封只会被 fail-visible 400（`linkCryptoActive` 能力位）。
    let local_target = crate::egress::is_loopback_host(&parsed.host);
    // 应用请求按**该应用**在对端的策略裁决（off / 未登记 = 明文）；策略来自健康
    // 探测缓存。宿主请求保持既有行为（shell 只打 auth/health 等宿主面）。
    let app_policy_encrypts = match (&caller, parsed.port) {
        (crate::commands::host_gate::CallerIdentity::Plugin(plugin_id), Some(port)) => matches!(
            crate::state::link_crypto_app_policy(&parsed.host, port, plugin_id).as_deref(),
            Some("preferred") | Some("required")
        ),
        _ => false,
    };
    let desktop_target_request = kind == "desktop" && !local_target && app_policy_encrypts;
    // 环回目标是桌面端本地豁免面（过滤器不介入）：加信封 = 把密文直投插件
    let encryption_active = !local_target && (host_request || desktop_target_request) && should_encrypt(&path);
    let mut request_keys: Option<wasmnest_link_crypto::HttpTrafficKeys> = None;
    let mut body_bytes: Option<Vec<u8>> = request.body.clone().map(String::into_bytes);

    if encryption_active {
        let ctx = crate::state::get_link_crypto_context();
        let kd_raw = ctx.kd_public_b64.as_deref().ok_or_else(|| {
            AppError::Egress("LINK_ENCRYPTION_NO_PIN: encryption active but no pinned key".to_string())
        })?;
        let kd_pub: [u8; 32] = base64::engine::general_purpose::STANDARD
            .decode(kd_raw)
            .map_err(|e| AppError::Egress(format!("pin b64 decode failed: {e}")))?
            .try_into()
            .map_err(|v: Vec<u8>| AppError::Egress(format!("pin length mismatch: expected 32, got {}", v.len())))?;
        let (eph_priv, eph_pub) = wasmnest_link_crypto::generate_ephemeral();
        let keys = wasmnest_link_crypto::derive_http_keys(&eph_priv, &kd_pub, &path)
            .map_err(|e| AppError::Egress(format!("derive http keys failed: {e}")))?;
        let aad = wasmnest_link_crypto::http_aad(wasmnest_link_crypto::Direction::Inbound, &path);
        if has_request_body(method.as_str()) {
            let plain = body_bytes.clone().unwrap_or_default();
            let sealed = wasmnest_link_crypto::encrypt_http_body(&keys.request, &plain, &aad)
                .map_err(|e| AppError::Egress(format!("encrypt http body failed: {e}")))?;
            body_bytes = Some(sealed);
        }
        headers.insert(
            "X-WasmNest-Crypto".to_string(),
            format!("v1 {}", base64::engine::general_purpose::STANDARD.encode(eph_pub)),
        );
        request_keys = Some(keys);
    }

    align_wire_headers(&mut headers, method.as_str(), body_bytes.as_deref());

    // ---------- 发送（select! 取消） ----------
    let mut builder = client().request(method, &request.url).timeout(timeout);
    if !headers.is_empty() {
        let mut header_map = reqwest::header::HeaderMap::new();
        for (k, v) in &headers {
            if let (Ok(k), Ok(v)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                header_map.insert(k, v);
            }
        }
        builder = builder.headers(header_map);
    }
    if let Some(b) = &body_bytes {
        builder = builder.body(b.clone());
    }
    let req = builder
        .build()
        .map_err(|e| AppError::Egress(format!("build request failed: {e}")))?;

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    pending_requests().lock().await.insert(request_id.clone(), cancel_tx);

    let fut = client().execute(req);
    tokio::pin!(fut);
    let result = tokio::select! {
        res = &mut fut => res,
        _ = cancel_rx => {
            pending_requests().lock().await.remove(&request_id);
            tracing::info!(request_id = %request_id, url = %request.url, "http proxy: request cancelled");
            return Err(AppError::Egress("REQUEST_CANCELED: http request cancelled".to_string()));
        }
    };
    pending_requests().lock().await.remove(&request_id);

    let response = result.map_err(|e| {
        tracing::error!(request_id = %request_id, url = %request.url, error = %e, "http proxy: request failed");
        AppError::Egress(format!("HTTP request failed: {e}"))
    })?;

    // ---------- 响应（解密 + pin 刷新） ----------
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let mut resp_headers: HashMap<String, String> = HashMap::new();
    for (k, v) in response.headers() {
        resp_headers
            .entry(k.as_str().to_string())
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(v.to_str().unwrap_or(""));
            })
            .or_insert_with(|| v.to_str().unwrap_or("").to_string());
    }
    let has_crypto_resp_header = resp_headers
        .get("x-wasmnest-crypto")
        .map(|v| v == "v1")
        .unwrap_or(false);

    let raw_body = response
        .bytes()
        .await
        .map_err(|e| AppError::Egress(format!("read response body failed: {e}")))?;

    let body_text = if encryption_active {
        match request_keys {
            Some(keys) if has_crypto_resp_header => {
                let aad = wasmnest_link_crypto::http_aad(wasmnest_link_crypto::Direction::Outbound, &path);
                let plain = wasmnest_link_crypto::decrypt_http_body(&keys.response, &raw_body, &aad)
                    .map_err(|e| AppError::Egress(format!("decrypt http body failed: {e}")))?;
                String::from_utf8(plain).unwrap_or_else(|_| {
                    tracing::warn!(request_id = %request_id, "http proxy: decrypted body not utf-8");
                    String::new()
                })
            }
            _ => {
                // 对端显式拒绝（带稳定码，内网穿透 T07）：这是「有名字的拒绝」，
                // 不是需要容忍的降级——没有载荷可交付，两种 strict 档资都报同一个码，
                // 应用按码给「升级对端」或「检查链路身份 / 重新配对」的出路。
                // 码只认共享 crate 登记值，对端自报的任意串不得变成本地错误分类。
                if let Some(code) = crypto_refusal_code(&resp_headers) {
                    tracing::error!(
                        request_id = %request_id,
                        code,
                        "http proxy: link crypto request refused by peer"
                    );
                    return Err(AppError::Egress(code.to_string()));
                }
                // 预期加密而响应明文（downgrade）：strict 断连报错；非 strict 明文续跑
                let strict = crate::state::get_link_crypto_context().strict_mode;
                if strict {
                    tracing::error!(request_id = %request_id, "http proxy: strict mode downgrade detected");
                    return Err(AppError::Egress("LINK_ENCRYPTION_DOWNGRADE".to_string()));
                }
                tracing::warn!(request_id = %request_id, "http proxy: response unencrypted (downgrade tolerated)");
                String::from_utf8_lossy(&raw_body).to_string()
            }
        }
    } else {
        String::from_utf8_lossy(&raw_body).to_string()
    };

    // 健康探测：缓存对端能力快照（过滤器是否在链上 + 应用策略 → 应用 HTTP
    // 是否加信封的判据）。只认 200 + JSON 字段；缺字段（旧宿主）= 不覆盖缓存
    // （未知 → 明文；required 应用会显性 400）。
    if kind == "desktop" && path == "/api/health" && status.is_success() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body_text) {
            if let (Some(active), Some(port)) = (value.get("linkCryptoActive").and_then(|v| v.as_bool()), parsed.port) {
                let policies = value
                    .get("linkCryptoPolicies")
                    .and_then(|v| v.as_object())
                    .map(|map| {
                        map.iter()
                            .filter_map(|(k, v)| v.as_str().map(|policy| (k.clone(), policy.to_string())))
                            .collect()
                    })
                    .unwrap_or_default();
                crate::state::set_link_crypto_server(&parsed.host, port, active, policies);
            }
        }
    }

    // pin 刷新收束（handoff §3.5）：auth 响应携带 kdPublicB64 → Rust 落地 +
    // 广播 ws_link_crypto_pin（前端 localStorage 保留作设置页展示，裁决在 Rust）
    if path.starts_with(AUTH_PATH_PREFIX) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body_text) {
            if let Some(kd) = v.pointer("/data/kdPublicB64").and_then(|k| k.as_str()) {
                if !kd.is_empty() {
                    crate::state::update_link_crypto_pin(Some(kd.to_string()));
                    let kd_fingerprint = v.pointer("/data/kdFingerprint").and_then(|f| f.as_str());
                    tracing::info!(
                        request_id = %request_id,
                        "http proxy: link crypto pin refreshed from auth response"
                    );
                    if let Some(handle) = app {
                        let _ = handle.emit(
                            "ws_link_crypto_pin",
                            json!({ "kdPublicB64": kd, "kdFingerprint": kd_fingerprint }),
                        );
                    }
                }
            }
        }
    }

    tracing::debug!(
        request_id = %request_id,
        method = %request.method.to_uppercase(),
        host = %parsed.host,
        status = %status.as_u16(),
        encrypted = %encryption_active,
        "http proxy: completed"
    );

    Ok(HttpProxyResponse {
        status: status.as_u16(),
        status_text,
        headers: resp_headers,
        body_text,
    })
}

/// 取消在途请求（request_id 多路复用；不存在时静默成功）
///
/// 身份（安全审查 #43）：按 `request_id` 取消是**宿主面**动作（前端超时兜底），
/// 应用前端不得借已知 request_id 掐断他人请求。用 `resolve_caller` 而不要求宿主：
/// 应用取消**自己的**请求是合法语义，身份只用于日志归因。
#[tauri::command]
pub async fn http_cancel(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    request_id: String,
    credential: String,
) -> Result<()> {
    let channel = crate::commands::host_gate::channel_registry(&app)?;
    let caller = crate::commands::host_gate::resolve_caller(&channel, webview.label(), "http_cancel", &credential)?;
    tracing::debug!(request_id = %request_id, caller = ?caller, "http proxy: cancel requested");
    cancel_pending(&request_id).await
}

/// 取消在途请求（命令体的可测试内核；集成测试不经凭证门直接调它）
pub async fn cancel_pending(request_id: &str) -> Result<()> {
    let removed = pending_requests().lock().await.remove(request_id);
    if removed.is_none() {
        tracing::debug!(request_id = %request_id, "http proxy: cancel for unknown request_id");
    }
    Ok(())
}

// ==================== 单元测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_drops_forbidden_headers() {
        let mut h = HashMap::new();
        h.insert("Content-Type".to_string(), "application/json".to_string());
        h.insert("Host".to_string(), "evil.com".to_string());
        h.insert("Proxy-Authorization".to_string(), "Basic xxx".to_string());
        h.insert("Sec-WebSocket-Key".to_string(), "abc".to_string());
        h.insert("X-Custom".to_string(), "ok".to_string());
        let cleaned = sanitize_headers(&h);
        assert!(cleaned.contains_key("Content-Type"));
        assert!(cleaned.contains_key("X-Custom"));
        assert!(!cleaned.contains_key("Host"));
        assert!(!cleaned.contains_key("Proxy-Authorization"));
        assert!(!cleaned.contains_key("Sec-WebSocket-Key"));
    }

    #[test]
    fn align_wire_headers_content_length_and_encoding() {
        // POST 无 body → Content-Length: 0
        let mut h = HashMap::new();
        align_wire_headers(&mut h, "POST", None);
        assert_eq!(h.get("Content-Length").map(String::as_str), Some("0"));
        // 空字节 body → 同样补 0
        let mut h = HashMap::new();
        align_wire_headers(&mut h, "PUT", Some(&[]));
        assert_eq!(h.get("Content-Length").map(String::as_str), Some("0"));
        // 非 UTF-8 密文 body 非空 → 不得补 Content-Length: 0（否则截断加密请求体）
        let mut h = HashMap::new();
        align_wire_headers(&mut h, "POST", Some(&[0xff, 0xfe, 0x00]));
        assert!(!h.contains_key("Content-Length"));
        // GET 不补
        let mut h = HashMap::new();
        align_wire_headers(&mut h, "GET", None);
        assert!(!h.contains_key("Content-Length"));
        // Range → Accept-Encoding: identity
        let mut h = HashMap::new();
        h.insert("Range".to_string(), "bytes=0-1023".to_string());
        align_wire_headers(&mut h, "GET", None);
        assert_eq!(h.get("Accept-Encoding").map(String::as_str), Some("identity"));
    }

    #[test]
    fn jwt_injection_whitelist() {
        assert!(!should_inject_jwt("/api/auth/pairing", "tok", true));
        assert!(!should_inject_jwt("/api/auth/reauth", "", true));
        assert!(should_inject_jwt("/api/sessions", "tok", true));
        assert!(!should_inject_jwt("/api/sessions", "", true));
    }

    /// 应用发起的请求不得附带宿主 JWT（安全审查 #43：宿主机密不出 Rust）
    #[test]
    fn jwt_never_injected_for_app_requests() {
        assert!(!should_inject_jwt("/api/sessions", "tok", false));
        assert!(!should_inject_jwt("/api/file-tree", "tok", false));
    }

    #[test]
    fn request_body_semantics() {
        assert!(!has_request_body("GET"));
        assert!(!has_request_body("head"));
        assert!(has_request_body("POST"));
        assert!(has_request_body("delete"));
    }

    /// 拒绝码头只认登记值：旧客户端（`encryption-unsupported`）与坏协商
    /// （`encryption-required`）必须可区分，杂头不得被当成码
    #[test]
    fn crypto_refusal_code_reads_only_registered_codes() {
        let mut headers = HashMap::new();
        headers.insert(
            wasmnest_link_crypto::ERROR_HEADER.to_ascii_lowercase(),
            wasmnest_link_crypto::CODE_ENCRYPTION_UNSUPPORTED.to_string(),
        );
        assert_eq!(
            crypto_refusal_code(&headers),
            Some(wasmnest_link_crypto::CODE_ENCRYPTION_UNSUPPORTED)
        );

        headers.insert(
            wasmnest_link_crypto::ERROR_HEADER.to_ascii_lowercase(),
            "some-other-reason".to_string(),
        );
        assert_eq!(crypto_refusal_code(&headers), None, "非登记码不得被采信");

        assert_eq!(crypto_refusal_code(&HashMap::new()), None, "无头 = 无码");
    }
}
