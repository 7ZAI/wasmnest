//! WIT 按包版本化锁（ADR 0061：单包 → 插件面 + 每能力域/端扩展一包）
//!
//! 版本真源分两层，本锁把两层钉在一起：
//!
//! 1. `wasmnest:plugin`（插件面）——唯一手写处 = 能力仓 `wasmnest-contract` crate 的
//!    `src/lib.rs`（`PACKAGE_NAME` / `PACKAGE_VERSION` / `PACKAGE`）。双端
//!    `compose.json` 的 `package` 只声明**包名**；`core.wit` / `plugin-face.wit`
//!    的 package 行必须与真源同版本；生成物 `wasmnest.wit` 的 package 行由
//!    `scripts/compose-wit.mjs` 注入。
//! 2. 其余每个能力域/端扩展包——版本真源 = 该分片 `.wit` 文件首行
//!    `package <name>@<x.y.z>;`；`compose.json` 的 `caps.*.package` 只声明包名，
//!    生成物 `deps/<pkg>/<file>` 是源文件的逐字拷贝。
//!
//! ## 为什么 `--check` 的 sha256 漂移锁不够
//!
//! 漂移锁只比「生成物 vs 真源现算」：源文件手写的版本若写错，重拼后一切自洽、
//! 漂移锁全绿，但 import 名会带错误版本——**编译面全绿、运行期实例化才炸**。
//! 本锁另加两件漂移锁不做的事：
//!
//! - **源文件 package 行 ↔ 清单声明包名**（清单写错包名时重拼同样自洽）；
//! - **生成物目录文件集合 == 清单声明集合**（残留文件会让 `wit-parser` 解析失败，
//!   而 sha 比对只覆盖「声明的文件」）。
//!
//! 共享产物场景（file-transfer 双端单产物，ADR 0050）另由应用仓
//! `apps/file-transfer/rust/src/wiring_lock.rs` 断言双端版本对齐——本锁管
//! 「单点一致性」，那把锁管「共享产物跨端一致性」，两者互补。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// 仓根（`wasmnest-desktop/src-tauri` → `../..`）
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// 能力仓 WIT 包版本真源（wasmnest:plugin 轴）——零依赖契约 crate 的常量文件
const PACKAGE_SOURCE: &str = "../wasmnest-lib/wasmnest-contract/src/lib.rs";

/// 能力域 crate 里必须与自身分片 package 行逐字一致的 const 导出名清单
/// （`inventory` 静态自报要求编译期常量，字面量无法经派生函数生成，故由本锁钉住）
const DOMAIN_EXPORT_LITERALS: &[&str] = &["../wasmnest-lib/wasmnest-discovery-engine/src/routing.rs"];

/// 双端端清单
const END_MANIFESTS: &[&str] = &[
    "wasmnest-desktop/packages/plugin-sdk-desktop/compose.json",
    "wasmnest-mobile/packages/plugin-sdk-mobile/compose.json",
];

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("{} 不可读: {e}", path.display()))
}

/// 取文件里首个 `package …;` 声明行（trim 后整行）
fn package_line(path: &Path) -> String {
    read(path)
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("package "))
        .unwrap_or_else(|| panic!("{} 缺 package 声明行", path.display()))
        .to_string()
}

/// `package ns:name@x.y.z;` → `("ns:name", "x.y.z")`（缺失 / 非三段 semver 即红）
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
        "{} 的包版本应为三段 semver（0.0.1 形态），实际 {version}",
        path.display()
    );
    (name.to_string(), version.to_string())
}

/// 读 `wasmnest:plugin` 真源并做形状校验（与拼装脚本 `readPackage()` 同判据）
fn package_source() -> (String, String, String) {
    let path = repo_root().join(PACKAGE_SOURCE);
    let raw = read(&path);
    let const_of = |name: &str| -> String {
        let needle = format!("pub const {name}: &str = \"");
        let start = raw
            .find(&needle)
            .unwrap_or_else(|| panic!("{} 缺常量 {name}", path.display()))
            + needle.len();
        let rest = &raw[start..];
        let end = rest
            .find('"')
            .unwrap_or_else(|| panic!("{} 常量 {name} 未闭合", path.display()));
        rest[..end].to_string()
    };
    let name = const_of("PACKAGE_NAME");
    let version = const_of("PACKAGE_VERSION");
    let full = const_of("PACKAGE");
    assert!(
        name.contains(':'),
        "{} 的 PACKAGE_NAME 应为 `wasmnest:<ns>` 形态，实际 {name}",
        path.display()
    );
    let parts: Vec<&str> = version.split('.').collect();
    assert!(
        parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())),
        "{} 的 PACKAGE_VERSION 应为三段 semver（0.1.0 形态），实际 {version}",
        path.display()
    );
    assert_eq!(
        full,
        format!("{name}@{version}"),
        "{} 的 PACKAGE 与 NAME/VERSION 不自洽",
        path.display()
    );
    (name, version, full)
}

