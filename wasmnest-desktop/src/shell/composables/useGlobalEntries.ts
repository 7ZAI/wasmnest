/**
 * 全局入口（桌面 · 票 04 / spec §4.3）
 * -----------------------------------------------------------------------------
 * manifest 声明 `contributes.globalEntries` 且持有 `ui:globalEntry` 的应用，
 * 在壳工具栏尾部出现一个用户可见入口；点击经 openApp 进全屏。
 *
 * 入口只对「已安装、已启用、激活成功」的应用渲染；停用/卸载/未声明权限/用户关闭即消失。
 * 壳不知道 Nest 是什么，只渲染声明过的通用入口（宿主薄壳红线 B1–B6）。
 */
import { computed } from 'vue'
import { useShellApps } from './useShellApps'
import { isServiceKind } from './useShellApps'

/** 全局入口视图模型（壳渲染用） */
export interface GlobalEntry {
  /** 宿主应用 id（= pluginId；openApp 用） */
  appId: string
  /** 入口声明 id（应用内唯一；manifest contributes.globalEntries[].id） */
  entryId: string
  /** 显示标题（manifest contributes.globalEntries[].title） */
  title: string
  /** 图标文件名（可选；manifest contributes.globalEntries[].icon） */
  icon?: string
  /** 排序权重（缺省 100；小者靠前） */
  order: number
  /** 应用显示名（fallback 用） */
  appName: string
}

/**
 * 计算全局入口列表。
 *
 * 渲染条件（spec §4.3.1「已安装、已启用、激活成功」的壳侧落点）：
 * - 应用已安装（在注册表里）
 * - 应用已启用（enabled !== false）
 * - 激活未失败（state !== 'error'；dormant / approval 仍可点：前者走激活，
 *   后者进审批弹窗，都不是「点了必失败」）
 * - manifest 声明了 contributes.globalEntries（非空数组）
 * - 应用持有 ui:globalEntry 权限
 *
 * 排序：按 entry.order 升序（缺省 100）。
 */
export function useGlobalEntries() {
  const appsStore = useShellApps()

  const entries = computed<GlobalEntry[]>(() => {
    const result: GlobalEntry[] = []
    for (const app of appsStore.plugins.value) {
      // 隐藏条件 1：未启用
      if (app.enabled === false) continue
      // 隐藏条件 2：上次激活失败（入口不留给「点了必失败」的应用）
      if (app.state === 'error') continue
      // 隐藏条件 3：未声明 globalEntries
      if (!app.globalEntries || app.globalEntries.length === 0) continue
      // 隐藏条件 4：未持有 ui:globalEntry 权限
      if (!app.permissions.includes('ui:globalEntry')) continue

      for (const entry of app.globalEntries) {
        result.push({
          appId: app.pluginId,
          entryId: entry.id,
          title: entry.title,
          icon: entry.icon,
          order: entry.order ?? 100,
          appName: app.name,
        })
      }
    }
    return result.sort((a, b) => a.order - b.order)
  })

  return { entries }
}

/** 服务型应用不产多任务卡（现行 isServiceKind 口径） */
export { isServiceKind }
