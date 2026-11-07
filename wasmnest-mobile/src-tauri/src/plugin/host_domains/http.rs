//! host_http_fetch — HTTP 出站（转发：`wasmnest-server-http` 能力域）
//!
//! **2026-10-10 wasm-core-mobile-purity 票 05**：与票 03 的 peer-net 同款手法——
//! 出站 HTTP 的执行本体（非流式请求 / SSE 流 / 上游限广大 byte / 重定向再校验）
//! 在能力域 crate `wasmnest-server-http`（`plugin_binding::egress`），本文件只把
//! 本端宿主服务接到能力域的 [`HttpPorts`]。
//!
//! **为什么 egress 判定（D9）不随之下沉**：三层判定（桌面端目标 / 声明 / 记忆）
//! 与 NeedConsent 授权弹窗是**宿主安全闸门**的内聚实现，能力域只见「放行 / 拒绝 /
//! 判定失败」三态结论（[`OutboundAuth`]）——拆过界会让弹窗编排脱离宿主载体。
//! 无 app_handle 的无头 / 测试上下文走 `CheckFailed`（fail-closed：弹窗事务没有
//! 载体，收紧为「判定失败」而非「查不到就放行」）。
//!
//! ## 行为 Variant（相对迁移前，均为错误文本而非判定结果）
//!
//! - 权限/egress/流畅能力的**判定**不变，只是生产者从本文件换成能力域；
//! - 错误前缀由 `HTTP request failed: ` → `http error: `（能力域统一字眼）；
//! - 缺 `url` 的拒绝从本文件的入参校验下沉到执行层（错误仍含 `missing 'url'`）。

use std::sync::Arc;

use super::support::guarded_host_call;
use super::{current_handle, host_ctx};
use tauri::Emitter;
use wasmnest_host_kit::WasmPluginState;
use wasmnest_server_http::plugin_binding::egress::http_fetch as core_http_fetch;
use wasmnest_server_http::plugin_binding::ports::{
    BoxedBlocked, HttpEventSink, HttpPorts, OutboundAuth, OutboundEnvelope,
};

use crate::plugin::bindings::wasmnest;

impl wasmnest::http::host_http::Host for WasmPluginState {
    fn fetch(&mut self, request_json: String) -> Result<Option<String>, String> {
        http_fetch(self, &request_json)
    }
}

// ==================== 能力域端口 adapter ====================

/// 统一 state → 能力域 [`HttpPorts`] 的移动 adapter
///
/// 能力域的端口契约带 `'static`（它的异步桥要求 future 可 `'static`），故本
/// adapter **持有副本**而非借 state：调用点在入口处一次性快照宿主服务的句柄
/// （权限快照 / 引擎端口 / AppHandle），不需要在此持 `&WasmPluginState`。
struct StateHttpPorts {
    granted: std::collections::HashSet<String>,
    ports: Arc<dyn wasmnest_wasm_core::host_api::ports::HostEnginePorts>,
    app_handle: Option<Arc<tauri::AppHandle>>,
}

impl HttpPorts for StateHttpPorts {
    fn check_permission(&self, _plugin_id: &str, permission: &str, _api: &str) -> bool {
        // 单调用方纪律：能力域传入的 plugin_id 恒等于本实例 plugin_id（逻辑层唯一入口），
        // 故直接查入口处快照的权限集
        self.granted.contains(permission)
    }

    fn authorize_outbound(&self, plugin_id: &str, url: &str, _may_prompt: bool) -> OutboundAuth {
        // egress 三层判定（桌面端目标 / 声明 / 记忆）+ NeedConsent 弹窗编排留宿主引擎
        // （D9）：能力域只见三态结论。无 app_handle 的无头 / 测试上下文 = 判定失败
        // （fail-closed：弹窗事务没有载体，收紧而非放行）。
        let origin = normalize_origin(url);
        let Some(app_handle) = self.app_handle.clone() else {
            return OutboundAuth::CheckFailed("egress denied: app_handle unavailable (headless/test)".to_string());
        };
        let ports = self.ports.clone();
        let source = format!("plugin:{}", plugin_id);
        let url_owned = url.to_string();
        match tokio::task::block_in_place(|| {
            current_handle().block_on(async move { ports.egress_check(&app_handle, &url_owned, &source).await })
        }) {
            Ok(()) => OutboundAuth::Allowed { origin },
            Err(reason) => OutboundAuth::Denied { reason, origin },
        }
    }