/// 包名 → 生成物 `deps/` 目录名（`wasmnest:http-endpoint` → `http-endpoint`）
fn deps_slug(package: &str) -> &str {
    package
        .split_once(':')
        .map(|(_, name)| name)
        .unwrap_or_else(|| panic!("包名应为「namespace:name」形态，实际 {package}"))
}

/// 递归列出目录下文件（相对 `out`，`/` 分隔）
fn walk(dir: &Path, base: &Path, out: &mut BTreeSet<String>) {
    for entry in fs::read_dir(dir).unwrap_or_else(|e| panic!("{} 不可读: {e}", dir.display())) {
        let entry = entry.expect("目录项");
        let path = entry.path();
        if path.is_dir() {
            walk(&path, base, out);
        } else {
            out.insert(
                path.strip_prefix(base)
                    .expect("相对 out")
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
}

/// ① 真源形状：name / version 字段在场且写法合法（防空转）
#[test]
fn package_source_is_wellformed() {
    let (name, version, _) = package_source();
    assert_eq!(
        name, "wasmnest:plugin",
        "包名真源应保持 wasmnest:plugin（双端 world / 导出面引用它）"
    );
    assert_eq!(
        version, "0.1.0",
        "拆包是破坏性变更：wasmnest:plugin 必须升 0.1.0（旧 0.0.2 产物按版本被拒）"
    );
}

/// ② 端清单只声明包名，不持版本字面量
#[test]
fn compose_manifests_declare_package_name_only() {
    let (name, _, _) = package_source();
    for rel in END_MANIFESTS {
        let path = repo_root().join(rel);
        let m: serde_json::Value =
            serde_json::from_str(&read(&path)).unwrap_or_else(|e| panic!("{} JSON 不可解析: {e}", path.display()));
        let declared = m["package"]
            .as_str()
            .unwrap_or_else(|| panic!("{} 缺 package 字段", path.display()));
        assert_eq!(
            declared,
            name,
            "{} 的 package 应等于真源 name（版本由 scripts/compose-wit.mjs 注入）",
            path.display()
        );
        assert!(
            !declared.contains('@'),
            "{} 的 package 不应持版本字面量 `{declared}`——版本真源单点化在 {PACKAGE_SOURCE}",
            path.display()
        );
        for (key, spec) in m["caps"].as_object().expect("caps 是对象") {
            let pkg = spec["package"]
                .as_str()
                .unwrap_or_else(|| panic!("{} caps.{key}.package 缺失", path.display()));
            assert!(
                !pkg.contains('@'),
                "{} caps.{key}.package 不应持版本字面量 `{pkg}`——版本真源=分片 .wit 的 package 行",
                path.display()
            );
        }
    }
}

/// ③ 源文件 package 行 ↔ 清单声明 ↔ 生成物（逐字 + 文件集合）
#[test]
fn source_and_generated_packages_match_declarations() {
    let (contract_name, contract_version, contract_full) = package_source();
    let root = repo_root();
    let mut checked = 0usize;

    for rel in END_MANIFESTS {
        let manifest_path = root.join(rel);
        let m: serde_json::Value = serde_json::from_str(&read(&manifest_path))
            .unwrap_or_else(|e| panic!("{} JSON 不可解析: {e}", manifest_path.display()));
        let out_rel = m["out"].as_str().expect("缺 out 字段");
        let out = root.join(out_rel);

        // 契约包（core / face）：package 行 == 真源整行；生成物逐字等于源文件
        for (label, key) in [("core", "core"), ("face", "face")] {
            let src_rel = m[key].as_str().unwrap_or_else(|| panic!("缺 {key} 字段"));
            let src = root.join(src_rel);
            let expected = format!("package {contract_name}@{contract_version};");
            assert_eq!(
                package_line(&src),
                expected,
                "{src_rel} 的 package 行与契约真源 {PACKAGE_SOURCE} 漂移——\
                 顶层文件必须同属 {contract_full}（wit-parser 要求）",
            );
            let generated = out.join(if label == "core" { "core.wit" } else { "plugin-face.wit" });
            assert_eq!(
                read(&generated),
                read(&src),
                "{} 与源文件 {src_rel} 不逐字一致——重跑 `node scripts/compose-wit.mjs --all`",
                generated.display()
            );
            checked += 1;
        }

        // 生成物 wasmnest.wit 的 package 行 == 真源整行
        assert_eq!(
            package_line(&out.join("wasmnest.wit")),
            format!("package {contract_name}@{contract_version};"),
            "生成物 wasmnest.wit 的 package 行漂移（重跑拼装）"
        );

        // 能力域/端扩展包：清单声明名 == 源文件包名；生成物 = 源文件逐字拷贝
        let mut expected_files: BTreeSet<String> = ["core.wit", "plugin-face.wit", "wasmnest.wit"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        for (key, spec) in m["caps"].as_object().expect("caps 是对象") {
            let src_rel = spec["file"]
                .as_str()
                .unwrap_or_else(|| panic!("caps.{key}.file 缺失（compose v2 schema）"));
            let declared = spec["package"]
                .as_str()
                .unwrap_or_else(|| panic!("caps.{key}.package 缺失（compose v2 schema）"));
            let src = root.join(src_rel);
            let (src_name, src_version) = split_package_line(&package_line(&src), &src);
            assert_eq!(
                src_name, declared,
                "caps.{key}.package 声明 `{declared}`，但分片真源 {src_rel} 的 package 行是 `{src_name}`"
            );
            let rel_gen = format!(
                "deps/{}/{}",
                deps_slug(&src_name),
                src.file_name().expect("源文件名").to_string_lossy()
            );
            let generated = out.join(&rel_gen);
            assert_eq!(
                read(&generated),
                read(&src),
                "{} 与分片真源 {src_rel} 不逐字一致——重跑 `node scripts/compose-wit.mjs --all`",
                generated.display()
            );
            expected_files.insert(rel_gen);
            // 版本三段已在 split_package_line 内断言；这里只做「非空」见证
            assert!(!src_version.is_empty(), "{src_rel} 版本为空");
            checked += 1;
        }

        // ④ 生成物目录文件集合 == 清单声明集合（残留旧扁平 cap-*.wit 即红）
        let mut actual: BTreeSet<String> = BTreeSet::new();
        walk(&out, &out, &mut actual);
        let missing: Vec<&String> = expected_files.difference(&actual).collect();
        let extra: Vec<&String> = actual.difference(&expected_files).collect();
        assert!(
            missing.is_empty(),
            "生成物缺文件 {missing:?}——重跑 `node scripts/compose-wit.mjs --all`"
        );
        assert!(
            extra.is_empty(),
            "生成物目录存在未声明文件 {extra:?}（旧扁平布局残留 / 手放文件）；\
             重跑拼装会清空重建"
        );
    }
    assert!(
        checked >= 33,
        "只检查了 {checked} 个分片（双端 core+face 4 + caps 29 = 33），清单读取可能已漂移"
    );
}

/// ⑤ 能力域 crate 的 const 导出名清单 == 自身分片 package 行（版本 + 包名）
///
/// 拆包后 `host-mdns` 属 `wasmnest:mdns` 包：字面量前缀必须换成该包、版本换成该包
/// 的版本（不再跟 `wasmnest:plugin` 版本）。前缀/版本都从分片文件现场读取，
/// bump 只改 `.wit` 一处即可。
#[test]
fn domain_const_export_literals_match_their_own_package() {
    let mdns_src = repo_root().join("../wasmnest-lib/wasmnest-discovery-engine/wit/mdns.wit");
    let (name, version) = split_package_line(&package_line(&mdns_src), &mdns_src);
    assert_eq!(name, "wasmnest:mdns", "host-mdns 应属独立能力域包 wasmnest:mdns");
    let expected_prefix = format!("{name}/host-mdns.");
    let expected_suffix = format!("@{version}");
    for rel in DOMAIN_EXPORT_LITERALS {
        let path = repo_root().join(rel);
        let literals: Vec<String> = read(&path)
            .lines()
            .filter_map(|line| {
                let t = line.trim().trim_end_matches(',');
                let t = t.strip_prefix('"')?.strip_suffix('"')?;
                t.starts_with(&expected_prefix).then(|| t.to_string())
            })
            .collect();
        assert!(
            !literals.is_empty(),
            "{} 未抽到任何 `{expected_prefix}*` 导出名字面量（锁失效即红）",
            path.display()
        );
        for lit in literals {
            assert!(
                lit.ends_with(&expected_suffix),
                "{} 的导出名 `{lit}` 缺版本后缀 `{expected_suffix}`——无版本/错版本写法对\
                 版本化产物恒不命中（组件导出实例键 = `ns:pkg/iface@version`）",
                path.display()
            );
        }
    }
}
