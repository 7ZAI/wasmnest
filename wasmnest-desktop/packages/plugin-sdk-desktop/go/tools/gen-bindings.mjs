#!/usr/bin/env node
/**
 * Go SDK 壳绑定生成（issue #21「应用后端 Go 语言支持」Phase 1）
 *
 * 把三路输入组装成 TinyGo/wasm-tools 可消费的 wit 包（`go/wit/`，派生产物不入库），
 * 再经 wit-bindgen-go 生成 Go 绑定到 `go/gen/`（入库，消费方零工具链即可引用）：
 *
 *   1. 拼装产物 `../rust/wit/*.wit`（compose-wit.mjs 维护——core + 全部 cap 分片
 *      + world plugin；契约真源仍在能力仓 WIT / wit-src，本脚本不重复拼装）；
 *   2. 本端 world 真源 `../rust/wit-src/go-plugin.wit`（world go-plugin = plugin +
 *      wasi:cli/command，见文件头注）；
 *   3. TinyGo 发行版自带 wasi-cli WIT（`lib/wasi-cli/wit/`）——按 wasm-tools
 *      `deps/` 单层约定平铺：包根文件进 `deps/wasi-cli/`，其 deps/<名>/ 进
 *      `deps/<名>/`（嵌套 deps 不被发现，Phase 0 spike 实证）。
 *
 * 依赖外部工具（PATH 或环境变量定位；工具链版本见 go/README.md）：
 *   - wit-bindgen-go（`WIT_BINDGEN_GO` 或 PATH；spike 实证 v0.7.0）
 *   - TinyGo（`TINYGO_ROOT` 或 PATH 反查；spike 实证 0.43.0）
 *
 * 用法（本目录执行）：node tools/gen-bindings.mjs
 * 幂等：连续两次运行 gen/ 输出 diff 为空；改契约后重跑本脚本 + TinyGo 重建产物。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_DIR = resolve(GO_DIR, "..");
const WIT_OUT = join(GO_DIR, "wit");
const GEN_OUT = join(GO_DIR, "gen");
const MODULE = "github.com/7zai/wasmnest-plugin-sdk-go";
// 绑定只对 world plugin（纯 wasmnest:plugin 面）生成：wasi:cli/command 的标准
// 导入由 TinyGo 运行时自带实现，再生成一份 gen/wasi/* 会与其重复（spike 实证
// 无需生成）。TinyGo 构建仍以 -wit-world go-plugin 组件化（wasi include 只进
// 构建期 world，不进绑定面）。
const BINDGEN_WORLD = "plugin";
const BUILD_WORLD = "go-plugin";

/** fail-visible 定位可执行文件：环境变量 > PATH；缺失即抛（不猜默认值） */
function requireTool(envVar, name) {
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`未找到 ${name}：安装后加入 PATH，或经 ${envVar} 指定路径（工具链版本见 go/README.md）`);
  }
}

/** TinyGo 根目录（lib/wasi-cli/wit 的容器）：TINYGO_ROOT > tinygo 可执行文件上一级 */
function tinyGoRoot(bindgenPath) {
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

// ==================== 1. 组装 wit 包（全量重建，幂等） ====================

rmSync(WIT_OUT, { recursive: true, force: true });
mkdirSync(WIT_OUT, { recursive: true });

const composedDir = join(SDK_DIR, "rust", "wit");
const composed = readdirSync(composedDir).filter((f) => f.endsWith(".wit"));
if (!composed.includes("core.wit") || !composed.includes("wasmnest.wit")) {
  throw new Error(`拼装产物不完整 ${composedDir}：缺 core.wit / wasmnest.wit（先跑 compose-wit.mjs --all）`);
}
for (const f of composed) cpSync(join(composedDir, f), join(WIT_OUT, f));

const goWorld = join(SDK_DIR, "rust", "wit-src", "go-plugin.wit");
if (!existsSync(goWorld)) throw new Error(`world 真源缺失 ${goWorld}`);
cpSync(goWorld, join(WIT_OUT, "go-plugin.wit"));

// wasi-cli deps 平铺：包根 → deps/wasi-cli/，deps/<名>/ → deps/<名>/
const wasiCliWit = join(tinyGoRoot(), "lib", "wasi-cli", "wit");
const depsOut = join(WIT_OUT, "deps");
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

// ==================== 2. wit-bindgen-go 生成绑定 ====================

const bindgen = requireTool("WIT_BINDGEN_GO", "wit-bindgen-go");
rmSync(GEN_OUT, { recursive: true, force: true });
execFileSync(
  bindgen,
  ["generate", "--world", BINDGEN_WORLD, "--package-root", `${MODULE}/gen`, "--out", GEN_OUT, WIT_OUT],
  { stdio: "inherit", cwd: GO_DIR },
);
if (!existsSync(join(GEN_OUT, "wasmnest", "plugin"))) {
  throw new Error(`生成物缺 gen/wasmnest/plugin（world ${BINDGEN_WORLD} 生成异常）`);
}

console.log(
  `gen-bindings: world ${BINDGEN_WORLD} → ${GEN_OUT}（wasmnest:plugin 绑定已生成；TinyGo 构建用 -wit-world ${BUILD_WORLD}）`,
);
