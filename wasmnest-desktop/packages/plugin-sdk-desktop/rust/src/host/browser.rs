//! 宿主能力：浏览器渲染（WIT `host-browser` 的 `fetch-rendered`）
//!
//! 宿主在隔离的浏览器进程里导航到目标页，回取可读文本；插件只给地址、等待档位
//! 与可选的正文容器，拿回状态、最终地址与文本。**不给**插件选择「列表提取」的
//! 入口（列表提取属宿主侧编排），也**不允许**插件申请私网访问：私网放行只由宿主
//! 按用户对该 origin 的既有授权记录裁决，因此本模块的请求结构里刻意没有
//! `allowPrivateNetwork` 字段——宿主在构造 WIT 请求时字面写 `false`。
//!
//! 需要 `network:browser` 权限（与 `network:http` 分域、不互相隐含）；移动端契约
//! 同形但实现恒返回 `browser.unsupported`。错误串保留宿主侧的 `browser.*` 前缀，
//! 本层不重新分类。

use super::HostError;
use serde::{Deserialize, Serialize};

/// 导航完成的判定时机（与 WIT `wait-until` 逐字对应）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserWaitUntil {
    /// 页面 `load` 事件
    Load,
    /// DOM 解析完成
    DomContentLoaded,
    /// 网络空闲（宿主按浏览器引擎能力近似）
    NetworkIdle,
}

/// 正文提取目标：只取一个容器内的可读文本
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageSpec {
    /// 正文容器选择器；`None` 时取整页可读文本
    pub content: Option<String>,
}

/// 一次渲染请求
///
/// 只含地址、等待档位、总超时与可选正文容器。私网申请、列表提取都不在插件可
/// 声明面内（见模块注释）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRenderRequest {
    /// 目标地址（只接受 http / https）
    pub url: String,
    /// 导航完成判定
    pub wait_until: BrowserWaitUntil,
    /// 总超时；宿主收敛到 1..=30000 毫秒
    pub timeout_ms: u32,
    /// 正文容器；`None` 表示不要求正文文本
    pub extract_page: Option<BrowserPageSpec>,
}

/// 渲染结果：只回文本与状态，不回整页 HTML
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRenderResponse {
    /// 主文档最终 HTTP 状态码
    pub status: u16,
    /// 重定向后的最终地址
    pub final_url: String,
    /// 页面标题（平台未提供时为 `None`）
    pub title: Option<String>,
    /// 整页可读文本（宿主侧已按上限截断）
    pub text: Option<String>,
    /// 正文文本（`extract_page` 生效时才有）
    pub content_text: Option<String>,
    /// 任一字段被截断时为 `true`
    pub truncated: bool,
}

/// 浏览器渲染（宿主实现：桌面为隔离浏览器进程，移动恒 `browser.unsupported`）
pub trait HostBrowser {
    /// 导航并在页面上下文执行宿主固定提取逻辑
    fn browser_fetch_rendered(
        &self,
        request: &BrowserRenderRequest,
    ) -> Result<BrowserRenderResponse, HostError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 请求字段名必须是 camelCase（与 WIT `request` 记录逐字对应，落库 / 日志都依赖它）
    #[test]
    fn request_serializes_with_camel_case_keys() {
        let request = BrowserRenderRequest {
            url: "https://example.com/".into(),
            wait_until: BrowserWaitUntil::DomContentLoaded,
            timeout_ms: 30_000,
            extract_page: Some(BrowserPageSpec {
                content: Some("article".into()),
            }),
        };
        let value = serde_json::to_value(&request).expect("serialize request");
        assert_eq!(value["url"], "https://example.com/");
        assert_eq!(value["waitUntil"], "dom-content-loaded");
        assert_eq!(value["timeoutMs"], 30_000);
        assert_eq!(value["extractPage"]["content"], "article");
        // 私网申请不在插件可声明面内（宿主导出侧恒 false）
        assert!(value.get("allowPrivateNetwork").is_none());
        // 列表提取不在插件可声明面内
        assert!(value.get("extractList").is_none());
    }

    /// 三个等待档位与 WIT 枚举值逐字一致
    #[test]
    fn wait_until_matches_wit_variants() {
        for (value, expected) in [
            (BrowserWaitUntil::Load, "load"),
            (BrowserWaitUntil::DomContentLoaded, "dom-content-loaded"),
            (BrowserWaitUntil::NetworkIdle, "network-idle"),
        ] {
            assert_eq!(
                serde_json::to_value(value).expect("serialize wait-until"),
                serde_json::Value::String(expected.into())
            );
        }
    }

    /// 响应字段名同样 camelCase，正文只走文本字段（HTML 不进结构）
    #[test]
    fn response_serializes_with_camel_case_keys() {
        let response = BrowserRenderResponse {
            status: 200,
            final_url: "https://example.com/final".into(),
            title: Some("Title".into()),
            text: Some("full text".into()),
            content_text: Some("body text".into()),
            truncated: true,
        };
        let value = serde_json::to_value(&response).expect("serialize response");
        assert_eq!(value["finalUrl"], "https://example.com/final");
        assert_eq!(value["contentText"], "body text");
        assert_eq!(value["truncated"], true);
        assert!(value.get("html").is_none());
    }
}
