//! Egress 判定类型、授权策略（三档）、授权记忆与策略引擎（全局单例）

use super::*;

// ==================== 判定结果与错误 ====================

/// 放行来源（日志/审计用）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantSource {
    /// L1：桌面端目标
    L1Desktop,
    /// L2：宿主内置声明
    L2Builtin,
    /// L2：插件 preauthUrls 声明
    L2Plugin,
    /// L3：授权记忆（会话/持久）命中
    L3Memory,
}

/// 弹窗事务请求（调用方携带 request_id 发起；前端按 request_id 回执）
#[derive(Debug, Clone)]
pub struct ConsentRequest {
    /// 弹窗事务 id（复用调用方 request_id，随事件下发并回执）
    pub id: String,
    pub url: String,
    pub host: String,
    pub path: String,
    /// 调用方来源（宿主 useUpdateChecker / 插件 ai-chatbox 等）
    pub source: String,
}

/// Egress 拒绝错误（fail-closed；code 为错误码常量）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EgressError {
    pub code: &'static str,
    pub url: String,
}

impl EgressError {
    /// 未声明（任何声明/记忆均未命中）
    pub fn not_declared(url: &str) -> Self {
        Self {
            code: ERROR_URL_NOT_DECLARED,
            url: url.to_string(),
        }
    }

    /// 用户拒绝（弹窗 deny / 超时）
    pub fn denied(url: &str) -> Self {
        Self {
            code: ERROR_URL_DENIED,
            url: url.to_string(),
        }
    }
}

/// Egress 判定结果
#[derive(Debug)]
pub enum EgressDecision {
    /// 放行（记录来源）
    Allow(GrantSource),
    /// 需授权弹窗（调用方应发起 consent 流程；超时/拒绝 → Deny）
    NeedConsent(ConsentRequest),
    /// 拒绝（fail-closed；错误码见 EgressError.code）
    Deny(EgressError),
}

// ==================== 授权策略（三档，ADR 0022 2026-09-28 节对齐） ====================

/// 授权策略档位（每插件 × network 资源；与桌面 `security::auth_policy::AuthStrategy` 同形）
///
/// 裁决要点（ADR 0022）：策略只回答一件事——遇到授权记录**未覆盖**的目标时，
/// 要不要问用户。它不是业务默认值（B5 不命中），是安全闸门（薄壳②）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthStrategy {
    /// 总是询问：跳过全部 allow 记录，每次判定都问（deny 记录仍优先）
    AlwaysAsk,
    /// 默认：记录命中即放行，未命中才问
    Default,
    /// 始终允许：不问直接放行，并以 `source='always_allow'` 落账（免询问也留痕）
    AlwaysAllow,
}

impl AuthStrategy {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AlwaysAsk => "always_ask",
            Self::Default => "default",
            Self::AlwaysAllow => "always_allow",
        }
    }

    /// 解析 wire 值；未知值返回 `None`（**写入面**用显性报错，不猜档位）
    ///
    /// 与读面 [`AuthStrategy::parse`] 的兜底方向相反：`always_allow` 手误成
    /// `always_allowed` 若被判成默认档存下去，用户看到的是「设置成功」而实际
    /// 档位没生效——策略界面骗人比报错严重得多。
    pub fn parse_wire(raw: &str) -> Option<Self> {
        match raw {
            "always_ask" => Some(Self::AlwaysAsk),
            "default" => Some(Self::Default),
            "always_allow" => Some(Self::AlwaysAllow),
            _ => None,
        }
    }

    /// 解析库值：**未知值一律回落 [`AuthStrategy::Default`]**
    ///
    /// fail-safe 方向的单点：不认识的档位绝不能等价于「免询问自动放行」，
    /// 也不能等价于「跳过记录」——两者都比默认档更宽松。取值词汇表只有
    /// [`AuthStrategy::parse_wire`] 一处，两处各拼一套必然漂移。
    pub fn parse(raw: &str) -> Self {
        Self::parse_wire(raw).unwrap_or(Self::Default)
    }
}

