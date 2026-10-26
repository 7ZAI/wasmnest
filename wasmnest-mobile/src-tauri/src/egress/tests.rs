// ==================== 单元测试 ====================

use super::policy::GRANT_PLUGIN_HOST;
use super::*;

/// `policy()` 是全局单例（OnceLock）：共享策略/记录/桌面目标状态的测试必须互斥执行。
/// Rust 测试默认并行，无锁会互相踩档位与记录（parallel-session 曾以「在途基线」挂账的 6 例失败）。
static POLICY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn parse_url_lite_basic() {
    let u = parse_url_lite("https://api.github.com/repos/x/y/releases/latest?per_page=1").unwrap();
    assert_eq!(u.scheme, "https");
    assert_eq!(u.host, "api.github.com");
    assert_eq!(u.port, None);
    assert_eq!(u.path, "/repos/x/y/releases/latest");

    let u = parse_url_lite("http://192.168.1.5:4455/api/health").unwrap();
    assert_eq!(u.scheme, "http");
    assert_eq!(u.host, "192.168.1.5");
    assert_eq!(u.port, Some(4455));
    assert_eq!(u.path, "/api/health");

    // 无 path → 默认 "/"
    let u = parse_url_lite("https://example.com").unwrap();
    assert_eq!(u.path, "/");
    // 非法 → None
    assert!(parse_url_lite("not-a-url").is_none());
    assert!(parse_url_lite("").is_none());
}

#[test]
fn url_pattern_parse_and_match() {
    // 完整模式
    let p = UrlPattern::parse("https://api.github.com/*").unwrap();
    assert_eq!(p.scheme.as_deref(), Some("https"));
    assert_eq!(p.host, "api.github.com");
    assert_eq!(p.path_prefix.as_deref(), Some("/"));
    assert!(p.matches(&parse_url_lite("https://api.github.com/repos/x").unwrap()));
    assert!(!p.matches(&parse_url_lite("http://api.github.com/repos/x").unwrap()));

    // 子域通配
    let p = UrlPattern::parse("https://*.openai.com/*").unwrap();
    assert!(p.wildcard_subdomain);
    assert!(p.matches(&parse_url_lite("https://api.openai.com/v1/chat").unwrap()));
    assert!(p.matches(&parse_url_lite("https://openai.com/x").unwrap()));
    assert!(!p.matches(&parse_url_lite("https://evilopenai.com/x").unwrap()));

    // 裸 host（scheme/port 任意）+ path 前缀
    let p = UrlPattern::parse("example.com/api").unwrap();
    assert!(p.scheme.is_none());
    assert!(p.matches(&parse_url_lite("https://example.com/api/v1/list").unwrap()));
    assert!(p.matches(&parse_url_lite("http://example.com/api").unwrap()));
    assert!(!p.matches(&parse_url_lite("https://example.com/other").unwrap()));

    // 非法
    assert!(UrlPattern::parse("").is_none());
    assert!(UrlPattern::parse("*.").is_none());
}

/// L2 宿主内置：GitHub API 放行（useUpdateChecker 路径）
#[test]
fn builtin_github_allowed() {
    let p = policy();
    assert!(matches!(
        p.decide(
            "https://api.github.com/repos/wasmnest/releases/latest",
            "useUpdateChecker"
        ),
        EgressDecision::Allow(GrantSource::L2Builtin)
    ));
    // 其它域名未声明 → NeedConsent
    assert!(matches!(
        p.decide("https://unknown.example.com/x", "useUpdateChecker"),
        EgressDecision::NeedConsent(_)
    ));
}

/// L1 桌面端目标：注入后放行；未注入 → NeedConsent
#[test]
fn l1_desktop_target_allowed() {
    let _guard = POLICY_LOCK.lock().unwrap();
    let p = policy();
    p.clear_desktop_targets();
    assert!(matches!(
        p.decide("http://192.168.1.5:4455/api/health", "host"),
        EgressDecision::NeedConsent(_)
    ));
    p.add_desktop_target("192.168.1.5", 4455);
    assert!(matches!(
        p.decide("http://192.168.1.5:4455/api/health", "host"),
        EgressDecision::Allow(GrantSource::L1Desktop)
    ));
    // 其它端口不算桌面端目标
    assert!(matches!(
        p.decide("http://192.168.1.5:9999/api/health", "host"),
        EgressDecision::NeedConsent(_)
    ));
    p.clear_desktop_targets();
}

