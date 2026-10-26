/**
 * 平台检测 — 旧路径再导出薄壳（issue #22 / #16，2026-10-24）
 * -----------------------------------------------------------------------------
 * withGlobalTauri=false 解阻塞：机制真源已收敛到壳内副本
 * `@/shell/composables/usePlatform`（唯一机制入口）。壳的 L1 锁禁止裸读 Tauri
 * 全局，探测真源是 plugin-os 插件调用本身而非任何注入全局——旧实现里的
 * `'__TAURI__' in window` 探测已随旧机制退役。
 *
 * 本文件保留原模块路径只为让既有消费方零改动：全部导出（含类型）逐一再导出，
 * 本体一律走壳副本，勿在此新增逻辑。`./model` 的 PlatformInfo 与壳副本内联
 * 声明结构同形（结构类型兼容），model 文件本身不动。
 */

export {
  usePlatform,
  initPlatform,
  getPlatformInfo,
  useIsDesktop,
  useIsMobile,
} from '@/shell/composables/usePlatform'

export type { PlatformInfo, Platform, Arch } from '@/shell/composables/usePlatform'
