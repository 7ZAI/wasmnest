/**
 * 后台运行应用的「上次停在哪一页」记忆（壳机制面，零业务语义）
 *
 * 与宿主 `src/shell/mount/appSession.ts` **同构副本**：应用界面离开时挂载槽会卸载
 * 该 app 的整包实例，再点应用图标是一次全新挂载——不记路径就只能回到落地页。
 *
 * 数据来源：**app 自报**（挂载契约 `AppMountEnv.onEvent('route', { path })`）。
 * 宿主不解析应用内部路由语义，只按 appId 原样存一个路径串，下次挂载时作为
 * `initialRoute` 交回。
 *
 * 进程内内存态，不落盘：重启应用后各自回落地页。
 */
import { ref } from 'vue'

/** appId → 应用内部路由路径（读时才展开，避免调用方直接改表） */
const lastRoutes = ref<Readonly<Record<string, string>>>({})

/**
 * 记录应用当前页（app 挂载包自报）。
 *
 * 非法输入（空 id / 空路径 / 根路径 / 非绝对路径）直接忽略：根路径不是「一页」，
 * 记下来只会让下次挂载多推一次无意义的路由。
 */
export function rememberAppRoute(appId: string, path: string): void {
  if (!appId || !path || !path.startsWith('/') || path === '/') return
  if (lastRoutes.value[appId] === path) return
  lastRoutes.value = { ...lastRoutes.value, [appId]: path }
}

/** 应用上次停留的路径；无记录 → undefined（调用方回落落地页） */
export function lastRouteOf(appId: string): string | undefined {
  return lastRoutes.value[appId]
}

/** 忘掉一个应用的页面记忆（停用 / 卸载时调用；幂等） */
export function forgetAppRoute(appId: string): void {
  if (!(appId in lastRoutes.value)) return
  const { [appId]: _dropped, ...rest } = lastRoutes.value
  lastRoutes.value = rest
}

/** 清空全部记忆（「全部关闭」与测试隔离用） */
export function clearAppRoutes(): void {
  lastRoutes.value = {}
}
