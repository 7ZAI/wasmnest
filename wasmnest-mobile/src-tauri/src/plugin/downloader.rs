//! Plugin Downloader / Installer（移动端）
//!
//! 插件包（zip）统一安装：本地文件或远程 URL → 解压 → wasm_hash 校验 → 写来源标记 → 移动到插件目录
//! 分发单元为单个 zip（内含 plugin.json、index.js 与可选的 .wasm）

use crate::egress::EgressDecision;
use crate::plugin::validation::validate_plugin_id;
use crate::system::constants::plugin::*;
use crate::Result;
use std::io::Read;
use std::path::Path;
use tokio::io::AsyncWriteExt;

/// 插件下载出站的 egress 闸门（与 `commands/http_proxy.rs` external 分支同判据）
///
/// 拆成两段是为了让**裁决**可脱离 AppHandle 单测（`AppHandle` 绑 Wry runtime，
/// mock 注入不进来）：`decide_download_url` 是纯判定，`ask_consent` 才碰弹窗。
/// 生产路径必须把两段串起来跑，跳过任一段都等于闸门失效——接线由
/// `tests/outbound_egress_gate_coverage_lock.rs` 的行为测试钉住。
///
/// `source` 取 `plugin:downloader`：策略层按 `plugin:` 前缀查插件档位
/// （宿主来源恒默认档）。下载由用户在前端触发但目的地是插件分发源，
/// 故归属插件策略面。
pub fn decide_download_url(zip_url: &str) -> Result<EgressDecision> {
    Ok(crate::egress::policy().decide(zip_url, "plugin:downloader"))
}

/// NeedConsent 分支的用户授权弹窗（无应答即视为拒绝 —— fail-closed）
pub async fn ask_consent(app: &tauri::AppHandle, zip_url: &str) -> Result<()> {
    use crate::egress::{EgressDecision, ERROR_URL_DENIED};

    match decide_download_url(zip_url)? {
        EgressDecision::Allow(_) => Ok(()),
        EgressDecision::Deny(e) => {
            tracing::warn!(url = %zip_url, code = %e.code, "egress: plugin download url denied");
            Err(crate::AppError::Egress(format!("{}: {}", e.code, e.url)))
        }
        EgressDecision::NeedConsent(mut req) => {
            // 弹窗事务 id：下载路径无前端 request_id，宿主生成 UUID（同 host_ports）
            req.id = uuid::Uuid::new_v4().to_string();
            let allowed = crate::egress::policy()
                .request_consent(app, req)
                .await
                .map_err(|e| crate::AppError::Egress(format!("egress consent flow failed: {e}")))?;
            if allowed {
                Ok(())
            } else {
                Err(crate::AppError::Egress(format!("{ERROR_URL_DENIED}: {zip_url}")))
            }
        }
    }
}

/// 同 id 目录已存在时的安装语义
///
/// `upgrade` 与「fresh install 是否恢复旧数据」是两件不相干的事，因此不合并成
/// 两个裸 bool：升级恒保数据（宿主事先裁定来源 / 运行态），fresh install 的
/// 同 id 目录只可能是残留（keep-data 卸载 / 被装载期重复裁决拒绝的副本 /
/// tombstone 后重装），是否带进新装必须由用户显式选择（默认不恢复）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallMode {
    /// 就地升级：保留 `plugin.db` 家族，替换目录内容
    Upgrade,
    /// fresh install：同 id 目录按残留处理
    FreshInstall {
        /// 是否恢复旧应用数据（私有库 `plugin.db` 家族；KV 由命令面按同一选择清理）
        restore_data: bool,
    },
}

/// 插件下载安装器
pub struct PluginDownloader;