// ==================== 跳转重校验 ====================

/// 公网跳转：跟随（首跳已过 L1/L2/L3，公网→公网无新增面）
#[test]
fn redirect_public_followed() {
    assert!(redirect_decision(
        "https://cdn.example.com/file",
        &["https://api.github.com/x"],
    ));
    assert!(redirect_decision("https://a.com", &[]));
}

/// SSRF 阻断：外网 302 → 内网/回环/链路本地（云元数据 169.254.169.254）Stop
#[test]
fn redirect_public_to_private_stopped() {
    assert!(!redirect_decision(
        "http://192.168.1.5:9999/api",
        &["https://api.example.com/x"],
    ));
    assert!(!redirect_decision(
        "http://127.0.0.1:8000/meta",
        &["https://api.example.com/x"],
    ));
    assert!(!redirect_decision(
        "http://169.254.169.254/latest/meta-data",
        &["https://api.example.com/x"],
    ));
    // 非法跳转目标 fail-closed
    assert!(!redirect_decision("not-a-url", &["https://api.example.com/x"]));
}

/// 私网合法跳转放行：已声明桌面端目标 / 同源 / 私网→私网链
#[test]
fn redirect_private_whitelisted() {
    let _guard = POLICY_LOCK.lock().unwrap();
    // 已声明桌面端目标
    policy().add_desktop_target("192.168.1.5", 4455);
    assert!(redirect_decision(
        "http://192.168.1.5:4455/api/other",
        &["https://api.example.com/x"],
    ));
    // 同源跳转（desktop 目标站内 302 到自身其它路径）
    assert!(redirect_decision(
        "http://192.168.1.5:4455/api/b",
        &["http://192.168.1.5:4455/api/a"],
    ));
    // 私网→私网链（NAS 站内跳转）
    assert!(redirect_decision(
        "http://192.168.1.9/x",
        &["http://192.168.1.5:4455/a"],
    ));
    // 公网链中存在私网前序仍阻断（混合链 fail-closed）
    assert!(!redirect_decision(
        "http://192.168.1.9/x",
        &["http://192.168.1.5:4455/a", "https://api.example.com/y"],
    ));
    policy().clear_desktop_targets();
}

/// L2 插件声明：注册后放行；卸载后拒绝
#[test]
fn plugin_declarations_registered_and_removed() {
    let _guard = POLICY_LOCK.lock().unwrap();
    let p = policy();
    p.register_plugin_urls(
        "com.wasmnest.ai-chatbox",
        &[
            "https://*.openai.com/*".to_string(),
            "https://api.deepseek.com/*".to_string(),
        ],
    );
    assert!(matches!(
        p.decide("https://api.openai.com/v1/chat/completions", "plugin:ai-chatbox"),
        EgressDecision::Allow(GrantSource::L2Plugin)
    ));
    assert!(matches!(
        p.decide("https://api.deepseek.com/chat/completions", "plugin:ai-chatbox"),
        EgressDecision::Allow(GrantSource::L2Plugin)
    ));
    // 未声明的其它域名 → NeedConsent
    assert!(matches!(
        p.decide("https://custom.example.com/v1", "plugin:ai-chatbox"),
        EgressDecision::NeedConsent(_)
    ));
    p.unregister_plugin_urls("com.wasmnest.ai-chatbox");
    assert!(matches!(
        p.decide("https://api.openai.com/v1/chat/completions", "plugin:ai-chatbox"),
        EgressDecision::NeedConsent(_)
    ));
}

