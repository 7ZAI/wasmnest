//! 移动端 WIT 按包拼装组合锁（ADR 0061：单包 → 插件面 + 每能力域/端扩展一包）
//!
//! 背景：端 `rust/wit/` 自票 03 起是**生成物**，ADR 0061 起布局变为
//! `core.wit` + `plugin-face.wit`（`wasmnest:plugin` 包顶层）+ `deps/<pkg>/…`
//! （每个能力域/端扩展一个独立包）+ `wasmnest.wit`（`world plugin { include core;
//! include plugin-face; include <pkg>/<world>@<ver>; … }`），由端清单
//! `compose.json`（v2 schema）驱动 `scripts/compose-wit.mjs` 拼装。
//!
//! 本锁承接其**结构面**职责（语义面 = `stale_artifact_rebuild_hint` 旧产物点名 +
//! 双端 ABI 锁步流程 ADR 0019）：
//!
//! 1. 契约包（`wasmnest:plugin`）的 `core.wit` / `plugin-face.wit` package 行 ==
//!    能力仓 `wasmnest-contract` 真源；每个 cap 分片的 package 行包名 == 清单
//!    `caps.*.package` 声明（版本真源在分片文件本身）；
//! 2. 生成物 `world plugin` 的 include 集 == `core` + `plugin-face` + 各 cap 包
//!    （结构；逐字漂移由 `compose-wit.mjs --check` 与桌面
//!    `tests/wit_package_version_lock.rs` 兜住，本锁管**结构**）；
//! 3. `compose.json` 的 `worlds` 列表在生成物目录（**含 `deps/**`**）中确实有声明。
//!
//! 只读源文件，不依赖 app crate；判据按代码行/结构比对（跳注释行）。

use std::path::{Path, PathBuf};

/// `wasmnest-mobile/src-tauri`
fn mobile_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

/// 移动 SDK 根（`wasmnest-mobile/packages/plugin-sdk-mobile`）
fn sdk_root() -> PathBuf {
    mobile_root().join("../packages/plugin-sdk-mobile")
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{} 不可读: {e}", path.display()))
}

fn package_line(path: &Path) -> String {
    read(path)
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("package "))
        .unwrap_or_else(|| panic!("{} 缺 package 声明行", path.display()))
        .to_string()
}

/// `package ns:name@x.y.z;` → `(ns:name, x.y.z)`
fn split_package_line(line: &str, path: &Path) -> (String, String) {
    let body = line
        .trim()
        .strip_prefix("package ")
        .and_then(|l| l.strip_suffix(';'))
        .unwrap_or_else(|| panic!("{} 的 package 行形状异常：{line}", path.display()));
    let (name, version) = body
        .rsplit_once('@')
        .unwrap_or_else(|| panic!("{} 的 package 行缺版本段：{line}", path.display()));
    let parts: Vec<&str> = version.split('.').collect();
    assert!(
        parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())),
        "{} 的包版本应为三段 semver，实际 {version}",
        path.display()
    );
    (name.to_string(), version.to_string())
}

/// 分片里唯一的 world 名（`world <name> {`）
fn sole_world(path: &Path) -> String {
    let src = read(path);
    let worlds: Vec<String> = src
        .lines()
        .map(str::trim)
        .filter_map(|l| l.strip_prefix("world "))
        .filter_map(|rest| rest.split('{').next().map(str::trim))
        .map(str::to_string)
        .collect();
    assert_eq!(
        worlds.len(),
        1,
        "{} 必须恰好声明 1 个 world（实际 {worlds:?}）",
        path.display()
    );
    worlds[0].clone()
}

fn deps_slug(package: &str) -> &str {
    package
        .split_once(':')
        .map(|(_, name)| name)
        .unwrap_or_else(|| panic!("包名应为「namespace:name」形态，实际 {package}"))
}

