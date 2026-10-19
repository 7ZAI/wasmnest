#!/usr/bin/env node
/**
 * 契约 crate 结构防复发锁（纯文件系统，不跑 cargo、不联网）
 *
 * 背景：契约包名 / 版本真源曾以「能力仓根一个游离 `.rs` 文件」存在，被内核 crate
 * 用 `include!("../../contracts/…")` 跨出 crate 目录读入。`include!` 是文本拼接：
 * 编译器看不见依赖边、`cargo package` 的归档不含 crate 目录外文件、rust-analyzer
 * 无法跳转。真源收进 `wasmnest-contract` crate 后，本锁负责让同类形态不再复发。
 *
 * 判据（任一失败即红，报错点名文件与行号）：
 *  1. 契约 crate 的常量仍是 `pub const <NAME>: &str = "<值>";` 普通字面量形状
 *     （平台仓两处 node 解析器按此形状取值，改 macro / env! 会静默打穿拼装链）；
 *  2. 能力仓（`../wasmnest-lib`，或 `WASMNEST_LIB_ROOT`）下不存在逃出所属 crate
 *     目录的 `include!` / `include_str!`；
 *  3. `bindgen!` 的 `path:` 指向本 crate 目录内（WIT 必须与它的绑定同 crate——
 *     `cargo package` 只归档 crate 目录内文件）；
 *  4. 双端 `compose.json` 声明的每个 WIT 路径真实存在。
 *
 * 为什么扫描的是能力仓而不是平台仓内路径：能力仓维护全部内部依赖 crate，平台仓
 * 按 R1 布局直接读兄弟目录（不再有 `packages/` submodule 挂载点）。
 *
 * 为什么「crate 根」取 `<能力仓>/<顶层目录>` 而不是最近的 Cargo.toml：夹具 crate
 * （`wasmnest-wasm-core/fixtures/**`）按设计绑定父 crate 的 `wit/core.wit`，属于
 * 同一棵 crate 树；按最近 manifest 判定会把这条合法形态误报成逃逸。
 *
 * 已知例外只有一条（见 `BINDGEN_ESCAPE_ALLOWLIST`）：它是既有 ADR 裁决，不是本次
 * 新增的逃逸。例外条目必须仍被扫描命中（反向自检），删掉代码却留条目同样红——
 * 否则登记表会悬空，新违规会被静默放行。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { libRoot } from "./lib-paths.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = libRoot();
const CONTRACT_SOURCE = join(LIB, "wasmnest-contract", "src", "lib.rs");

/** 端清单（声明「组合了什么」；路径相对平台仓根） */
const COMPOSE_MANIFESTS = [
  "wasmnest-desktop/packages/plugin-sdk-desktop/compose.json",
  "wasmnest-mobile/packages/plugin-sdk-mobile/compose.json",
];

/**
 * `bindgen!` 跨 crate 的唯一合法既有例外。
 *
 * `wasmnest-server-websocket` 的客户端 provider 直接绑定共享契约真源
 * `wasmnest-ws-client-engine/wit/ws.wit`（ADR 0052 D2/D4）：该目录就是分片的唯一
 * 真源，再复制一份进本 crate 才是漂移源；回接端 SDK 生成物目录仍由桌面宿主锁禁止。
 * 条目按「文件 + path 值」精确匹配，不做按目录的宽豁免。
 */
const BINDGEN_ESCAPE_ALLOWLIST = [
  {
    file: "wasmnest-server-websocket/src/plugin_binding.rs",
    spec: "../wasmnest-ws-client-engine/wit/ws.wit",
  },
];

/** 递归收集文件（跳过构建产物 / 版本控制目录） */
function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "target" || entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkFiles(path, out);
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

/** `child` 是否在 `parent` 内（含 parent 自身） */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

/** 文件所属 crate 根：`<能力仓>/<顶层目录>`；直接落在能力仓根的文件按仓根算 */
export function crateRootOf(libDir, file) {
  const rel = relative(libDir, file);
  if (rel.startsWith("..")) return null;
  const [first, ...rest] = rel.split(sep);
  if (!first) return null;
  return rest.length === 0 ? libDir : join(libDir, first);
}

/** 迭代匹配项的起始行号（1-based） */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** 抽取 `include!` / `include_str!` 的相对路径参数 */
export function extractIncludes(text) {
  const found = [];
  const re = /\b(include|include_str)!\s*\(\s*"([^"]+)"\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push({ kind: `${m[1]}!`, spec: m[2], line: lineOf(text, m.index) });
  }
  return found;
}