/// 档位本体（动作语义；副作用标志见 [`StrategyStep`] 字段）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// 总是询问：**跳过全部 allow 记录**，每次判定都问
    Ask,
    /// 默认：读 allow 记录，命中即放行，未命中才问
    ConsultRecords,
    /// 始终允许：免询问直接放行，并以 `source='always_allow'` 落账
    AutoAllow,
}

/// 策略层给出的下一步（档位 → 动作映射的**单点**；票 19 防回接锁目标）
///
/// struct 而非 unit enum：档位副作用（读不读 allow 记录、是否必须落
/// always_allow 审计）是随档位携带的一等字段，消费方无需在注释里记住义务——
/// `must_land_auto_allow()` 就在结构体上。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StrategyStep {
    tier: Tier,
    /// 判定时是否读 allow 记录（镜像：弹窗给不给「记住」；`Ask` 恒 false）
    reads_allow_records: bool,
    /// 是否必须落 always_allow 审计记录（`AutoAllow` 恒 true；审计是档位义务，
    /// 不是可选项——不留痕的管理界面在最高风险档上出现不可见空洞）
    must_land_auto_allow: bool,
}

impl StrategyStep {
    /// 档位 → 动作（**唯一**映射点）
    pub const fn of(strategy: AuthStrategy) -> Self {
        match strategy {
            AuthStrategy::AlwaysAsk => Self::ask(),
            AuthStrategy::Default => Self::consult_records(),
            AuthStrategy::AlwaysAllow => Self::auto_allow(),
        }
    }

    pub const fn ask() -> Self {
        Self {
            tier: Tier::Ask,
            reads_allow_records: false,
            must_land_auto_allow: false,
        }
    }

    pub const fn consult_records() -> Self {
        Self {
            tier: Tier::ConsultRecords,
            reads_allow_records: true,
            must_land_auto_allow: false,
        }
    }

    pub const fn auto_allow() -> Self {
        Self {
            tier: Tier::AutoAllow,
            reads_allow_records: false,
            must_land_auto_allow: true,
        }
    }

    /// 档位本体（match 分派用）
    pub const fn tier(&self) -> Tier {
        self.tier
    }

    /// 该步是否「读授权记录」——判定时读不读 allow 记录、询问层给不给「记住」
    ///
    /// 两者必须同向："总是询问"档既然跳过记录，就不能再让弹窗落一条以后不会被
    /// 读到的记录。`AutoAllow` 不读记录但**仍写审计**——读/写是两个独立义务。
    pub const fn reads_allow_records(self) -> bool {
        self.reads_allow_records
    }

    /// 是否必须落 always_allow 审计记录（`AutoAllow` 恒 true）
    pub const fn must_land_auto_allow(self) -> bool {
        self.must_land_auto_allow
    }

    /// 日志用的层名（排障要能一眼看出这次判定走的是哪一支）
    pub const fn as_str(self) -> &'static str {
        match self.tier {
            Tier::Ask => "always-ask",
            Tier::ConsultRecords => "default",
            Tier::AutoAllow => "always-allow",
        }
    }
}

/// 授权记录来源（写入口径的单点：来源取值只在这里拼）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthRecordSource {
    /// 用户在弹窗里确认并「记住」
    User,
    /// `always_allow` 档免询问自动放行（界面标「未经确认」）
    AlwaysAllow,
    /// 用户显式拒绝（弹窗「以后都拒绝」或管理界面撤销）
    UserDeny,
}

impl AuthRecordSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::AlwaysAllow => "always_allow",
            Self::UserDeny => "user_deny",
        }
    }
}

/// 记录效果取值（写入口径单点）
///
/// `deny` 记录优先于一切放行路径（含策略档位与 allow 记录，ADR 0022 spec §6.1）。
pub const AUTH_EFFECT_ALLOW: &str = "allow";
pub const AUTH_EFFECT_DENY: &str = "deny";

