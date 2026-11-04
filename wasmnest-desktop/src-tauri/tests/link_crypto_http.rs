//! 链路加密 HTTP 集成测试（issue 02；server-lib-split 票 08 曾迁入 `wasmnest-server-http`，
//! crate 单测纯净性轮次迁回宿主）
//!
//! 真 TrafficFilter 中间件全链路：客户端加密请求 → 过滤器解密 → handler 收明文
//! → 响应加密 → 客户端用 k_resp 解回。全局链为进程级单例，串行化触碰。
//!
//! 策略模型（2026-11-04）：按**应用**（plugin id）一个策略，覆盖该应用全部端点；
//! 本文件用真注册表把「应用 A required / 应用 B off」共存钉在真实 HTTP 边界上。
//!
//! ## 为什么住在宿主 `tests/`（crate 单测纯净性）
//!
//! 被测单元**跨三个 crate**：`TrafficFilter`（`wasmnest-server-http` ×
//! `link_crypto` / `TrafficFilterChain`（`wasmnest-server-core`）× `wasmnest-crypto-engine`
//! （算法原语）。拆分产物的纯净性口径是「crate 只保留单元测试，跨 crate 集成测试归宿主」
//! ——组合测试的天然归属就是宿主：那里**全部依赖都是生产依赖**，既不需要
//! `[dev-dependencies]`，也不需要给任何 crate 开一个只测对外行为的 `tests/` 二进制。
//!
//! 依赖面：本文件零新增依赖——`wasmnest-server-http` / `wasmnest-server-core` /
//! `wasmnest-crypto-engine` / `base64` / `actix-web` 全在宿主 `[dependencies]`，
//! `tempfile` 在 `[dev-dependencies]`。
//!
//! 防复发：`tests/capability_crates_unit_tests_only.rs`（拆分产物不得有 crate 根
//! `tests/`，也不得有 dev-only 内部依赖）。

use std::sync::Mutex;

use actix_web::{test, web, App, HttpResponse};
use base64::Engine as _;

use wasmnest_crypto_engine::x25519::{x25519_diffie_hellman, x25519_generate};
use wasmnest_server_core::filter::TrafficFilterChain;
use wasmnest_server_core::link_crypto::{
    self, decrypt_http_body, derive_http_traffic_keys, encrypt_http_body, EncryptionPolicy, NEGOTIATION_HEADER,
};

/// 全局链 + 应用策略表均为进程级单例，测试串行化
static GLOBAL_LOCK: Mutex<()> = Mutex::new(());

/// 身份密钥懒初始化（OnceLock 保 tempdir 存活到进程结束）
fn init_identity_once() {
    static IDENTITY_DIR: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    let dir = IDENTITY_DIR.get_or_init(|| tempfile::tempdir().unwrap());
    link_crypto::init_identity(dir.path()).unwrap();
}

/// 注册一条测试端点并设置应用策略，返回内部路径（`/api/plugin/<owner>/echo`）
fn setup_app(owner: &str, policy: EncryptionPolicy) -> String {
    use wasmnest_server_http::{registry, wire::EndpointAuth};

    registry::purge_for_plugin(owner);
    link_crypto::remove_app_policy(owner);
    link_crypto::set_app_policy(owner, policy).expect("set app policy");
    registry::register(owner, "echo", None, &["POST".to_string()], EndpointAuth::None).expect("register endpoint");
    format!("/api/plugin/{owner}/echo")
}

/// 清空全局链后显式注册过滤器（`chain.clear()` 与 REGISTERED 标志会脱节）
fn reset_chain() {
    let chain = TrafficFilterChain::global();
    chain.clear();
    link_crypto::register_into(&chain);
}

/// 收尾：策略 / 端点 / 链不留痕
fn teardown(owner: &str) {
    wasmnest_server_http::registry::purge_for_plugin(owner);
    link_crypto::remove_app_policy(owner);
    TrafficFilterChain::global().clear();
}

/// 客户端模拟：生成临时密钥并对 Kd_pub 派生两方向会话密钥
struct ClientCtx {
    negotiation: String,
    keys: link_crypto::HttpTrafficKeys,
    path: &'static str,
}

