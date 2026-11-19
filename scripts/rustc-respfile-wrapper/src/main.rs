//! rustc 命令行超限响应文件包装器（Windows 发布构建专用）。
//!
//! 背景：全量 wasmtime 依赖图的 rustc 调用命令行达 ~40KB，超 Windows CreateProcess
//! 32767 字符上限（os error 206），发布构建在编译大依赖 crate 时红。cargo 以完整
//! 参数拉起本包装器（exe 形态可携带长命令行，实测 sccache 同形态可行）；超阈值时
//! 把参数逐行写入临时响应文件，改以 `sccache rustc @<file>` 拉起——rustc 响应文件
//! 格式 = 每行一个参数，行内空格/反斜杠原样保留（已实测验证）。
//!
//! 短命令直接透传内层包装器（sccache），缓存行为与原先一致。仅发布流水线使用
//! （product-release.yml build job 现场 cargo build 本 crate 后设 RUSTC_WRAPPER）；
//! 仓内默认包装器仍是 sccache（.cargo/config.toml），本地开发不受影响。

use std::env;
use std::fs;
use std::process::{Command, Stdio};

/// 阈值：低于此长度直接透传（远低于 32767 上限，留足余量）
const LIMIT: usize = 30_000;

fn inherit() -> Stdio {
    Stdio::inherit()
}

fn main() {
    let argv: Vec<String> = env::args().collect();
    let Some(rustc) = argv.get(1) else {
        eprintln!("[rustc-wrapper] 缺 rustc 路径参数（cargo 应传 <rustc> <args...>）");
        std::process::exit(2);
    };
    let args: Vec<&String> = argv[2..].iter().collect();
    let total: usize = args.iter().map(|a| a.len() + 1).sum();
    let inner = env::var("RUSTC_WRAPPER_INNER").unwrap_or_else(|_| "sccache".to_string());

    let run = |inner_name: &str, cmd: &[String], fallback_args: &[&String]| -> i32 {
        match Command::new(&cmd[0])
            .args(&cmd[1..])
            .stdin(inherit())
            .stdout(inherit())
            .stderr(inherit())
            .status()
        {
            Ok(status) => status.code().unwrap_or(1),
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound && cmd[0] == inner_name {
                    eprintln!("[rustc-wrapper] 内层包装器 {inner_name} 不可用，回退直调 rustc");
                    return match Command::new(rustc)
                        .args(fallback_args.iter().copied())
                        .stdin(inherit())
                        .stdout(inherit())
                        .stderr(inherit())
                        .status()
                    {
                        Ok(s) => s.code().unwrap_or(1),
                        Err(e2) => {
                            eprintln!("[rustc-wrapper] rustc 拉起失败: {e2}");
                            1
                        }
                    };
                }
                eprintln!("[rustc-wrapper] 拉起失败: {e}");
                1
            }
        }
    };

    if total <= LIMIT {
        let mut cmd = vec![inner.clone(), rustc.clone()];
        cmd.extend(args.iter().map(|s| s.to_string()));
        std::process::exit(run(&inner, &cmd, &args));
    }

    let dir = env::temp_dir().join(format!("rustc-resp-{}", std::process::id()));
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("[rustc-wrapper] 响应文件目录创建失败: {e}");
        std::process::exit(1);
    }
    let file = dir.join("args.txt");
    let content: String = args.iter().map(|a| format!("{a}\n")).collect();
    if let Err(e) = fs::write(&file, content) {
        eprintln!("[rustc-wrapper] 响应文件写入失败: {e}");
        std::process::exit(1);
    }
    eprintln!(
        "[rustc-wrapper] 命令行 {total} 字符超阈值，改用响应文件 {}",
        file.display()
    );
    let code = run(&inner, &[inner.clone(), rustc.clone(), format!("@{}", file.display())], &args);
    let _ = fs::remove_dir_all(&dir);
    std::process::exit(code);
}
