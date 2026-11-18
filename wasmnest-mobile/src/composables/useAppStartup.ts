/**
 * 应用启动任务注册表 + 开屏退出时刻策略
 *
 * 时间轴:performance.now() 的 0 点即页面 timeOrigin(WebView 导航起点),
 * 所有打点(readyAt / mountAt / max)共用该轴。开屏的最短展示时长以挂载
 * 时刻为基准折算(见 SplashScreen.scheduleExit),避免静态首屏的加载耗时
 * 预先烧掉固定显示时长;硬兜底 max 直接用该轴时刻,限制总启动时长。
 *
 * 启动链路打点(与 SPLASH_CONFIG.lines 的 id 对应):
 * - platform / settings:main.ts 预初始化完成后
 * - plugins:main.ts initPluginSystem 结束后(finally,失败不卡兜底)
 * - connection:useMobileConnection 模块级 init() 末尾(监听器注册完成,
 *   不等 WS 实际建连——建连是用户操作驱动的长时段,不属于启动期)
 * - ui:App.vue onMounted(主题/字体/安全区就绪)
 * - apps:壳应用清单非空(App.vue 经 bindAppsTaskToListReady 观察壳清单)。后端应用
 *   扫描(解压 → WASM 运行时 → 扫描加载)晚于前端就绪,plugins 打点只代表前端
 *   初始化完成、不代表清单可显示;apps 是开屏收起的最后闸门——保证收起时首页
 *   应用已在,动画放完进主界面不再「应用晚几秒才出现」。零应用等异常由 App.vue
 *   兜底时长接管。打点落宿主侧而非壳内:L7 壳内自足锁禁止壳 import 宿主机制
 *   目录,且 apps 是开屏私有闸门,壳只暴露清单事实、不感知开屏时序
 *
 * SplashScreen 依据 computeSplashExitAt 决定淡出时刻:
 * minDurationMs 从开屏挂载(可见)起算——启动快于该值则补足,保证叙事完整;
 * 落在 min~max 区间 → 就绪即退(就绪行再定格一拍);
 * 超过 maxDurationMs 仍未就绪 → 兜底强制退出。
 */
import { computed, reactive, readonly, watch } from 'vue'
import { SPLASH_CONFIG } from '@/config/splash'

// ==================== 启动任务注册表(模块级单例) ====================

const completedAt = reactive<Record<string, number | null>>(
  Object.fromEntries(SPLASH_CONFIG.lines.map((line) => [line.id, null])),
)

/**
 * 标记启动任务完成(幂等;未知 id 忽略,配置删行后旧打点不致报错)
 */
export function completeStartupTask(id: string): void {
  if (!(id in completedAt) || completedAt[id] !== null) return
  completedAt[id] = performance.now()
}

/** 各任务完成时刻(未完成为 null),供开屏组件驱动日志行与进度 */
export const taskCompletedAt = readonly(completedAt)

/** 全部启动任务完成(前端启动链路就绪,不等于 WS 已建连) */
export const startupReady = computed(() =>
  SPLASH_CONFIG.lines.every((line) => completedAt[line.id] !== null),
)

/** 就绪时刻(最后完成任务的时刻;未就绪为 null) */
export const readyAt = computed<number | null>(() => {
  if (!startupReady.value) return null
  return Math.max(...SPLASH_CONFIG.lines.map((line) => completedAt[line.id] ?? 0))
})

// ==================== 开屏退出策略(纯函数,单测覆盖) ====================

/**
 * 计算开屏退出时刻(与 performance.now() 同时间轴)
 *
 * @param now 当前时刻
 * @param readyAt 启动就绪时刻(null 表示尚未就绪)
 * @param minExitAt 固定显示时长下限时刻
 * @param maxExitAt 最长兜底时刻
 * @returns 退出时刻(不早于 now)
 */
export function computeSplashExitAt(params: {
  now: number
  readyAt: number | null
  minExitAt: number
  maxExitAt: number
}): number {
  const { now, readyAt, minExitAt, maxExitAt } = params

  let target: number
  if (readyAt === null || readyAt >= maxExitAt) {
    // 未就绪 / 就绪已晚于兜底:由兜底时刻接管
    target = maxExitAt
  } else if (readyAt <= minExitAt) {
    // 启动快于固定时长:补足到固定显示时长
    target = minExitAt
  } else {
    // 区间内:就绪即退
    target = readyAt
  }
  return Math.max(now, target)
}

// ==================== apps 清单闸门(壳清单 → 启动任务桥) ====================

/**
 * 绑定「壳应用清单非空 → 打点 apps 任务」闸门,返回停止函数(供挂载方卸载时摘除)。
 *
 * 为什么在宿主侧观察而不是壳内打点:L7 壳内自足锁(shellConstraintLocks)禁止壳
 * import 宿主机制目录(`@/composables/*`),且 apps 是开屏收起的私有闸门——壳只
 * 暴露清单事实(由调用方传入 getter),不感知开屏时序。清单非空 = 后端扫描完成且
 * 首页宫格数据就位,此刻打点,开屏退让后应用零间隙可见;空清单(扫描未完成)不打点,
 * 由壳自身的清单轮询驱动后续 refresh,零应用等异常由 App.vue 兜底时长接管。
 * immediate 兜住「绑定前清单已就绪」的时序;打点幂等,重复触发无副作用。
 */
export function bindAppsTaskToListReady(listLength: () => number): () => void {
  const stop = watch(
    () => listLength() > 0,
    (ready) => {
      if (ready) completeStartupTask('apps')
    },
    { immediate: true },
  )
  return () => stop()
}
