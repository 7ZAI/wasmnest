#!/usr/bin/env node
/**
 * 能力仓（wasmnest-lib）路径 resolver——平台仓读取内部依赖 crate 的唯一入口。
 *
 * 能力仓维护全部内部依赖 crate；平台仓**不再**用 git submodule 挂载，而是按 R1
 * 同场布局直接读兄弟目录 `../wasmnest-lib/<crate>`。因此所有平台侧 node 脚本、
 * 发布清单锁与结构锁都经本模块取根，不要各自拼 `packages/`。
 *
 * 解析顺序（fail-visible，绝不返回猜测路径）：
 *  1. `WASMNEST_LIB_ROOT` 显式指定（CI / 非常规布局）；
 *  2. 平台仓根的同级兄弟目录 `../wasmnest-lib`（R1 布局）；
 *  3. 都不可用即抛错，并给出路（设置环境变量或按 R1 摆放）。
 *
 * 注意：Cargo 的 `path` 依赖不能读环境变量，23 处宿主 manifest 只能写固定的
 * `../../../wasmnest-lib/<crate>`；本 resolver 只服务不经 Cargo 的读取面
 *（node 脚本 / 测试锁 / 发布清单）。
 */
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 平台仓根（本文件位于 `<平台>/scripts/`） */
export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 能力仓根（含 `wasmnest-contract/`、`wasmnest-wasm-core/` 等 crate 的目录）。
 *
 * 失败形态必须是显性报错：返回一个不存在的路径会让上层锁退化成「扫不到即无命中」
 * 的假绿灯，这是拆仓后最危险的失效方式。
 */
export function libRoot() {
  const env = process.env.WASMNEST_LIB_ROOT;
  if (env) {
    const explicit = resolve(env);
    if (!isDir(explicit)) {
      throw new Error(
        `WASMNEST_LIB_ROOT 指向的目录不存在: ${explicit}（能力仓未按 R1 布局放置？）`,
      );
    }
    return explicit;
  }

  const sibling = resolve(PLATFORM_ROOT, "..", "wasmnest-lib");
  if (isDir(sibling)) return sibling;

  throw new Error(
    `能力仓未找到：${sibling} 不存在。请按 R1 布局把 wasmnest-lib 放在平台仓同级目录，` +
      `或设置 WASMNEST_LIB_ROOT 指向它（平台仓不再通过 packages/ submodule 挂载能力仓）`,
  );
}

/** 能力仓内路径（`libPath("wasmnest-contract/src/lib.rs")`） */
export function libPath(...segments) {
  return join(libRoot(), ...segments);
}
