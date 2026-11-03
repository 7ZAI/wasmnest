//! 宿主能力：系统剪贴板读写（WIT `host-clipboard`，共享域契约）
//!
//! 2026-11-02 新建（ADR-0006 · notenote 剪贴板后端能力票）：双端共享契约
//! `host-clipboard`（真源 `packages/wasmnest-clipboard-engine/wit/clipboard.wit`）。
//!
//! 权限：`clipboard:read` / `clipboard:write` 分域授权（fail-closed，manifest 必须
//! 单独声明）。读 / 写是两种权力——「只需粘贴」的插件不获得复制面，反之亦然。

use super::HostError;

/// 系统剪贴板读写（WIT `host-clipboard`，双端共享契约）
///
/// 读返回 `Option<String>`：剪贴板为空或含非文本内容时返回 `None`（不是 Err）。
/// 写返回 `()`：成功即 `Ok(())`，失败经 `Err(HostError)` 传宿主侧可读消息。
pub trait HostClipboard {
    /// 读取系统剪贴板文本内容。
    ///
    /// 剪贴板有文本时返回 `Ok(Some(text))`，为空或含非文本内容时返回 `Ok(None)`。
    /// 宿主 API 故障返回 `Err(HostError)`。
    fn clipboard_read_text(&self) -> Result<Option<String>, HostError>;

    /// 写入文本到系统剪贴板。
    ///
    /// 成功返回 `Ok(())`，失败返回 `Err(HostError)`。
    fn clipboard_write_text(&self, text: &str) -> Result<(), HostError>;
}
