//! plugin.json 声明类型：PluginManifest / ResourceOverrides / PluginConfiguration / ConfigProperty

use super::*;

///
/// `Default` 的用途是**测试夹具与合成 manifest 的构造基线**：除 `id` / `name` /
/// `version` / `platform` 四个必填项外，每个字段都带 `#[serde(default)]`，因此
/// `Default` 与「一份只写了必填项的 plugin.json 解析结果」逐字段等价。调用点写成
/// `PluginManifest { id, name, version, ..Default::default() }`
/// 之后，本类型**追加可选字段不再连带测试编译红**——此前六处结构体字面量把「逐字段列全」
/// 当隐式契约用，`pty_quota` 追加时就漏修了 `plugin-wasip3-test` 一处（会话引擎下沉票 14）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    /// 唯一标识（反向域名格式，如 com.wasmnest.quick-snippets）
    pub id: String,
    /// 显示名称
    pub name: String,
    /// 语义化版本号
    pub version: String,
    /// 适配平台：`desktop`（仅桌面）/ `mobile`（仅移动）/ `both`（双端适配）
    ///
    /// **必填项**（与 id/name/version 同档，无 serde 缺省）——声明本应用适配哪一端；
    /// 宿主在**加载 / zip 安装**时校验声明必须覆盖当前端（`PluginPlatform::supports`），
    /// 不匹配即 fail-visible 拒绝：把一端的分发包装到另一端后「装了却不工作」
    /// 比一次显性拒绝难排查得多。
    pub platform: PluginPlatform,
    /// 插件描述
    #[serde(default)]
    pub description: String,
    /// 作者
    #[serde(default)]
    pub author: String,
    /// 入口文件路径（相对于插件根目录，TS-only 插件使用）
    #[serde(default)]
    pub main: String,
    /// 请求的权限列表
    #[serde(default)]
    pub permissions: Vec<String>,
    /// 对外可互调 api 清单（ADR-0017，插件互调机制）
    ///
    /// 全限定名数组（如 `com.wasmnest.scheduler.add`）；宿主在插件激活时
    /// 登记到 api 注册表，`wasmnest.api.*` 请求 topic 的目标 api 必须命中
    /// 某已激活插件的声明清单，否则被总线门禁拒绝。缺省空数组 = 不对外
    /// 提供互调 api（现有插件不受影响）。
    #[serde(default)]
    pub api: Vec<String>,
    /// 扩展点声明
    #[serde(default)]
    pub contributes: PluginContributes,
    /// 插件产物形态：frontend / backend / full（语言无关三档，wasmnest-apps#21）
    #[serde(default = "default_plugin_type")]
    pub plugin_type: PluginType,
    /// WASM 库文件名（不含路径，相对于插件目录）
    /// 携带 wasm 后端的形态使用（backend / full），宿主根据平台自动添加后缀
    #[serde(default)]
    pub rust_library: String,
    /// WASM 模块内容 SHA-256（小写十六进制；缺省空串 = 不校验）
    ///
    /// 由**发布者**在打包时填入：宿主 `downloader` 安装期比对 zip 内 wasm 文件的
    /// 摘要，拦截「包内二进制与 manifest 声明不符」的替换（与移动端同形）。
    /// 缺省空串时跳过校验（既有插件零迁移）——但**空串不等于安全**：
    /// 插件内容仍受审批门禁的目录哈希钉扎约束（`plugin/security/approval.rs`）。
    #[serde(default)]
    pub wasm_hash: String,
    /// 插件图标：图片路径（相对插件目录）或内联 SVG 标记
    #[serde(default)]
    pub icon: Option<String>,
    /// WASI 预打开目录声明（**仅 worker 类别可用**，ADR 0034）
    ///
    /// 主 wasm-app 文件访问一律走宿主 `host-fs` 授权机制（`fs:read` / `fs:write`
    /// 权限 + `fs_request_auth` / preauth 目录授权），不再使用 WASI preopen。
    /// 本字段为 worker 类别（`lifecycle: ephemeral`，ADR 0032 L3.b 预留）保留：
    /// 宿主在实例化时逐项校验授权（is_granted，无弹窗）后挂载到 guest
    /// 路径 `/data`、`/data1`、…；未授权/展开失败的目录跳过（不阻断加载）。
    /// 支持 `${home}` 变量展开为主目录绝对路径。缺省空数组 = 无预打开
    /// （既有 wasm32-unknown-unknown 插件不受影响）。
    ///
    /// 非 worker 声明在**构建期（manifest-validate.js）与加载期（validation.rs）双侧
    /// 显性拒绝**（ADR 0034）：worker 未实现期间（ephemeral 本身被拒）本字段对一切
    /// manifest 不可达。
    ///
    /// 条目两形态（[`WasiPreopenDir`]）：裸路径 = 可写挂载，`{path, readonly}`
    /// = 只读挂载。只读档只收紧 guest 对该目录的写能力，**不放宽授权**——
    /// 未授权目录无论哪一档都建不出 preopen（审计票 07 裁决 3）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wasi_preopen_dirs: Vec<WasiPreopenDir>,
    /// 装配角色：`basic-service`（L1 基础服务）/ `internal-business`
    /// （L2 内部统一业务应用）/ `business-app`（L3 业务应用，缺省）
    ///
    /// 三个角色对应三张加载层，顺序固定 **L1 → L2 → L3**（ADR 0032）：
    /// L1 最早（其 host-* 同形能力要先装配进能力注册表）→ L2 次之（宿主网关
    /// 的裁决依赖方须先于业务应用就绪）→ L3 最后（持久化批量激活的应用面）。
    /// L1/L2 是**角色驱动**（启停不持久化，持久化真源是「角色」而非用户状态）。
    /// 缺省 `business-app`，旧插件零迁移。
    ///
    /// 历史拼写兼容（反序列化别名，序列化统一写新拼写）：`application` =
    /// L3、`system` = L1（ADR 0032 之前的 `PluginKind::System`）。
    /// 注意与 `pluginType`（产物形态）正交——本字段描述**装配角色**。
    #[serde(
        rename = "type",
        default,
        skip_serializing_if = "PluginKind::is_business_app"
    )]
    pub kind: PluginKind,
    /// 能力依赖声明（应用插件消费的能力名，WIT host-* 接口名，如
    /// `host-storage`）
    ///
    /// 宿主在激活时校验：每个依赖必须已有提供者（宿主原语或已激活的
    /// 系统组件实例），缺失即激活失败并指明能力名。缺省空数组 =
    /// 无依赖（现有插件不受影响）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<String>,
    /// 单插件 Store 资源覆盖请求（core-config × core-security，wasm-core 票据 07）
    ///
    /// 重型插件（大 JSON 解析等）可请求更大的燃料预算/线性内存；`None`
    /// 字段继承内核配置。最终值由宿主安全模块仲裁：逐字段取 min（请求值、
    /// 内核配置值、编译期硬上限）——插件只能自我收紧，放宽请求被钳回上限。
    /// 缺省 None = 完全继承内核配置（现有插件零迁移）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_overrides: Option<ResourceOverrides>,
    /// 单插件在册 `host-pty` 句柄数上限声明（会话引擎下沉 P1 / H1）
    ///
    /// 缺省 `None` = 取内核默认 `PLUGIN_PTY_MAX_SESSIONS_PER_PLUGIN`（8 条，迁移前
    /// 行为）。`Some(n)` 只在 `1..=PLUGIN_PTY_SESSIONS_CEILING_PER_PLUGIN` 内合法，
    /// 越界与 0 在**加载期**即拒绝（宿主 `manager/validation.rs`），不夹取——静默降级
    /// 会让插件按自己声明的并发数规划业务、实际却少得多，与 `ringBytes` 同一分级口径。
    ///
    /// 存在理由：业务会话改由插件经 `host-pty.spawn` 自持 PTY 后，「用户可开多少终端」
    /// 变成该插件的配额；默认 8 条是「多 shell 并发」型插件的档位，不是会话产品档位。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty_quota: Option<usize>,
    /// 实例生命周期策略：`persistent`（常驻，缺省）/ `ephemeral`（即用即弃）
    ///
    /// **正交于 `kind`（装配角色）**：角色回答「装配在哪一层、谁调它」，
    /// 本字段回答「实例活多久」。`ephemeral` = 业务 worker 形态
    /// （只对 store 操作、用完即弃、无页面），其存在理由是**内存生命周期**：
    /// wasm 线性内存只能 grow 不能 shrink，长驻实例处理大输入会单调增长到宿主
    /// 单实例限额并 trap，drop 实例则内存归还 OS、限额从低水位重算。
    ///
    /// **本期只预留类型**（ADR 0032 §6）：宿主的一次性实例机制与调度框架
    /// 尚未落地，故声明 `ephemeral` 的 manifest 在**加载期显性被拒**（宿主
    /// `manager/validation.rs` + 构建链 `manifest-validate.js` 双侧拒），
    /// 不做「静默当常驻处理」——那会让作者以为 worker 已生效。
    #[serde(default, skip_serializing_if = "InstanceLifecycle::is_persistent")]
    pub lifecycle: InstanceLifecycle,
    /// 运行期传输租约声明（manifest `backgroundTransport`，桌面服务端型应用）
    ///
    /// `true` = 应用**运行期间**（启动成功 → 停用 / Error）持有宿主传输面
    /// （`net.transport`：WS + HTTP 同端口 + mDNS 广播）的应用作用域租约；
    /// **界面挂载 / 卸载不再是其生死开关**。代价是整段运行期对外可达，故必须
    /// 显式 opt-in，并在 `permissions` 声明 `ws:server` / `network:http` 至少
    /// 一个——构建期（`bin/manifest-validate.js`）与宿主加载期
    /// （`manager/validation.rs`）双侧校验，缺权限即拒。
    ///
    /// 缺省 `false` = 既有行为：界面打开才 acquire，关闭最后一个界面即停播。
    #[serde(default, skip_serializing_if = "is_false")]
    pub background_transport: bool,
}