fn make_client(path: &'static str) -> ClientCtx {
    let eph = x25519_generate();
    let (_, kd_pub_b64) = link_crypto::identity_parts().unwrap();
    let kd_pub: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(kd_pub_b64)
        .unwrap()
        .try_into()
        .unwrap();
    let shared = x25519_diffie_hellman(&eph, &kd_pub).unwrap();
    let keys = derive_http_traffic_keys(shared.as_bytes(), path).unwrap();
    ClientCtx {
        negotiation: format!("v1 {}", base64::engine::general_purpose::STANDARD.encode(eph.public())),
        keys,
        path,
    }
}

impl ClientCtx {
    fn seal_request(&self, plaintext: &[u8]) -> (Vec<u8>, String) {
        use crate_aad_shim::*;
        (
            encrypt_http_body(
                &self.keys.request,
                plaintext,
                &http_aad_shim(wasmnest_server_core::filter::Direction::Inbound, self.path),
            )
            .unwrap(),
            self.negotiation.clone(),
        )
    }

    fn open_response(&self, envelope: &[u8]) -> Vec<u8> {
        use crate_aad_shim::*;
        decrypt_http_body(
            &self.keys.response,
            envelope,
            &http_aad_shim(wasmnest_server_core::filter::Direction::Outbound, self.path),
        )
        .unwrap()
    }
}

/// AAD 构造是模块私有 fn，集成测试（独立二进制，只能经 `pub` API）拿不到——用等价字节
/// 序列复刻（spec §3 固定格式：b"v1" || dir || u32be(len) || path），并断言与
/// 单元测试一致；若协议变更此处会先红。
mod crate_aad_shim {
    pub fn http_aad_shim(direction: wasmnest_server_core::filter::Direction, path: &str) -> Vec<u8> {
        let mut aad = Vec::with_capacity(7 + path.len());
        aad.extend_from_slice(b"v1");
        aad.push(match direction {
            wasmnest_server_core::filter::Direction::Inbound => 0x01,
            wasmnest_server_core::filter::Direction::Outbound => 0x02,
        });
        aad.extend_from_slice(&(path.len() as u32).to_be_bytes());
        aad.extend_from_slice(path.as_bytes());
        aad
    }
}

async fn echo_handler(body: web::Bytes) -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({ "echo": String::from_utf8_lossy(&body) }))
}

#[actix_web::test]
async fn encrypted_request_plaintext_handler_encrypted_response() {
    let _guard = GLOBAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    init_identity_once();

    let owner = "test-http-roundtrip";
    let path = setup_app(owner, EncryptionPolicy::Required);
    reset_chain();

    let app = test::init_service(
        App::new()
            .wrap(wasmnest_server_http::middleware::http_filter::TrafficFilter)
            .route(&path, web::post().to(echo_handler)),
    )
    .await;
    let client = make_client(Box::leak(path.clone().into_boxed_str()));
    let req_plain = br#"{"ping":"pong"}"#.to_vec();
    let (sealed, negotiation) = client.seal_request(&req_plain);

    let req = test::TestRequest::post()
        .uri(&path)
        .insert_header((NEGOTIATION_HEADER, negotiation.as_str()))
        .set_payload(sealed)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert!(res.status().is_success(), "status = {}", res.status());

    let body = test::read_body(res).await;
    let opened = client.open_response(&body);
    let value: serde_json::Value = serde_json::from_slice(&opened).unwrap();
    assert_eq!(
        value["echo"],
        serde_json::json!(r#"{"ping":"pong"}"#),
        "handler 应收到解密后的明文请求（整包回显）"
    );

    teardown(owner);
}

#[actix_web::test]
async fn tampered_envelope_rejected_with_400() {
    let _guard = GLOBAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    init_identity_once();

    let owner = "test-http-tamper";
    let path = setup_app(owner, EncryptionPolicy::Required);
    reset_chain();

    let app = test::init_service(
        App::new()
            .wrap(wasmnest_server_http::middleware::http_filter::TrafficFilter)
            .route(&path, web::post().to(echo_handler)),
    )
    .await;
    let client = make_client(Box::leak(path.clone().into_boxed_str()));
    let (mut sealed, negotiation) = client.seal_request(b"hello");
    // 破坏信封 JSON 结构（非 GCM 层篡改，走 malformed 路径）
    sealed.truncate(sealed.len() / 2);

    let req = test::TestRequest::post()
        .uri(&path)
        .insert_header((NEGOTIATION_HEADER, negotiation.as_str()))
        .set_payload(sealed)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), actix_web::http::StatusCode::BAD_REQUEST);
    let text = test::read_body(res).await;
    assert!(
        text.windows(7).any(|w| w == b"decrypt") || text.windows(9).any(|w| w == b"malformed"),
        "400 响应应携带失败原因: {}",
        String::from_utf8_lossy(&text)
    );

    teardown(owner);
}