/// 一条授权记录（设置页展示 + 判定匹配；与桌面 `security::auth_policy::AuthRecord` 同形）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRecord {
    /// 所属插件（`plugin:{id}` 归一化；`host` = 宿主调用）
    pub plugin_id: String,
    /// `allow` | `deny`
    pub effect: String,
    /// 归一化 host（精确；小写）
    pub target: String,
    /// 可选 path 前缀（None = 全部路径）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_prefix: Option<String>,
    /// `user` | `always_allow` | `user_deny`
    pub source: String,
    /// unix 秒
    pub created_at: u64,
}

// ==================== 授权记忆 ====================

/// 持久授权条目（egress_grants.json；「不再询问」勾选落盘）
///
/// 字段演进兼容：旧文件只有 host/path_prefix/allowed_at，新字段一律 serde default。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PersistentGrant {
    /// 授权的 host（精确；小写）
    pub host: String,
    /// 可选 path 前缀（None = 全部路径）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_prefix: Option<String>,
    /// 授权时间（unix 秒；设置页展示）
    pub allowed_at: u64,
    /// 所属插件（旧文件缺省 → 视为宿主全局授权，[`GRANT_PLUGIN_HOST`]）
    #[serde(default = "default_grant_plugin_host")]
    pub plugin_id: String,
    /// `allow` | `deny`（旧文件缺省 → allow）
    #[serde(default = "default_grant_effect_allow")]
    pub effect: String,
    /// 记录来源（旧文件缺省 → user）
    #[serde(default = "default_grant_source_user")]
    pub source: String,
}

/// 宿主全局调用方（`http_request` kind=external 的 `source="host"`；无策略档位）
pub(super) const GRANT_PLUGIN_HOST: &str = "host";

