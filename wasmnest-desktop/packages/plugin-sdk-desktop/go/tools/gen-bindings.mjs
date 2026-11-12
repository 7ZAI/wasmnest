#!/usr/bin/env node
/**
 * Go SDK 壳绑定生成（issue #21「应用后端 Go 语言支持」Phase 1）
 *
 * 组装 wit 包到 `go/wit/`（三路输入与规则见 assemble-wit.mjs 头注；派生产物不入库），
 * 再经 wit-bindgen-go 生成 Go 绑定到 `go/gen/`（入库，消费方零工具链即可引用）。
 *
 * 依赖外部工具（PATH 或环境变量定位；工具链版本见 go/README.md）：
 *   - wit-bindgen-go（`WIT_BINDGEN_GO` 或 PATH；spike 实证 v0.7.0）
 *   - TinyGo（`TINYGO_ROOT` 或 PATH 反查；spike 实证 0.43.0）
 *
 * 用法（本目录执行）：node tools/gen-bindings.mjs
 * 幂等：连续两次运行 gen/ 输出 diff 为空；改契约后重跑本脚本 + TinyGo 重建产物。
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleWit, requireTool } from "./assemble-wit.mjs";

const GO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIT_OUT = join(GO_DIR, "wit");
const GEN_OUT = join(GO_DIR, "gen");
const MODULE = "github.com/7zai/wasmnest-plugin-sdk-go";
// 绑定只对 world plugin（纯 wasmnest:plugin 面）生成：wasi:cli/command 的标准
// 导入由 TinyGo 运行时自带实现，再生成一份 gen/wasi/* 会与其重复（spike 实证
// 无需生成）。TinyGo 构建仍以 -wit-world go-plugin 组件化（wasi include 只进
// 构建期 world，不进绑定面）。
const BINDGEN_WORLD = "plugin";
const BUILD_WORLD = "go-plugin";

// ==================== 1. 组装 wit 包（全量重建，幂等） ====================

assembleWit(WIT_OUT);

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