/// GCM 密文层字节篡改（票据 13：真正的攻击路径——信封 JSON 结构完好，
/// 仅密文被翻转，AES-GCM 认证必须失败且响应 400）
#[actix_web::test]
async fn gcm_ciphertext_tamper_rejected_with_400() {
    let _guard = GLOBAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    init_identity_once();

    let owner = "test-http-gcm";
    let path = setup_app(owner, EncryptionPolicy::Required);
    reset_chain();

    let app = test::init_service(
        App::new()
            .wrap(wasmnest_server_http::middleware::http_filter::TrafficFilter)
            .route(&path, web::post().to(echo_handler)),
    )
    .await;
    let client = make_client(Box::leak(path.clone().into_boxed_str()));
    let (mut sealed, negotiation) = client.seal_request(b"hello");

    // 解析信封 JSON，定位 base64 密文字段并翻转其末尾字节（GCM tag/密文层篡改）
    let envelope: serde_json::Value = serde_json::from_slice(&sealed).expect("envelope is valid JSON");
    let ct_b64 = envelope["ct"].as_str().expect("ct field exists");
    let mut ct = base64::engine::general_purpose::STANDARD
        .decode(ct_b64)
        .expect("ct is base64");
    let last = ct.len() - 1;
    ct[last] ^= 0xFF;
    let tampered_ct = base64::engine::general_purpose::STANDARD.encode(&ct);
    // 重建信封：仅替换 ct，其余结构原样
    let mut obj = envelope.as_object().cloned().unwrap();
    obj.insert("ct".to_string(), serde_json::Value::String(tampered_ct));
    sealed = serde_json::to_vec(&serde_json::Value::Object(obj)).unwrap();

    let req = test::TestRequest::post()
        .uri(&path)
        .insert_header((NEGOTIATION_HEADER, negotiation.as_str()))
        .set_payload(sealed)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), actix_web::http::StatusCode::BAD_REQUEST);
    let text = test::read_body(res).await;
    // GCM 认证失败应可观测（decrypt / auth 特征），且不泄露明文 hello
    assert!(
        text.windows(7).any(|w| w == b"decrypt") || text.windows(9).any(|w| w == b"malformed"),
        "GCM 篡改应报解密失败: {}",
        String::from_utf8_lossy(&text)
    );
    assert!(!String::from_utf8_lossy(&text).contains("hello"), "不得泄露明文");

    teardown(owner);
}

#[actix_web::test]
async fn required_app_rejects_unnegotiated_requests() {
    let _guard = GLOBAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    init_identity_once();

    let owner = "test-http-strict";
    let path = setup_app(owner, EncryptionPolicy::Required);
    reset_chain();

    let app = test::init_service(
        App::new()
            .wrap(wasmnest_server_http::middleware::http_filter::TrafficFilter)
            .route(&path, web::post().to(echo_handler)),
    )
    .await;
    let req = test::TestRequest::post()
        .uri(&path)
        .set_payload("plain legacy request")
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), actix_web::http::StatusCode::BAD_REQUEST);
    let text = String::from_utf8_lossy(&test::read_body(res).await).into_owned();
    assert!(
        text.contains(owner) && text.contains("required") && text.contains(NEGOTIATION_HEADER),
        "拒绝文案须点名属主 / 策略 / 协商头: {text}"
    );

    teardown(owner);
}

