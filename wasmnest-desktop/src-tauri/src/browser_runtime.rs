//! 桌面浏览器运行时：组件分发、sidecar 生命周期与 CDP 渲染。
//!
//! 浏览器进程是宿主侧通用能力。能力仓 `wasmnest-server-browser` 负责闸门、固定提取
//! 脚本与结果收敛；本模块只补宿主才有的那一半——把组件装好、把进程起对、按端口契约
//! 执行导航与脚本。应用 wasm 只调度，不承载浏览器运行时。
//!
//! 关键约束：
//! - 组件来源只认 `browser-runtime.lock.json` 的 `bytes` / `sha256`，不猜「最新版」；
//! - sidecar 只绑 `127.0.0.1`，每插件独立 `storage-dir`，退出即回收；
//! - 准备预算（下载 / 校验 / 解包）与渲染预算（导航 / 脚本）分开计时，
//!   准备超时不得伪装成渲染超时；
//! - 渲染只执行能力域给出的脚本，不自行拼接，也不把整页 HTML 带回 guest。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, Semaphore};
use tokio_tungstenite::tungstenite::Message;

use wasmnest_server_browser::error::{BrowserError, BrowserErrorKind};
use wasmnest_server_browser::guard::ensure_public_ip;
use wasmnest_server_browser::model::WaitUntil;
use wasmnest_server_browser::ports::{RenderRequest, RenderedPage};

/// 组件准备预算：下载 / 校验 / 解包。慢网不该被判成站点超时。
const INSTALL_BUDGET: Duration = Duration::from_secs(600);
/// 每次渲染最多允许两个并行浏览器上下文。
const MAX_CONTEXTS: usize = 2;
/// `Runtime.evaluate` 返回串的上限，防止内存放大。
const MAX_EVALUATE_BYTES: usize = 4 * 1024 * 1024;
/// 等待 sidecar CDP 端点就绪的上限。
const SIDECAR_READY_TIMEOUT: Duration = Duration::from_secs(15);
/// 浏览器组件的唯一允许变体。
const ALLOWED_VARIANT: &str = "default-render";

/// 渲染后端：端口层只依赖本 trait，测试可注入替身。
pub trait BrowserRenderService: Send + Sync + 'static {
    /// 按能力域已收敛的请求执行一次渲染。
    fn render(&self, plugin_id: &str, request: &RenderRequest<'_>) -> Result<RenderedPage, BrowserError>;
}

/// 组件锁：只认已验证平台的字节数与摘要。
#[derive(Debug, Deserialize)]
struct ComponentLock {
    schema: u32,
    obscura: ObscuraMeta,
    #[serde(default)]
    artifacts: HashMap<String, Artifact>,
}

#[derive(Debug, Deserialize)]
struct ObscuraMeta {
    version: String,
    license: String,
    variant: String,
    #[serde(rename = "releaseApi")]
    release_api: String,
}

#[derive(Debug, Deserialize)]
struct Artifact {
    asset: String,
    bytes: u64,
    sha256: String,
    archive: String,
    entry: String,
}

/// 已安装组件的位置。
#[derive(Debug, Clone)]
struct RuntimeLayout {
    entry: PathBuf,
    version: String,
}

/// sidecar 句柄：进程、端点与 profile 目录。
struct Sidecar {
    child: Child,
    ws_url: String,
    port: u16,
    profile: PathBuf,
    pid: u32,
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        // 同步路径的兜底：真正的优雅退出在 `shutdown` 里做，这里只保证进程不残留。
        let _ = self.child.start_kill();
    }
}

/// 进程级浏览器运行时。
pub struct BrowserRuntime {
    root: PathBuf,
    lock_path: Option<PathBuf>,
    install_budget: Duration,
    contexts: Semaphore,
    plugin_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    sidecars: Mutex<HashMap<String, Sidecar>>,
}

impl BrowserRuntime {
    /// 从宿主应用数据目录构造；`lock_path` 缺省时在资源目录与源码树里查找。
    pub fn new(root: PathBuf, lock_path: Option<PathBuf>) -> Arc<Self> {
        Arc::new(Self {
            root,
            lock_path,
            install_budget: INSTALL_BUDGET,
            contexts: Semaphore::new(MAX_CONTEXTS),
            plugin_locks: Mutex::new(HashMap::new()),
            sidecars: Mutex::new(HashMap::new()),
        })
    }

    /// 生产构造：数据目录固定为 `app_data_dir()/browser-runtime`。
    pub fn from_app(app: Option<&tauri::AppHandle>) -> Arc<Self> {
        let base = app
            .and_then(|handle| {
                use tauri::Manager;
                handle.path().app_data_dir().ok()
            })
            .unwrap_or_else(|| std::env::temp_dir().join("wasmnest"));
        let lock_path = resolve_lock_path(app);
        Self::new(base.join("browser-runtime"), lock_path)
    }

    /// 退出回收：终止全部 sidecar 并删除临时 profile。
    pub async fn shutdown(&self) {
        let mut map = self.sidecars.lock().await;
        for (_, mut sidecar) in map.drain() {
            let _ = sidecar.child.kill().await;
            let _ = tokio::fs::remove_file(self.run_file(sidecar.pid)).await;
            let _ = tokio::fs::remove_dir_all(&sidecar.profile).await;
        }
    }

    fn run_file(&self, pid: u32) -> PathBuf {
        self.root.join("run").join(format!("{pid}.json"))
    }

