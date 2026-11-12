//! 插件组件化工具（迁移阶段 B 构建链）
//!
//! 将 wit-bindgen 产出的 core module（含 `component-type` 自定义段）编码为
//! Component Model 组件，等价于 `wasm-tools component new`：
//! - 产物已是组件（魔法字节 `0d 00 01 00`）时直接复制（幂等，支持增量构建）
//! - 编码失败的输入（无组件元数据）给出明确错误
//!
//! 用法：`componentize <input.wasm> -o <output.wasm>`
//! 插件构建脚本（wasm-apps/*/scripts/build.js）在 cargo build 后调用本工具。
//!
//! 另有只读模式 `componentize --list-packages <component.wasm>`：解码组件，
//! 输出其 world 实际 import / export 的 `wasmnest:` WIT 包 → 版本 JSON
//! （ADR 0061 拆包后的发布下限：`compat.witPackages` 必须来自**二进制本身**，
//! 不能从源码猜）。同一包出现两个版本即失败（组件不可能合法地同时依赖两版）。

use std::collections::BTreeMap;
use std::process::ExitCode;

use wit_parser::{WorldItem, WorldKey};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let mut input: Option<String> = None;
    let mut output: Option<String> = None;
    let mut list_packages: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--list-packages" => {
                if i + 1 < args.len() {
                    list_packages = Some(args[i + 1].clone());
                    i += 1;
                } else {
                    eprintln!("Missing value after --list-packages");
                    return ExitCode::FAILURE;
                }
            }
            "-o" | "--output" => {
                if i + 1 < args.len() {
                    output = Some(args[i + 1].clone());
                    i += 1;
                } else {
                    eprintln!("Missing value after {}", args[i]);
                    return ExitCode::FAILURE;
                }
            }
            a if a.starts_with('-') => {
                eprintln!("Unknown option: {}", a);
                return ExitCode::FAILURE;
            }
            a => input = Some(a.to_string()),
        }
        i += 1;
    }

    if let Some(path) = list_packages {
        return list_component_packages(&path);
    }

    let (Some(input), Some(output)) = (input, output) else {
        eprintln!("Usage: componentize <input.wasm> -o <output.wasm>");
        eprintln!("       componentize --list-packages <component.wasm>");
        return ExitCode::FAILURE;
    };

    let bytes = match std::fs::read(&input) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("Failed to read {}: {}", input, e);
            return ExitCode::FAILURE;
        }
    };

    // 幂等：产物已是组件（版本字 0d 00 01 00）则直接复制
    if bytes.len() >= 8 && &bytes[0..4] == b"\0asm" && &bytes[4..8] == [0x0d, 0x00, 0x01, 0x00] {
        return match std::fs::write(&output, &bytes) {
            Ok(()) => {
                println!("componentize: {} already a component, copied to {}", input, output);
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("Failed to write {}: {}", output, e);
                ExitCode::FAILURE
            }
        };
    }

    let mut encoder = match wit_component::ComponentEncoder::default().module(&bytes) {
        Ok(e) => e,
        Err(e) => {
            eprintln!(
                "componentize: {} is not a componentizable core module (missing WIT metadata): {}",
                input, e
            );
            return ExitCode::FAILURE;
        }
    };
    let encoded = match encoder.encode() {
        Ok(b) => b,
        Err(e) => {
            eprintln!("componentize: encode {} failed: {}", input, e);
            return ExitCode::FAILURE;
        }
    };

    match std::fs::write(&output, &encoded) {
        Ok(()) => {
            println!("componentize: {} -> {} ({} bytes)", input, output, encoded.len());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Failed to write {}: {}", output, e);
            ExitCode::FAILURE
        }
    }
}

/// `--list-packages`：列出组件 world 实际 import/export 的 `wasmnest:` 包 → 版本
///
/// 只保留 `wasmnest:` 前缀（WASI 包由宿主运行时负责，不进本门禁）。输出为单行
/// JSON（键排序），供构建脚本写入 `compat.witPackages`。
fn list_component_packages(path: &str) -> ExitCode {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("Failed to read {}: {}", path, e);
            return ExitCode::FAILURE;
        }
    };
    let decoded = match wit_component::decode(&bytes) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("list-packages: decode {} failed: {}", path, e);
            return ExitCode::FAILURE;
        }
    };
    let (resolve, world_id) = match decoded {
        wit_component::DecodedWasm::Component(resolve, world) => (resolve, world),
        wit_component::DecodedWasm::WitPackage(..) => {
            eprintln!(
                "list-packages: {} 是 WIT 包而不是组件（需要构建后的 component）",
                path
            );
            return ExitCode::FAILURE;
        }
    };
    let world = &resolve.worlds[world_id];
    let mut packages: BTreeMap<String, String> = BTreeMap::new();
    let push = |iface_id: wit_parser::InterfaceId, packages: &mut BTreeMap<String, String>| {
        let iface = &resolve.interfaces[iface_id];
        let Some(pkg_id) = iface.package else { return };
        let pkg = &resolve.packages[pkg_id].name;
        if pkg.namespace != "wasmnest" {
            return;
        }
        let name = format!("{}:{}", pkg.namespace, pkg.name);
        let version = pkg
            .version
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or_default();
        match packages.get(&name) {
            Some(prev) if *prev != version => {
                eprintln!(
                    "list-packages: 包 {} 在组件里出现两个版本（{} 与 {}）",
                    name, prev, version
                );
                // 交给外层用 Err 语义处理：这里直接 panic 不如返回标记
                packages.insert(name.clone(), format!("{}!{}", prev, version));
            }
            Some(_) => {}
            None => {
                packages.insert(name, version);
            }
        }
    };
    for (key, item) in world.imports.iter().chain(world.exports.iter()) {
        if let WorldKey::Interface(id) = key {
            push(*id, &mut packages);
        }
        if let WorldItem::Interface { id, .. } = item {
            push(*id, &mut packages);
        }
    }
    if let Some((name, _)) = packages.iter().find(|(_, v)| v.contains('!')) {
        eprintln!("list-packages: 包版本冲突 {}", name);
        return ExitCode::FAILURE;
    }
    let body = packages
        .iter()
        .map(|(k, v)| format!("\"{}\":\"{}\"", k, v))
        .collect::<Vec<_>>()
        .join(",");
    println!("{{{}}}", body);
    ExitCode::SUCCESS
}
