//! `run_with` 的插件目录注入测试 —— 通用 runtime crate 的可注入装配契约
//!
//! 行为契约（见 `apply_plugins_dir_env` 文档注释）：
//! - 任意路径写进 `WASMNEST_PLUGINS_DIR`，启动流程据此解析插件目录（唯一读取点）；
//! - 重复调用覆盖旧值（同一进程内多次装配以最后一次为准）；
//! - 空路径必须显性失败：宿主会把空字符串当作「未设置」而回退到内置插件目录，
//!   静默回退会让调用方以为自己的目录生效了。
//!
//! 测试串行化：环境变量是进程级全局状态，用互斥锁把本模块的用例串起来，并在
//! 每个用例结束后还原原值，避免影响同二进制里的其它用例。

#[cfg(test)]
mod tests {
    use super::super::{apply_plugins_dir_env, PLUGINS_DIR_ENV};
    use std::ffi::OsString;
    use std::path::PathBuf;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// 在锁保护下临时改写环境变量，结束后还原
    fn with_env_lock<T>(f: impl FnOnce() -> T) -> T {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous: Option<OsString> = std::env::var_os(PLUGINS_DIR_ENV);
        let result = f();
        match previous {
            Some(value) => std::env::set_var(PLUGINS_DIR_ENV, value),
            None => std::env::remove_var(PLUGINS_DIR_ENV),
        }
        result
    }

    #[test]
    fn writes_plugins_dir_to_env_var() {
        with_env_lock(|| {
            std::env::remove_var(PLUGINS_DIR_ENV);
            let dir = PathBuf::from("/tmp/wasmnest-run-with/plugins");

            let applied = apply_plugins_dir_env(dir.clone());

            assert_eq!(applied, dir, "返回写入的目录供调用方记录来源");
            assert_eq!(
                std::env::var_os(PLUGINS_DIR_ENV),
                Some(dir.into_os_string()),
                "启动流程只从 {PLUGINS_DIR_ENV} 读取插件目录"
            );
        });
    }

    #[test]
    fn overwrites_previous_value() {
        with_env_lock(|| {
            std::env::set_var(PLUGINS_DIR_ENV, "/tmp/wasmnest-run-with/stale");

            apply_plugins_dir_env("/tmp/wasmnest-run-with/fresh");

            assert_eq!(
                std::env::var(PLUGINS_DIR_ENV).as_deref(),
                Ok("/tmp/wasmnest-run-with/fresh"),
                "同进程重复装配以最后一次为准"
            );
        });
    }

    #[test]
    #[should_panic(expected = "plugins_dir 不能为空")]
    fn rejects_empty_path() {
        with_env_lock(|| {
            std::env::remove_var(PLUGINS_DIR_ENV);
            apply_plugins_dir_env(PathBuf::new());
        });
    }
}