    /// 启动前回收异常退出遗留的 sidecar：run 文件里不在当前存活集合的 pid 一律终止。
    async fn reap_orphans(&self) {
        let run_dir = self.root.join("run");
        let Ok(mut entries) = tokio::fs::read_dir(&run_dir).await else {
            return;
        };
        let live: std::collections::HashSet<u32> = {
            let map = self.sidecars.lock().await;
            map.values().map(|sidecar| sidecar.pid).collect()
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let Ok(text) = tokio::fs::read_to_string(&path).await else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let Some(pid) = value.get("pid").and_then(Value::as_u64) else {
                continue;
            };
            let pid = pid as u32;
            if pid != 0 && !live.contains(&pid) {
                terminate_pid(pid);
                tracing::info!(pid, "reclaimed orphan browser sidecar");
            }
            let _ = tokio::fs::remove_file(&path).await;
        }
    }

    async fn record_sidecar(&self, sidecar: &Sidecar) {
        if sidecar.pid == 0 {
            return;
        }
        let run_dir = self.root.join("run");
        if tokio::fs::create_dir_all(&run_dir).await.is_err() {
            return;
        }
        let payload = json!({
            "pid": sidecar.pid,
            "port": sidecar.port,
            "profile": sidecar.profile,
            "startedAt": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_millis() as u64)
                .unwrap_or_default(),
        });
        if let Err(error) = tokio::fs::write(self.run_file(sidecar.pid), payload.to_string()).await {
            tracing::warn!(error = %error, "cannot record browser sidecar pid file");
        }
    }

    fn read_lock(&self) -> Result<ComponentLock, BrowserError> {
        let Some(path) = &self.lock_path else {
            return Err(BrowserError::new(
                BrowserErrorKind::Unsupported,
                "browser-runtime.lock.json is not available",
            ));
        };
        let text = std::fs::read_to_string(path).map_err(|error| {
            BrowserError::new(
                BrowserErrorKind::Unsupported,
                format!("cannot read browser component lock: {error}"),
            )
        })?;
        let lock: ComponentLock = serde_json::from_str(&text).map_err(|error| {
            BrowserError::new(
                BrowserErrorKind::Unsupported,
                format!("browser component lock is malformed: {error}"),
            )
        })?;
        if lock.schema == 0 {
            return Err(BrowserError::new(
                BrowserErrorKind::Unsupported,
                "browser component lock has no valid schema",
            ));
        }
        if lock.obscura.variant != ALLOWED_VARIANT {
            return Err(BrowserError::new(
                BrowserErrorKind::Unsupported,
                format!(
                    "browser component variant '{}' is not allowed; only '{ALLOWED_VARIANT}' is supported",
                    lock.obscura.variant
                ),
            ));
        }
        Ok(lock)
    }

    /// 确保组件已安装；命中 `.complete` 且入口存在时零网络。
    async fn ensure_installed(&self, lock: &ComponentLock) -> Result<RuntimeLayout, BrowserError> {
        let key = platform_key();
        let Some(artifact) = lock.artifacts.get(&key) else {
            return Err(BrowserError::new(
                BrowserErrorKind::Unsupported,
                format!("no browser component asset for {key}"),
            ));
        };
        let dir = self.root.join(&lock.obscura.version).join(&key);
        let entry = dir.join(&artifact.entry);
        if dir.join(".complete").is_file() && entry.is_file() {
            return Ok(RuntimeLayout {
                entry,
                version: lock.obscura.version.clone(),
            });
        }

        let parent = dir.parent().unwrap_or(&self.root).to_path_buf();
        tokio::fs::create_dir_all(&parent).await.map_err(|error| {
            BrowserError::new(
                BrowserErrorKind::Unavailable,
                format!("cannot create browser component directory: {error}"),
            )
        })?;
        let temp = tempfile::Builder::new()
            .prefix(".download-")
            .tempdir_in(&parent)
            .map_err(|error| {
                BrowserError::new(
                    BrowserErrorKind::Unavailable,
                    format!("cannot create browser download directory: {error}"),
                )
            })?;
        let temp_path = temp.path().to_path_buf();

        let url = download_url(&lock.obscura.release_api, &artifact.asset)?;
        self.download_and_verify(artifact, &url, &temp_path).await?;
        extract_archive(artifact, &temp_path)?;
        write_notice(&temp_path, &lock.obscura, artifact)?;
        tokio::fs::write(temp_path.join(".complete"), b"ok")
            .await
            .map_err(|error| {
                BrowserError::new(
                    BrowserErrorKind::Unavailable,
                    format!("cannot finalize browser component: {error}"),
                )
            })?;
        if dir.exists() {
            tokio::fs::remove_dir_all(&dir).await.map_err(|error| {
                BrowserError::new(
                    BrowserErrorKind::Unavailable,
                    format!("cannot replace browser component: {error}"),
                )
            })?;
        }
        tokio::fs::rename(&temp_path, &dir).await.map_err(|error| {
            BrowserError::new(
                BrowserErrorKind::Unavailable,
                format!("cannot install browser component: {error}"),
            )
        })?;
        std::mem::forget(temp);

        let entry = dir.join(&artifact.entry);
        if !entry.is_file() {
            return Err(BrowserError::new(
                BrowserErrorKind::Unavailable,
                format!(
                    "browser component entry '{}' is missing after extraction",
                    artifact.entry
                ),
            ));
        }
        tracing::info!(
            version = %lock.obscura.version,
            bytes = artifact.bytes,
            sha256 = %artifact.sha256,
            "browser runtime installed"
        );
        Ok(RuntimeLayout {
            entry,
            version: lock.obscura.version.clone(),
        })
    }

    async fn download_and_verify(&self, artifact: &Artifact, url: &str, dir: &Path) -> Result<(), BrowserError> {
        let client = build_download_client()?;
        let response = client.get(url).send().await.map_err(|error| {
            BrowserError::new(
                BrowserErrorKind::Unavailable,
                format!("browser component download failed: {error}"),
            )
        })?;
        if !response.status().is_success() {
            return Err(BrowserError::new(
                BrowserErrorKind::Unavailable,
                format!("browser component download returned HTTP {}", response.status()),
            ));
        }

        let target = dir.join(&artifact.asset);
        let mut file = std::fs::File::create(&target).map_err(|error| {
            BrowserError::new(
                BrowserErrorKind::Unavailable,
                format!("cannot create browser component file: {error}"),
            )
        })?;
        let mut hasher = Sha256::new();
        let mut total = 0_u64;
        let mut stream = response;
        while let Some(chunk) = stream.chunk().await.map_err(|error| {
            BrowserError::new(
                BrowserErrorKind::Unavailable,
                format!("browser component stream failed: {error}"),
            )
        })? {
            total += chunk.len() as u64;
            if total > artifact.bytes {
                return Err(BrowserError::new(
                    BrowserErrorKind::TooLarge,
                    format!("browser component exceeded locked size {} bytes", artifact.bytes),
                ));
            }
            hasher.update(&chunk);
            file.write_all(&chunk).map_err(|error| {
                BrowserError::new(
                    BrowserErrorKind::Unavailable,
                    format!("cannot write browser component: {error}"),
                )
            })?;
        }
        drop(file);
        if total != artifact.bytes {
            return Err(BrowserError::new(
                BrowserErrorKind::Unavailable,
                format!(
                    "browser component size mismatch: expected {}, got {total}",
                    artifact.bytes
                ),
            ));
        }
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(&artifact.sha256) {
            let _ = std::fs::remove_file(&target);
            return Err(BrowserError::new(
                BrowserErrorKind::Unavailable,
                "browser component sha256 mismatch; download removed",
            ));
        }
        Ok(())
    }

    async fn plugin_lock(&self, plugin_id: &str) -> Arc<Mutex<()>> {
        let mut map = self.plugin_locks.lock().await;
        Arc::clone(
            map.entry(plugin_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    async fn sidecar_url(&self, plugin_id: &str, layout: &RuntimeLayout) -> Result<String, BrowserError> {
        self.reap_orphans().await;
        let mut map = self.sidecars.lock().await;
        if let Some(sidecar) = map.get_mut(plugin_id) {
            match sidecar.child.try_wait() {
                Ok(None) => return Ok(sidecar.ws_url.clone()),
                _ => {
                    let mut exited = map.remove(plugin_id).expect("sidecar was just observed");
                    let _ = exited.child.start_kill();
                    tracing::info!(plugin_id = %plugin_id, outcome = "exit", "browser sidecar exited");
                }
            }
        }
        let profile = self.root.join("profiles").join(plugin_id);
        let sidecar = spawn_sidecar(&layout.entry, &profile).await?;
        self.record_sidecar(&sidecar).await;
        let url = sidecar.ws_url.clone();
        tracing::info!(
            plugin_id = %plugin_id,
            version = %layout.version,
            port = sidecar.port,
            "browser sidecar started"
        );
        map.insert(plugin_id.to_string(), sidecar);
        Ok(url)
    }

    async fn forget_sidecar(&self, plugin_id: &str) {
        let mut map = self.sidecars.lock().await;
        if let Some(mut sidecar) = map.remove(plugin_id) {
            let _ = sidecar.child.kill().await;
        }
    }

    async fn render_once(
        &self,
        plugin_id: &str,
        layout: &RuntimeLayout,
        request: &RenderRequest<'_>,
    ) -> Result<RenderedPage, BrowserError> {
        let ws_url = self.sidecar_url(plugin_id, layout).await?;
        let mut cdp = Cdp::connect(&ws_url).await?;
        let result = cdp.render(request).await;
        cdp.close().await;
        result
    }

    async fn render_with_retry(
        &self,
        plugin_id: &str,
        layout: &RuntimeLayout,
        request: &RenderRequest<'_>,
    ) -> Result<RenderedPage, BrowserError> {
        match self.render_once(plugin_id, layout, request).await {
            Ok(page) => Ok(page),
            Err(error) if error.kind() == BrowserErrorKind::Unavailable => {
                tracing::warn!(plugin_id = %plugin_id, "browser sidecar unavailable; restarting once");
                self.forget_sidecar(plugin_id).await;
                self.render_once(plugin_id, layout, request).await
            }
            Err(error) => Err(error),
        }
    }
}

impl BrowserRenderService for BrowserRuntime {
    fn render(&self, plugin_id: &str, request: &RenderRequest<'_>) -> Result<RenderedPage, BrowserError> {
        // 能力域已收敛超时；这里只做宿主侧的执行与再上界。
        let render_budget = Duration::from_millis(u64::from(request.timeout_ms.max(1)));
        wasmnest_wasm_core::runtime_util::block_on_async(async {
            let lock = self.read_lock()?;
            let layout = tokio::time::timeout(self.install_budget, self.ensure_installed(&lock))
                .await
                .map_err(|_| {
                    BrowserError::new(
                        BrowserErrorKind::Unavailable,
                        "stage=download-timeout: browser component preparation exceeded budget",
                    )
                })??;

            let _permit = self
                .contexts
                .acquire()
                .await
                .map_err(|_| BrowserError::new(BrowserErrorKind::Unavailable, "browser context gate is closed"))?;
            let plugin_lock = self.plugin_lock(plugin_id).await;
            let _serial = plugin_lock.lock().await;

            match tokio::time::timeout(render_budget, self.render_with_retry(plugin_id, &layout, request)).await {
                Ok(result) => result,
                Err(_) => Err(BrowserError::new(
                    BrowserErrorKind::Timeout,
                    format!("render exceeded {} ms", request.timeout_ms),
                )),
            }
        })
    }
}

fn resolve_lock_path(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("WASMNEST_BROWSER_RUNTIME_LOCK") {
        if !raw.trim().is_empty() {
            return Some(PathBuf::from(raw));
        }
    }
    if let Some(app) = app {
        use tauri::Manager;
        if let Ok(dir) = app.path().resource_dir() {
            let candidate = dir.join("browser-runtime.lock.json");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../browser-runtime.lock.json");
    dev.is_file().then_some(dev)
}

fn platform_key() -> String {
    let os = std::env::consts::OS;
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => other,
    };
    format!("{os}-{arch}")
}

fn download_url(release_api: &str, asset: &str) -> Result<String, BrowserError> {
    // 测试与镜像站可覆盖下载基址；信任源仍是 lock 的 bytes / sha256，不因基址改变。
    if let Ok(base) = std::env::var("WASMNEST_BROWSER_RUNTIME_BASE_URL") {
        let base = base.trim().trim_end_matches('/');
        if !base.is_empty() {
            return Ok(format!("{base}/{asset}"));
        }
    }
    let marker = "/repos/";
    let Some(rest) = release_api.split(marker).nth(1) else {
        return Err(BrowserError::new(
            BrowserErrorKind::Unsupported,
            "browser component lock has no usable release API",
        ));
    };
    let mut parts = rest.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    let tag = parts
        .collect::<Vec<_>>()
        .split(|part| *part == "tags")
        .nth(1)
        .and_then(|tail| tail.first().copied())
        .unwrap_or_default();
    if owner.is_empty() || repo.is_empty() || tag.is_empty() {
        return Err(BrowserError::new(
            BrowserErrorKind::Unsupported,
            "browser component lock has an incomplete release API",
        ));
    }
    Ok(format!(
        "https://github.com/{owner}/{repo}/releases/download/{tag}/{asset}"
    ))
}

fn build_download_client() -> Result<reqwest::Client, BrowserError> {
    let mut builder = reqwest::Client::builder();
    if let Some(proxy) = crate::plugin::stt::resolve_download_proxy() {
        builder = builder.proxy(reqwest::Proxy::all(&proxy).map_err(|error| {
            BrowserError::new(
                BrowserErrorKind::Unavailable,
                format!("browser download proxy is invalid: {error}"),
            )
        })?);
    }
    builder.build().map_err(|error| {
        BrowserError::new(
            BrowserErrorKind::Unavailable,
            format!("browser download client unavailable: {error}"),
        )
    })
}

fn extract_archive(artifact: &Artifact, dir: &Path) -> Result<(), BrowserError> {
    let archive = dir.join(&artifact.asset);
    match artifact.archive.as_str() {
        "tar.gz" => {
            let file = std::fs::File::open(&archive).map_err(|error| {
                BrowserError::new(
                    BrowserErrorKind::Unavailable,
                    format!("cannot open browser component archive: {error}"),
                )
            })?;
            let decoder = flate2::read::GzDecoder::new(file);
            let mut tar = tar::Archive::new(decoder);
            tar.unpack(dir).map_err(|error| {
                BrowserError::new(
                    BrowserErrorKind::Unavailable,
                    format!("cannot extract browser component archive: {error}"),
                )
            })?;
        }
        "zip" => {
            let file = std::fs::File::open(&archive).map_err(|error| {
                BrowserError::new(
                    BrowserErrorKind::Unavailable,
                    format!("cannot open browser component archive: {error}"),
                )
            })?;
            let mut zip = zip::ZipArchive::new(file).map_err(|error| {
                BrowserError::new(
                    BrowserErrorKind::Unavailable,
                    format!("cannot read browser component archive: {error}"),
                )
            })?;
            zip.extract(dir).map_err(|error| {
                BrowserError::new(
                    BrowserErrorKind::Unavailable,
                    format!("cannot extract browser component archive: {error}"),
                )
            })?;
        }
        other => {
            return Err(BrowserError::new(
                BrowserErrorKind::Unsupported,
                format!("browser component archive '{other}' is not supported"),
            ))
        }
    }
    Ok(())
}

fn write_notice(dir: &Path, meta: &ObscuraMeta, artifact: &Artifact) -> Result<(), BrowserError> {
    let notice = format!(
        "Obscura {}\nSource: {}\nsha256: {}\nLicense: {}\nModifications: none\n",
        meta.version, meta.release_api, artifact.sha256, meta.license
    );
    std::fs::write(dir.join("NOTICE"), notice).map_err(|error| {
        BrowserError::new(
            BrowserErrorKind::Unavailable,
            format!("cannot write browser component notice: {error}"),
        )
    })
}

async fn spawn_sidecar(entry: &Path, profile: &Path) -> Result<Sidecar, BrowserError> {
    tokio::fs::create_dir_all(profile).await.map_err(|error| {
        BrowserError::new(
            BrowserErrorKind::Unavailable,
            format!("cannot create browser profile: {error}"),
        )
    })?;
    let port = probe_port().await?;
    let mut child = Command::new(entry)
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .arg("--storage-dir")
        .arg(profile)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            BrowserError::new(
                BrowserErrorKind::Unavailable,
                format!("cannot start browser sidecar: {error}"),
            )
        })?;
    let ws_url = wait_for_cdp(port, &mut child).await?;
    let pid = child.id().unwrap_or(0);
    Ok(Sidecar {
        child,
        ws_url,
        port,
        profile: profile.to_path_buf(),
        pid,
    })
}

/// 终止遗留进程：只用于 run 文件里确认不属于当前运行时的 pid。
fn terminate_pid(pid: u32) {
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
    }
}