    /// 前端事件通道：缺席（`None`）= 无头上下文，能力域据此显性拒绝流式请求
    /// （缺席语义 ≠ 投递失败，见能力域 ports 头注）
    fn event_sink(&self) -> Option<Arc<dyn HttpEventSink>> {
        let app_handle = self.app_handle.clone()?;
        Some(Arc::new(AppHandleSink {
            app: (*app_handle).clone(),
        }))
    }

    fn block_on_any(&self, fut: BoxedBlocked) -> Box<dyn std::any::Any + Send> {
        // 能力域的执行是 async，宿主在同步调用点阻塞驱动（重入避让在内核
        // `runtime_util::block_on_async` 单点：嵌套异步上下文里它会换线程驱动）。
        // fut 已是擦除后的 `Box<dyn Any + Send>`（server-http 泛型助手装箱），
        // 直接返回驱动结果，不得再套一层 Box（套层会让 downcast 落空——
        // 与桌面宿主 plugin/http.rs 同形，2026-10-11 单形态对齐）。
        wasmnest_wasm_core::runtime_util::block_on_async(fut)
    }

    /// `"jwtAuth": true` 的全局 token 代注（移动侧独有能力的托管口径：token 的
    /// 真源是宿主进程内状态，**不落插件**，C4；当下无 token 即显错，
    /// 禁止静默降级为匿名请求）
    fn jwt_auth_token(&self, _plugin_id: &str) -> Result<Option<String>, String> {
        let token = self.ports.global_token();
        if token.is_empty() {
            Err("jwtAuth requested but no global token available (not authenticated)".to_string())
        } else {
            Ok(Some(token))
        }
    }

    /// 出站链路信封（应用发起的 HTTP 到已配对桌面）
    ///
    /// 与宿主 `http_proxy` 的 `host_request` 信封同协议；差别只在触发面：应用请求
    /// 没有“宿主内建”身份，但目标若是已声明桌面端，同一份宿主信任锚可以透明加封。
    /// gating 口径：主开关 ∧ `encryptHttp` ∧ 已 pin ∧ 目标是已配对桌面 ∧ 非 auth 路径。
    fn outbound_envelope(&self, plugin_id: &str, url: &str) -> Option<Arc<dyn OutboundEnvelope>> {
        mobile_http_envelope(plugin_id, url)
    }
}

// ==================== 出站链路信封（移动端协议实现） ====================

