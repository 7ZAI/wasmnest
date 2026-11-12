#!/usr/bin/env node
/**
 * WIT 按包拼装脚本（ADR 0061：单包 → 「插件面 + 每个能力域/端扩展一包」）
 *
 * 端 `wit/` 目录是生成物，布局（顶层只放 `wasmnest:plugin` 包——`wit-parser` 要求
 * 同一目录顶层文件同属一个 package）：
 *
 *   wit/
 *     core.wit          逐字拷贝能力仓 `wasmnest-wasm-core/wit/core.wit`
 *     plugin-face.wit   逐字拷贝端 `wit-src/plugin-face.wit`（导出面 + binding-only world）
 *     wasmnest.wit      生成：`world plugin { include core; include plugin-face;
 *                       include <pkg>/<world>@<ver>; … }`
 *     deps/<pkg>/…      每个能力域/端扩展包一个目录（逐字拷贝真源分片）
 *
 * 「组合了什么」的唯一答案在双端 `compose.json`（v2 schema）：
 *   { package, world, core, face, out, caps: { <key>: { file, package } }, worlds, abi }
 *
 * 版本真源：
 * - `wasmnest:plugin` = 能力仓 `wasmnest-contract/src/lib.rs` 的
 *   `PACKAGE_NAME` / `PACKAGE_VERSION`（唯一手写处，本脚本只注入 `wasmnest.wit`
 *   的 package 行；`core.wit` / `plugin-face.wit` 自带版本，逐字拷贝）；
 * - 其余包 = 各自 `.wit` 文件首行 `package <name>@<version>;`。`compose.json` 的
 *   `caps.*.package` **只声明包名**（不得含 `@`）——版本写进清单即第二真源。
 *
 * 用法（仓库根执行）：
 *   node scripts/compose-wit.mjs <end>           # 拼装写入端 wit/ 目录（先清空）
 *   node scripts/compose-wit.mjs <end> --check   # 只读：逐文件 sha + 文件集合比对（漂移锁）
 *   node scripts/compose-wit.mjs --all           # 双端拼装
 *
 * fail-visible（缺字段 / 形状不符直接抛，不猜默认值）：
 * - 清单缺 `core` / `face` / `caps.*.file` / `caps.*.package`；
 * - 分片缺 `package <name>@<semver>;` 行、包名与清单声明不符、world 数 != 1；
 * - `core.wit` / `plugin-face.wit` 的 package 行与契约真源不等；
 * - `--check` 发现生成物目录有未声明文件（残留旧扁平 `cap-*.wit` 即红）。
 *
 * 幂等：连续两次输出 `diff -r` 为空；`--check` 两次的比对结果一致。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { libPath } from "./lib-paths.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ENDS = {
  desktop: "wasmnest-desktop/packages/plugin-sdk-desktop/compose.json",
  mobile: "wasmnest-mobile/packages/plugin-sdk-mobile/compose.json",
};

/** `wasmnest:plugin` 包版本真源（ADR 0051 D3 / ADR 0061）——`wasmnest-contract`
 *  crate 的 `src/lib.rs`；能力仓经 `lib-paths.mjs` 解析（默认兄弟目录
 *  `../wasmnest-lib`）。正则只认 `pub const <NAME>: &str = "<值>";` 的精确文本
 *  形状（crate 头注把该形状写成了跨语言契约，勿改成 macro / `env!`） */
const PACKAGE_SOURCE = libPath("wasmnest-contract", "src", "lib.rs");

const PACKAGE_LINE = /^package\s+([A-Za-z0-9_.:-]+)@(\d+\.\d+\.\d+);\s*$/m;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readManifest(end) {
  const manifestPath = join(ROOT, ENDS[end]);
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch {
    throw new Error(`端清单不存在: ${manifestPath}`);
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    throw new Error(`端清单 JSON 解析失败 ${manifestPath}: ${e.message}`);
  }
  for (const key of ["package", "world", "core", "face", "out"]) {
    if (typeof m[key] !== "string" || !m[key]) {
      throw new Error(`[${end}] 端清单缺字段 \`${key}\`（compose v2 schema）: ${manifestPath}`);
    }
  }
  m.core = resolve(ROOT, m.core);
  m.face = resolve(ROOT, m.face);
  m.out = resolve(ROOT, m.out);
  const caps = m.caps;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
    throw new Error(`[${end}] 端清单 caps 必须是对象: ${manifestPath}`);
  }
  for (const [key, spec] of Object.entries(caps)) {
    if (!spec || typeof spec.file !== "string" || typeof spec.package !== "string") {
      throw new Error(`[${end}] caps.${key} 必须形如 { file, package }（compose v2 schema）`);
    }
    if (spec.package.includes("@")) {
      throw new Error(
        `[${end}] caps.${key}.package "${spec.package}" 不得含版本——版本真源是分片 .wit 的 package 行`,
      );
    }
    spec.file = resolve(ROOT, spec.file);
  }
  return m;
}

