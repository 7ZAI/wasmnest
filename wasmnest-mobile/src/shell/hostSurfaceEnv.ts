/**
 * 宿主环境注入面（运行面独立 Vue 应用共享）
 * -----------------------------------------------------------------------------
 * 移动端每个应用的运行面是宿主创建的**独立 Vue 应用**（Level 1，见
 * `.scratch/2026-10-24-mobile-app-surface-vue-instances/spec.md` §4.5）：
 * 独立应用不继承壳组件树的 provide，平台信息 / 安全区 / 键盘 / 前后台信号等
 * 宿主环境必须**显式注入**。
 *
 * 本模块是这份注入清单的单一持有点：壳根（App.vue）在 setup 期把同一批响应式
 * refs 收集一次（`registerHostSurfaceEnv`），运行面创建时经注册表 ensure 输入
 * 按应用生成注入表（见 surfaceRuntime.ts）。**禁止**在第二处再维护一份清单——
 * 新增 / 删除注入项必须同步契约测试（shellAppSurface.test.ts 的注入探针）。
 *
 * 注：宿主公共组件面（wasmnestHostComponents）已整面退役（issue #24），
 * 应用侧直接 import 自己需要的组件，不再经 provide 注入。
 */

/** 收集到的宿主环境（键 → 壳根持有的响应式引用；值为 null = 壳尚未收集） */
let env: Readonly<Record<PropertyKey, unknown>> | null = null

/** 壳根收集宿主环境（幂等：以最后一次为准，壳重挂时刷新） */
export function registerHostSurfaceEnv(entries: Readonly<Record<PropertyKey, unknown>>): void {
  env = entries
}

/** 运行面创建时读取宿主环境（未收集时返回 null，注入面退化为仅前后台信号） */
export function getHostSurfaceEnv(): Readonly<Record<PropertyKey, unknown>> | null {
  return env
}

/** 测试隔离用：清空已收集的环境 */
export function clearHostSurfaceEnv(): void {
  env = null
}