/// 应用发起的 HTTP 是否走宿主信封；`None` = 明文
/// （未启用 / 非桌面目标 / 环回 / auth·health 路径 / 该应用策略为 off 或未知）
fn mobile_http_envelope(plugin_id: &str, url: &str) -> Option<Arc<dyn OutboundEnvelope>> {
    let parsed = crate::egress::parse_url_lite(url)?;
    if parsed.scheme != "http" {
        return None;
    }
    let port = parsed.port?;
    // 环回目标是桌面端本地豁免面（过滤器不介入）：加信封 = 把密文直投插件
    if crate::egress::is_loopback_host(&parsed.host) {
        return None;
    }
    if !crate::egress::policy().is_desktop_target(&parsed.host, Some(port)) {
        return None;
    }
    // auth / health 路径在桌面端被过滤器豁免（明文白名单），信封会被当密文/无用
    if parsed.path.starts_with(crate::commands::http_proxy::AUTH_PATH_PREFIX)
        || parsed.path == "/api/health"
        || parsed.path == "/health"
    {
        return None;
    }
    // 按**该应用**在对端的策略裁决（健康探测缓存的 `linkCryptoPolicies`）：
    // off / 未登记 / 未知 = 明文；只有 preferred / required 才加信封。这样
    // 「bedcode 加密、file-transfer 明文」的 per-app 语义在客户端侧也成立。
    if !matches!(
        crate::state::link_crypto_app_policy(&parsed.host, port, plugin_id).as_deref(),
        Some("preferred") | Some("required")
    ) {
        return None;
    }
    let ctx = crate::state::get_link_crypto_context();
    if !ctx.enabled || !ctx.encrypt_http {
        return None;
    }
    let Some(kd_raw) = ctx.kd_public_b64.as_deref() else {
        // 未配对（无信任锚）= 无法信封；与 HTTP 宿主路径同口径
        return None;
    };
    let kd_public = match wasmnest_link_crypto::b64_decode(kd_raw) {
        Ok(raw) => match raw.try_into() {
            Ok(key) => key,
            Err(_) => {
                tracing::error!("http link crypto: pinned key has invalid length (expect 32 bytes)");
                return None;
            }
        },
        Err(error) => {
            tracing::error!(%error, "http link crypto: pinned key is not valid base64");
            return None;
        }
    };
    let (ephemeral_private, ephemeral_public) = wasmnest_link_crypto::generate_ephemeral();
    let keys = match wasmnest_link_crypto::derive_http_keys(&ephemeral_private, &kd_public, &parsed.path) {
        Ok(keys) => keys,
        Err(error) => {
            tracing::error!(%error, "http link crypto: key derivation failed");
            return None;
        }
    };
    Some(Arc::new(MobileHttpEnvelope {
        path: parsed.path,
        ephemeral_b64: wasmnest_link_crypto::b64_encode(&ephemeral_public),
        request_key: keys.request,
        response_key: keys.response,
    }))
}

/// 单次请求的信封状态（请求/响应双向密钥 + 路径绑定 AAD）
struct MobileHttpEnvelope {
    path: String,
    ephemeral_b64: String,
    request_key: [u8; wasmnest_link_crypto::X25519_KEY_LEN],
    response_key: [u8; wasmnest_link_crypto::X25519_KEY_LEN],
}

impl OutboundEnvelope for MobileHttpEnvelope {
    fn seal_request(
        &self,
        headers: &mut Vec<(String, String)>,
        body: Option<Vec<u8>>,
    ) -> Result<Option<Vec<u8>>, String> {
        // 传输面头后写入：插件自带的同名头不得覆盖协商提案
        headers.retain(|(name, _)| !name.eq_ignore_ascii_case(wasmnest_link_crypto::NEGOTIATION_HEADER));
        headers.push((
            wasmnest_link_crypto::NEGOTIATION_HEADER.to_string(),
            format!("v{} {}", wasmnest_link_crypto::PROTOCOL_VERSION, self.ephemeral_b64),
        ));
        match body {
            // GET/HEAD 无 body：协商头足以派生响应密钥（与桌面入站过滤器同语义）
            Some(plain) if !plain.is_empty() => {
                let aad = wasmnest_link_crypto::http_aad(wasmnest_link_crypto::Direction::Inbound, &self.path);
                wasmnest_link_crypto::encrypt_http_body(&self.request_key, &plain, &aad)
                    .map(Some)
                    .map_err(|error| format!("encrypt http body failed: {error}"))
            }
            _ => Ok(body),
        }
    }

    fn open_response(&self, headers: &[(String, String)], body: Vec<u8>) -> Result<Vec<u8>, String> {
        let negotiated = headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case(wasmnest_link_crypto::NEGOTIATION_HEADER)
                && value.trim() == format!("v{}", wasmnest_link_crypto::PROTOCOL_VERSION)
        });
        if !negotiated {
            if crate::state::get_link_crypto_context().strict_mode {
                return Err("LINK_ENCRYPTION_DOWNGRADE".to_string());
            }
            tracing::warn!(
                path = %self.path,
                "http link crypto: response is not encrypted (downgrade tolerated)"
            );
            return Ok(body);
        }
        let aad = wasmnest_link_crypto::http_aad(wasmnest_link_crypto::Direction::Outbound, &self.path);
        wasmnest_link_crypto::decrypt_http_body(&self.response_key, &body, &aad)
            .map_err(|error| format!("decrypt http body failed: {error}"))
    }
}

