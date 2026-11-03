//! host-clipboard 宿主侧接线（路径 B：WIT 绑定 + `Host` impl + 域函数同处）
//!
//! 2026-11-02 新建（ADR-0006 · notenote 剪贴板后端能力票）：桌面端经
//! `tauri-plugin-clipboard-manager` 读写系统剪贴板，WIT 契约真源在能力仓
//! `wasmnest-clipboard-engine/wit/clipboard.wit`（双端 caps.clipboard 直接消费）。
//!
//! 权限：`clipboard:read` / `clipboard:write` **有权限门**（fail-closed，未声明即拒）。
//! 剪贴板是用户隐私面——跨应用数据泄露风险高，读 / 写分域授权：「只需粘贴」的
//! 插件不获得复制面，反之亦然。门禁落点在本文件的 `require_clipboard_read` /
//! `require_clipboard_write` 域函数入口。
//!
//! 错误语义：
//! - `read-text`：剪贴板为空或含非文本内容 → `Ok(None)`（不是 Err）；宿主 API 故障
//!   → `Err(message)`；
//! - `write-text`：成功 → `Ok(())`；宿主 API 故障 → `Err(message)`。

use wasmnest_host_kit::ports::downcast_host;
use wasmnest_host_kit::{HostModule, HostModuleDesc, ModuleEntry, WasmPluginState};
use wasmnest_wasm_core::host_api::context::WasmHostContext;
use wasmnest_wasm_core::permission::{PERMISSION_CLIPBOARD_READ, PERMISSION_CLIPBOARD_WRITE};

use crate::plugin::bindings::wasmnest;

// 能力模块白名单条目
wasmnest_host_kit::expect_host_module!(MODULE_NAME);

/// 能力模块名
pub const MODULE_NAME: &str = "clipboard";

/// 本域提供的 WIT 接口
pub const MODULE_INTERFACES: &[&str] = &["wasmnest:plugin@0.0.2/host-clipboard"];

/// 本域的权限位（读 / 写分域）
pub const MODULE_PERMISSIONS: &[&str] = &[PERMISSION_CLIPBOARD_READ, PERMISSION_CLIPBOARD_WRITE];

/// 能力模块描述符
const DESC: HostModuleDesc = HostModuleDesc {
    name: MODULE_NAME,
    interfaces: MODULE_INTERFACES,
    permissions: MODULE_PERMISSIONS,
    abi_min: 38,
};

/// host-clipboard 能力模块
pub struct ClipboardModule;

impl HostModule for ClipboardModule {
    fn desc(&self) -> HostModuleDesc {
        DESC
    }

    fn register(
        &self,
        linker: &mut wasmtime::component::Linker<WasmPluginState>,
    ) -> wasmtime::Result<()> {
        wasmnest::plugin::host_clipboard::add_to_linker::<WasmPluginState, HasSelf>(linker, |s| s)
    }
}

type HasSelf = wasmtime::component::HasSelf<WasmPluginState>;

static MODULE: ClipboardModule = ClipboardModule;

inventory::submit! {
    ModuleEntry { module: &MODULE }
}

// ==================== WIT 层（import 接口 → 域函数转发） ====================

impl wasmnest::plugin::host_clipboard::Host for WasmPluginState {
    fn read_text(&mut self) -> Result<Option<String>, String> {
        require_clipboard_read(ctx_of(self), &self.plugin_id)?;
        clipboard_read_text(ctx_of(self))
    }

    fn write_text(&mut self, text: String) -> Result<(), String> {
        require_clipboard_write(ctx_of(self), &self.plugin_id)?;
        clipboard_write_text(ctx_of(self), &text)
    }
}

/// 权限门：未声明 `clipboard:read` 即拒
fn require_clipboard_read(ctx: &WasmHostContext, plugin_id: &str) -> Result<(), String> {
    if wasmnest_wasm_core::host_api::check_permission(
        ctx,
        plugin_id,
        PERMISSION_CLIPBOARD_READ,
        "host_clipboard.read_text",
    ) {
        Ok(())
    } else {
        Err("permission denied: clipboard:read".to_string())
    }
}

/// 权限门：未声明 `clipboard:write` 即拒
fn require_clipboard_write(ctx: &WasmHostContext, plugin_id: &str) -> Result<(), String> {
    if wasmnest_wasm_core::host_api::check_permission(
        ctx,
        plugin_id,
        PERMISSION_CLIPBOARD_WRITE,
        "host_clipboard.write_text",
    ) {
        Ok(())
    } else {
        Err("permission denied: clipboard:write".to_string())
    }
}

fn ctx_of(state: &WasmPluginState) -> &WasmHostContext {
    downcast_host::<WasmHostContext>(state.host.as_ref())
}

// ==================== 域函数 ====================