/** 抽取 `bindgen!({ … path: "…" })` 的路径参数 */
export function extractBindgenPaths(text) {
  const found = [];
  const re = /\bbindgen!\s*\(\s*\{[\s\S]*?\bpath\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push({ kind: "bindgen!", spec: m[1], line: lineOf(text, m.index) });
  }
  return found;
}

/**
 * 扫描任意能力仓根：返回逃逸引用与悬空引用。
 *
 * 导出纯函数是为了让自检用例能在临时目录里构造「逃逸 include」——锁最危险的失效
 * 形态是扫描器静默不匹配，光靠真实仓当前恰好干净无法证明它有效。
 */
export function scanCrateBoundaries(libDir, allowlist = []) {
  const violations = [];
  const allowlistSeen = new Set();
  const rustFiles = walkFiles(libDir).filter((p) => p.endsWith(".rs"));

  for (const file of rustFiles) {
    const crateRoot = crateRootOf(libDir, file);
    if (!crateRoot) continue;
    const rel = relative(libDir, file).split(sep).join("/");
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const hit of [...extractIncludes(text), ...extractBindgenPaths(text)]) {
      // 解析基准不同：`include!` 相对当前源文件，`bindgen!` 的 `path` 相对
      // `CARGO_MANIFEST_DIR`（crate 根）——wasmtime 的宏按 crate 根解析。
      const base = hit.kind === "bindgen!" ? crateRoot : dirname(file);
      const target = resolve(base, hit.spec);
      if (!existsSync(target)) {
        violations.push({ file: rel, line: hit.line, kind: hit.kind, spec: hit.spec, reason: "引用目标不存在" });
        continue;
      }
      if (isInside(crateRoot, target)) continue;

      const allowed = allowlist.find((e) => e.file === rel && e.spec === hit.spec);
      if (allowed) {
        allowlistSeen.add(rel);
        continue;
      }
      violations.push({
        file: rel,
        line: hit.line,
        kind: hit.kind,
        spec: hit.spec,
        reason: `逃出 crate 目录（crate 根 = ${relative(libDir, crateRoot).split(sep).join("/")}）`,
      });
    }
  }

  return { violations, allowlistSeen };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

test("契约 crate 的常量保持普通字面量形状（node 正则解析器的输入契约）", () => {
  assert.ok(existsSync(CONTRACT_SOURCE), `契约真源缺失: ${CONTRACT_SOURCE}`);
  const source = readFileSync(CONTRACT_SOURCE, "utf8");
  const read = (name) => {
    const m = new RegExp(`pub\\s+const\\s+${name}\\s*:\\s*&str\\s*=\\s*"([^"]+)"\\s*;`).exec(source);
    assert.ok(m, `${CONTRACT_SOURCE} 缺 \`pub const ${name}: &str = "…";\` 形状的常量`);
    return m[1];
  };
  const name = read("PACKAGE_NAME");
  const version = read("PACKAGE_VERSION");
  const full = read("PACKAGE");
  assert.ok(name.includes(":"), `PACKAGE_NAME 应为命名空间形态: ${name}`);
  assert.match(version, /^\d+\.\d+\.\d+$/, `PACKAGE_VERSION 应为三段 semver: ${version}`);
  assert.equal(full, `${name}@${version}`, "PACKAGE 必须等于 PACKAGE_NAME@PACKAGE_VERSION");
});

test("能力仓下没有逃出 crate 目录的 include!/include_str!/bindgen! 路径", () => {
  const { violations, allowlistSeen } = scanCrateBoundaries(LIB, BINDGEN_ESCAPE_ALLOWLIST);
  const detail = violations
    .map((v) => `  ${v.file}:${v.line}  ${v.kind}("${v.spec}")  ${v.reason}`)
    .join("\n");
  assert.equal(violations.length, 0, `跨 crate 目录引用必须回到 crate 边界内：\n${detail}`);

  // 反向自检：例外条目必须仍被真实扫描命中，删代码不删条目同样红
  for (const entry of BINDGEN_ESCAPE_ALLOWLIST) {
    assert.ok(
      allowlistSeen.has(entry.file),
      `例外条目已悬空（${entry.file} 不再出现 ${entry.spec}）——核实后删除，否则新违规会被静默放行`,
    );
  }
});

test("扫描器能点名逃逸文件（自检：构造临时 crate，防锁空转）", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "wasmnest-crate-lock-"));
  try {
    const crateDir = join(tempRoot, "fake-crate", "src");
    mkdirSync(crateDir, { recursive: true });
    writeFileSync(join(tempRoot, "outside.rs"), "pub const X: &str = \"x\";\n");
    writeFileSync(
      join(crateDir, "lib.rs"),
      'mod x {\n    include!("../../outside.rs");\n}\n',
    );
    const { violations } = scanCrateBoundaries(tempRoot);
    assert.equal(violations.length, 1, "扫描器必须命中构造出的逃逸 include");
    assert.equal(violations[0].file, "fake-crate/src/lib.rs");
    assert.equal(violations[0].line, 2);
    assert.match(violations[0].reason, /逃出 crate 目录/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("双端 compose.json 声明的 WIT 路径真实存在", () => {
  for (const rel of COMPOSE_MANIFESTS) {
    const manifestPath = join(ROOT, rel);
    assert.ok(existsSync(manifestPath), `端清单缺失: ${rel}`);
    const manifest = readJson(manifestPath);
    const declared = [["core", manifest.core], ...Object.entries(manifest.caps ?? {})];
    assert.ok(declared.length >= 2, `${rel} 的 core/caps 声明为空（判据会空转）`);
    for (const [key, value] of declared) {
      assert.equal(typeof value, "string", `${rel} 的 ${key} 应为路径字符串`);
      const abs = resolve(ROOT, value);
      assert.ok(existsSync(abs), `${rel} 声明的 ${key} 路径不存在: ${value}`);
      assert.ok(
        isInside(ROOT, abs) || isInside(LIB, abs),
        `${rel} 的 ${key} 路径既不在平台仓也不在能力仓内: ${value}`,
      );
    }
  }
});