impl PluginDownloader {
    /// 从本地 zip 插件包安装（来源标记 file-install）
    ///
    /// 1. 打开 zip，校验 plugin.json 必填字段
    /// 2. 解压到临时目录（路径穿越防护）
    /// 3. wasm_hash 校验（manifest 声明时）
    /// 4. 写来源标记（file-install）
    /// 5. 移动到 app_data_dir/plugins/{plugin_id}/
    pub async fn install_from_file(zip_path: &str, plugins_dir: &Path, mode: InstallMode) -> Result<String> {
        Self::install_package(zip_path, plugins_dir, SOURCE_FILE_INSTALL, mode).await
    }

    /// 安装已下载到本地的远程包（来源标记 remote-download）
    ///
    /// 与 `install_from_file` 只差来源标记：远程安装同样必须由壳层在落盘前
    /// 拿到用户的「是否恢复旧数据」选择（两相下载见 `download_package`）。
    pub async fn install_downloaded_file(zip_path: &str, plugins_dir: &Path, mode: InstallMode) -> Result<String> {
        Self::install_package(zip_path, plugins_dir, SOURCE_REMOTE_DOWNLOAD, mode).await
    }

    async fn install_package(zip_path: &str, plugins_dir: &Path, source: &str, mode: InstallMode) -> Result<String> {
        let zip_path = Path::new(zip_path);
        if !zip_path.exists() {
            return Err(crate::AppError::Plugin(format!(
                "Plugin package not found: {}",
                zip_path.display()
            )));
        }
        Self::install_zip(zip_path, plugins_dir, source, mode).await
    }

