//! 枚举与运行时状态：PluginType/Platform/Kind / InstanceLifecycle / PluginState / PluginInfo

use super::*;

pub(crate) fn default_plugin_type() -> PluginType {
    PluginType::TsOnly
}

/// 插件产物形态类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginType {
    /// 纯 Rust 插件，无前端组件
    Rust,
    /// Rust + TypeScript 插件，Rust 提供后端能力，TS 提供 UI
    RustTs,
    /// 纯 TypeScript 插件，仅前端组件
    TsOnly,
}

/// 缺省产物形态取自 [`default_plugin_type`]，与 manifest `pluginType` 的 serde 缺省共用
/// 同一真源（不另立 `#[default]` 造成两处漂移）
impl Default for PluginType {
    fn default() -> Self {
        default_plugin_type()
    }
}

/// 应用适配平台（manifest `platform` 字段，必填）
///
/// 三值：`desktop`（仅桌面）/ `mobile`（仅移动）/ `both`（双端适配）。宿主在加载 /
/// 安装时按本端校验（`supports`），单端声明遇到另一端即拒绝装载。
///
/// `Default` 取 `Both` **仅服务测试夹具与合成清单**（wire 层该字段必填、无 serde
/// 缺省）：合成清单对两端都可装载，不把测试夹具钉死在某一个端。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PluginPlatform {
    /// 仅桌面端
    Desktop,
    /// 仅移动端
    Mobile,
    /// 双端适配（两端均可加载）
    #[default]
    Both,
}

impl PluginPlatform {
    /// wire 值（错误文案 / 对比用；与 serde rename 同源）
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Mobile => "mobile",
            Self::Both => "both",
        }
    }

    /// 本声明是否适用于 `host`（宿主当前端；只应传 `Desktop` / `Mobile`）
    ///
    /// `both` 对任一端成立；单端声明只对本端成立。
    pub const fn supports(self, host: PluginPlatform) -> bool {
        match (self, host) {
            (Self::Both, _) => true,
            (Self::Desktop, Self::Desktop) => true,
            (Self::Mobile, Self::Mobile) => true,
            _ => false,
        }
    }
}

/// 组件装配角色（manifest `type` 字段，core-plugin-manager · ADR 0032）
///
/// 与 [`PluginType`]（产物形态）、[`Lifecycle`]（实例生命周期）**正交**：
/// 本枚举只回答「这个组件装配在哪一层、谁调它」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum PluginKind {
    /// **L3 业务应用**（缺省）：消费 host-* 能力，经 `dependencies` 声明依赖
    #[default]
    #[serde(alias = "application")]
    BusinessApp,
    /// **L1 基础服务**：引擎域组件，最先激活，向能力注册表提供 host-*
    /// 同形接口能力（应用插件的 import 经 Linker 路由到它）
    #[serde(alias = "system")]
    BasicService,
    /// **L2 内部统一业务应用**：宿主网关的**裁决依赖方**——宿主内核**主动
    /// 调它**做 allow/deny 裁决，是本仓唯一「宿主反向依赖 wasm 组件」的
    /// 角色（ADR 0032 三条红线：白名单式登记 / 只做安全闸门 / 宿主只转发不解释）
    InternalBusiness,
}

impl PluginKind {
    /// 角色驱动层的加载顺序（**L1 先于 L2**；不含 L3——L3 走持久化批量激活）
    ///
    /// 顺序真源在本 SDK 而非宿主：宿主按本常量逐层激活，新增角色只需改这一处，
    /// 宿主不必（也不应）认识具体角色值（防回接锁
    /// `internal_business_host_dependency_stays_gated` 断言宿主只调谓词）。
    pub const ROLE_DRIVEN_LOAD_ORDER: [PluginKind; 2] =
        [PluginKind::BasicService, PluginKind::InternalBusiness];

    /// serde skip_serializing_if 钩子：缺省角色（L3）不写入序列化输出
    pub fn is_business_app(&self) -> bool {
        matches!(self, PluginKind::BusinessApp)
    }

