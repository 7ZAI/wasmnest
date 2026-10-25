//! 扩展点声明：PluginContributes 与各 *Contribution / EndpointAuth / WasiPreopenDir

use super::*;

/// 插件扩展点声明
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginContributes {
    #[serde(default)]
    pub commands: Vec<CommandContribution>,
    #[serde(default)]
    pub views: Vec<ViewContribution>,
    #[serde(default)]
    pub terminal: Option<TerminalContribution>,
    #[serde(default)]
    pub tool_providers: Vec<ToolProviderContribution>,
    #[serde(default)]
    pub file_handlers: Vec<FileHandlerContribution>,
    /// 插件 HTTP 端点清单（`_http_endpoint` 的路径白名单 + 认证档位，票 16 / 票 08）
    ///
    /// 条目是**相对路径段**（不含 `/api/plugin/<插件 id>/` 前缀，前缀由宿主补），
    /// 与请求里 `path` 字段逐字一致。宿主 registry 据此生成完整路径登记，路由侧
    /// **只按声明精确匹配**：未声明的端点 404（票 08 起「未声明清单 → 前缀内 ANY
    /// 放行」的票据 03 过渡策略已退役，未声明插件的 HTTP 面整体不可达）。
    /// 每条可同时声明认证档位（[`HttpEndpointContribution::Declared`]），缺省即最严
    /// 档 `jwt`——免凭证必须逐条显式写 `auth: "none"`。
    #[serde(default)]
    pub http_endpoints: Vec<HttpEndpointContribution>,
    /// 插件 WS 端点清单（`contributes.wsEndpoints`，票 09a WS 动作词表声明式化 · expand）
    ///
    /// 与 `httpEndpoints` 同语义：插件在 manifest 声明它要挂到宿主 WS 服务器的端点
    /// 相对路径段（宿主注入完整路径 `/ws/plugin/<插件 id>/<path>`）。宿主按声明
    /// 静态登记进 WS 端点注册表，路由侧**只按声明精确匹配**：未声明的路径不可达。
    /// 每条可同时声明认证档位（[`WsEndpointContribution::Declared`]），缺省按
    /// WS 面默认档（`none`）处理。声明式路由与既有硬编码分发（终端/会话动作
    /// switch）**并存**，存量动作走旧路径仍工作（expand–contract 的 expand 阶段）。
    #[serde(default)]
    pub ws_endpoints: Vec<WsEndpointContribution>,
    /// 配置声明
    #[serde(default)]
    pub configuration: Option<PluginConfiguration>,
    /// 生命周期钩子声明
    #[serde(default)]
    pub lifecycle: Option<LifecycleContribution>,
    /// 声明此插件会发布的消息 topic（文档性质，不做强制校验）
    #[serde(default)]
    pub provides: Vec<String>,
    /// 声明此插件感兴趣的消息 topic（宿主据此路由消息）
    #[serde(default)]
    pub subscribes: Vec<String>,
    /// 自定义监控面板声明（monitor 统一壳消费）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub monitor_panels: Vec<MonitorPanelContribution>,
}

/// 自定义监控面板声明（只登记元数据；实现住提供方应用工程）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorPanelContribution {
    pub id: String,
    pub title: String,
    /// 排序权重（小者靠前；缺省 100，与 core / 前端同口径）
    #[serde(default = "default_monitor_panel_order")]
    pub order: i32,
}

fn default_monitor_panel_order() -> i32 {
    100
}

/// 生命周期扩展点声明
///
/// 插件通过此声明告知宿主它需要接收应用启动/关闭事件。
/// Rust 插件通过 `WasmNestPlugin` trait 的 `on_startup`/`on_shutdown` 方法实现回调；
/// TS-only 插件通过前端事件 `lifecycle:startup`/`lifecycle:shutdown` 接收。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleContribution {
    /// 是否注册 onStartup 回调
    #[serde(default)]
    pub on_startup: bool,
    /// 是否注册 onShutdown 回调
    #[serde(default)]
    pub on_shutdown: bool,
}

/// 命令扩展点
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandContribution {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub icon: Option<String>,
}

/// 视图扩展点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContribution {
    pub id: String,
    /// "sidebar" | "toolbox" | "statusbar"
    #[serde(rename = "type")]
    pub view_type: String,
    /// 静态标题；statusbar 项由运行时注册动态 label，声明中可缺省
    #[serde(default)]
    pub title: String,
    /// 视图组件名；statusbar 项无独立视图组件（点击行为运行时注册），声明中可缺省
    #[serde(default)]
    pub component: String,
}

/// 终端扩展点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalContribution {
    #[serde(default)]
    pub input_handlers: Vec<String>,
    #[serde(default)]
    pub output_parsers: Vec<String>,
}

/// 外部工具扩展点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProviderContribution {
    pub id: String,
    pub name: String,
    pub endpoint: String,
}

/// 文件处理扩展点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHandlerContribution {
    pub id: String,
    pub extensions: Vec<String>,
    pub viewer: String,
    #[serde(default)]
    pub icon: Option<String>,
}