    /// 读取 zip 内 `plugin.json` 的插件 id（升级前置裁决用；不解压落盘）
    ///
    /// 与安装共用同一份 manifest 解析 / id 校验，避免「先装后判」造成半成品目录。
    pub fn peek_plugin_id(zip_path: &Path) -> Result<String> {
        let file = std::fs::File::open(zip_path)
            .map_err(|e| crate::AppError::Plugin(format!("Failed to open plugin package: {}", e)))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| crate::AppError::Plugin(format!("Invalid plugin package: {}", e)))?;
        let mut manifest_str = String::new();
        archive
            .by_name(PLUGIN_MANIFEST_FILE)
            .map_err(|e| crate::AppError::Plugin(format!("Plugin package missing plugin.json: {}", e)))?
            .read_to_string(&mut manifest_str)
            .map_err(|e| crate::AppError::Plugin(format!("Failed to read plugin.json: {}", e)))?;
        let manifest: crate::plugin::types::PluginManifest = serde_json::from_str(&manifest_str)
            .map_err(|e| crate::AppError::Plugin(format!("Failed to parse plugin.json: {}", e)))?;
        if !validate_plugin_id(&manifest.id) {
            return Err(crate::AppError::Plugin(format!(
                "plugin.json id {:?} is invalid: must be a reverse-domain name like com.example.plugin",
                manifest.id
            )));
        }
        Ok(manifest.id)
    }

    /// 下载远程 zip 到插件临时目录（**不安装**），返回本地包路径
    ///
    /// 两相拆分（2026-11-07 安装↔卸载闭环，与桌面「选包 → 预读 → 询问 → 安装」
    /// 同口径）：fresh install 若同 id 留有旧数据，壳层必须在**落盘前**拿到用户的
    /// 「是否恢复旧数据」选择；一相「下载即安装」只能在安装后才知道 id，永远无法
    /// 询问。调用方拿到路径后用 `peek_plugin_id` + 宿主注册表裁决，再走
    /// `install_downloaded_file` 落地。
    ///
    /// **出站必须过 egress 闸门**：URL 由前端传入（`plugin_download_package` 命令的
    /// `zip_url` 参数），是一条与插件自身 HTTP 面平行的出站路径。不经闸门时，
    /// 插件下载会成为整个宿主唯一不受 egress 策略约束的网络出口——用户在设置
    /// 页授权的外网域名清单对它形同虚设。判据与 `commands/http_proxy.rs`
    /// 的 external 分支同款（`EgressPolicy::decide` 三层判定 + 授权弹窗），
    /// 跳转另经 `egress::redirect_policy()` 复检，两处缺一则闸门可被绕过。
    pub async fn download_package(
        app: &tauri::AppHandle,
        zip_url: &str,
        plugins_dir: &Path,
    ) -> Result<std::path::PathBuf> {
        ask_consent(app, zip_url).await?;

        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(PLUGIN_DOWNLOAD_CONNECT_TIMEOUT_SECS))
            .read_timeout(std::time::Duration::from_secs(PLUGIN_DOWNLOAD_READ_TIMEOUT_SECS))
            // 跳转目标复检：首跳放行不代表跳转链每跳都放行（跳向私网/未声明
            // 目标必须在链上被截断，否则闸门只管住了第一跳）
            .redirect(crate::egress::redirect_policy())
            .build()
            .map_err(|e| crate::AppError::Plugin(format!("Failed to create HTTP client: {}", e)))?;

        tracing::info!("[PluginDownloader] Downloading plugin package from: {}", zip_url);
        let response = client
            .get(zip_url)
            .send()
            .await
            .map_err(|e| crate::AppError::Plugin(format!("Failed to download plugin package: {}", e)))?;
        if !response.status().is_success() {
            return Err(crate::AppError::Plugin(format!(
                "Download '{}' returned status {}",
                zip_url,
                response.status()
            )));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| crate::AppError::Plugin(format!("Failed to read download response: {}", e)))?;

        // 临时包用唯一文件名：两相之间可能并存多个待裁决包，不能被下一次下载覆盖。
        // 写入前顺手清掉上一轮遗留（用户取消询问时留下）——目录只放下载产物。
        let temp_dir = plugins_dir.join(PLUGIN_DOWNLOAD_TEMP_DIR);
        tokio::fs::create_dir_all(&temp_dir).await?;
        Self::clear_stale_downloads(&temp_dir).await;
        let temp_zip = temp_dir.join(format!("download-{}.zip", uuid::Uuid::new_v4()));
        let mut file = tokio::fs::File::create(&temp_zip).await?;
        file.write_all(&bytes).await?;
        drop(file);

        Ok(temp_zip)
    }

    /// 清理遗留的下载包（只删 `download-*.zip`，不碰解压临时目录）
    async fn clear_stale_downloads(temp_dir: &Path) {
        let Ok(mut entries) = tokio::fs::read_dir(temp_dir).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("download-") && name.ends_with(".zip") {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }

    /// zip 解压安装（file-install / remote-download 共用）
    ///
    /// `mode = Upgrade`：同 id 就地升级（替换插件目录；插件 KV 在独立 DB，不受影响）。
    /// `mode = FreshInstall { restore_data }`：同 id 目录只能是残留（注册表无该 id，
    /// 命令面已裁决）——`restore_data` 决定 `plugin.db` 家族是否带进新装；默认丢弃。
    /// 运行态 / 系统服务 / 非可更新来源的裁决在命令面（需要 PluginManager 才能读到
    /// 真实状态）；本函数只负责「目录换新 + 写来源标记」。
    async fn install_zip(zip_path: &Path, plugins_dir: &Path, source: &str, mode: InstallMode) -> Result<String> {
        // 1. 打开 zip
        let file = std::fs::File::open(zip_path)
            .map_err(|e| crate::AppError::Plugin(format!("Failed to open plugin package: {}", e)))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| crate::AppError::Plugin(format!("Invalid plugin package: {}", e)))?;

        // 2. 读取并校验 manifest
        let mut manifest_str = String::new();
        archive
            .by_name(PLUGIN_MANIFEST_FILE)
            .map_err(|e| crate::AppError::Plugin(format!("Plugin package missing plugin.json: {}", e)))?
            .read_to_string(&mut manifest_str)
            .map_err(|e| crate::AppError::Plugin(format!("Failed to read plugin.json: {}", e)))?;
        let manifest: crate::plugin::types::PluginManifest = serde_json::from_str(&manifest_str)
            .map_err(|e| crate::AppError::Plugin(format!("Failed to parse plugin.json: {}", e)))?;
        // 身份校验：id 必须为反向域名格式（防伪造 id 冒名顶替/路径注入）
        if !validate_plugin_id(&manifest.id) {
            return Err(crate::AppError::Plugin(format!(
                "plugin.json id {:?} is invalid: must be a reverse-domain name like com.example.plugin",
                manifest.id
            )));
        }
        if manifest.name.is_empty() {
            return Err(crate::AppError::Plugin("plugin.json missing name field".to_string()));
        }
        if manifest.version.is_empty() {
            return Err(crate::AppError::Plugin("plugin.json missing version field".to_string()));
        }
        // rustLibrary 是拼 wasm 路径的唯一输入：拒绝路径成分（目录外 wasm 不在
        // 审批哈希的钉扎范围内）
        if !manifest.rust_library.is_empty() {
            wasmnest_wasm_core::manager::validation::validate_rust_library_name(&manifest.rust_library)?;
        }
        // 平台适配门禁（platform 必填）：移动端只放行 mobile / both——桌面专属
        // 分发包被安装到本端即显性拒绝（与目录扫描 loader.rs::load_manifest 同判据）
        if !manifest.platform.supports(crate::plugin::types::PluginPlatform::Mobile) {
            return Err(crate::AppError::Plugin(format!(
                "plugin.json platform=\"{}\" 与移动端不匹配：该插件声明仅适配另一端\
                 （platform 需为 \"mobile\"；双端适配写 \"both\"），移动端拒绝安装",
                manifest.platform.as_str()
            )));
        }

        let plugin_id = manifest.id.clone();
        let temp_dir = plugins_dir.join(PLUGIN_DOWNLOAD_TEMP_DIR).join(&plugin_id);

        // 3. 解压到临时目录
        if temp_dir.exists() {
            tokio::fs::remove_dir_all(&temp_dir).await?;
        }
        tokio::fs::create_dir_all(&temp_dir).await?;

        // 解压是同步阻塞 I/O：搬进 spawn_blocking，不能占住 Tokio worker
        // （大包会让同一运行时的连接/事件任务一起变慢）。
        let extract_dir = temp_dir.clone();
        tokio::task::spawn_blocking(move || -> crate::Result<()> {
            for i in 0..archive.len() {
                let mut entry = archive
                    .by_index(i)
                    .map_err(|e| crate::AppError::Plugin(format!("Failed to read plugin package entry: {}", e)))?;
                let name = entry.name().to_string();
                if entry.is_dir() {
                    continue;
                }
                if !Self::is_safe_zip_name(&name) {
                    return Err(crate::AppError::Plugin(format!(
                        "Plugin package contains unsafe path: {}",
                        name
                    )));
                }
                let dest = extract_dir.join(&name);
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| crate::AppError::Plugin(format!("Failed to create '{}': {}", name, e)))?;
                }
                let mut out = std::fs::File::create(&dest)
                    .map_err(|e| crate::AppError::Plugin(format!("Failed to create '{}': {}", name, e)))?;
                std::io::copy(&mut entry, &mut out)
                    .map_err(|e| crate::AppError::Plugin(format!("Failed to extract '{}': {}", name, e)))?;
            }
            Ok(())
        })
        .await
        .map_err(|e| crate::AppError::Plugin(format!("Plugin extract task failed: {}", e)))??;

        // 4. wasm_hash 校验（manifest 声明时）
        if !manifest.rust_library.is_empty() && !manifest.wasm_hash.is_empty() {
            let wasm_path = temp_dir.join(format!("{}{}", manifest.rust_library, WASM_FILE_EXT));
            if !wasm_path.exists() {
                return Err(crate::AppError::Plugin(format!(
                    "Plugin package missing WASM file: {}{}",
                    manifest.rust_library, WASM_FILE_EXT
                )));
            }
            Self::verify_sha256(&wasm_path, &manifest.wasm_hash).await?;
        }

        // 5. 写来源标记
        let marker = temp_dir.join(PLUGIN_SOURCE_MARKER);
        tokio::fs::write(&marker, source).await?;

        // 6. 移动到最终目录
        //
        // fresh install 时含 plugin.json 的同 id 目录也拒绝覆盖：无签名链时无法
        // 区分「同作者更新」与「冒名顶替替换」，静默替换会让既有审批（哈希钉扎）
        // 与权限继续作用于被替换后的新代码（审批门禁的旁路）。只有**无 manifest 的
        // 残留**（keep-data 卸载 / 被装载期重复裁决拒绝的休眠副本）可被替换，
        // 是否保留 `plugin.db` 家族由 `InstallMode` 决定。
        let final_dir = plugins_dir.join(&plugin_id);
        if final_dir.exists() {
            let has_manifest = final_dir.join(PLUGIN_MANIFEST_FILE).exists();
            let restoring = match mode {
                InstallMode::Upgrade => true,
                InstallMode::FreshInstall { restore_data } => {
                    if has_manifest {
                        tokio::fs::remove_dir_all(&temp_dir).await?;
                        return Err(crate::AppError::Plugin(format!(
                            "Plugin '{}' is already installed. Uninstall it first to install a new version.",
                            plugin_id
                        )));
                    }
                    restore_data
                }
            };
            // 恢复 / 升级：`plugin.db` 家族搬进新包目录（插件包正常不含私有库，
            // 同名冲突极小）；不恢复：整目录丢弃，旧数据随残留一起删除。
            if restoring {
                Self::preserve_private_db(&final_dir, &temp_dir).await?;
            }
            tokio::fs::remove_dir_all(&final_dir).await?;
        }
        tokio::fs::rename(&temp_dir, &final_dir).await?;

        tracing::info!(
            "[PluginDownloader] Plugin '{}' installed to {:?} (source: {})",
            plugin_id,
            final_dir,
            source
        );
        Ok(plugin_id)
    }

    /// 升级 / keep-data 重装的私有库保留：`plugin.db` 及 sqlite 伴生文件搬进新包目录
    async fn preserve_private_db(old_dir: &Path, new_dir: &Path) -> Result<()> {
        let mut entries = tokio::fs::read_dir(old_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str != "plugin.db" && !name_str.starts_with("plugin.db-") {
                continue;
            }
            let from = entry.path();
            let to = new_dir.join(&name);
            tokio::fs::rename(&from, &to).await.map_err(|e| {
                crate::AppError::Plugin(format!(
                    "Failed to preserve plugin database '{}': {}",
                    from.display(),
                    e
                ))
            })?;
            tracing::info!(
                file = %name_str,
                "[PluginDownloader] Preserved plugin private database"
            );
        }
        Ok(())
    }

    /// zip 条目路径安全校验：拒绝绝对路径、盘符、.. 路径穿越
    fn is_safe_zip_name(name: &str) -> bool {
        if name.starts_with('/') || name.starts_with('\\') {
            return false;
        }
        if name.contains(':') {
            return false;
        }
        // 规范化后检查是否有 .. 段
        let normalized = name.replace('\\', "/");
        if normalized.split('/').any(|seg| seg == ".." || seg == ".") {
            return false;
        }
        true
    }

    /// SHA256 校验
    async fn verify_sha256(file_path: &Path, expected_hash: &str) -> Result<()> {
        let bytes = tokio::fs::read(file_path).await?;
        let hash = sha256_hex(&bytes);
        let expected = expected_hash.strip_prefix(SHA256_PREFIX).unwrap_or(expected_hash);

        if hash != expected {
            return Err(crate::AppError::Plugin(format!(
                "SHA256 verification failed for {:?}: expected {}, got {}",
                file_path, expected, hash
            )));
        }

        tracing::info!("[PluginDownloader] SHA256 verified for {:?}", file_path);
        Ok(())
    }
}