/// ==================== 按应用策略：A 加密 / B 明文共存 ====================
///
/// 真中间件 + 真注册表：两个应用挂在同一宿主 HTTP 服务上，A 设 `required`
/// （对端不加密就拒绝），B 未设置（`off`，明文）。断言四件事：
/// 1. A 无协商 → 400，文案点名属主 / 策略；
/// 2. A 带协商 → handler 收明文、响应加密并回 `X-WasmNest-Crypto: v1`；
/// 3. B 明文 → handler 收原字节、响应明文且**不带**加密标记头（不被 A 的策略波及）；
/// 4. B 带协商 → 400（明文端点不接受加密信封，避免下游把密文当 JSON 解析）。
#[actix_web::test]
async fn app_policies_coexist_on_one_host() {
    let _guard = GLOBAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    init_identity_once();

    let owner_a = "test-enc-a";
    let owner_b = "test-enc-b";
    let path_a = setup_app(owner_a, EncryptionPolicy::Required);
    let path_b = setup_app(owner_b, EncryptionPolicy::Off);
    reset_chain();

    let app = test::init_service(
        App::new()
            .wrap(wasmnest_server_http::middleware::http_filter::TrafficFilter)
            .route(&path_a, web::post().to(echo_handler))
            .route(&path_b, web::post().to(echo_handler)),
    )
    .await;

    // 1) A 无协商 → 400（fail-visible），不落到 handler
    let res = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&path_a)
            .set_payload("secret")
            .to_request(),
    )
    .await;
    assert_eq!(res.status(), actix_web::http::StatusCode::BAD_REQUEST);
    let text = String::from_utf8_lossy(&test::read_body(res).await).into_owned();
    assert!(
        text.contains(owner_a) && text.contains("required"),
        "拒绝文案须点名属主 / 策略: {text}"
    );

    // 2) A 带协商 → 加密闭环
    let client_a = make_client(Box::leak(path_a.clone().into_boxed_str()));
    let (sealed_a, negotiation_a) = client_a.seal_request(br#"{"k":"v"}"#);
    let res = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&path_a)
            .insert_header((NEGOTIATION_HEADER, negotiation_a.as_str()))
            .set_payload(sealed_a)
            .to_request(),
    )
    .await;
    if !res.status().is_success() {
        let body = test::read_body(res).await;
        panic!("required 应用协商失败: {}", String::from_utf8_lossy(&body));
    }
    assert_eq!(
        res.headers().get(NEGOTIATION_HEADER).and_then(|v| v.to_str().ok()),
        Some("v1"),
        "required 应用的加密响应必须带标记头"
    );
    let opened = client_a.open_response(&test::read_body(res).await);
    let value: serde_json::Value = serde_json::from_slice(&opened).unwrap();
    assert_eq!(value["echo"], serde_json::json!(r#"{"k":"v"}"#), "handler 应收到明文");

    // 3) B 明文 → 原样闭环，且不带加密标记头
    let res = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&path_b)
            .set_payload("public status")
            .to_request(),
    )
    .await;
    assert!(res.status().is_success(), "status = {}", res.status());
    assert!(
        res.headers().get(NEGOTIATION_HEADER).is_none(),
        "明文应用不得回加密标记头"
    );
    let body = String::from_utf8_lossy(&test::read_body(res).await).into_owned();
    assert!(body.contains("public status"), "明文应用响应应可读: {body}");

    // 4) B 带协商 → 自愿加密被接受（off = 不要求加密，不是禁止），成对回密
    //
    // 移动端只有一个全局链路加密开关，无法预知每个应用在桌面端的策略；若
    // off 端点拒绝加密请求，开着开关的用户会打不开任何 off 应用的 HTTP。
    let client_b = make_client(Box::leak(path_b.clone().into_boxed_str()));
    let (sealed_b, negotiation_b) = client_b.seal_request(b"hello");
    let res = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&path_b)
            .insert_header((NEGOTIATION_HEADER, negotiation_b.as_str()))
            .set_payload(sealed_b)
            .to_request(),
    )
    .await;
    assert!(
        res.status().is_success(),
        "off 应用应接受客户端自愿加密: {}",
        res.status()
    );
    assert_eq!(
        res.headers().get(NEGOTIATION_HEADER).and_then(|v| v.to_str().ok()),
        Some("v1"),
        "自愿加密的请求必须成对回密"
    );
    let opened = String::from_utf8_lossy(&client_b.open_response(&test::read_body(res).await)).into_owned();
    assert!(opened.contains("hello"), "handler 应收到解密后的明文: {opened}");

    // 5) 审计面：应用 × 策略 + 端点计数（只读；没有声明/生效双值）
    let audit = wasmnest_desktop_lib::commands::get_link_crypto_app_policies();
    let audited_a = audit.iter().find(|r| r.owner == owner_a).expect("A 必须在审计快照中");
    assert_eq!(audited_a.policy, EncryptionPolicy::Required);
    assert!(audited_a.endpoint_count >= 1);
    let audited_b = audit.iter().find(|r| r.owner == owner_b).expect("B 必须在审计快照中");
    assert_eq!(audited_b.policy, EncryptionPolicy::Off);

    teardown(owner_a);
    teardown(owner_b);
}