/// 端点认证档位（WS 端点注册与 HTTP 端点声明共用这一张词汇表）
///
/// 只有 `none | jwt` 两档。**缺省档位由各传输面自己决定**，不在这里表达：
/// WS 首消息认证的历史缺省是 `none`（插件自管认证），HTTP 声明缺省是 `jwt`
/// （票 08 裁决 1「未声明即最严」）。未知取值一律 Err，绝不静默降级为较宽档位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EndpointAuth {
    /// 免凭证：宿主不校验 JWT（环回 hook、配对 / QR 这类「拿 token 之前」的入口）
    None,
    /// 必须通过宿主 JWT 验签
    Jwt,
}

impl EndpointAuth {
    /// manifest / 线协议取值
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Jwt => "jwt",
        }
    }

    /// 解析声明值：缺省 / 空串 → `default`（由调用方给档位）；未知取值 → Err
    ///
    /// 大小写敏感——与 WS 注册面既有行为一致，`"JWT"` 视为拼写错误而非合法档位。
    pub fn parse_with(raw: Option<&str>, default: Self) -> Result<Self, String> {
        match raw.map(str::trim).unwrap_or("") {
            "" => Ok(default),
            "none" => Ok(Self::None),
            "jwt" => Ok(Self::Jwt),
            other => Err(format!(
                "unknown auth '{}' (expected \"none\" or \"jwt\")",
                other
            )),
        }
    }
}

/// 一条 HTTP 端点声明（票 08：两种形态并存）
///
/// - `"configs"` —— 只声明路径段，认证档位取宿主默认（最严档 `jwt`）
/// - `{ "path": "task-status", "auth": "none" }` —— 显式声明档位
///
/// 两形态并存是为了零迁移：既有 manifest 的 `string[]` 不必重写，收紧只作用在
/// 「未声明 auth」的端点上（默认变严）。`auth` 保留原始字符串，档位仲裁在宿主
/// registry（[`EndpointAuth::parse_with`]）——声明面负责表达，判定面负责解释。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HttpEndpointContribution {
    /// 仅路径段（认证档位 = 宿主默认）
    Path(String),
    /// 路径段 + 显式认证档位
    Declared {
        /// 相对路径段，与宿主传入 `_http_endpoint` 的 `path` 字段逐字一致
        path: String,
        /// `"none"` | `"jwt"`；缺省 = 宿主默认档位
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auth: Option<String>,
    },
}

impl HttpEndpointContribution {
    /// 声明的相对路径段
    pub fn path(&self) -> &str {
        match self {
            Self::Path(p) => p,
            Self::Declared { path, .. } => path,
        }
    }

    /// 声明的认证档位原始值（`None` = 未声明，由宿主按默认档处理）
    pub fn auth_raw(&self) -> Option<&str> {
        match self {
            Self::Path(_) => None,
            Self::Declared { auth, .. } => auth.as_deref(),
        }
    }
}

/// 一条 WS 端点声明（票 09a：`contributes.wsEndpoints`，WS 动作词表声明式化 · expand）
///
/// - `"echo"` —— 只声明路径段，认证档位取宿主默认
/// - `{ "path": "echo", "auth": "jwt" }` —— 显式声明档位
///
/// 与 [`HttpEndpointContribution`] 同形态（两形态并存 = 零迁移）。`auth` 保留原始
/// 字符串，档位仲裁在宿主（[`EndpointAuth::parse_with`]）——声明面负责表达，
/// 判定面负责解释。**缺省档由各传输面自定**：WS 缺省 = `none`（与 `host-websocket`
/// `register-endpoint` 一致，插件自管首消息认证），HTTP 缺省 = `jwt`（最严，票 08）。
/// 声明面只负责表达「路径 + 是否显式给档位」，不在此强求任何一面默认。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WsEndpointContribution {
    /// 仅路径段（认证档位 = 宿主默认）
    Path(String),
    /// 路径段 + 显式认证档位
    Declared {
        /// 相对路径段，与插件挂载到 `/ws/plugin/<id>/<path>` 的 `path` 逐字一致
        path: String,
        /// `"none"` | `"jwt"`；缺省 = 宿主默认档位
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auth: Option<String>,
    },
}

impl WsEndpointContribution {
    /// 声明的相对路径段
    pub fn path(&self) -> &str {
        match self {
            Self::Path(p) => p,
            Self::Declared { path, .. } => path,
        }
    }

    /// 声明的认证档位原始值（`None` = 未声明，由宿主按默认档处理）
    pub fn auth_raw(&self) -> Option<&str> {
        match self {
            Self::Path(_) => None,
            Self::Declared { auth, .. } => auth.as_deref(),
        }
    }
}