    /// 是否**角色驱动**（L1 / L2）：启动由角色而非用户状态决定，启停不持久化
    ///
    /// 持久化真源是「角色」——停用只对当前会话生效，下次启动按角色重新激活。
    pub fn is_role_driven(&self) -> bool {
        matches!(
            self,
            PluginKind::BasicService | PluginKind::InternalBusiness
        )
    }

    /// 是否向能力注册表提供 host-* 同形接口能力（**仅 L1**）
    ///
    /// L2 不提供能力（它是裁决方不是提供方），L3 是消费方。
    pub fn provides_host_capabilities(&self) -> bool {
        matches!(self, PluginKind::BasicService)
    }

    /// 是否 L2 内部统一业务应用（宿主网关的裁决依赖方；宿主静态声明段用它判定
    /// “谁该先加载”，动态就绪段 = `auth-center-register` 调用，两段不合并，
    /// ADR 0031 K9）
    pub fn is_internal_business(&self) -> bool {
        matches!(self, PluginKind::InternalBusiness)
    }

    /// 日志 / 诊断用的角色标签（如 `L1 基础服务`）
    pub fn label(&self) -> &'static str {
        match self {
            PluginKind::BasicService => "L1 基础服务",
            PluginKind::InternalBusiness => "L2 内部统一业务",
            PluginKind::BusinessApp => "L3 业务应用",
        }
    }

    /// manifest wire 拼写（与 serde `rename_all = "kebab-case"` 同源，
    /// 供日志 / 诊断输出使用；**不是**反序列化入口）
    pub fn as_str(&self) -> &'static str {
        match self {
            PluginKind::BasicService => "basic-service",
            PluginKind::InternalBusiness => "internal-business",
            PluginKind::BusinessApp => "business-app",
        }
    }
}

/// 实例生命周期策略（manifest `lifecycle` 字段，ADR 0032）
///
/// 命名带 `Instance` 前缀是为了与 `contributes.lifecycle`（应用生命周期钩子贡献，
/// `LifecycleContribution`）区分：两者毫无关系，同名会让人以为 worker 与钩子有关。
///
/// 正交于 [`PluginKind`]：角色管装配层，本枚举管实例活多久。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum InstanceLifecycle {
    /// 常驻实例（缺省）：激活即持有，deactivate 才释放
    #[default]
    Persistent,
    /// 即用即弃实例（业务 worker）：用完即 drop，线性内存归还 OS
    ///
    /// **无别名**：wire 拼写只有 `ephemeral`（构建链 `manifest-validate.js` 的取值域
    /// 同源）。曾加过 `alias = "worker"`，已删——它未经裁定，且会让两侧取值域漂移
    /// （构建期拒、宿主期收）
    Ephemeral,
}

impl InstanceLifecycle {
    /// serde skip_serializing_if 钩子：缺省策略（常驻）不写入序列化输出
    pub fn is_persistent(&self) -> bool {
        matches!(self, InstanceLifecycle::Persistent)
    }

    /// 日志 / 诊断用的策略标签
    pub fn label(&self) -> &'static str {
        match self {
            InstanceLifecycle::Persistent => "常驻",
            InstanceLifecycle::Ephemeral => "即用即弃",
        }
    }

    /// manifest wire 拼写（与 serde `rename_all = "kebab-case"` 同源）
    pub fn as_str(&self) -> &'static str {
        match self {
            InstanceLifecycle::Persistent => "persistent",
            InstanceLifecycle::Ephemeral => "ephemeral",
        }
    }
}

/// 插件运行时状态
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", content = "error")]
pub enum PluginState {
    Loaded,
    /// 激活进行中（auto-activation / 手动激活期间的瞬时中间态，列表查询可见）
    Activating,
    Activated,
    /// 激活成功但启动初始化失败（v8 契约）：WASM 实例可用、扩展点已注册，
    /// 但插件内部启动流程未完成。可重试激活回到 Activated
    Degraded(String),
    /// 插件请求的权限尚未获得用户批准（需在插件管理页人工审批后才能激活）
    NeedsApproval,
    Error(String),
    Deactivated,
}

/// 插件信息（返回给前端的精简版本）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub main: String,
    pub plugin_type: PluginType,
    pub permissions: Vec<String>,
    pub state: PluginState,
    pub extension_path: String,
    pub contributes: PluginContributes,
}