fn default_grant_plugin_host() -> String {
    GRANT_PLUGIN_HOST.to_string()
}
fn default_grant_effect_allow() -> String {
    AUTH_EFFECT_ALLOW.to_string()
}
fn default_grant_source_user() -> String {
    AuthRecordSource::User.as_str().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PersistentGrantStore {
    #[serde(default)]
    grants: Vec<PersistentGrant>,
}

/// 前端弹窗回执
#[derive(Debug, Clone, Copy)]
pub struct ConsentVerdict {
    pub allow: bool,
    /// 用户勾选「不再询问」→ 持久记忆
    pub persist: bool,
    /// 用户勾选「以后都拒绝」→ 落 deny 记录（fail-safe：显式拒绝优先于一切）
    pub deny: bool,
}

// ==================== Egress 策略引擎 ====================

/// Egress 策略引擎（全局单例；Rust 端裁决）
pub struct EgressPolicy {
    /// L1：桌面端目标 host:port 集合（连接模块注入；probe/connect 时 add）
    desktop_targets: StdRwLock<HashSet<(String, u16)>>,
    /// L2：插件 preauthUrls 声明（plugin_id → 模式列表；插件卸载时移除）
    plugin_patterns: StdRwLock<HashMap<String, Vec<UrlPattern>>>,
    /// L3：会话级授权（本次连接有效，连接断开/撤销时清空）
    session_grants: StdRwLock<Vec<PersistentGrant>>,
    /// L3：持久授权（加载自 GRANTS_FILE；「不再询问」落盘）
    persistent_grants: StdRwLock<Vec<PersistentGrant>>,
    /// 三档策略：plugin_id → 档位（缺省 = [`AuthStrategy::Default`]，fail-safe）
    plugin_strategies: StdRwLock<HashMap<String, AuthStrategy>>,
    /// 持久文件路径（init 时设置）
    grants_path: StdRwLock<Option<PathBuf>>,
    /// 策略文件路径（init 时设置；egress_policy.json）
    strategy_path: StdRwLock<Option<PathBuf>>,
    /// 弹窗桥：request_id → 前端回执通道
    pending_consents: tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<ConsentVerdict>>>,
}

impl EgressPolicy {
    fn new() -> Self {
        Self {
            desktop_targets: StdRwLock::new(HashSet::new()),
            plugin_patterns: StdRwLock::new(HashMap::new()),
            session_grants: StdRwLock::new(Vec::new()),
            persistent_grants: StdRwLock::new(Vec::new()),
            plugin_strategies: StdRwLock::new(HashMap::new()),
            grants_path: StdRwLock::new(None),
            strategy_path: StdRwLock::new(None),
            pending_consents: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    // ---------- L1：桌面端目标注入 ----------

    /// 注入/更新桌面端目标 host:port（setApiBaseUrl / probe / ws_connect 时调用）。
    /// 集合式维护：probe 阶段（ws_connect 前）也可放行，解决 httpProbe 时序。
    pub fn add_desktop_target(&self, host: &str, port: u16) {
        self.desktop_targets
            .write()
            .unwrap()
            .insert((host.to_lowercase(), port));
        tracing::debug!(host = %host, port = %port, "egress: desktop target registered");
    }

    /// 清空桌面端目标（断开/重置连接时调用）
    pub fn clear_desktop_targets(&self) {
        self.desktop_targets.write().unwrap().clear();
    }

    /// 是否命中 L1 桌面端目标（http_request kind=desktop 校验用；
    /// port 缺省不命中——桌面端 HTTP 服务必有自定义端口）
    pub fn is_desktop_target(&self, host: &str, port: Option<u16>) -> bool {
        match port {
            Some(p) => self.desktop_targets.read().unwrap().contains(&(host.to_lowercase(), p)),
            None => false,
        }
    }

    // ---------- L2：插件声明注册 ----------

    /// 注册插件 preauthUrls 声明（插件加载时调用；失败模式静默跳过非法项）
    pub fn register_plugin_urls(&self, plugin_id: &str, patterns: &[String]) {
        let parsed: Vec<UrlPattern> = patterns.iter().filter_map(|p| UrlPattern::parse(p)).collect();
        tracing::info!(
            plugin_id = %plugin_id,
            declared = %patterns.len(),
            parsed = %parsed.len(),
            "egress: plugin url declarations registered"
        );
        self.plugin_patterns
            .write()
            .unwrap()
            .insert(plugin_id.to_string(), parsed);
    }

    /// 移除插件声明（插件卸载时调用）
    pub fn unregister_plugin_urls(&self, plugin_id: &str) {
        self.plugin_patterns.write().unwrap().remove(plugin_id);
        tracing::debug!(plugin_id = %plugin_id, "egress: plugin url declarations removed");
    }

    // ---------- 三档策略（每插件 × network） ----------

    /// 读取插件策略档位（缺省 = 默认档；未识别的库值回落默认档，fail-safe）
    pub fn strategy_for(&self, plugin_id: &str) -> AuthStrategy {
        self.plugin_strategies
            .read()
            .unwrap()
            .get(plugin_id)
            .copied()
            .unwrap_or(AuthStrategy::Default)
    }

    /// 设置插件策略档位（写入面：未知值显性报错，不猜档位——见 [`AuthStrategy::parse_wire`]）
    pub fn set_plugin_strategy(&self, plugin_id: &str, strategy: AuthStrategy) {
        self.plugin_strategies
            .write()
            .unwrap()
            .insert(plugin_id.to_string(), strategy);
        self.save_plugin_strategies();
        tracing::info!(
            plugin_id = %plugin_id,
            strategy = %strategy.as_str(),
            "egress: plugin strategy updated"
        );
    }

    /// 卸载插件：清策略 + 清记录（重装即全新授权，ADR 0022 §8 生命周期）
    pub fn purge_plugin(&self, plugin_id: &str) {
        self.plugin_strategies.write().unwrap().remove(plugin_id);
        self.save_plugin_strategies();
        self.persistent_grants
            .write()
            .unwrap()
            .retain(|g| g.plugin_id != plugin_id);
        self.session_grants
            .write()
            .unwrap()
            .retain(|g| g.plugin_id != plugin_id);
        self.save_persistent_grants();
        self.unregister_plugin_urls(plugin_id);
        tracing::info!(plugin_id = %plugin_id, "egress: plugin strategy and records purged");
    }

    /// 策略持久文件（egress_policy.json）：`{ "plugins": { id: "always_ask" | "default" | "always_allow" } }`
    fn save_plugin_strategies(&self) {
        let path = match self.strategy_path.read().unwrap().clone() {
            Some(p) => p,
            None => return,
        };
        let strategies = self.plugin_strategies.read().unwrap().clone();
        let map: HashMap<String, &str> = strategies.iter().map(|(k, v)| (k.clone(), v.as_str())).collect();
        let content = match serde_json::to_string_pretty(&map) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("egress: serialize strategies failed: {}", e);
                return;
            }
        };
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                tracing::error!(error = %e, "egress: create strategy dir failed");
                return;
            }
        }
        if let Err(e) = std::fs::write(&path, content) {
            tracing::error!(error = %e, path = %path.display(), "egress: save strategies failed");
        }
    }

    // ---------- L3：授权记忆（allow / deny 记录） ----------

    /// 记录命中判定（host + 可选 path 前缀；只匹配指定 effect）
    fn record_hit(&self, host: &str, path: &str, plugin_id: &str, effect: &str) -> bool {
        let hit = |g: &PersistentGrant| {
            g.effect == effect
                && g.plugin_id == plugin_id
                && g.host == host
                && match &g.path_prefix {
                    Some(prefix) => path.starts_with(prefix),
                    None => true,
                }
        };
        self.persistent_grants.read().unwrap().iter().any(hit) || self.session_grants.read().unwrap().iter().any(hit)
    }

    /// 记忆授权（L3 命中后调用）：persist=true 落盘（「不再询问」），否则会话级。
    /// `source`：`user` | `always_allow` | `user_deny`（写入口径单点）。
    pub(super) fn record_grant(
        &self,
        host: &str,
        path_prefix: Option<String>,
        persist: bool,
        plugin_id: &str,
        effect: &str,
        source: AuthRecordSource,
    ) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let grant = PersistentGrant {
            host: host.to_string(),
            path_prefix,
            allowed_at: now,
            plugin_id: plugin_id.to_string(),
            effect: effect.to_string(),
            source: source.as_str().to_string(),
        };
        if persist {
            self.persistent_grants.write().unwrap().push(grant.clone());
            self.save_persistent_grants();
        } else {
            // 会话记录按完整维度保存：同 host 的不同 path 前缀 / effect / 插件
            // 各自独立，不能以 host 为 key 互相覆盖（deny 与 allow 必须共存才
            // 能维持「拒绝优先」判定）。
            let mut grants = self.session_grants.write().unwrap();
            grants.retain(|g| {
                !(g.host == grant.host
                    && g.path_prefix == grant.path_prefix
                    && g.plugin_id == grant.plugin_id
                    && g.effect == grant.effect)
            });
            grants.push(grant);
        }
        tracing::info!(
            host = %host,
            plugin_id = %plugin_id,
            effect = %effect,
            source = %source.as_str(),
            persist = %persist,
            "egress: record landed"
        );
    }

    /// 撤销全部授权（设置页「撤销」；清会话 + 清持久文件）
    pub fn revoke_all_grants(&self) {
        self.session_grants.write().unwrap().clear();
        self.persistent_grants.write().unwrap().clear();
        self.save_persistent_grants();
        tracing::info!("egress: all grants revoked");
    }

    /// 撤销单条记录（设置页逐条撤销；deny 与 allow 都可移除）
    pub fn revoke_grant(&self, host: &str, plugin_id: &str) -> bool {
        let mut removed_persistent = false;
        {
            let mut grants = self.persistent_grants.write().unwrap();
            if grants.iter().any(|g| g.host == host && g.plugin_id == plugin_id) {
                grants.retain(|g| !(g.host == host && g.plugin_id == plugin_id));
                removed_persistent = true;
            }
        }
        let mut removed_session = false;
        {
            let mut grants = self.session_grants.write().unwrap();
            if grants.iter().any(|g| g.host == host && g.plugin_id == plugin_id) {
                grants.retain(|g| !(g.host == host && g.plugin_id == plugin_id));
                removed_session = true;
            }
        }
        if removed_persistent {
            self.save_persistent_grants();
        }
        tracing::info!(host = %host, plugin_id = %plugin_id, "egress: grant revoked");
        removed_persistent || removed_session
    }

    /// 列出全部授权（会话 + 持久；设置页展示）
    pub fn list_grants(&self) -> Vec<PersistentGrant> {
        let mut grants: Vec<PersistentGrant> = self.session_grants.read().unwrap().clone();
        grants.extend(self.persistent_grants.read().unwrap().iter().cloned());
        grants
    }

    /// 列出全部授权记录（会话 + 持久；设置页展示，含来源/效果/插件维度）
    pub fn list_records(&self) -> Vec<AuthRecord> {
        let mut records: Vec<AuthRecord> = self
            .session_grants
            .read()
            .unwrap()
            .iter()
            .chain(self.persistent_grants.read().unwrap().iter())
            .map(|g| AuthRecord {
                plugin_id: g.plugin_id.clone(),
                effect: g.effect.clone(),
                target: g.host.clone(),
                path_prefix: g.path_prefix.clone(),
                source: g.source.clone(),
                created_at: g.allowed_at,
            })
            .collect();
        // 稳定排序：插件 → 时间（设置页展示顺序稳定，不依赖 HashMap 遍历序）
        records.sort_by(|a, b| a.plugin_id.cmp(&b.plugin_id).then(a.created_at.cmp(&b.created_at)));
        records
    }

    /// 持久授权落盘（egress_grants.json；失败仅告警，不阻断放行）
    fn save_persistent_grants(&self) {
        let path = match self.grants_path.read().unwrap().clone() {
            Some(p) => p,
            None => return,
        };
        let store = PersistentGrantStore {
            grants: self.persistent_grants.read().unwrap().clone(),
        };
        let content = match serde_json::to_string_pretty(&store) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("egress: serialize grants failed: {}", e);
                return;
            }
        };
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                tracing::error!(error = %e, "egress: create grants dir failed");
                return;
            }
        }
        if let Err(e) = std::fs::write(&path, content) {
            tracing::error!(error = %e, path = %path.display(), "egress: save grants failed");
        }
    }

    // ---------- 弹窗桥 ----------

    /// 发起授权弹窗并等待前端回执（超时视为拒绝，fail-closed）。
    /// 调用方（http_request / 插件 host_http_fetch）传入自己的 request_id。
    pub async fn request_consent(&self, app: &tauri::AppHandle, request: ConsentRequest) -> Result<bool> {
        use tauri::Emitter;
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending_consents.lock().await.insert(request.id.clone(), tx);
        let payload = serde_json::json!({
            "request_id": request.id,
            "url": request.url,
            "host": request.host,
            "path": request.path,
            "source": request.source,
        });
        app.emit("egress_consent_request", payload)
            .map_err(|e| AppError::Egress(format!("egress consent emit failed: {e}")))?;
        tracing::info!(
            request_id = %request.id,
            host = %request.host,
            source = %request.source,
            "egress: consent requested"
        );
        match tokio::time::timeout(CONSENT_TIMEOUT, rx).await {
            Ok(Ok(verdict)) => {
                if verdict.allow {
                    self.record_grant(
                        &request.host,
                        None,
                        verdict.persist,
                        &request.source,
                        AUTH_EFFECT_ALLOW,
                        AuthRecordSource::User,
                    );
                    Ok(true)
                } else if verdict.deny {
                    // 用户显式「以后都拒绝」→ 落 deny 记录（fail-safe：deny 优先于一切放行）
                    self.record_grant(
                        &request.host,
                        None,
                        true,
                        &request.source,
                        AUTH_EFFECT_DENY,
                        AuthRecordSource::UserDeny,
                    );
                    tracing::warn!(request_id = %request.id, "egress: consent denied by user (persistent deny)");
                    Ok(false)
                } else {
                    tracing::warn!(request_id = %request.id, "egress: consent denied by user");
                    Ok(false)
                }
            }
            Ok(Err(_)) | Err(_) => {
                // 通道断 / 超时 → 拒绝 + 清理，防 map 膨胀
                self.pending_consents.lock().await.remove(&request.id);
                tracing::warn!(request_id = %request.id, "egress: consent timeout or channel closed");
                Ok(false)
            }
        }
    }

    /// 前端回执（egress_consent_resolve 命令调用）；request_id 不存在返回 false
    pub async fn resolve_consent(&self, request_id: &str, allow: bool, persist: bool, deny: bool) -> bool {
        let mut pending = self.pending_consents.lock().await;
        match pending.remove(request_id) {
            Some(tx) => {
                let _ = tx.send(ConsentVerdict { allow, persist, deny });
                true
            }
            None => false,
        }
    }

    // ---------- 核心判定 ----------

    /// 判定管线（同步；对齐 ADR 0022 2026-09-28 spec §6.1 顺序）：
    ///
    /// ```text
    /// 0. manifest 声明门（权限位）      —— 资源侧（host_impl/http.rs 已先于本函数执行）
    /// 1. L1 桌面端目标                   —— 固定层（优先于策略档位）
    /// 2. L2 声明（宿主内置 + 插件 preauthUrls）—— 固定层
    /// 3. 硬拒绝记录命中                  —— deny 优先于一切放行路径
    /// 4. 策略层（三档；实时读取）        —— 本模块 StrategyStep::of
    /// 5. allow 记录命中（仅默认档读）     —— 总是询问档已跳过
    /// 6. 询问用户                         —— 未命中 → NeedConsent（fail-closed）
    /// ```
    ///
    /// `source`：调用方来源描述（宿主 useUpdateChecker / 插件 `plugin:{id}` 等）。
    /// 插件来源按 `plugin:` 前缀取策略档位；宿主来源恒默认档（L2 固定层已覆盖其主流）。
    pub fn decide(&self, url: &str, source: &str) -> EgressDecision {
        let parsed = match parse_url_lite(url) {
            Some(p) => p,
            None => {
                return EgressDecision::Deny(EgressError::not_declared(url));
            }
        };

        // 第 1 步：L1 桌面端目标（配对/会话内，无需声明）
        {
            let targets = self.desktop_targets.read().unwrap();
            if let Some(port) = parsed.port {
                if targets.contains(&(parsed.host.clone(), port)) {
                    return EgressDecision::Allow(GrantSource::L1Desktop);
                }
            }
        }

        // 第 2 步：L2 宿主内置声明
        let builtin_hit = HOST_BUILTIN_URL_PATTERNS
            .iter()
            .filter_map(|p| UrlPattern::parse(p))
            .any(|p| p.matches(&parsed));
        if builtin_hit {
            return EgressDecision::Allow(GrantSource::L2Builtin);
        }

        // 第 2 步：L2 插件 preauthUrls 声明
        let plugin_hit = self
            .plugin_patterns
            .read()
            .unwrap()
            .values()
            .flatten()
            .any(|p| p.matches(&parsed));
        if plugin_hit {
            return EgressDecision::Allow(GrantSource::L2Plugin);
        }

        // 策略归属：`plugin:{id}` 来源保留完整前缀（记录/档位存储口径 = 带 `plugin:` 前缀，
        // 见 record_grant / set_plugin_strategy——此前 strip_prefix 去前缀导致记录永远匹配不上）；
        // 其余（host / useUpdateChecker）归一为 GRANT_PLUGIN_HOST（宿主全局记录以 "host" 存储）
        let plugin_id = if source.starts_with("plugin:") {
            source
        } else {
            GRANT_PLUGIN_HOST
        };

        // 第 3 步：硬拒绝记录优先于一切放行路径（ADR 0022 spec §6.1 第 1 步）
        if self.record_hit(&parsed.host, &parsed.path, plugin_id, AUTH_EFFECT_DENY) {
            tracing::info!(
                plugin_id = %plugin_id,
                host = %parsed.host,
                "egress: deny record hit, not prompting"
            );
            return EgressDecision::Deny(EgressError::denied(url));
        }

        // 第 4 步：策略层（三档；实时读取）
        let step = StrategyStep::of(self.strategy_for(plugin_id));
        match step.tier() {
            // 始终允许：免询问放行 + 以 `source='always_allow'` 落账（审计是档位义务）
            Tier::AutoAllow => {
                debug_assert!(step.must_land_auto_allow(), "AutoAllow 档位字段丢失审计义务");
                self.record_grant(
                    &parsed.host,
                    None,
                    true,
                    plugin_id,
                    AUTH_EFFECT_ALLOW,
                    AuthRecordSource::AlwaysAllow,
                );
                return EgressDecision::Allow(GrantSource::L3Memory);
            }
            // 总是询问：跳过全部 allow 记录直接进询问
            Tier::Ask => {
                tracing::debug!(
                    plugin_id = %plugin_id,
                    host = %parsed.host,
                    "egress: always-ask tier, skipping allow records"
                );
            }
            Tier::ConsultRecords => {}
        }

        // 第 5 步：allow 记录命中（**仅默认档读记录**——总是询问在此之前已跳过）
        if step.reads_allow_records() && self.record_hit(&parsed.host, &parsed.path, plugin_id, AUTH_EFFECT_ALLOW) {
            return EgressDecision::Allow(GrantSource::L3Memory);
        }

        // 第 6 步：未命中 → 需弹窗（fail-closed：调用方不弹则拒绝）
        EgressDecision::NeedConsent(ConsentRequest {
            id: String::new(), // 调用方填充 request_id
            url: url.to_string(),
            host: parsed.host,
            path: parsed.path,
            source: source.to_string(),
        })
    }
}

