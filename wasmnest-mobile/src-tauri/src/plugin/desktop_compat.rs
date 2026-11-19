//! 桌面兼容面桩（双端共享产物的桌面独有 import 闭合，2026-10-13 起）
//!
//! ## 为什么移动宿主要实现「桌面专属」interface
//!
//! 双端共享一份 wasm 产物的应用按桌面 `world plugin` 构建，产物的 import 面会带上
//! 它实际引用过的桌面独有域；移动宿主的 `world plugin`（core + plugin-face + 各能力
//! 域包）不提供这些 interface。组件模型**没有「缺省 import」**：import 不闭合即
//! 实例化失败，所以共享产物引用到的每一个桌面独有 interface 都必须在这里有实现。
//!
//! 当前登记（按产物逐个累加）：
//!
//! - file-transfer：`host-api-call`（auth_center 互调认证中心）+
//!   `host-platform-desktop`（reveal-in-dir 等桌面平台事实）；
//! - news：`host-clipboard`（复制链接）+ `host-timer`（15 分钟刷新）——
//!   移动分支经 `host-platform.platform()` 探测后不调用它们（复制走前端
//!   `navigator.clipboard`、刷新由前台事件驱动）。
//!
//! 故本模块为这些 interface 提供 **fail-visible 桩**：全部函数显性
//! `Err("unsupported on mobile: …")`。桩的存在只是为了 import 闭合，**不是
//! 「移动端实现桌面能力」**；若哪天真被调用（= 平台探测失效 / 产物误走桌面分支），
//! 错误文案会当场点名，不会静默走空实现。
//!
//! ## 绑定来源（跨端读桌面 wit 生成物）
//!
//! 本模块 `bindgen!` 的是**桌面 SDK 的 wit 目录**（`compose-wit.mjs` 生成物）的
//! `world desktop-compat`——该 world 定义在桌面 wit-src `plugin-face.wit`
//! （binding-only，同 `plugin-binary` 先例）。桌面 wit 演进时本模块的 `Host` impl
//! 若漏跟，**编译期**即红（生成 trait 多方法而 impl 缺失）——契约同步是编译错误
//! 而非运行期断链。移动 SDK / 移动 wit / 移动插件契约面**零变更**。
//!
//! 新共享产物引用别的桌面独有域时：在桌面 `plugin-face.wit` 的 `world
//! desktop-compat` 登记 import（绑定面），再在此补 `Host` impl 与
//! `MODULE_INTERFACES` / `register` 登记——漏一处即编译期或实例化期红。

use wasmnest_host_kit::{HostModule, HostModuleDesc, ModuleEntry, WasmPluginState};
use wasmtime::component::bindgen;

bindgen!({
    // 桌面 wit 生成物目录（相对本 crate 根 `wasmnest-mobile/src-tauri`）；
    // `desktop-compat` world = api-call / platform-desktop / clipboard / timer 四个
    // 桌面独有 import（定义见桌面 wit-src plugin-face.wit，compose 后进生成物）。
    path: "../../wasmnest-desktop/packages/plugin-sdk-desktop/rust/wit",
    world: "desktop-compat",
});

// ==================== 桩实现（fail-visible unsupported） ====================

/// 桌面专属错误文案（fail-visible：点名「移动不提供」与「为何不应被调用」）
fn unsupported(api: &str) -> String {
    format!(
        "unsupported on mobile: {api} is a desktop-only capability; \
         the shared artifact takes its mobile branch after \
         host-platform.platform() probes `mobile` — reaching here means the \
         platform probe failed or the artifact called a desktop-only domain on mobile"
    )
}

impl wasmnest::api_call::host_api_call::Host for WasmPluginState {
    /// 插件互调（桌面认证中心路径）：移动不提供——共享产物的 `ConsentGate`
    /// 移动实现走宿主原语直答，不经互调
    fn call(&mut self, _request_topic: String, _payload_json: String, _timeout_ms: u64) -> Result<String, String> {
        Err(unsupported("host-api-call.call"))
    }
}

impl wasmnest::platform_desktop::host_platform_desktop::Host for WasmPluginState {
    /// WSL 发行版枚举：桌面专属平台事实，移动不提供
    fn wsl_distros(&mut self) -> Result<String, String> {
        Err(unsupported("host-platform-desktop.wsl-distros"))
    }

