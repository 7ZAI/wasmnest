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
pub fn parse_url_lite(url: &str) -> Option<LiteUrl> {
    let scheme_end = url.find("://")?;
    let scheme = url[..scheme_end].to_lowercase();
    let rest = &url[scheme_end + 3..];
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    // authority 可能含 query（无 path 时）——取到 ? 为止
    let authority = authority.split('?').next().unwrap_or(authority);
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h.to_lowercase(), p.parse::<u16>().ok()),
        None => (authority.to_lowercase(), None),
    };
    if host.is_empty() {
        return None;
    }
    // path 剥 query
    let path = match path.split('?').next() {
        Some(p) if !p.is_empty() => p,
        _ => "/",
    };
    Some(LiteUrl {
        scheme,
        host,
        port,
        path: path.to_string(),
    })
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
            None => (false, host_part.to_lowercase()),
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