async fn probe_port() -> Result<u16, BrowserError> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|error| {
        BrowserError::new(
            BrowserErrorKind::Unavailable,
            format!("cannot reserve browser sidecar port: {error}"),
        )
    })?;
    let port = listener
        .local_addr()
        .map_err(|error| {
            BrowserError::new(
                BrowserErrorKind::Unavailable,
                format!("cannot read browser sidecar port: {error}"),
            )
        })?
        .port();
    drop(listener);
    Ok(port)
}

async fn wait_for_cdp(port: u16, child: &mut Child) -> Result<String, BrowserError> {
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + SIDECAR_READY_TIMEOUT;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(BrowserError::new(
                BrowserErrorKind::Unavailable,
                format!("browser sidecar exited before CDP was ready: {status}"),
            ));
        }
        let response = client
            .get(format!("http://127.0.0.1:{port}/json/version"))
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        if let Ok(response) = response {
            if response.status().is_success() {
                if let Ok(text) = response.text().await {
                    if let Ok(value) = serde_json::from_str::<Value>(&text) {
                        if let Some(url) = value.get("webSocketDebuggerUrl").and_then(Value::as_str) {
                            return Ok(url.to_string());
                        }
                    }
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(BrowserError::new(
                BrowserErrorKind::Unavailable,
                "browser sidecar did not expose a CDP endpoint",
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// 最小 CDP 客户端：命令响应按 id 匹配，事件走广播通道。
struct Cdp {
    tx: mpsc::UnboundedSender<Message>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    events: broadcast::Sender<Value>,
    next_id: AtomicU64,
    session_id: String,
    target_id: String,
}

impl Cdp {
    async fn connect(url: &str) -> Result<Self, BrowserError> {
        let (socket, _) = tokio_tungstenite::connect_async(url).await.map_err(|error| {
            BrowserError::new(
                BrowserErrorKind::Unavailable,
                format!("cannot connect to browser sidecar CDP: {error}"),
            )
        })?;
        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        });

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = Arc::clone(&pending);
        let (events, _) = broadcast::channel(512);
        let reader_events = events.clone();
        tokio::spawn(async move {
            while let Some(message) = stream.next().await {
                let Ok(Message::Text(text)) = message else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    if let Some(sender) = reader_pending.lock().await.remove(&id) {
                        let _ = sender.send(value);
                    }
                } else {
                    let _ = reader_events.send(value);
                }
            }
        });

        Ok(Self {
            tx,
            pending,
            events,
            next_id: AtomicU64::new(1),
            session_id: String::new(),
            target_id: String::new(),
        })
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, BrowserError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);

        let mut payload = json!({ "id": id, "method": method, "params": params });
        if !self.session_id.is_empty() {
            payload["sessionId"] = json!(self.session_id);
        }
        self.tx
            .send(Message::Text(payload.to_string().into()))
            .map_err(|_| BrowserError::new(BrowserErrorKind::Unavailable, "browser CDP channel is closed"))?;

        let response = tokio::time::timeout(Duration::from_secs(30), receiver)
            .await
            .map_err(|_| BrowserError::new(BrowserErrorKind::Timeout, format!("CDP {method} timed out")))?
            .map_err(|_| BrowserError::new(BrowserErrorKind::Unavailable, "browser CDP channel is closed"))?;

        if let Some(error) = response.get("error") {
            return Err(BrowserError::new(
                BrowserErrorKind::ParseError,
                format!("CDP {method} failed: {error}"),
            ));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn open_target(&mut self) -> Result<(), BrowserError> {
        let result = self
            .call("Target.createTarget", json!({ "url": "about:blank" }))
            .await?;
        self.target_id = result
            .get("targetId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                BrowserError::new(
                    BrowserErrorKind::ParseError,
                    "CDP Target.createTarget returned no targetId",
                )
            })?
            .to_string();
        let attached = self
            .call(
                "Target.attachToTarget",
                json!({ "targetId": self.target_id, "flatten": true }),
            )
            .await?;
        self.session_id = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                BrowserError::new(
                    BrowserErrorKind::ParseError,
                    "CDP Target.attachToTarget returned no sessionId",
                )
            })?
            .to_string();
        Ok(())
    }

    async fn render(&mut self, request: &RenderRequest<'_>) -> Result<RenderedPage, BrowserError> {
        if !matches!(request.url.scheme(), "http" | "https") {
            return Err(BrowserError::new(
                BrowserErrorKind::InvalidRequest,
                format!("scheme '{}' is not allowed", request.url.scheme()),
            ));
        }
        preflight_url(request.url).await?;

        self.open_target().await?;
        self.call("Page.enable", json!({})).await?;
        self.call("Network.enable", json!({})).await?;
        self.call("Runtime.enable", json!({})).await?;
        self.call("Network.clearBrowserCookies", json!({})).await?;

        let mut events = self.events.subscribe();
        let navigation = self
            .call("Page.navigate", json!({ "url": request.url.as_str() }))
            .await?;
        if let Some(error) = navigation.get("errorText").and_then(Value::as_str) {
            return Err(BrowserError::new(
                BrowserErrorKind::HttpError,
                format!("navigation failed: {error}"),
            ));
        }

        let (status, final_url) = self.wait_navigation(request.wait_until, &mut events).await?;
        if !(200..300).contains(&status) {
            return Err(BrowserError::new(
                BrowserErrorKind::HttpError,
                format!("page returned HTTP {status}"),
            ));
        }
        let payload = self.evaluate(request.script).await?;
        Ok(RenderedPage {
            status,
            final_url,
            payload,
        })
    }

    async fn wait_navigation(
        &mut self,
        wait_until: WaitUntil,
        events: &mut broadcast::Receiver<Value>,
    ) -> Result<(u16, String), BrowserError> {
        let mut status = 0_u16;
        let mut final_url = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(BrowserError::new(
                    BrowserErrorKind::Timeout,
                    "navigation did not complete in time",
                ));
            }
            let event = match tokio::time::timeout(remaining, events.recv()).await {
                Ok(Ok(event)) => event,
                Ok(Err(_)) => {
                    return Err(BrowserError::new(
                        BrowserErrorKind::Unavailable,
                        "browser CDP event channel closed",
                    ))
                }
                Err(_) => {
                    return Err(BrowserError::new(
                        BrowserErrorKind::Timeout,
                        "navigation did not complete in time",
                    ))
                }
            };
            match event.get("method").and_then(Value::as_str).unwrap_or("") {
                "Network.responseReceived" => {
                    let params = &event["params"];
                    if params.get("type").and_then(Value::as_str) == Some("Document") {
                        let response = &params["response"];
                        status = response.get("status").and_then(Value::as_u64).unwrap_or(0) as u16;
                        final_url = response.get("url").and_then(Value::as_str).unwrap_or("").to_string();
                    }
                }
                "Page.loadEventFired" => match wait_until {
                    WaitUntil::Load => break,
                    WaitUntil::NetworkIdle => {
                        let _ = tokio::time::timeout(Duration::from_millis(500), events.recv()).await;
                        break;
                    }
                    WaitUntil::DomContentLoaded => {}
                    _ => {}
                },
                "Page.domContentEventFired" => match wait_until {
                    WaitUntil::DomContentLoaded => break,
                    _ => {}
                },
                _ => {}
            }
        }

        if final_url.is_empty() {
            final_url = self
                .evaluate_raw("location.href")
                .await?
                .as_str()
                .unwrap_or_default()
                .to_string();
        }
        // 重定向后的复检：CDP 不提供 remoteAddress（实测为 undefined），只能再解析
        // 最终地址。DNS rebinding 的 TOCTOU 残余风险无法在单次解析里消除，已在
        // 实施记录中登记。
        if let Ok(final_url_parsed) = url::Url::parse(&final_url) {
            if matches!(final_url_parsed.scheme(), "http" | "https") {
                preflight_url(&final_url_parsed).await?;
            }
        }
        if status == 0 {
            return Err(BrowserError::new(
                BrowserErrorKind::HttpError,
                "navigation produced no document response status",
            ));
        }
        Ok((status, final_url))
    }

    async fn evaluate(&self, script: &str) -> Result<String, BrowserError> {
        let value = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": script, "returnByValue": true, "awaitPromise": false }),
            )
            .await?;
        let payload = value
            .get("result")
            .and_then(|result| result.get("value"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                BrowserError::new(
                    BrowserErrorKind::ParseError,
                    "extraction script returned no string payload",
                )
            })?;
        if payload.len() > MAX_EVALUATE_BYTES {
            return Err(BrowserError::new(
                BrowserErrorKind::TooLarge,
                format!("extraction payload exceeded {MAX_EVALUATE_BYTES} bytes"),
            ));
        }
        Ok(payload.to_string())
    }

    async fn evaluate_raw(&self, expression: &str) -> Result<Value, BrowserError> {
        let value = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await?;
        Ok(value
            .get("result")
            .and_then(|result| result.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    async fn close(&mut self) {
        if !self.target_id.is_empty() {
            let _ = self
                .call("Target.closeTarget", json!({ "targetId": self.target_id }))
                .await;
            self.target_id.clear();
        }
    }
}

async fn preflight_url(url: &url::Url) -> Result<(), BrowserError> {
    let Some(host) = url.host_str() else {
        return Err(BrowserError::new(
            BrowserErrorKind::InvalidRequest,
            "browser request has no host",
        ));
    };
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| BrowserError::new(BrowserErrorKind::HttpError, format!("cannot resolve {host}: {error}")))?;
    for address in addresses {
        ensure_public_ip(address.ip())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_key_is_lowercase_os_and_arch() {
        let key = platform_key();
        assert!(key.starts_with(std::env::consts::OS));
        assert!(!key.contains(' '));
    }

    #[test]
    fn download_url_is_derived_from_release_api() {
        let url = download_url(
            "https://api.github.com/repos/h4ckf0r0day/obscura/releases/tags/v0.2.7",
            "obscura-x86_64-linux.tar.gz",
        )
        .expect("url");
        assert_eq!(
            url,
            "https://github.com/h4ckf0r0day/obscura/releases/download/v0.2.7/obscura-x86_64-linux.tar.gz"
        );
    }

    #[test]
    fn non_default_variant_is_rejected_before_any_download() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lock_path = dir.path().join("browser-runtime.lock.json");
        std::fs::write(
            &lock_path,
            r#"{
                "schema": 1,
                "obscura": {
                    "version": "0.2.7",
                    "license": "Apache-2.0",
                    "variant": "stealth",
                    "releaseApi": "https://api.github.com/repos/h4ckf0r0day/obscura/releases/tags/v0.2.7"
                },
                "artifacts": {}
            }"#,
        )
        .expect("write lock");
        let runtime = BrowserRuntime::new(dir.path().join("runtime"), Some(lock_path));
        let error = runtime.read_lock().expect_err("variant must be rejected");
        assert_eq!(error.kind(), BrowserErrorKind::Unsupported);
        assert!(error.to_string().contains("default-render"));
    }

    /// 真实组件冒烟：需要本机已安装 Obscura，并由环境变量指向运行时缓存。
    ///
    /// 运行方式：
    /// `WASMNEST_BROWSER_RUNTIME_ROOT=… WASMNEST_BROWSER_RUNTIME_LOCK=… \
    ///  cargo test --lib browser_runtime::tests::renders_a_real_page -- --ignored`
    #[test]
    #[ignore = "requires a real obscura component in the runtime cache"]
    fn renders_a_real_page() {
        let root = std::env::var("WASMNEST_BROWSER_RUNTIME_ROOT")
            .map(PathBuf::from)
            .expect("WASMNEST_BROWSER_RUNTIME_ROOT");
        let lock = std::env::var("WASMNEST_BROWSER_RUNTIME_LOCK")
            .map(PathBuf::from)
            .expect("WASMNEST_BROWSER_RUNTIME_LOCK");
        let runtime = BrowserRuntime::new(root, Some(lock));
        let url = url::Url::parse("https://example.com/").expect("url");
        let request = RenderRequest {
            url: &url,
            wait_until: WaitUntil::DomContentLoaded,
            timeout_ms: 30_000,
            script: "(() => JSON.stringify({ title: document.title }))()",
        };
        let page = runtime.render("com.wasmnest.news", &request).expect("render");
        assert_eq!(page.status, 200);
        assert!(page.payload.contains("Example Domain"), "payload: {}", page.payload);
    }

    /// 私网目标在导航前被拒绝：即使组件已就绪，也不得启动一次私网请求。
    #[test]
    #[ignore = "requires a real obscura component in the runtime cache"]
    fn rejects_private_targets_before_navigation() {
        let root = std::env::var("WASMNEST_BROWSER_RUNTIME_ROOT")
            .map(PathBuf::from)
            .expect("WASMNEST_BROWSER_RUNTIME_ROOT");
        let lock = std::env::var("WASMNEST_BROWSER_RUNTIME_LOCK")
            .map(PathBuf::from)
            .expect("WASMNEST_BROWSER_RUNTIME_LOCK");
        let runtime = BrowserRuntime::new(root, Some(lock));
        let url = url::Url::parse("http://127.0.0.1:9/").expect("url");
        let request = RenderRequest {
            url: &url,
            wait_until: WaitUntil::DomContentLoaded,
            timeout_ms: 30_000,
            script: "(() => null)()",
        };
        let error = runtime
            .render("com.wasmnest.news", &request)
            .expect_err("private target");
        assert_eq!(error.kind(), BrowserErrorKind::BlockedPrivate);
    }

    /// 组件失败分类：篡改摘要、超字节、离线三例都必须落到稳定分类，且不留下安装目录。
    #[test]
    #[ignore = "uses a local HTTP fixture and process-wide env override"]
    fn artifact_failure_classes_are_stable() {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;

        fn serve_once(body: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            let address = listener.local_addr().expect("addr");
            let handle = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut buffer = [0_u8; 1024];
                let _ = stream.read(&mut buffer);
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
            });
            (format!("http://{address}"), handle)
        }

        fn run_case(name: &str, base: &str, bytes: u64, sha256: &str) -> BrowserErrorKind {
            std::env::set_var("WASMNEST_BROWSER_RUNTIME_BASE_URL", base);
            let dir = tempfile::tempdir().expect("tempdir");
            let lock_path = dir.path().join("lock.json");
            let key = platform_key();
            let mut artifacts = serde_json::Map::new();
            artifacts.insert(
                key.clone(),
                json!({
                    "asset": "fixture.tar.gz",
                    "bytes": bytes,
                    "sha256": sha256,
                    "archive": "tar.gz",
                    "entry": "obscura"
                }),
            );
            let lock = json!({
                "schema": 1,
                "obscura": {
                    "version": "0.2.7",
                    "license": "Apache-2.0",
                    "variant": "default-render",
                    "releaseApi": "https://api.github.com/repos/h4ckf0r0day/obscura/releases/tags/v0.2.7"
                },
                "artifacts": Value::Object(artifacts)
            });
            std::fs::write(&lock_path, lock.to_string()).expect("lock");
            let runtime = BrowserRuntime::new(dir.path().join("runtime"), Some(lock_path));
            let parsed = runtime.read_lock().expect("read lock");
            let error =
                wasmnest_wasm_core::runtime_util::block_on_async(runtime.ensure_installed(&parsed)).expect_err(name);
            assert!(
                !dir.path().join("runtime").join("0.2.7").join(&key).exists(),
                "{name}: 失败后不得留下安装目录"
            );
            error.kind()
        }

        let body = b"not a real tar.gz".to_vec();
        let (base, handle) = serve_once(body.clone());
        assert_eq!(
            run_case("sha256 mismatch", &base, body.len() as u64, &"0".repeat(64)),
            BrowserErrorKind::Unavailable
        );
        handle.join().expect("server");

        let (base, handle) = serve_once(body.clone());
        assert_eq!(
            run_case("oversized", &base, (body.len() - 1) as u64, &"0".repeat(64)),
            BrowserErrorKind::TooLarge
        );
        handle.join().expect("server");

        assert_eq!(
            run_case("offline", "http://127.0.0.1:1", body.len() as u64, &"0".repeat(64)),
            BrowserErrorKind::Unavailable
        );
        std::env::remove_var("WASMNEST_BROWSER_RUNTIME_BASE_URL");
    }

    /// 首次安装路径：从本地镜像下载真实资产，完成校验、解包、NOTICE 与 `.complete`。
    #[test]
    #[ignore = "requires a local HTTP mirror of the real obscura asset"]
    fn installs_from_local_fixture_and_writes_notice() {
        let base = std::env::var("WASMNEST_BROWSER_FIXTURE_BASE").expect("WASMNEST_BROWSER_FIXTURE_BASE");
        let asset = std::env::var("WASMNEST_BROWSER_FIXTURE_ASSET").expect("WASMNEST_BROWSER_FIXTURE_ASSET");
        let bytes: u64 = std::env::var("WASMNEST_BROWSER_FIXTURE_BYTES")
            .expect("WASMNEST_BROWSER_FIXTURE_BYTES")
            .parse()
            .expect("bytes");
        let sha256 = std::env::var("WASMNEST_BROWSER_FIXTURE_SHA256").expect("WASMNEST_BROWSER_FIXTURE_SHA256");
        std::env::set_var("WASMNEST_BROWSER_RUNTIME_BASE_URL", &base);

        let dir = tempfile::tempdir().expect("tempdir");
        let lock_path = dir.path().join("lock.json");
        let key = platform_key();
        let mut artifacts = serde_json::Map::new();
        artifacts.insert(
            key.clone(),
            json!({
                "asset": asset,
                "bytes": bytes,
                "sha256": sha256,
                "archive": "tar.gz",
                "entry": "obscura"
            }),
        );
        let lock = json!({
            "schema": 1,
            "obscura": {
                "version": "0.2.7",
                "license": "Apache-2.0",
                "variant": "default-render",
                "releaseApi": "https://api.github.com/repos/h4ckf0r0day/obscura/releases/tags/v0.2.7"
            },
            "artifacts": Value::Object(artifacts)
        });
        std::fs::write(&lock_path, lock.to_string()).expect("lock");

        let runtime = BrowserRuntime::new(dir.path().join("runtime"), Some(lock_path));
        let parsed = runtime.read_lock().expect("read lock");
        let layout =
            wasmnest_wasm_core::runtime_util::block_on_async(runtime.ensure_installed(&parsed)).expect("install");
        assert!(layout.entry.is_file(), "entry 缺失: {}", layout.entry.display());

        let install_dir = dir.path().join("runtime").join("0.2.7").join(&key);
        assert!(install_dir.join(".complete").is_file(), ".complete 缺失");
        let notice = std::fs::read_to_string(install_dir.join("NOTICE")).expect("NOTICE");
        assert!(notice.contains("Obscura 0.2.7"), "NOTICE: {notice}");
        assert!(notice.contains("Apache-2.0"), "NOTICE: {notice}");
        assert!(notice.contains(&sha256), "NOTICE: {notice}");
        std::env::remove_var("WASMNEST_BROWSER_RUNTIME_BASE_URL");
    }

    /// 脚本返回串超过 evaluate 上限时按 `browser.too-large` 收敛，不回传大载荷。
    #[test]
    #[ignore = "requires a real obscura component in the runtime cache"]
    fn rejects_oversized_payload() {
        let root = std::env::var("WASMNEST_BROWSER_RUNTIME_ROOT")
            .map(PathBuf::from)
            .expect("WASMNEST_BROWSER_RUNTIME_ROOT");
        let lock = std::env::var("WASMNEST_BROWSER_RUNTIME_LOCK")
            .map(PathBuf::from)
            .expect("WASMNEST_BROWSER_RUNTIME_LOCK");
        let runtime = BrowserRuntime::new(root, Some(lock));
        let url = url::Url::parse("https://example.com/").expect("url");
        let request = RenderRequest {
            url: &url,
            wait_until: WaitUntil::DomContentLoaded,
            timeout_ms: 30_000,
            script: "(() => 'x'.repeat(4 * 1024 * 1024 + 1))()",
        };
        let error = runtime
            .render("com.wasmnest.news", &request)
            .expect_err("oversized payload");
        assert_eq!(error.kind(), BrowserErrorKind::TooLarge);
    }
}