/// L3 授权记忆：会话级 grant 放行 + 撤销后重新需要弹窗
#[test]
fn session_grant_memory() {
    let _guard = POLICY_LOCK.lock().unwrap();
    let p = policy();
    // 清空避免与持久文件互相干扰（测试环境无 init，persistent 为空）
    p.revoke_all_grants();
    assert!(matches!(
        p.decide("https://custom.example.com/api", "host"),
        EgressDecision::NeedConsent(_)
    ));
    p.record_grant(
        "custom.example.com",
        None,
        false,
        GRANT_PLUGIN_HOST,
        AUTH_EFFECT_ALLOW,
        AuthRecordSource::User,
    );
    assert!(matches!(
        p.decide("https://custom.example.com/api", "host"),
        EgressDecision::Allow(GrantSource::L3Memory)
    ));
    p.revoke_all_grants();
    assert!(matches!(
        p.decide("https://custom.example.com/api", "host"),
        EgressDecision::NeedConsent(_)
    ));
}

/// 会话级记录按完整维度保存：同 host 的 allow / deny 与不同 path 前缀不得互相覆盖
#[test]
fn session_grants_keep_distinct_dimensions() {
    let _guard = POLICY_LOCK.lock().unwrap();
    let p = policy();
    p.revoke_all_grants();

    // 同一 host：allow + deny 两条会话记录共存，deny 优先判定
    p.record_grant(
        "custom.example.com",
        None,
        false,
        GRANT_PLUGIN_HOST,
        AUTH_EFFECT_ALLOW,
        AuthRecordSource::User,
    );
    p.record_grant(
        "custom.example.com",
        None,
        false,
        GRANT_PLUGIN_HOST,
        AUTH_EFFECT_DENY,
        AuthRecordSource::UserDeny,
    );
    let grants = p.list_grants();
    assert!(grants
        .iter()
        .any(|g| g.host == "custom.example.com" && g.effect == AUTH_EFFECT_ALLOW));
    assert!(grants
        .iter()
        .any(|g| g.host == "custom.example.com" && g.effect == AUTH_EFFECT_DENY));
    assert!(matches!(
        p.decide("https://custom.example.com/api", "host"),
        EgressDecision::Deny(_)
    ));

    // 不同 path 前缀各自独立：/other 的 deny 不得覆盖 /api 的 allow
    p.revoke_all_grants();
    p.record_grant(
        "custom.example.com",
        Some("/api".to_string()),
        false,
        GRANT_PLUGIN_HOST,
        AUTH_EFFECT_ALLOW,
        AuthRecordSource::User,
    );
    p.record_grant(
        "custom.example.com",
        Some("/other".to_string()),
        false,
        GRANT_PLUGIN_HOST,
        AUTH_EFFECT_DENY,
        AuthRecordSource::UserDeny,
    );
    assert!(matches!(
        p.decide("https://custom.example.com/api/x", "host"),
        EgressDecision::Allow(GrantSource::L3Memory)
    ));
    assert!(matches!(
        p.decide("https://custom.example.com/other/x", "host"),
        EgressDecision::Deny(_)
    ));
    p.revoke_all_grants();
}

/// 非法 URL → fail-closed 拒绝（非弹窗——无法展示的 URL 不应打扰用户）
#[test]
fn malformed_url_denied() {
    let p = policy();
    match p.decide("not-a-url", "host") {
        EgressDecision::Deny(e) => assert_eq!(e.code, ERROR_URL_NOT_DECLARED),
        other => panic!("expected Deny, got {other:?}"),
    }
}

// ==================== 三档策略（ADR 0022 2026-09-28） ====================