/// 计算 SHA256 哈希（hex 编码）
fn sha256_hex(data: &[u8]) -> String {
    use std::fmt::Write;
    let hash = <sha2::Sha256 as sha2::Digest>::digest(data);
    let mut hex = String::with_capacity(hash.len() * 2);
    for byte in hash {
        write!(hex, "{:02x}", byte).unwrap();
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 构造一个合法插件 zip（frontend 形态免 wasm 产物，platform 可指定）
    fn build_zip(dir: &Path, id: &str, platform: &str) -> std::path::PathBuf {
        build_zip_version(dir, id, platform, "1.0.0")
    }

    /// 同 [`build_zip`]，版本可控（升级测试用）
    fn build_zip_version(dir: &Path, id: &str, platform: &str, version: &str) -> std::path::PathBuf {
        let zip_path = dir.join(format!("{}-{}.zip", id, version));
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let manifest = serde_json::json!({
            "id": id,
            "name": "Test Plugin",
            "version": version,
            "platform": platform,
            "pluginType": "frontend",
            "main": "index.js",
            "permissions": [],
            "contributes": {}
        })
        .to_string();
        writer
            .start_file(PLUGIN_MANIFEST_FILE, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(manifest.as_bytes()).unwrap();
        writer
            .start_file("index.js", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"console.log('test')").unwrap();
        writer.finish().unwrap();
        zip_path
    }

    /// 升级安装：fresh install 拒绝覆盖已安装；Upgrade 替换目录并更新版本（插件 KV 在独立 DB，不动）
    #[test]
    fn install_upgrade_replaces_existing_plugin_only_when_flag_set() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let plugins_dir = tmp.path().join("plugins");
            let id = "com.test.upgrade";

            let fresh = InstallMode::FreshInstall { restore_data: false };
            let v1 = build_zip_version(tmp.path(), id, "mobile", "1.0.0");
            PluginDownloader::install_from_file(v1.to_str().unwrap(), &plugins_dir, fresh)
                .await
                .expect("首个版本安装成功");

            let v2 = build_zip_version(tmp.path(), id, "mobile", "1.0.1");
            let err = PluginDownloader::install_from_file(v2.to_str().unwrap(), &plugins_dir, fresh)
                .await
                .expect_err("fresh install 不得覆盖已安装应用");
            assert!(err.to_string().contains("already installed"), "err: {err}");

            PluginDownloader::install_from_file(v2.to_str().unwrap(), &plugins_dir, InstallMode::Upgrade)
                .await
                .expect("升级模式必须替换目录");
            let manifest = std::fs::read_to_string(plugins_dir.join(id).join(PLUGIN_MANIFEST_FILE)).unwrap();
            let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
            assert_eq!(manifest["version"], "1.0.1", "manifest: {manifest}");
            assert_eq!(
                std::fs::read_to_string(plugins_dir.join(id).join(PLUGIN_SOURCE_MARKER)).unwrap(),
                SOURCE_FILE_INSTALL
            );
        });
    }

    /// keep-data 卸载后的重装：目录里只有 plugin.db（无 plugin.json）必须放行。
    /// 用户选「恢复」→ 私有库搬进新包目录；不能误报 "already installed"。
    #[test]
    fn install_reinstalls_data_only_orphan_and_restores_private_db_when_chosen() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let plugins_dir = tmp.path().join("plugins");
            let id = "com.test.keep-data-reinstall";
            let final_dir = plugins_dir.join(id);
            std::fs::create_dir_all(&final_dir).unwrap();
            std::fs::write(final_dir.join("plugin.db"), b"keep-me").unwrap();

            let zip = build_zip(tmp.path(), id, "mobile");
            PluginDownloader::install_from_file(
                zip.to_str().unwrap(),
                &plugins_dir,
                InstallMode::FreshInstall { restore_data: true },
            )
            .await
            .expect("data-only 孤儿目录应按重装处理");

            assert_eq!(
                std::fs::read(plugins_dir.join(id).join("plugin.db")).unwrap(),
                b"keep-me",
                "用户选恢复时必须保留私有库"
            );
            assert!(
                plugins_dir.join(id).join(PLUGIN_MANIFEST_FILE).exists(),
                "新包 manifest 已落地"
            );
        });
    }

    /// 默认（不恢复）：残留目录里的旧私有库必须随残留一起丢弃，不能静默继承。
    /// 延续同一组用例——「保留不等于自动恢复」的具象断言。
    #[test]
    fn install_fresh_without_restore_discards_retained_private_db() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let plugins_dir = tmp.path().join("plugins");
            let id = "com.test.keep-data-discard";
            let final_dir = plugins_dir.join(id);
            std::fs::create_dir_all(&final_dir).unwrap();
            std::fs::write(final_dir.join("plugin.db"), b"old-data").unwrap();
            std::fs::write(final_dir.join("plugin.db-wal"), b"old-wal").unwrap();

            let zip = build_zip(tmp.path(), id, "mobile");
            PluginDownloader::install_from_file(
                zip.to_str().unwrap(),
                &plugins_dir,
                InstallMode::FreshInstall { restore_data: false },
            )
            .await
            .expect("fresh install 默认丢弃残留后应成功");

            assert!(
                !plugins_dir.join(id).join("plugin.db").exists()
                    && !plugins_dir.join(id).join("plugin.db-wal").exists(),
                "不恢复 = 旧私有库必须删除（不得变成重装静默继承）"
            );
            assert!(plugins_dir.join(id).join(PLUGIN_MANIFEST_FILE).exists(), "新包照常落地");
        });
    }

    /// 平台适配门禁（安装路径）：desktop 专属分发包必须 fail-visible 拒装
    ///
    /// 与目录扫描侧 `loader.rs::load_manifest` 同判据；拒绝必须发生在任何落盘
    /// 之前（最终目录与临时目录都不该出现）。mobile / both 放行。
    #[test]
    fn install_zip_enforces_mobile_platform() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let plugins_dir = tmp.path().join("plugins");

            // desktop 专属：拒绝，且错误信息点名 platform / desktop / both
            let desktop_zip = build_zip(tmp.path(), "com.test.desktop-only", "desktop");
            let fresh = InstallMode::FreshInstall { restore_data: false };
            let err = PluginDownloader::install_from_file(desktop_zip.to_str().unwrap(), &plugins_dir, fresh)
                .await
                .expect_err("desktop 专属分发包在移动端必须被拒");
            let msg = err.to_string();
            assert!(msg.contains("platform"), "错误须点名字段: {msg}");
            assert!(msg.contains("desktop"), "错误须点名声明值: {msg}");
            assert!(msg.contains("both"), "错误须给出双端出路: {msg}");
            assert!(
                !plugins_dir.join("com.test.desktop-only").exists()
                    && !plugins_dir
                        .join(PLUGIN_DOWNLOAD_TEMP_DIR)
                        .join("com.test.desktop-only")
                        .exists(),
                "拒绝必须发生在落盘之前"
            );

            // mobile：放行并完成安装（来源标记 file-install）
            let mobile_zip = build_zip(tmp.path(), "com.test.mobile-ok", "mobile");
            let id = PluginDownloader::install_from_file(mobile_zip.to_str().unwrap(), &plugins_dir, fresh)
                .await
                .expect("mobile 分发包必须放行");
            assert_eq!(id, "com.test.mobile-ok");
            assert_eq!(
                std::fs::read_to_string(plugins_dir.join(&id).join(PLUGIN_SOURCE_MARKER)).unwrap(),
                SOURCE_FILE_INSTALL
            );
        });
    }
}