/// 一条 WASI 预打开目录声明（manifest `wasiPreopenDirs`，审计票 07 增只读档）
///
/// - `"/data/x"` —— 可写挂载（既有 manifest 的唯一形态，零迁移）
/// - `{ "path": "/data/x", "readonly": true }` —— 只读挂载
///
/// **缺省档 = 可写**，与改造前的行为逐字一致：本字段收紧的是「插件能声明什么」，
/// 不是「已声明的插件失去什么」。两形态共用同一默认，避免同一个列表里
/// 「写成对象就悄悄变只读、写成字符串就可写」这种反向意外。
///
/// 只读档只作用在 guest 侧写能力（宿主按 [`Self::readonly`] 选 `FsPerms`），
/// **不构成更松的授权**：两种形态都要先过 `is_granted` 才建得出 preopen
/// （票 07 裁决 3——「声明即免弹窗」会让插件声明 `~/.ssh` 就能预打开）。
///
/// `readonly` 用 `Option<bool>` 而非 `bool`：三态里 `None` = 未声明，序列化该
/// 条目时不回写此键，产物与源清单保持逐字一致（票 14 口径）。
///
/// 反序列化走手写实现（[`WasiPreopenDir::from_json`]）而非 serde derive：
/// derive 的 `untagged` 只会给出「data did not match any variant」这种不点名的
/// 错误，而这条声明是第三方 zip 绕开构建 CLI 时唯一的仲裁点——错误必须点名到键
/// 与非法取值（与 [`EndpointAuth::parse_with`] 同口径），且未知键一律拒绝。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum WasiPreopenDir {
    /// 仅路径（挂载档 = 可写）
    Path(String),
    /// 路径 + 显式挂载档
    Declared {
        /// 主机路径，支持 `${home}` 展开
        path: String,
        /// `true` = 只读挂载；缺省 / `false` = 可写（与既有行为一致）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        readonly: Option<bool>,
    },
}

impl WasiPreopenDir {
    /// 构造可写档条目（宿主内部与测试用）
    pub fn writable(path: impl Into<String>) -> Self {
        Self::Path(path.into())
    }

    /// 构造只读档条目
    pub fn read_only(path: impl Into<String>) -> Self {
        Self::Declared {
            path: path.into(),
            readonly: Some(true),
        }
    }

    /// 声明的主机路径（未展开 `${home}`）
    pub fn path(&self) -> &str {
        match self {
            Self::Path(p) => p,
            Self::Declared { path, .. } => path,
        }
    }

    /// 挂载档：`true` = 只读。未声明即可写（缺省档见类型注释）
    pub fn readonly(&self) -> bool {
        match self {
            Self::Path(_) => false,
            Self::Declared { readonly, .. } => readonly.unwrap_or(false),
        }
    }

    /// 以展开后的主机路径替换自身路径，挂载档保持不变
    ///
    /// `${home}` 展开与尾分隔符清理走这一步，避免各消费方自己重建条目时丢掉档位。
    pub fn with_path(self, path: impl Into<String>) -> Self {
        let readonly = self.readonly();
        Self::Declared {
            path: path.into(),
            readonly: readonly.then_some(true),
        }
    }

    /// 解析一条 manifest 声明：`"路径"` 字符串 或 `{path, readonly}` 对象
    ///
    /// 只管形态，不管语义：空串与 `${home}` 不可用留给展开阶段处理（既有口径）。
    /// 未知键报错而非忽略——拼成 `read_only` 若被静默吞掉，条目会退化成可写
    /// 挂载，插件的自我收紧声明就此消失且无人报错。
    pub fn from_json(value: &serde_json::Value) -> Result<Self, String> {
        match value {
            serde_json::Value::String(s) => Ok(Self::Path(s.clone())),
            serde_json::Value::Object(map) => {
                for key in map.keys() {
                    if key != "path" && key != "readonly" {
                        return Err(format!(
                            "wasiPreopenDirs 条目含未知字段（只允许 path / readonly）: {key} → {value}"
                        ));
                    }
                }
                let path = map.get("path").and_then(|p| p.as_str()).ok_or_else(|| {
                    format!("wasiPreopenDirs 条目缺 path 或 path 不是字符串: {value}")
                })?;
                let readonly = match map.get("readonly") {
                    None => None,
                    Some(v) => Some(v.as_bool().ok_or_else(|| {
                        format!("wasiPreopenDirs 条目 readonly 必须是布尔（true / false）: {value}")
                    })?),
                };
                Ok(Self::Declared {
                    path: path.to_string(),
                    readonly,
                })
            }
            other => Err(format!(
                "wasiPreopenDirs 条目形态非法（须为路径字符串或 {{path, readonly}} 对象）: {other}"
            )),
        }
    }
}

impl<'de> serde::Deserialize<'de> for WasiPreopenDir {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        Self::from_json(&value).map_err(serde::de::Error::custom)
    }
}

impl From<&str> for HttpEndpointContribution {
    fn from(path: &str) -> Self {
        Self::Path(path.to_string())
    }
}

impl From<String> for HttpEndpointContribution {
    fn from(path: String) -> Self {
        Self::Path(path)
    }
}

impl From<&str> for WsEndpointContribution {
    fn from(path: &str) -> Self {
        Self::Path(path.to_string())
    }
}

impl From<String> for WsEndpointContribution {
    fn from(path: String) -> Self {
        Self::Path(path)
    }
}