/// 读取系统剪贴板文本（经 Tauri ClipboardExt）
///
/// 无头上下文（测试 / 无 AppHandle）→ `Ok(None)`（剪贴板不可用时降级为空，
/// 不报错——与 notify 的强需求语义不同，剪贴板读是查询型操作）。
fn clipboard_read_text(ctx: &WasmHostContext) -> Result<Option<String>, String> {
    let Some(app_handle) = ctx.app_handle() else {
        return Ok(None);
    };
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let text = app_handle
        .clipboard()
        .read_text()
        .map_err(|e| format!("clipboard read error: {}", e))?;
    Ok(if text.is_empty() { None } else { Some(text) })
}

/// 写入文本到系统剪贴板（经 Tauri ClipboardExt）
///
/// 无头上下文 → 显性报错（写是操作型能力，降级成「假装已写」会让插件误以为
/// 数据已入剪贴板）。
fn clipboard_write_text(ctx: &WasmHostContext, text: &str) -> Result<(), String> {
    let Some(app_handle) = ctx.app_handle() else {
        return Err("clipboard error: app_handle not available in headless context".to_string());
    };
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app_handle
        .clipboard()
        .write_text(text)
        .map_err(|e| format!("clipboard write error: {}", e))
}

// ==================== Tests ====================

#[cfg(test)]
mod tests {
    use super::*;
    use wasmnest_wasm_core::host_api::context::PermissionScope;
    use wasmnest_wasm_core::test_support::build_host_ctx_at;

    /// 无头上下文：read 降级为 None（查询型操作，不报错）
    #[test]
    fn read_headless_returns_none() {
        let ctx = build_host_ctx_at(None);
        let result = clipboard_read_text(ctx.as_ref()).unwrap();
        assert!(result.is_none(), "无头上下文读剪贴板应返回 None");
    }

    /// 无头上下文：write 显性报错（操作型能力，不静默降级）
    #[test]
    fn write_headless_rejected() {
        let ctx = build_host_ctx_at(None);
        let err = clipboard_write_text(ctx.as_ref(), "test").unwrap_err();
        assert!(err.contains("app_handle not available"), "got: {err}");
    }

    /// 白名单三件一致
    #[test]
    fn host_module_declaration_matches_domain_constants() {
        assert!(
            wasmnest_host_kit::expected_host_modules().contains(&MODULE_NAME),
            "能力模块白名单缺 {MODULE_NAME}（expect_host_module! 行被删 / 未收集）"
        );
        assert_eq!(MODULE_NAME, "clipboard");
        assert_eq!(
            MODULE_INTERFACES,
            &["wasmnest:plugin@0.0.2/host-clipboard"],
            "接口路径必须与 WIT 契约逐字一致"
        );
        assert_eq!(
            MODULE_PERMISSIONS,
            &[PERMISSION_CLIPBOARD_READ, PERMISSION_CLIPBOARD_WRITE],
            "clipboard 读 / 写分域授权"
        );
        assert_eq!(DESC.name, MODULE_NAME);
        assert_eq!(DESC.interfaces, MODULE_INTERFACES);
        assert_eq!(DESC.permissions, MODULE_PERMISSIONS);
    }

    /// 权限门：未声明 clipboard:read 即拒，授予后放行
    #[test]
    fn read_requires_declared_permission() {
        let ctx = build_host_ctx_at(None);
        let plugin = "com.wasmnest.unprivileged";

        let err = require_clipboard_read(ctx.as_ref(), plugin).unwrap_err();
        assert_eq!(err, "permission denied: clipboard:read");

        ctx.permission()
            .grant_permissions(plugin, &[PERMISSION_CLIPBOARD_READ.to_string()]);
        require_clipboard_read(ctx.as_ref(), plugin)
            .expect("授予 clipboard:read 后必须放行");

        // 授权不跨插件串号
        assert!(require_clipboard_read(ctx.as_ref(), "com.wasmnest.other").is_err());
    }

    /// 权限门：未声明 clipboard:write 即拒，授予后放行
    #[test]
    fn write_requires_declared_permission() {
        let ctx = build_host_ctx_at(None);
        let plugin = "com.wasmnest.unprivileged";

        let err = require_clipboard_write(ctx.as_ref(), plugin).unwrap_err();
        assert_eq!(err, "permission denied: clipboard:write");

        ctx.permission()
            .grant_permissions(plugin, &[PERMISSION_CLIPBOARD_WRITE.to_string()]);
        require_clipboard_write(ctx.as_ref(), plugin)
            .expect("授予 clipboard:write 后必须放行");

        // 读权限不放行写（分域授权）
        ctx.permission()
            .grant_permissions("com.wasmnest.read-only", &[PERMISSION_CLIPBOARD_READ.to_string()]);
        assert!(
            require_clipboard_write(ctx.as_ref(), "com.wasmnest.read-only").is_err(),
            "clipboard:read 不能代替 clipboard:write"
        );
    }
}