/// 前端事件通道：`tauri::AppHandle` 的 emit 投影
///
/// 能力域不许依赖 tauri（WIT-无关、端口化）：事件怎么投出去是本宿主的事——
/// `emit` 失败只降级告警（前端没收着事件不是本次请求失败的判据：请求本体已发完）。
struct AppHandleSink {
    app: tauri::AppHandle,
}

impl HttpEventSink for AppHandleSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if let Err(e) = self.app.emit(event, payload) {
            tracing::warn!(error = %e, event = %event, "emit stream event failed");
        }
    }
}

/// 归一化 `scheme://host[:port]`（错误串只带这三者：不带 path / query，
/// AGENTS §8 凭据红线）
fn normalize_origin(url: &str) -> String {
    let (scheme, rest) = match url.split_once("://") {
        Some((scheme, rest)) => (Some(scheme), rest),
        None => (None, url),
    };
    let authority = rest.split(['/', '?']).next().unwrap_or(rest);
    match scheme {
        Some(scheme) => format!("{}://{}", scheme, authority),
        None => authority.to_string(),
    }
}

// ==================== 逻辑层（薄转发） ====================

/// 逻辑层：发起 HTTP 请求（request 为 JSON；`stream: true` 走流式分支）
///
/// 流式分支：能力域注册 streamId 后立即返回（后台推流经 [`HttpPorts::event_sink`]
/// 广播），非流式由能力域同步返回响应 JSON。
pub(crate) fn http_fetch(state: &WasmPluginState, request_json: &str) -> Result<Option<String>, String> {
    // 端口快照（能力域端口要求 `'static`，故在此一次性取句柄而非借 state）
    let ctx = host_ctx(state);
    let ports: Arc<dyn HttpPorts> = Arc::new(StateHttpPorts {
        // 权限快照向内核真源结算（端口要求 `'static`；判定口径与
        // `WasmHostContext::has_permission` 同一份）
        granted: ctx.granted_permissions(&state.plugin_id),
        ports: ctx.ports.clone(),
        app_handle: ctx.app_handle.clone(),
    });
    guarded_host_call(
        &state.plugin_id,
        "host_http_fetch",
        Err("host_http_fetch panicked".to_string()),
        || core_http_fetch(&ports, &state.plugin_id, request_json, true),
    )
}

