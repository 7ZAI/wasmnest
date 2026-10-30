/**
 * 运行面运行时（注册表装配层 + 壳对账）
 * -----------------------------------------------------------------------------
 * 「每应用一个独立 Vue 应用」的装配发生在注册表（surfaceAppRegistry.ts，
 * 纯 Vue/DOM 记账）；本模块在注册表之上补三件装配事：
 *
 * 1. **注册表单例**：模块级持有，生命周期与页面同长——壳卸载只 detach、
 *    不 dispose，壳重挂后对账重建 attach 面（保活语义见 spec §4.6）。
 * 2. **ensure 输入装配**：共享运行时（宿主同一份 i18n / router；Pinia 走
 *    app-run-scope 的运行期作用域、Level 1 不安装新 Pinia）+ 宿主环境注入
 *    （hostSurfaceEnv 收集的平台信息等 + 该应用自己的前后台信号）。
 * 3. **壳对账**（reconcileSurfaceApps）：「打开过 ∩ 运行中 ∩ 有运行面」的
 *    应用 ensure 出实例（后台应用也建，不 attach）；条件不再满足的 dispose
 *    并清打开记录。壳（ShellHost）在清单 / 状态 / 注册变化时调用；输入是纯
 *    数据 + 解析函数（不读组件树），模块级兜底对账复用同一实现。
 *
 * 派生销毁说明：本层的 dispose 是「外部状态变化」的对账兜底（应用离开运行态）。
 * 用户动作路径（详情页停用 / 卸载）的**显式**「先 dispose UI 再拆插件上下文」
 * 接线由 useShellApps.stop / removeApp 负责，与本层互为补充。
 */
import type { Component } from 'vue'
import i18n from '@/locales'
import router from '@/router'
import { logger } from '@/utils/frontendLogger'
import {
  createSurfaceAppRegistry,
  type SurfaceAppEnsureInput,
  type SurfaceAppRegistry,
  type SurfaceRegistryLogEvent,
} from './surfaceAppRegistry'
import { SURFACE_ACTIVE_KEY, dropSurface } from './composables/useAppSurfaces'
import { getHostSurfaceEnv } from './hostSurfaceEnv'
import type { ShellApp } from './types'

/** 注册表生命周期日志 → 前端 logger（分级对齐：info 档落 log） */
function logEvent(level: 'log' | 'warn' | 'error', event: SurfaceRegistryLogEvent): void {
  const phase = event.phase ? ` phase=${event.phase}` : ''
  const detail = event.detail ? ` ${event.detail}` : ''
  const line = `[surface] ${event.action} appId=${event.appId}${phase} instances=${event.instanceCount}${detail}`
  if (level === 'log') logger.log(line)
  else if (level === 'warn') logger.warn(line)
  else logger.error(line, event)
}

/** 运行面实例注册表（模块级单例：跨壳挂载存活） */
const registry: SurfaceAppRegistry = createSurfaceAppRegistry({
  logger: {
    info: (e) => logEvent('log', e),
    warn: (e) => logEvent('warn', e),
    error: (e) => logEvent('error', e),
  },
})

export function getSurfaceAppRegistry(): SurfaceAppRegistry {
  return registry
}

/**
 * 多任务卡（2026-10-30）：把运行面容器搬进卡片缩略区。
 *
 * 展示的是**真实实例本身**（按整幅尺寸等比缩放，布局不重排、滚动 / 输入原样），
 * 不是截图 / 克隆 / 自绘预览；卡片不是可交互前台（前台信号推 false），层收起即
 * 回后台（容器脱文档不渲染）。实例缺失（未运行 / 未打开过 / 装载失败）→ false，
 * 卡片回退图标 + 元信息。
 */
export function presentSurfaceInPreview(appId: string, boxEl: HTMLElement): boolean {
  return registry.attachPreview(appId, boxEl)
}

/** 卡片尺寸变化（旋转 / 分屏 / 卡片数变化）：重算等比缩放 */
export function fitSurfacePreview(appId: string): boolean {
  return registry.fitPreview(appId)
}

/** 卡片卸载：把实例从卡片摘下（回后台保留，不销毁） */
export function leaveSurfacePreview(appId: string): boolean {
  return registry.detachPreview(appId)
}

/**
 * 显式销毁单个应用的运行面实例（停用 / 卸载的用户动作路径）：dispose（幂等、
 * 能处理创建在途）+ 同步清打开记录（下次打开是全新实例）。**调用方必须先于
 * 插件 loader 的 deactivate / uninstall 调用**——组件要在 pluginContext 仍
 * 有效时完成 onUnmounted 清理。
 *
 * 不向外抛：unmount 抛错时注册表已摘记账并移除容器，这里只落日志——抛出去会
 * 打断停用 / 卸载主流程（source.stop / source.remove 与打开记录清理）。
 */
export async function disposeSurfaceApp(appId: string): Promise<void> {
  try {
    await registry.dispose(appId)
  } catch (e) {
    logger.error(`[surfaceRuntime] 运行面销毁失败 appId=${appId}`, e)
  } finally {
    dropSurface(appId)
  }
}

/**
 * 装配 ensure 输入：组件 + 共享运行时 + 宿主环境注入。
 *
 * 注入清单是契约（spec §4.5）：SURFACE_ACTIVE_KEY（该应用自己的响应式前后台
 * 信号）永远在场；hostSurfaceEnv 收集到的平台键原样透传（壳未收集时只有信号，
 * 测试与壳装配一致性由 shellAppSurface.test.ts 的注入探针锁住）。
 */
export function makeSurfaceEnsureInput(component: Component): SurfaceAppEnsureInput {
  return {
    component,
    // 共享运行时：宿主同一份 i18n / router（Level 1 不为运行面新建；Pinia 的
    // 运行期作用域由 app-run-scope 自持，不在此安装）
    plugins: [i18n, router],
    provides: (active) => {
      const entries: Record<PropertyKey, unknown> = { [SURFACE_ACTIVE_KEY]: active }
      const env = getHostSurfaceEnv()
      if (env) Object.assign(entries, env)
      return entries
    },
  }
}

/** 对账输入（纯数据 + 解析函数，不依赖组件树，便于模块级兜底对账复用） */
export interface SurfaceReconcileInput {
  apps: ShellApp[]
  opened: ReadonlySet<string>
  resolveSurface: (appId: string) => Component | undefined
}

/**
 * 壳对账：desired = 打开过 ∩ 运行中 ∩ 有运行面。
 * - desired 里的应用 ensure 出实例（幂等；后台应用只建不 attach，attach 由
 *   运行屏适配器按当前屏决定）；
 * - 注册表里不在 desired 的实例 dispose（先摘记账再 unmount，注册表保证），
 *   并同步清掉打开记录（dropSurface），下次打开是全新实例。
 */
export async function reconcileSurfaceApps(input: SurfaceReconcileInput): Promise<void> {
  const desired = new Set<string>()
  for (const app of input.apps) {
    if (app.state !== 'running' || !input.opened.has(app.id)) continue
    const component = input.resolveSurface(app.id)
    if (!component) continue
    desired.add(app.id)
    try {
      await registry.ensure(app.id, makeSurfaceEnsureInput(component))
    } catch (e) {
      // 创建失败 fail-visible：注册表已清半挂载实例并落日志；对账继续，
      // 失败不牵连其他应用（下次对账 / 重试可重建）
      logger.error(`[surfaceRuntime] 运行面创建失败 appId=${app.id}`, e)
    }
  }
  for (const appId of registry.list()) {
    if (desired.has(appId)) continue
    await disposeSurfaceApp(appId)
  }
}