    /// 本机 IPv4 枚举：桌面专属平台事实，移动不提供
    fn local_ipv4_addresses(&mut self) -> Result<String, String> {
        Err(unsupported("host-platform-desktop.local-ipv4-addresses"))
    }

    /// 在系统文件管理器中定位：移动不提供（无对应平台交互）
    fn reveal_in_dir(&mut self, _path: String) -> Result<(), String> {
        Err(unsupported("host-platform-desktop.reveal-in-dir"))
    }
}

impl wasmnest::clipboard::host_clipboard::Host for WasmPluginState {
    /// 读系统剪贴板：移动分支不调用（news 复制走前端 `navigator.clipboard`）
    fn read_text(&mut self) -> Result<Option<String>, String> {
        Err(unsupported("host-clipboard.read-text"))
    }

    /// 写系统剪贴板：同上，移动分支不调用
    fn write_text(&mut self, _text: String) -> Result<(), String> {
        Err(unsupported("host-clipboard.write-text"))
    }
}

impl wasmnest::timer::host_timer::Host for WasmPluginState {
    /// 注册周期定时器：移动分支不调用（news 刷新由前台事件驱动）
    fn register(&mut self, _interval_secs: u64, _command: String) -> Result<(), String> {
        Err(unsupported("host-timer.register"))
    }
}

// ==================== 能力模块自报 ====================

/// 能力模块名（白名单键 = 装载期日志与错误文案里的模块名）
pub const MODULE_NAME: &str = "mobile-desktop-compat";

/// 本模块提供的 WIT 接口（桌面兼容面；移动宿主 `world plugin` 本身不 import 它们）
pub const MODULE_INTERFACES: &[&str] = &[
    "wasmnest:api-call@0.0.1/host-api-call",
    "wasmnest:platform-desktop@0.0.1/host-platform-desktop",
    "wasmnest:clipboard@0.0.1/host-clipboard",
    "wasmnest:timer@0.0.1/host-timer",
];

/// 本模块读写的权限位：**空**——桩不放行任何能力，调用即拒
pub const MODULE_PERMISSIONS: &[&str] = &[];

/// 能力模块描述符（机制面：接口路径 / 权限位 / ABI 下界；禁带产品名词）
const DESC: HostModuleDesc = HostModuleDesc {
    name: MODULE_NAME,
    interfaces: MODULE_INTERFACES,
    permissions: MODULE_PERMISSIONS,
    // 移动 ABI 21（共享产物形态引入时的移动契约面版本；本模块随该形态引入）
    abi_min: 21,
};

/// 桌面兼容面桩能力模块
pub struct MobileDesktopCompatModule;

impl HostModule for MobileDesktopCompatModule {
    fn desc(&self) -> HostModuleDesc {
        DESC
    }

    /// 兜底/兼容桩：只为 import 闭合（跨端共享产物）而存在。跨端同进程装配
    /// （桌面真实现与移动桩同时在场）时必须让位——否则同一 interface 被装配两次，
    /// 当日即红：`map entry \`call\` defined twice`。
    fn fallback(&self) -> bool {
        true
    }

    fn register(&self, linker: &mut wasmtime::component::Linker<WasmPluginState>) -> wasmtime::Result<()> {
        type D = wasmtime::component::HasSelf<WasmPluginState>;
        wasmnest::api_call::host_api_call::add_to_linker::<WasmPluginState, D>(linker, |s| s)?;
        wasmnest::platform_desktop::host_platform_desktop::add_to_linker::<WasmPluginState, D>(linker, |s| s)?;
        wasmnest::clipboard::host_clipboard::add_to_linker::<WasmPluginState, D>(linker, |s| s)?;
        wasmnest::timer::host_timer::add_to_linker::<WasmPluginState, D>(linker, |s| s)?;
        Ok(())
    }
}

/// 静态单例（供 `inventory::submit!` 取址）
static MODULE: MobileDesktopCompatModule = MobileDesktopCompatModule;

wasmnest_host_kit::expect_host_module!(MODULE_NAME);

// 能力模块自报（自报静态住在宿主 lib = 最终二进制 ⇒ 无需强制引用行）
inventory::submit! {
    ModuleEntry { module: &MODULE }
}