/// 档位 → 动作映射单点：AlwaysAsk 不读记录；Default 读记录；AutoAllow 必须落账
#[test]
fn strategy_step_single_mapping() {
    assert_eq!(StrategyStep::of(AuthStrategy::AlwaysAsk), StrategyStep::ask());
    assert!(!StrategyStep::of(AuthStrategy::AlwaysAsk).reads_allow_records());
    assert!(!StrategyStep::of(AuthStrategy::AlwaysAsk).must_land_auto_allow());

    assert_eq!(StrategyStep::of(AuthStrategy::Default), StrategyStep::consult_records());
    assert!(StrategyStep::of(AuthStrategy::Default).reads_allow_records());
    assert!(!StrategyStep::of(AuthStrategy::Default).must_land_auto_allow());

    assert_eq!(StrategyStep::of(AuthStrategy::AlwaysAllow), StrategyStep::auto_allow());
    assert!(!StrategyStep::of(AuthStrategy::AlwaysAllow).reads_allow_records());
    assert!(StrategyStep::of(AuthStrategy::AlwaysAllow).must_land_auto_allow());
}

/// 未知档位值回落默认档（fail-safe，绝不猜成更宽松档位）
#[test]
fn unknown_strategy_parse_falls_back_to_default() {
    assert_eq!(AuthStrategy::parse("always_allowed"), AuthStrategy::Default);
    assert_eq!(AuthStrategy::parse(""), AuthStrategy::Default);
    // 写入面：未知值显性报错（None）
    assert_eq!(AuthStrategy::parse_wire("always_allowed"), None);
    assert_eq!(AuthStrategy::parse_wire("always_ask"), Some(AuthStrategy::AlwaysAsk));
}

/// 默认档：allow 记录命中 → 放行；未命中 → 弹窗
#[test]
fn default_tier_consults_records() {
    let _guard = POLICY_LOCK.lock().unwrap();
    let p = policy();
    p.revoke_all_grants();
    p.purge_plugin("plugin:com.wasmnest.demo");
    // 未命中 → NeedConsent
    assert!(matches!(
        p.decide("https://custom.example.com/api", "plugin:com.wasmnest.demo"),
        EgressDecision::NeedConsent(_)
    ));
    // 落 allow 记录 → 放行
    p.record_grant(
        "custom.example.com",
        None,
        true,
        "plugin:com.wasmnest.demo",
        AUTH_EFFECT_ALLOW,
        AuthRecordSource::User,
    );
    assert!(matches!(
        p.decide("https://custom.example.com/api", "plugin:com.wasmnest.demo"),
        EgressDecision::Allow(GrantSource::L3Memory)
    ));
    p.revoke_all_grants();
    p.purge_plugin("plugin:com.wasmnest.demo");
}

/// 总是询问档：跳过 allow 记录（有记录也弹窗）
#[test]
fn always_ask_tier_skips_records() {
    let _guard = POLICY_LOCK.lock().unwrap();
    let p = policy();
    p.revoke_all_grants();
    p.purge_plugin("plugin:com.wasmnest.demo");
    // 先落记录（默认档下会放行）
    p.record_grant(
        "custom.example.com",
        None,
        true,
        "plugin:com.wasmnest.demo",
        AUTH_EFFECT_ALLOW,
        AuthRecordSource::User,
    );
    // 切到总是询问 → 记录被跳过，仍弹窗
    p.set_plugin_strategy("plugin:com.wasmnest.demo", AuthStrategy::AlwaysAsk);
    assert!(matches!(
        p.decide("https://custom.example.com/api", "plugin:com.wasmnest.demo"),
        EgressDecision::NeedConsent(_)
    ));
    // 切回默认 → 记录生效
    p.set_plugin_strategy("plugin:com.wasmnest.demo", AuthStrategy::Default);
    assert!(matches!(
        p.decide("https://custom.example.com/api", "plugin:com.wasmnest.demo"),
        EgressDecision::Allow(GrantSource::L3Memory)
    ));
    p.revoke_all_grants();
    p.purge_plugin("plugin:com.wasmnest.demo");
}

