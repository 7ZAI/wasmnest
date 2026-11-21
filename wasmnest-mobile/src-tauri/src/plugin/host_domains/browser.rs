//! host-browser — 移动端不可用实现（`browser.unsupported`）
//!
//! 浏览器渲染能力域只在桌面端有真实后端（隔离浏览器进程 + 组件下载）；移动端
//! **契约存在、能力不存在**：本文件实现 WIT `host-browser` 的宿主侧，恒返回
//! `browser.unsupported`，不启动进程、不下载组件、不依赖
//! `wasmnest-server-browser`（避免把桌面侧引擎与二进制依赖带进移动包）。
//!
//! 为什么必须有这份实现：双端 compose 都拼入了 `wasmnest:browser`（共享业务核
//! 双端共用同一份 wasm 产物时，world 的 import 必须两端都可满足）。若移动宿主
//! 缺这条 interface 的 `add_to_linker`，插件实例化期会报 missing import ——
//! 那是装载故障，不是「能力不可用」。能力不可用必须由调用期的稳定错误码表达。
//!
//! 错误前缀与桌面侧分类逐字一致（`browser.unsupported`），调用方据此展示
//! 「此能力仅桌面可用」，而不是当成网络错误重试。

use crate::plugin::bindings::wasmnest;
use wasmnest_host_kit::WasmPluginState;

impl wasmnest::browser::host_browser::Host for WasmPluginState {
    fn fetch_rendered(
        &mut self,
        _req: wasmnest::browser::host_browser::Request,
    ) -> Result<wasmnest::browser::host_browser::Response, String> {
        // 不做权限判定：无后端时权限通过也拿不到结果，先判权限只会让「未声明」
        // 与「本端不支持」两个原因混成一条。分类固定为 unsupported。
        Err("browser.unsupported: 浏览器渲染仅桌面端可用（移动端不启动浏览器进程）".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 移动宿主声明与能力域契约逐字一致（装载期一致性核对与跨端回退判据都用它）
    #[test]
    fn module_declaration_includes_browser_interface() {
        assert_eq!(
            super::super::MODULE_INTERFACES
                .iter()
                .filter(|i| i.starts_with("wasmnest:browser@"))
                .copied()
                .collect::<Vec<_>>(),
            vec!["wasmnest:browser@0.0.1/host-browser"],
        );
        assert!(super::super::MODULE_PERMISSIONS.contains(&"network:browser"));
    }
}
