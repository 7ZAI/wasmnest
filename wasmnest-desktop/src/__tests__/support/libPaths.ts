/**
 * 能力仓（wasmnest-lib）源码路径 resolver —— 与 `appPaths.ts` 同规则的三仓拆分面。
 *
 * 宿主测试里的跨仓锁（wire 副本比对 / 权限词汇 / 穿透字面）要读能力仓源码，路径
 * 解析统一走本文件（禁止散落硬编码）：
 * 1. `WASMNEST_LIB_ROOT` 显式指定（CI / 非常规布局）；
 * 2. 未设时按 R1 布局推导：端目录（`process.cwd()`）的兄弟目录 `wasmnest-lib`；
 * 3. 缺仓时不吞错——`libPath` 返回的路径在读取处 ENOENT 显性失败（不静默跳过）。
 */
import { resolve } from 'node:path'

const LIB_ROOT = process.env.WASMNEST_LIB_ROOT ?? resolve(process.cwd(), '../../wasmnest-lib')

/** 能力仓内文件路径：`<libRoot>/<...rest>` */
export function libPath(...rest: string[]): string {
  return resolve(LIB_ROOT, ...rest)
}

/** 能力仓根（跨 crate 扫描用） */
export function libRepoRoot(): string {
  return LIB_ROOT
}