/// 始终允许档：免询问放行 + 落 always_allow 审计记录（界面标「未经确认」）
#[test]
fn always_allow_tier_lands_audit_record() {
    let _guard = POLICY_LOCK.lock().unwrap();
    let p = policy();
    p.revoke_all_grants();
    p.purge_plugin("plugin:com.wasmnest.demo");
    p.set_plugin_strategy("plugin:com.wasmnest.demo", AuthStrategy::AlwaysAllow);
    // 未命中任何记录也直接放行
    assert!(matches!(
        p.decide("https://custom.example.com/api", "plugin:com.wasmnest.demo"),
        EgressDecision::Allow(GrantSource::L3Memory)
    ));
    // 落账：source = always_allow
    let grants = p.list_grants();
    assert!(grants.iter().any(|g| {
        g.host == "custom.example.com"
            && g.effect == AUTH_EFFECT_ALLOW
            && g.source == AuthRecordSource::AlwaysAllow.as_str()
    }));
    p.revoke_all_grants();
    p.purge_plugin("plugin:com.wasmnest.demo");
}

/// deny 记录优先于一切放行路径（含 always_allow 档）
#[test]
fn deny_record_beats_always_allow() {
    let _guard = POLICY_LOCK.lock().unwrap();
    let p = policy();
    p.revoke_all_grants();
    p.purge_plugin("plugin:com.wasmnest.demo");
    p.set_plugin_strategy("plugin:com.wasmnest.demo", AuthStrategy::AlwaysAllow);
    p.record_grant(
        "custom.example.com",
        None,
        true,
        "plugin:com.wasmnest.demo",
        AUTH_EFFECT_DENY,
        AuthRecordSource::UserDeny,
    );
    // always_allow 也放行不了 deny 记录
    assert!(matches!(
        p.decide("https://custom.example.com/api", "plugin:com.wasmnest.demo"),
        EgressDecision::Deny(_)
    ));
    // 另一 host 不受影响（仍 always_allow 放行）
    assert!(matches!(
        p.decide("https://other.example.com/api", "plugin:com.wasmnest.demo"),
        EgressDecision::Allow(_)
    ));
    p.revoke_all_grants();
    p.purge_plugin("plugin:com.wasmnest.demo");
}

/// 插件隔离：A 插件的记录/策略不影响 B 插件
#[test]
fn plugin_records_isolated() {
    let _guard = POLICY_LOCK.lock().unwrap();
    let p = policy();
    p.revoke_all_grants();
    p.purge_plugin("plugin:a");
    p.purge_plugin("plugin:b");
    p.record_grant(
        "custom.example.com",
        None,
        true,
        "plugin:a",
        AUTH_EFFECT_ALLOW,
        AuthRecordSource::User,
    );
    assert!(matches!(
        p.decide("https://custom.example.com/api", "plugin:a"),
        EgressDecision::Allow(GrantSource::L3Memory)
    ));
    assert!(matches!(
        p.decide("https://custom.example.com/api", "plugin:b"),
        EgressDecision::NeedConsent(_)
    ));
    p.revoke_all_grants();
    p.purge_plugin("plugin:a");
    p.purge_plugin("plugin:b");
}

/// 生命周期：卸载插件清空策略 + 记录（重装即全新授权）
#[test]
fn purge_plugin_clears_strategy_and_records() {
    let _guard = POLICY_LOCK.lock().unwrap();
    let p = policy();
    p.revoke_all_grants();
    p.purge_plugin("plugin:com.wasmnest.demo");
    p.set_plugin_strategy("plugin:com.wasmnest.demo", AuthStrategy::AlwaysAllow);
    p.record_grant(
        "custom.example.com",
        None,
        true,
        "plugin:com.wasmnest.demo",
        AUTH_EFFECT_ALLOW,
        AuthRecordSource::AlwaysAllow,
    );
    // 卸载前：always_allow 放行
    assert!(matches!(
        p.decide("https://custom.example.com/api", "plugin:com.wasmnest.demo"),
        EgressDecision::Allow(_)
    ));
    // 卸载：策略 + 记录清空
    p.purge_plugin("plugin:com.wasmnest.demo");
    assert_eq!(p.strategy_for("plugin:com.wasmnest.demo"), AuthStrategy::Default);
    assert!(p.list_grants().is_empty());
    assert!(matches!(
        p.decide("https://custom.example.com/api", "plugin:com.wasmnest.demo"),
        EgressDecision::NeedConsent(_)
    ));
    p.revoke_all_grants();
}
