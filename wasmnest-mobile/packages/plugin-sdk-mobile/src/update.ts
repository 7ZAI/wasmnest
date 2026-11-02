/**
 * 应用更新检查（SDK 默认实现；宿主统一提供 GitHub Release 判定）
 *
 * 数据面由宿主给出（`PluginContext.appUpdate.check`）：宿主负责查 Release、校验
 * 身份 / 完整性、做平台兼容裁决；本模块只做状态机与展示口径，供应用设置页复用。
 *
 * 应用可以选择：
 * - **默认实现**：`useAppUpdate()` / `<AppUpdateSection />`（宿主能力 + 本模块状态）；
 * - **自实现**：自己查更新 / 自己画界面，不消费本模块。
 *
 * 失败口径：检查是被动动作，不向用户抛技术错误——状态落 `error`，技术详情由宿主
 * 日志承载（应用可自行决定是否提示）。
 */
import { computed, getCurrentInstance, inject, ref, type ComputedRef, type Ref } from 'vue'
import type { AppUpdateAPI, AppUpdateCheckResult, AppUpdateReason, PluginContext } from './types'

/** 状态机的展示态（与宿主返回的 status 子集一致） */
export type AppUpdateStatus =
  'idle' | 'checking' | 'up-to-date' | 'available' | 'incompatible' | 'error'

export interface UseAppUpdateOptions {
  /**
   * 自定义检查器（缺省 = 宿主 `PluginContext.appUpdate.check`）
   *
   * 应用自实现更新检查时传入；返回形状与宿主默认实现一致，SDK 默认卡片即可复用。
   */
  check?: () => Promise<AppUpdateCheckResult>
}

export interface UseAppUpdate {
  status: Ref<AppUpdateStatus>
  latestVersion: Ref<string | undefined>
  currentVersion: Ref<string | undefined>
  reason: Ref<AppUpdateReason | undefined>
  checking: ComputedRef<boolean>
  /** 当前平台是否提供更新检查能力（旧宿主 / dev-shell 可能没有） */
  supported: ComputedRef<boolean>
  /** 执行一次检查；并发调用复用同一在途请求 */
  check: () => Promise<void>
}

/**
 * 取宿主注入的更新能力（composable 必须在 setup 期间调用；inject 只在 setup 有上下文）
 *
 * 不经 SDK `getPluginContext()`：桌面挂载包没有 `__WASMNEST_SHARED__`，移动端虽有
 * 共享运行时但取 context 的路径也不同；`inject('pluginContext')` 是双端应用都已
 * 提供的唯一入口（桌面 appContext / 移动 PluginViewHost 同键）。
 */
function resolveHostApi(): AppUpdateAPI | undefined {
  if (!getCurrentInstance()) return undefined
  return inject<PluginContext | undefined>('pluginContext', undefined)?.appUpdate
}

/**
 * 应用更新状态机（模块内无全局单例：每个设置页实例各自持状态，避免跨应用串状态）
 */
export function useAppUpdate(options: UseAppUpdateOptions = {}): UseAppUpdate {
  const hostApi = options.check ? undefined : resolveHostApi()
  const checker =
    options.check ??
    (() => {
      if (!hostApi) {
        return Promise.reject(
          new Error('[PluginSDK] app update capability is not provided by this host'),
        )
      }
      return hostApi.check()
    })
  const status = ref<AppUpdateStatus>('idle')
  const latestVersion = ref<string | undefined>()
  const currentVersion = ref<string | undefined>()
  const reason = ref<AppUpdateReason | undefined>()
  let inFlight: Promise<void> | null = null

  const supported = computed(() => Boolean(options.check || hostApi))

  async function run(): Promise<void> {
    status.value = 'checking'
    reason.value = undefined
    try {
      const result = await checker()
      currentVersion.value = result.currentVersion
      latestVersion.value = result.latestVersion
      reason.value = result.reason
      switch (result.status) {
        case 'up-to-date':
        case 'available':
        case 'incompatible':
          status.value = result.status
          break
        case 'idle':
        case 'checking':
          // 宿主返回中间态没有意义（调用已返回）→ 按失败处理，不把界面钉在「检查中」
          status.value = 'error'
          break
        default:
          status.value = 'error'
      }
    } catch {
      status.value = 'error'
    }
  }

  function check(): Promise<void> {
    if (!inFlight) {
      const pending = run().finally(() => {
        if (inFlight === pending) inFlight = null
      })
      inFlight = pending
    }
    return inFlight
  }

  return {
    status,
    latestVersion,
    currentVersion,
    reason,
    checking: computed(() => status.value === 'checking'),
    supported,
    check,
  }
}