/// ① 契约包 package 行 == 真源；cap 分片包名 == 清单声明
#[test]
fn compose_manifest_packages_match_wit_sources() {
    let compose = read(&sdk_root().join("compose.json"));
    let m: serde_json::Value = serde_json::from_str(&compose).expect("端清单 JSON 可解析");
    let declared = m["package"].as_str().expect("compose.json 缺 package");

    let root = mobile_root().join("../..");
    let raw = read(&root.join("../wasmnest-lib/wasmnest-contract/src/lib.rs"));
    let const_of = |name: &str| -> String {
        let needle = format!("pub const {name}: &str = \"");
        let start = raw
            .find(&needle)
            .unwrap_or_else(|| panic!("wasmnest-contract/src/lib.rs 缺常量 {name}"))
            + needle.len();
        let rest = &raw[start..];
        let end = rest
            .find('"')
            .unwrap_or_else(|| panic!("wasmnest-contract/src/lib.rs 常量 {name} 未闭合"));
        rest[..end].to_string()
    };
    let name = const_of("PACKAGE_NAME");
    let version = const_of("PACKAGE_VERSION");
    assert_eq!(
        const_of("PACKAGE"),
        format!("{name}@{version}"),
        "wasmnest-contract/src/lib.rs 的 PACKAGE 与 NAME@VERSION 自洽（ADR 0051 D3）"
    );
    assert_eq!(
        declared, name,
        "端清单 package 与仓根版本真源 PACKAGE_NAME 漂移（ADR 0051 D3 单点化）"
    );
    assert!(
        !declared.contains('@'),
        "端清单 package 不应持版本字面量 `{declared}`——版本真源单点化在 \
         wasmnest-contract，清单回写版本=第二真源"
    );

    // 契约包顶层文件：core / face
    let expected = format!("package {name}@{version};");
    for key in ["core", "face"] {
        let rel = m[key]
            .as_str()
            .unwrap_or_else(|| panic!("compose.json 缺 {key} 字段（v2 schema）"));
        let path = root.join(rel);
        assert_eq!(
            package_line(&path),
            expected,
            "{rel} 的 package 行与契约真源不相等——顶层文件必须同属 {name}@{version}"
        );
    }

    // 能力域/端扩展包：清单只声明包名，版本在分片文件
    for (key, spec) in m["caps"].as_object().expect("caps 是对象") {
        let rel = spec["file"].as_str().unwrap_or_else(|| panic!("caps.{key}.file 缺失"));
        let pkg = spec["package"]
            .as_str()
            .unwrap_or_else(|| panic!("caps.{key}.package 缺失"));
        let path = root.join(rel);
        let (src_name, _) = split_package_line(&package_line(&path), &path);
        assert_eq!(
            src_name, pkg,
            "caps.{key}.package 声明 `{pkg}`，但分片真源 {rel} 的 package 行是 `{src_name}`"
        );
    }
}

/// ② 生成物 world plugin 的 include 集 == core + plugin-face + 各 cap 包/世界/版本
#[test]
fn generated_wasmnest_wit_includes_match_compose_caps() {
    let root = mobile_root().join("../..");
    let compose = read(&sdk_root().join("compose.json"));
    let m: serde_json::Value = serde_json::from_str(&compose).expect("端清单 JSON 可解析");

    let mut expected: Vec<String> = vec!["core".to_string(), "plugin-face".to_string()];
    for (key, spec) in m["caps"].as_object().expect("caps 是对象") {
        let rel = spec["file"].as_str().unwrap_or_else(|| panic!("caps.{key}.file 缺失"));
        let src = root.join(rel);
        let (pkg, ver) = split_package_line(&package_line(&src), &src);
        expected.push(format!("{pkg}/{}@{ver}", sole_world(&src)));
    }
    expected.sort();

    let gen = read(&sdk_root().join("rust/wit/wasmnest.wit"));
    let mut includes: Vec<String> = gen
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .filter_map(|l| {
            let t = l.trim();
            t.strip_prefix("include ")
                .and_then(|rest| rest.strip_suffix(';'))
                .map(|name| name.trim().to_string())
        })
        .collect();
    includes.sort();

    assert_eq!(
        includes, expected,
        "生成物 wasmnest.wit 的 include 集与端清单 caps / 分片 package 行漂移——重跑 \
         `node scripts/compose-wit.mjs mobile`（真源改了没重拼？）"
    );

    // 分片文件必须在场（只列 include 而分片缺失 = 解析期才炸）
    assert!(sdk_root().join("rust/wit/core.wit").exists(), "生成物缺 core.wit");
    assert!(
        sdk_root().join("rust/wit/plugin-face.wit").exists(),
        "生成物缺 plugin-face.wit"
    );
    for (key, spec) in m["caps"].as_object().expect("caps 是对象") {
        let rel = spec["file"].as_str().unwrap_or_else(|| panic!("caps.{key}.file 缺失"));
        let src = root.join(rel);
        let (pkg, _) = split_package_line(&package_line(&src), &src);
        let gen = sdk_root()
            .join("rust/wit/deps")
            .join(deps_slug(&pkg))
            .join(src.file_name().expect("源文件名"));
        assert!(gen.exists(), "生成物分片缺失: {}", gen.display());
    }
}

/// ③ compose.json 的 worlds 列表在生成物中（含 `deps/**`）确实有声明
#[test]
fn compose_worlds_are_declared_in_generated_wit() {
    let compose = read(&sdk_root().join("compose.json"));
    let m: serde_json::Value = serde_json::from_str(&compose).expect("端清单 JSON 可解析");
    let worlds: Vec<&str> = m["worlds"]
        .as_array()
        .expect("compose.json 缺 worlds")
        .iter()
        .map(|v| v.as_str().expect("worlds 元素为字符串"))
        .collect();
    assert!(!worlds.is_empty(), "compose.json worlds 为空（判据会空转）");

    let wit_dir = sdk_root().join("rust/wit");
    let mut all = String::new();
    let mut stack = vec![wit_dir.clone()];
    let mut files: Vec<PathBuf> = Vec::new();
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("{} 不可读: {e}", dir.display()))
            .flatten()
        {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|e| e.to_str()) == Some("wit") {
                files.push(p);
            }
        }
    }
    files.sort();
    for p in &files {
        all.push_str(&read(p));
        all.push('\n');
    }

    for world in worlds {
        let needle = format!("world {world} {{");
        assert!(
            all.contains(&needle),
            "端清单声明的 world `{world}` 在生成物目录中找不到 `{needle}`——\
             清单与拼装产物脱节（重拼或修清单）"
        );
    }
}