// ==================== 单元测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    fn granted_state(plugin_id: &str) -> WasmPluginState {
        wasmnest_wasm_core::test_support::build_component_state(
            plugin_id,
            &[wasmnest_wasm_core::permission::PERMISSION_NETWORK_HTTP],
        )
    }

    // ==================== 出站链路信封（2026-11-04） ====================

    /// 触碰全局链路上下文的用例必须串行
    static CRYPTO_CTX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    const TEST_PATH: &str = "/api/sessions";

    fn envelope_fixture() -> MobileHttpEnvelope {
        let kd_public = [7u8; wasmnest_link_crypto::X25519_KEY_LEN];
        let (ephemeral_private, ephemeral_public) = wasmnest_link_crypto::generate_ephemeral();
        let keys = wasmnest_link_crypto::derive_http_keys(&ephemeral_private, &kd_public, TEST_PATH)
            .expect("derive http keys");
        MobileHttpEnvelope {
            path: TEST_PATH.to_string(),
            ephemeral_b64: wasmnest_link_crypto::b64_encode(&ephemeral_public),
            request_key: keys.request,
            response_key: keys.response,
        }
    }

    /// 密封：保留插件自带头、覆盖同名协商头、body 密文可被同密钥解开
    #[test]
    fn envelope_seals_request_and_keeps_plugin_headers() {
        let envelope = envelope_fixture();
        let mut headers = vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            (
                wasmnest_link_crypto::NEGOTIATION_HEADER.to_string(),
                "v1 attacker-value".to_string(),
            ),
        ];

        let sealed = envelope
            .seal_request(&mut headers, Some(b"hello".to_vec()))
            .expect("seal")
            .expect("body present");

        assert!(
            headers
                .iter()
                .any(|(k, v)| k == "Content-Type" && v == "application/json"),
            "插件自带头不得丢失"
        );
        let negotiation: Vec<_> = headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case(wasmnest_link_crypto::NEGOTIATION_HEADER))
            .collect();
        assert_eq!(negotiation.len(), 1, "协商头必须唯一（插件自带值被覆盖）");
        assert!(negotiation[0].1.starts_with("v1 "));
        assert_ne!(negotiation[0].1, "v1 attacker-value");
        assert!(!sealed.windows(5).any(|w| w == b"hello"), "body 必须是密文");

        let aad = wasmnest_link_crypto::http_aad(wasmnest_link_crypto::Direction::Inbound, TEST_PATH);
        let plain =
            wasmnest_link_crypto::decrypt_http_body(&envelope.request_key, &sealed, &aad).expect("decrypt sealed body");
        assert_eq!(plain, b"hello");
    }

    /// 无 body（GET/HEAD）：只下发协商头，不伪造 body
    #[test]
    fn envelope_seals_header_only_for_empty_body() {
        let envelope = envelope_fixture();
        let mut headers = Vec::new();
        let sealed = envelope.seal_request(&mut headers, None).expect("seal");
        assert!(sealed.is_none());
        assert_eq!(headers.len(), 1);
        assert!(headers[0].1.starts_with("v1 "));
    }

    /// 响应解密：带协商回执 → 解信封；缺回执 → 非 strict 明文续跑 / strict 断开
    #[test]
    fn envelope_opens_response_and_honors_strict_mode() {
        let _guard = CRYPTO_CTX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let envelope = envelope_fixture();
        let aad = wasmnest_link_crypto::http_aad(wasmnest_link_crypto::Direction::Outbound, TEST_PATH);
        let sealed =
            wasmnest_link_crypto::encrypt_http_body(&envelope.response_key, b"ok", &aad).expect("encrypt response");
        let negotiated = vec![(wasmnest_link_crypto::NEGOTIATION_HEADER.to_string(), "v1".to_string())];

        assert_eq!(envelope.open_response(&negotiated, sealed).expect("open"), b"ok");

        // 缺加密回执：非 strict 明文续跑
        crate::state::set_link_crypto_context(crate::state::LinkCryptoContext {
            enabled: true,
            strict_mode: false,
            encrypt_http: true,
            kd_public_b64: None,
        });
        assert_eq!(
            envelope.open_response(&[], b"plain".to_vec()).expect("plain downgrade"),
            b"plain"
        );

        // strict：显性降级错误（与宿主 http_proxy 同字面量）
        crate::state::set_link_crypto_context(crate::state::LinkCryptoContext {
            enabled: true,
            strict_mode: true,
            encrypt_http: true,
            kd_public_b64: None,
        });
        let err = match envelope.open_response(&[], b"plain".to_vec()) {
            Ok(_) => panic!("strict mode must reject plaintext response"),
            Err(error) => error,
        };
        assert_eq!(err, "LINK_ENCRYPTION_DOWNGRADE");

        // 复位全局态，避免污染其他用例
        crate::state::set_link_crypto_context(crate::state::LinkCryptoContext::default());
    }

    /// 应用 HTTP 信封按**该应用**策略裁决：off / 未探测 = 明文，preferred / required = 加密
    #[test]
    fn envelope_follows_per_app_policy_cache() {
        let _guard = CRYPTO_CTX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let host = "203.0.113.77";
        let port = 4555u16;
        crate::egress::policy().add_desktop_target(host, port);
        crate::state::set_link_crypto_context(crate::state::LinkCryptoContext {
            enabled: true,
            strict_mode: false,
            encrypt_http: true,
            kd_public_b64: Some(wasmnest_link_crypto::b64_encode(
                &[7u8; wasmnest_link_crypto::X25519_KEY_LEN],
            )),
        });
        let url = format!("http://{host}:{port}/api/sessions");
        let owner = "com.example.envelope-policy";

        // 未探测（旧宿主 / 首请求前）→ 明文
        assert!(super::mobile_http_envelope(owner, &url).is_none());

        // off → 明文
        crate::state::set_link_crypto_server(
            host,
            port,
            true,
            [(owner.to_string(), "off".to_string())].into_iter().collect(),
        );
        assert!(super::mobile_http_envelope(owner, &url).is_none());

        // preferred / required → 加密；其他应用未登记 → 明文
        for policy in ["preferred", "required"] {
            crate::state::set_link_crypto_server(
                host,
                port,
                true,
                [(owner.to_string(), policy.to_string())].into_iter().collect(),
            );
            assert!(
                super::mobile_http_envelope(owner, &url).is_some(),
                "{policy} 应用必须加信封"
            );
            assert!(
                super::mobile_http_envelope("com.example.other", &url).is_none(),
                "未登记应用必须明文"
            );
        }

        // 环回 / auth / health 永不加密
        crate::state::set_link_crypto_server(
            host,
            port,
            true,
            [(owner.to_string(), "required".to_string())].into_iter().collect(),
        );
        assert!(super::mobile_http_envelope(owner, "http://127.0.0.1:4555/api/sessions").is_none());
        assert!(super::mobile_http_envelope(owner, &format!("http://{host}:{port}/api/auth/pairing")).is_none());
        assert!(super::mobile_http_envelope(owner, &format!("http://{host}:{port}/api/health")).is_none());

        crate::state::set_link_crypto_context(crate::state::LinkCryptoContext::default());
    }

    /// 权限门 fail-closed（票 13 显性锁）：未授予 `network:http` → 请求在
    /// 权限层即拒绝（不进入 egress 判定，也不发起网络请求）
    #[tokio::test]
    async fn permission_denied_without_network_http() {
        let st = wasmnest_wasm_core::test_support::build_component_state("com.wasmnest.demo", &[]);
        let err = http_fetch(
            &st,
            &serde_json::json!({ "method": "GET", "url": "http://192.168.1.5:4455/api/health" }).to_string(),
        )
        .unwrap_err();
        assert!(err.contains("permission denied"), "got: {err}");
    }

    /// 缺 url 字段 → 执行层拒绝（能力域统一字眼「Missing 'url'」；
    /// 迁移前字眼为 `missing 'url'`，故按小写比较，不受能力域大小写变化影响）
    #[tokio::test]
    async fn missing_url_rejected() {
        let st = granted_state("com.wasmnest.demo");
        let err = http_fetch(&st, &serde_json::json!({ "method": "GET" }).to_string()).unwrap_err();
        let lowered = err.to_lowercase();
        assert!(
            lowered.contains("missing 'url'"),
            "缺 url 的请求必须被拒，且错误点名 url 字段，got: {err}"
        );
    }

    /// 非法 JSON 请求体 → 拒绝（入参校验，能力域解析失败）
    #[tokio::test]
    async fn invalid_request_json_rejected() {
        let st = granted_state("com.wasmnest.demo");
        let err = http_fetch(&st, "not json").unwrap_err();
        assert!(err.contains("invalid request JSON"), "got: {err}");
    }

    /// 无头上下文（无 app_handle）→ egress fail-closed 拒绝（禁「查不到就放行」）
    #[test]
    fn headless_context_denied_by_egress() {
        // 测试内自建 runtime 且该 runtime 的 handle 被桥使用：block_in_place 桥内
        // drop runtime 会 panic（tokio 禁止异步上下文 drop runtime），故 forget 保活
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");
        std::mem::forget(rt);
        let st = granted_state("com.wasmnest.demo");
        let err = http_fetch(
            &st,
            &serde_json::json!({ "method": "GET", "url": "http://192.168.1.5:4455/api/health" }).to_string(),
        )
        .unwrap_err();
        assert!(
            err.contains("egress denied") && err.contains("app_handle unavailable"),
            "无 app_handle 的无头上下文必须 fail-closed，got: {err}"
        );
    }

    /// 错误串只带归一化 origin（不带 path / query —— AGENTS §8 凭据红线）
    #[test]
    fn normalize_origin_strips_path_and_query() {
        assert_eq!(
            normalize_origin("https://h.example:8080/a/b?token=x"),
            "https://h.example:8080"
        );
        assert_eq!(normalize_origin("http://192.168.1.5:4455"), "http://192.168.1.5:4455");
    }
}
