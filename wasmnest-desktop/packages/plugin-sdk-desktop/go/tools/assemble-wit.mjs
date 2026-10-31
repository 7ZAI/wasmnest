#!/usr/bin/env node
/**
 * Go 组件构建的 wit 包组装（issue #21「应用后端 Go 语言支持」）
 *
 * 把三路输入组装成 TinyGo/wasm-tools 可消费的 wit 包（`--out` 指定目录，派生产物
 * 不入库）。两个消费方：
 *   - `gen-bindings.mjs`：组装进 `go/wit/` 后跑 wit-bindgen-go 生成绑定；
 *   - 应用 Go 工程的 build 脚本：组装进 app 构建区，作 `tinygo build
 *     -wit-package` 输入（应用不重生成绑定，gen/ 随 SDK 模块分发）。
 *
 * 三路输入（契约真源仍在能力仓 WIT / wit-src，本脚本不重复拼装）：
 *   1. 拼装产物 `../rust/wit/*.wit`（compose-wit.mjs 维护——core + 全部 cap 分片
 *      + world plugin）；
 *   2. 本端 world 真源 `../rust/wit-src/go-plugin.wit`（world go-plugin = plugin +
 *      wasi:cli/command，见文件头注）；
 *   3. TinyGo 发行版自带 wasi-cli WIT（`lib/wasi-cli/wit/`）——按 wasm-tools
 *      `deps/` 单层约定平铺：包根文件进 `deps/wasi-cli/`，其 deps/<名>/ 进
 *      `deps/<名>/`（嵌套 deps 不被发现，Phase 0 spike 实证）。
 *
 * 依赖外部工具（PATH 或环境变量定位；工具链版本见 go/README.md）：
 *   - TinyGo（`TINYGO_ROOT` 或 PATH 反查；spike 实证 0.43.0）
 *
 * 用法：node tools/assemble-wit.mjs --out <dir>（幂等，全量重建）
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_DIR = resolve(GO_DIR, "..");

/** fail-visible 定位可执行文件：环境变量 > PATH；缺失即抛（不猜默认值） */
export function requireTool(envVar, name) {
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`未找到 ${name}：安装后加入 PATH，或经 ${envVar} 指定路径（工具链版本见 go/README.md）`);
  }
}

/** TinyGo 根目录（lib/wasi-cli/wit 的容器）：TINYGO_ROOT > tinygo 可执行文件上一级 */
export function tinyGoRoot() {
  if (process.env.TINYGO_ROOT) {
    if (!existsSync(join(process.env.TINYGO_ROOT, "lib", "wasi-cli", "wit"))) {
      throw new Error(`TINYGO_ROOT=${process.env.TINYGO_ROOT} 下无 lib/wasi-cli/wit`);
    }
    return process.env.TINYGO_ROOT;
  }
  const tinygo = requireTool("TINYGO_BIN", "tinygo");
  // bin/tinygo → 根目录（源码树与发行包同构）
  const root = resolve(dirname(tinygo), "..");
  if (!existsSync(join(root, "lib", "wasi-cli", "wit"))) {
    throw new Error(`TinyGo ${tinygo} 的 lib/wasi-cli/wit 不存在（预期随发行版携带）`);
  }
  return root;
}

/**
 * 组装 wit 包到 outDir（全量重建，幂等）。outDir 必填（目标位置由消费方决定）。
 * 返回 outDir 绝对路径。
 */
export function assembleWit(outDir) {
  if (!outDir) throw new Error("assemble-wit: 缺 --out <dir>");
  const out = resolve(outDir);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const composedDir = join(SDK_DIR, "rust", "wit");
  const composed = readdirSync(composedDir).filter((f) => f.endsWith(".wit"));
  if (!composed.includes("core.wit") || !composed.includes("wasmnest.wit")) {
    throw new Error(`拼装产物不完整 ${composedDir}：缺 core.wit / wasmnest.wit（先跑 compose-wit.mjs --all）`);
  }
  for (const f of composed) cpSync(join(composedDir, f), join(out, f));

  const goWorld = join(SDK_DIR, "rust", "wit-src", "go-plugin.wit");
  if (!existsSync(goWorld)) throw new Error(`world 真源缺失 ${goWorld}`);
  cpSync(goWorld, join(out, "go-plugin.wit"));

  // wasi-cli deps 平铺：包根 → deps/wasi-cli/，deps/<名>/ → deps/<名>/
  const wasiCliWit = join(tinyGoRoot(), "lib", "wasi-cli", "wit");
  const depsOut = join(out, "deps");
  mkdirSync(join(depsOut, "wasi-cli"), { recursive: true });
  for (const f of readdirSync(wasiCliWit).filter((f) => f.endsWith(".wit"))) {
    cpSync(join(wasiCliWit, f), join(depsOut, "wasi-cli", f));
  }
  for (const name of readdirSync(join(wasiCliWit, "deps"))) {
    const src = join(wasiCliWit, "deps", name);
    const dst = join(depsOut, name);
    mkdirSync(dst, { recursive: true });
    for (const f of readdirSync(src).filter((f) => f.endsWith(".wit"))) {
      cpSync(join(src, f), join(dst, f));
    }
  }
  return out;
}

// ==================== CLI（仅直接执行时运行；被 import 只取 assembleWit） ====================

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  function flagValue(flag) {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  }
  const out = flagValue("--out");
  if (!out) {
    console.error("用法：node tools/assemble-wit.mjs --out <dir>");
    process.exit(1);
  }
  const dir = assembleWit(out);
  console.log(`assemble-wit: wit 包已组装 → ${dir}`);
}
