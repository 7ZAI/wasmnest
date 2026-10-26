/**
 * 应用仓（wasmnest-apps）源码路径 resolver —— 三仓拆分 spec §5-E7。
 *
 * 宿主测试里仍有跨应用的一致性锁（i18n 副本漂移 / 挂载槽 chrome / 页面过渡类 /
 * 构建脚本断言 / 壳迁移面），它们要读 app 源码。app 源码自三仓拆分起住独立应用仓，
 * 路径解析统一走本文件（禁止散落硬编码），规则：
 * 1. `WASMNEST_APPS_ROOT` 显式指定（CI / 非常规布局）；
 * 2. 未设时按 R1 布局推导：端目录（`process.cwd()`）的兄弟目录 `wasmnest-apps`；
 * 3. 缺仓时不吞错——`resolve` 返回的路径在读取处 ENOENT 显性失败（不静默跳过）。
 */
import { resolve } from 'node:path'

const APPS_ROOT = process.env.WASMNEST_APPS_ROOT ?? resolve(process.cwd(), '../../wasmnest-apps')

/** 应用工程内文件路径：`<appsRoot>/apps/<slug>/<end>/<...rest>` */
export function appPath(slug: string, end: 'desktop' | 'mobile', ...rest: string[]): string {
  return resolve(APPS_ROOT, 'apps', slug, end, ...rest)
}

/** 应用仓根（跨 app 扫描用） */
export function appsRepoRoot(): string {
  return APPS_ROOT
}