// ==================== 全局单例 ====================

static EGRESS: OnceLock<Arc<EgressPolicy>> = OnceLock::new();

/// 获取全局 Egress 策略引擎
pub fn policy() -> Arc<EgressPolicy> {
    EGRESS.get_or_init(|| Arc::new(EgressPolicy::new())).clone()
}

/// 初始化（lib.rs setup 调用）：设置持久层路径并加载既有授权
pub fn init(app_data_dir: PathBuf) {
    let p = policy();
    let path = app_data_dir.join(GRANTS_FILE);
    let loaded = match std::fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<PersistentGrantStore>(&content) {
            Ok(store) => store.grants,
            Err(e) => {
                tracing::warn!(error = %e, path = %path.display(), "egress: grants file malformed, start empty");
                Vec::new()
            }
        },
        Err(_) => Vec::new(),
    };
    *p.grants_path.write().unwrap() = Some(path);
    *p.persistent_grants.write().unwrap() = loaded;

    // 三档策略：egress_policy.json（`{ plugin_id: "always_ask" | "default" | "always_allow" }`）
    let strategy_path = app_data_dir.join(STRATEGY_FILE);
    let loaded_strategies = match std::fs::read_to_string(&strategy_path) {
        Ok(content) => match serde_json::from_str::<HashMap<String, String>>(&content) {
            Ok(map) => map
                .into_iter()
                // 读面：未知档位回落默认档（fail-safe，绝不猜成更宽松的档位）
                .map(|(k, v)| (k, AuthStrategy::parse(&v)))
                .collect(),
            Err(e) => {
                tracing::warn!(error = %e, path = %strategy_path.display(), "egress: strategy file malformed, start empty");
                HashMap::new()
            }
        },
        Err(_) => HashMap::new(),
    };
    *p.strategy_path.write().unwrap() = Some(strategy_path);
    *p.plugin_strategies.write().unwrap() = loaded_strategies;
    tracing::info!(
        grants = %p.persistent_grants.read().unwrap().len(),
        strategies = %p.plugin_strategies.read().unwrap().len(),
        "egress: policy initialized"
    );
}