/** 读仓根 `wasmnest:plugin` 包版本真源并做最小形状校验 */
function readPackage() {
  let raw;
  try {
    raw = readFileSync(PACKAGE_SOURCE, "utf-8");
  } catch (e) {
    throw new Error(`包版本真源不存在或不可读 ${PACKAGE_SOURCE}: ${e.message}`);
  }
  const read = (name) => {
    const m = raw.match(new RegExp(`pub\\s+const\\s+${name}\\s*:\\s*&str\\s*=\\s*"([^"]+)"\\s*;`));
    if (!m) throw new Error(`包版本真源缺常量 ${name}: ${PACKAGE_SOURCE}`);
    return m[1];
  };
  const name = read("PACKAGE_NAME");
  const version = read("PACKAGE_VERSION");
  const full = read("PACKAGE");
  if (!name.includes(":")) {
    throw new Error(`包名应为「wasmnest:<ns>」形态，实际 ${name}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`包版本应为三段 semver，实际 ${version}`);
  }
  if (full !== `${name}@${version}`) {
    throw new Error(
      `真源自相矛盾：PACKAGE="${full}" ≠ PACKAGE_NAME@PACKAGE_VERSION="${name}@${version}"`,
    );
  }
  return { name, version };
}

/** 读一个 WIT 源文件的 package 行与 world 名（fail-visible）
 *
 * `requireSingleWorld = false` 用于 `plugin-face.wit`：它按设计承载多个
 * binding-only world（plugin-binary / plugin-ws / …），只有被 include 的那个
 * （`plugin-face`）进主 world。
 */
function readSlice(end, label, path, { requireSingleWorld = true } = {}) {
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(`[${end}] ${label} 真源不可读 ${path}: ${e.message}`);
  }
  const pkg = raw.match(PACKAGE_LINE);
  if (!pkg) {
    throw new Error(
      `[${end}] ${label} 缺 \`package <name>@<x.y.z>;\` 行（版本真源=分片文件本身）: ${path}`,
    );
  }
  const worlds = [...raw.matchAll(/^world\s+([A-Za-z0-9_-]+)\s*\{/gm)].map((m) => m[1]);
  if (worlds.length === 0) {
    throw new Error(`[${end}] ${label} 未声明任何 world: ${path}`);
  }
  if (requireSingleWorld && worlds.length !== 1) {
    throw new Error(
      `[${end}] ${label} 必须恰好声明 1 个 world（实际 ${worlds.length} 个：${worlds.join(", ")}）: ${path}`,
    );
  }
  return { raw, packageName: pkg[1], version: pkg[2], world: worlds[0], worlds };
}

/** 包名 → `deps/` 目录名（`wasmnest:http-endpoint` → `http-endpoint`） */
function depsSlug(packageName) {
  const parts = packageName.split(":");
  if (parts.length !== 2 || !parts[1]) {
    throw new Error(`包名应为「namespace:name」形态，实际 ${packageName}`);
  }
  return parts[1];
}

/** 计算生成物清单：相对路径 -> { kind: "copy", src } | { kind: "gen", content }（不落盘） */
function computeFiles(end, m, pkg) {
  const files = {};
  files["core.wit"] = { kind: "copy", src: m.core };
  files["plugin-face.wit"] = { kind: "copy", src: m.face };

  const contractPkg = `${pkg.name}@${pkg.version}`;
  for (const [label, path, opts] of [
    ["core", m.core, {}],
    ["face", m.face, { requireSingleWorld: false }],
  ]) {
    const slice = readSlice(end, label, path, opts);
    if (`${slice.packageName}@${slice.version}` !== contractPkg) {
      throw new Error(
        `[${end}] ${label} 的 package 行是 ${slice.packageName}@${slice.version}，` +
          `与契约真源 ${contractPkg} 不等——顶层文件必须同属 wasmnest:plugin 且同版本（wit-parser 要求）`,
      );
    }
    if (label === "face" && !slice.worlds.includes("plugin-face")) {
      throw new Error(
        `[${end}] plugin-face.wit 必须声明 \`world plugin-face\`（参与主 world 拼装的镜面入口；` +
          `wasmnest.wit 里 \`include plugin-face;\` 按这个名字定位）`,
      );
    }
  }

  const includes = ["    include core;", "    include plugin-face;"];
  for (const [key, spec] of Object.entries(m.caps)) {
    const slice = readSlice(end, `cap \`${key}\``, spec.file);
    if (slice.packageName !== spec.package) {
      throw new Error(
        `[${end}] caps.${key}.package 声明 "${spec.package}"，但真源 ${spec.file} ` +
          `的 package 行是 "${slice.packageName}"——包名漂移（清单只声明名，不写版本）`,
      );
    }
    const rel = join("deps", depsSlug(slice.packageName), basename(spec.file));
    if (files[rel]) {
      throw new Error(`[${end}] 生成物路径冲突 ${rel}（两个 cap 指向同名分片文件）`);
    }
    files[rel] = { kind: "copy", src: spec.file };
    includes.push(`    include ${slice.packageName}/${slice.world}@${slice.version};`);
  }

  // package 行是本脚本唯一的版本注入点（wasmnest:plugin 版本）；能力域包的版本随
  // 分片文件逐字拷贝进 deps/，此处不重写。
  files["wasmnest.wit"] = {
    kind: "gen",
    content: `package ${contractPkg};\n\nworld ${m.world} {\n${includes.join("\n")}\n}\n`,
  };
  return files;
}

function materialize(m, files) {
  // 布局从扁平改成 deps/ 后，残留的旧文件会让 wit-parser 直接报 package 不一致，
  // 故一律全量重建（不做「只覆盖」）。
  rmSync(m.out, { recursive: true, force: true });
  mkdirSync(m.out, { recursive: true });
  for (const [rel, spec] of Object.entries(files)) {
    const dst = join(m.out, rel);
    mkdirSync(dirname(dst), { recursive: true });
    if (spec.kind === "copy") copyFileSync(spec.src, dst);
    else writeFileSync(dst, spec.content, "utf-8");
  }
}

/** 递归列出目录下所有文件（相对路径，`/` 分隔，排序） */
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split("\\").join("/"));
  }
  return out.sort();
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const ends = check ? args.filter((a) => a !== "--check") : args;
  const all = ends.includes("--all");

  let exitCode = 0;
  const pkg = readPackage();
  for (const end of all ? Object.keys(ENDS) : ends) {
    if (!ENDS[end]) throw new Error(`未知端 "${end}"（可选：${Object.keys(ENDS).join(" / ")}）`);
    const m = readManifest(end);
    // 端清单只声明包名：与真源 name 不一致即抛（版本真源单点化的前提，ADR 0051 D3）
    if (m.package !== pkg.name) {
      throw new Error(
        `[${end}] 端清单 package "${m.package}" 与仓根真源 name "${pkg.name}" 漂移——` +
          `包名/版本真源单点化在 ${PACKAGE_SOURCE}，清单只写包名`,
      );
    }
    const files = computeFiles(end, m, pkg);
    if (check) {
      const expected = Object.keys(files).sort();
      const actual = existsSync(m.out) ? walk(m.out) : [];
      const missing = expected.filter((f) => !actual.includes(f));
      const extra = actual.filter((f) => !expected.includes(f));
      for (const f of missing) {
        console.error(`[${end}] ${f} 缺失（生成物不存在，需重跑拼装）`);
        exitCode = 1;
      }
      for (const f of extra) {
        console.error(`[${end}] ${f} 是未声明残留（生成物目录只允许清单声明的文件；重跑拼装会清空）`);
        exitCode = 1;
      }
      for (const [rel, spec] of Object.entries(files)) {
        const path = join(m.out, rel);
        if (!existsSync(path)) continue;
        const want = spec.kind === "copy" ? sha256(spec.src) : sha256Text(spec.content);
        const got = sha256(path);
        if (got !== want) {
          console.error(`[${end}] ${rel} 漂移: 期望 ${want} 实际 ${got}（真源已改或生成物被手改）`);
          exitCode = 1;
        } else {
          console.log(`[${end}] ${rel} ok`);
        }
      }
    } else {
      materialize(m, files);
      for (const [rel, spec] of Object.entries(files)) {
        const sha = spec.kind === "copy" ? sha256(spec.src) : sha256Text(spec.content);
        console.log(`[${end}] ${rel} ${sha}`);
      }
    }
  }
  process.exit(exitCode);
}

main();