/// `skip_serializing_if` 辅助：布尔 `false` 不写入序列化输出（与中性 manifest 同形）
fn is_false(value: &bool) -> bool {
    !*value
}

/// 单插件 Store 资源上限覆盖请求（manifest `resourceOverrides`）
///
/// 字段可选：`None` = 继承内核配置（`CoreConfig.store` 对应项）；
/// `Some(v)` = 请求值，宿主仲裁后生效（见 [`PluginManifest::resource_overrides`]）。
/// 字段语义与 [`crate`] 宿主侧 `StoreLimits` 同名项一致（燃料预算 / 线性
/// 内存字节 / 表元素 / 实例数 / 内存数 / 表数）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResourceOverrides {
    /// 单次导出调用燃料预算（指令数）；None = 继承
    pub fuel_per_call: Option<u64>,
    /// 线性内存上限（字节）；None = 继承
    pub max_memory_bytes: Option<usize>,
    /// 表元素上限；None = 继承
    pub max_table_entries: Option<usize>,
    /// 单 Store 核心实例数上限；None = 继承
    pub max_instances: Option<usize>,
    /// 单 Store 线性内存数量上限；None = 继承
    pub max_memories: Option<usize>,
    /// 单 Store 表数量上限；None = 继承
    pub max_tables: Option<usize>,
}

/// 插件配置声明
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfiguration {
    /// 配置区域标题
    pub title: String,
    /// 配置属性映射（key → 属性定义）
    pub properties: HashMap<String, ConfigProperty>,
}

/// 配置属性定义
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigProperty {
    /// 属性类型：string / number / boolean
    #[serde(rename = "type")]
    pub prop_type: String,
    /// 显示标题
    pub title: String,
    /// 帮助描述
    #[serde(default)]
    pub description: Option<String>,
    /// 默认值
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    /// 枚举选项（type 为 string 时使用）
    #[serde(default)]
    pub enum_values: Option<Vec<String>>,
}
