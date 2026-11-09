//! URL 轻量解析与声明模式（仅 Egress 匹配用，非通用 URL 库）

// ==================== URL 轻量解析（仅 Egress 匹配用） ====================

/// 轻量解析后的 URL 成分（HTTP/HTTPS 场景足够）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiteUrl {
    pub scheme: String,
    pub host: String,
    pub port: Option<u16>,
    /// 不含 query 的路径（默认 "/"）
    pub path: String,
}

/// 轻量 URL 解析：`scheme://host[:port]/path...`。host 归一化小写；
/// 无法解析返回 None（判定方按拒绝处理，fail-closed）。
///
/// **必须与 reqwest 使用同一份解析结果**（CWE-20 / CWE-918）：安全判定看的是
/// 这里解析出的 host/port，实际请求由 reqwest 发出——两套手写解析对 userinfo
/// （`http://127.0.0.1:80@evil.com`）与 IPv6 authority 的分叉会让策略检查 A、
/// 请求发给 B。故直接复用 `reqwest::Url`（reqwest 内部同一 crate/同一版本），
/// 并显式拒绝 userinfo：宿主的任何合法调用面都不需要它。
pub fn parse_url_lite(url: &str) -> Option<LiteUrl> {
    let parsed = reqwest::Url::parse(url).ok()?;
    // userinfo 会让 reqwest 的 host 与策略解析分叉，且宿主无此需求 → fail-closed
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    Some(LiteUrl {
        scheme: parsed.scheme().to_ascii_lowercase(),
        // `Url::host_str` 对 IPv6 带方括号（`[::1]`）：去掉后再与 IP 解析 / L1 目标
        // 集合同口径（`is_loopback_host` / `is_private_ip` 都按裸地址判断）。
        host: parsed
            .host_str()?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_ascii_lowercase(),
        // 默认端口（http:80 / https:443）返回 None，与既有「未显式声明即任意」语义一致
        port: parsed.port(),
        path: parsed.path().to_string(),
    })
}

/// 目标 host 是否环回（本地豁免判据；与桌面过滤器同口径）
///
/// 环回流量在桌面端**不进入链路加密过滤器**（本地豁免）：客户端若给它加信封，
/// 密文会被原样交给插件。移动端所有「是否加信封」的判定都必须先排除环回目标。
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

// ==================== URL 声明模式（preauthUrls / 宿主内置） ====================

/// URL 声明模式（glob）：`[scheme://][*.]host[:port][/path-prefix]`
///
/// - `*` 仅支持子域通配前缀（`*.example.com` 匹配 `example.com` 与任意子域）
/// - scheme / port 省略时按任意匹配（仅 host 维度声明）
/// - path-prefix 为前缀匹配（默认全路径）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlPattern {
    pub scheme: Option<String>,
    pub wildcard_subdomain: bool,
    pub host: String,
    pub port: Option<u16>,
    pub path_prefix: Option<String>,
}

impl UrlPattern {
    /// 解析声明字符串；非法（空 host）返回 None
    pub fn parse(pattern: &str) -> Option<UrlPattern> {
        let pattern = pattern.trim();
        if pattern.is_empty() {
            return None;
        }
        let (scheme, rest) = match pattern.find("://") {
            Some(i) => (Some(pattern[..i].to_lowercase()), &pattern[i + 3..]),
            None => (None, pattern),
        };
        let (authority, path_prefix) = match rest.find('/') {
            Some(i) => {
                // glob：末尾 `*` 通配任意剩余 → 存前缀（匹配用 starts_with）
                let p = rest[i..].strip_suffix('*').unwrap_or(&rest[i..]);
                (&rest[..i], Some(p.to_string()))
            }
            None => (rest, None),
        };
        let (host_part, port) = match authority.rsplit_once(':') {
            Some((h, p)) if p.parse::<u16>().is_ok() => (h, p.parse::<u16>().ok()),
            _ => (authority, None),
        };
        let (wildcard_subdomain, host) = match host_part.strip_prefix("*.") {
            Some(h) => (true, h.to_lowercase()),
            // IPv6 声明同样去掉方括号，与 `LiteUrl.host` 同口径
            None => (
                false,
                host_part.trim_start_matches('[').trim_end_matches(']').to_lowercase(),
            ),
        };
        if host.is_empty() {
            return None;
        }
        Some(UrlPattern {
            scheme,
            wildcard_subdomain,
            host,
            port,
            path_prefix,
        })
    }

    /// 模式是否匹配解析后的 URL
    pub fn matches(&self, url: &LiteUrl) -> bool {
        if let Some(s) = &self.scheme {
            if *s != url.scheme {
                return false;
            }
        }
        let host_matches = if self.wildcard_subdomain {
            url.host == self.host || url.host.ends_with(&format!(".{}", self.host))
        } else {
            url.host == self.host
        };
        if !host_matches {
            return false;
        }
        if let Some(p) = self.port {
            if Some(p) != url.port {
                return false;
            }
        }
        if let Some(prefix) = &self.path_prefix {
            if !url.path.starts_with(prefix) {
                return false;
            }
        }
        true
    }
}
