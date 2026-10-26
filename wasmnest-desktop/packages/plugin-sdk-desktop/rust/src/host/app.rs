//! 宿主能力：插件随包 CLI 生命周期（v8，host-app）
//!
//! 供调度框架类插件（如计划任务）在激活/停用时安装/卸载自身随包的 CLI
//! （如 bedtask）：复制到用户 bin 目录 + 注册 PATH（Windows 用户级注册表 /
//! unix symlink），全部由宿主侧实现——WASM 插件无注册表等直接通道。
//!
//! 需要 `app:cli` 权限（manifest `permissions` 声明）。
//!
//! 幂等语义：
//! - 重复安装不产生重复 PATH 条目，文件覆盖（升级）
//! - 卸载仅删除本插件的文件与 PATH 条目，保留用户原有项
//! - 应用关闭流程中的卸载自动跳过（CLI 随下次激活重新安装）

use super::HostError;

/// 插件随包 CLI 生命周期管理
pub trait HostApp {
    /// 安装 CLI（幂等），返回安装后的 bin 目录绝对路径
    ///
    /// `file_name`：CLI 文件名（Windows 自动补 .exe，如 "bedtask"）；
    /// 源文件位于插件包目录 `cli/<file-name>`。
    /// `bin_dir`：目标目录，为空用平台默认
    /// （Windows `%LOCALAPPDATA%/com.wasmnest.app/bin`；unix `~/.wasmnest/bin`）。
    fn cli_install(&self, file_name: &str, bin_dir: &str) -> Result<String, HostError>;

    /// 卸载 CLI（幂等）：删除文件 + 移除仅本插件添加的 PATH 条目
    fn cli_uninstall(&self, file_name: &str, bin_dir: &str) -> Result<(), HostError>;

    /// 插件自身资源目录（v25 函数级追加，**无权限门**——只返回调用方自己的安装路径）
    ///
    /// 返回本插件安装目录的绝对路径（含随包资源，如 Agent 集成 hook 脚本）。
    /// 会话创建编排整体移交插件后（session-engine-downsink P1-b）宿主不再产生
    /// `Creating` 生命周期事件，本方法是插件获取自身资源目录的唯一途径（原由
    /// 该事件 payload 的 `resource_dir` 字段提供）。
    /// 宿主服务不可用 / 插件未加载 → `Err`（不静默返回空串）。
    fn plugin_resource_dir(&self) -> Result<String, HostError>;

    /// 把目录登记进**用户级 PATH**（幂等）：`dir` 为绝对路径。
    ///
    /// Windows：追加进 `HKCU\Environment\Path`（保留 `REG_EXPAND_SZ` 与用户
    /// 原有项，写后广播 `WM_SETTINGCHANGE` → 新开终端立即生效）；
    /// unix：为目录下每个可执行文件建 `~/.local/bin` 符号链接。
    ///
    /// 需要 `app:path` 权限（与 `app:cli` 分域）。目录必须落在宿主 allowlist
    /// 根之内（应用数据根 / `~/.local`），越界即拒绝并点名实际路径——PATH 是
    /// 持久化用户环境面，不能由插件任意指定。
    fn path_register(&self, dir: &str) -> Result<(), HostError>;

    /// 从用户级 PATH 精确摘除该目录（幂等）：只摘本目录的条目/链接。
    ///
    /// 需要 `app:path` 权限；条目不存在即成功（幂等）。
    fn path_unregister(&self, dir: &str) -> Result<(), HostError>;
}
