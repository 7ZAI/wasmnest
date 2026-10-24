/**
 * 运行面 Vue 实例注册表（移动端每应用一个独立 Vue 应用）
 *
 * 模型：壳仍是 1 个 Vue 应用；每个「打开过且有运行面」的应用由宿主创建 1 个
 * 独立 Vue 应用，挂在该应用自己的容器里。本模块只做 Vue / DOM 记账，是这一
 * 模型的唯一新测试 seam：不 import Tauri、不认识业务名词（appId 键控的 UI
 * 记账，B1–B6 均不命中）。壳接线（何时 ensure / 对账 / 插槽归属）不在本模块。
 *
 * 生命周期口径（与桌面 appSurfaceRegistry 同组判据）：
 * - `ensure`：确保有且只有一个实例；幂等、并发调用合并为一次创建；组件身份
 *   变化（不同的组件对象）时销毁旧实例再建新实例，不继续挂旧组件。
 * - `attach` / `detach`：容器在运行屏插槽与脱文档之间移动，幂等；**不**销毁
 *   实例——切走保留（DOM / 组件状态 / 滚动 / 表单原样，后台不渲染），停用 /
 *   卸载才是唯一销毁点。attach / detach 同时推动该应用的响应式前台信号
 *   （应用侧经 SURFACE_ACTIVE_KEY 语义消费，可在后台暂停轮询 / 动画）。
 * - `dispose`：唯一会 `app.unmount()` 的路径；**先摘记账**再 unmount 再移除
 *   容器——unmount 期间的并发 attach 拿到 false，不会复用半销毁实例；幂等；
 *   能处理「创建在途」：在途 ensure 完成后发现记账已不在，不得重新登记，
 *   已创建的实例就地清干净。
 *
 * 创建使用宿主同一份 Vue 运行时（宿主模块图里的 `vue` 即外置给应用的共享
 * 那份，不再引入第二份）；共享运行时安装（i18n / pinia / router）与宿主环境
 * 注入（pluginContext、平台信息、前台信号……）都经 `ensure` 输入显式传入——
 * 注入清单是契约，由壳统一收集一次，本模块不复制第二份清单。
 *
 * 错误隔离：每个实例自己的 `app.config.errorHandler`，日志带 appId 与阶段
 * （create / mount / render / event / lifecycle），错误不冒泡到壳。注意 Vue
 * 多实例解决的是应用上下文与错误边界，不是 CSS / DOM / window / IPC 隔离
 * （同 webview 同信任域）。
 */
import { createApp, ref, type App, type Component, type Plugin, type Ref } from 'vue'

/** 错误阶段：create / mount 是注册表创建的两步；render / event / lifecycle 是 Vue 运行期错误分类 */
export type SurfaceErrorPhase = 'create' | 'mount' | 'render' | 'event' | 'lifecycle'

/** 注册表生命周期日志事件（字段契约：appId + 事实 + 当前存活实例数；不携带应用内部状态） */
export interface SurfaceRegistryLogEvent {
  appId: string
  action: 'ensure' | 'attach' | 'detach' | 'dispose' | 'error'
  /** action=error 时的阶段归类 */
  phase?: SurfaceErrorPhase
  /** 当前存活（已登记）实例数 */
  instanceCount: number
  /** 人类可读细节（错误类别 / 竞态事实） */
  detail?: string
}

/**
 * 日志出口由调用方注入（壳接线时传 frontendLogger 的分级方法；本模块不
 * import Tauri 侧设施）。对象形态对齐前端 logger 的 info / warn / error。
 */
export interface SurfaceRegistryLogger {
  info(event: SurfaceRegistryLogEvent): void
  warn(event: SurfaceRegistryLogEvent): void
  error(event: SurfaceRegistryLogEvent): void
}

/** 运行面实例记录（外部可观察面：查询 / 对账 / 测试都用它） */
export interface SurfaceAppRecord {
  readonly appId: string
  /** 该应用独立的 Vue 应用（宿主创建；dispose 是唯一 unmount 路径） */
  readonly app: App
  /** 应用自己的挂载容器（宿主不在里面放任何宿主 DOM；加载 / 失败态必须是容器的兄弟节点） */
  readonly container: HTMLElement
  /** 创建时的根组件身份（不同组件对象 = 需要重建实例） */
  readonly component: Component
  /** 前台标记：attach 推 true / detach 推 false（响应式，经注入清单桥接给应用） */
  readonly active: Ref<boolean>
}

/** ensure 输入：组件 + 共享运行时安装 + 宿主环境注入（都由壳装配成同一份） */
export interface SurfaceAppEnsureInput {
  /** 运行面根组件（应用注册、宿主包装后的组件） */
  component: Component
  /** 共享运行时安装（i18n / pinia / router 等宿主同一份实例，按序 `app.use`） */
  plugins?: unknown[]
  /**
   * 宿主环境注入工厂：独立 Vue 应用不能靠组件树继承宿主 provide，由壳统一
   * 收集一次注入清单，创建时按应用生成注入表（含该应用的前台信号）。键可为
   * string 或 Symbol。
   */
  provides?: (active: Ref<boolean>) => Record<PropertyKey, unknown>
}

export interface SurfaceAppRegistry {
  has(appId: string): boolean
  get(appId: string): SurfaceAppRecord | undefined
  /** 当前存活实例的 appId 列表（对账 / 排障用） */
  list(): string[]
  /** 确保有且只有一个实例；幂等、并发合并一次创建、组件身份变化重建 */
  ensure(appId: string, input: SurfaceAppEnsureInput): Promise<SurfaceAppRecord>
  /** 容器放进运行屏插槽（幂等）；false = 没有该实例（含 dispose 在途） */
  attach(appId: string, outlet: HTMLElement): boolean
  /** 容器脱离文档（不销毁）；幂等 */
  detach(appId: string): boolean
  /** 真正销毁：先摘记账再 unmount 再移除容器；幂等；能处理创建在途 */
  dispose(appId: string): Promise<boolean>
}

/** Vue 运行期错误信息 → 阶段归类（info 形如 'render function' / 'event handler' / '* hook'） */
function classifyRuntimePhase(info: string): SurfaceErrorPhase {
  if (info.includes('render')) return 'render'
  if (info.includes('event') || info.includes('handler')) return 'event'
  // 其余（setup / 生命周期钩子 / watcher / 调度器）都归组件生命周期路径
  return 'lifecycle'
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 创建在途的记账：并发 ensure 合并到同一 promise；dispose 置 disposed 位 */
interface InflightCreate {
  promise: Promise<SurfaceAppRecord>
  disposed: boolean
}

export function createSurfaceAppRegistry(
  options: { logger?: SurfaceRegistryLogger } = {},
): SurfaceAppRegistry {
  const logger: SurfaceRegistryLogger =
    options.logger ??
    {
      info(event) {
        console.info(renderEvent(event))
      },
      warn(event) {
        console.warn(renderEvent(event))
      },
      error(event) {
        console.error(renderEvent(event))
      },
    }

  function renderEvent(event: SurfaceRegistryLogEvent): string {
    const phase = event.phase ? ` phase=${event.phase}` : ''
    const detail = event.detail ? ` ${event.detail}` : ''
    return `[surfaceAppRegistry] ${event.action} appId=${event.appId}${phase} instances=${event.instanceCount}${detail}`
  }

  const records = new Map<string, SurfaceAppRecord>()
  const inflight = new Map<string, InflightCreate>()

  /** 组装日志事件（instanceCount 字段只在组装点取值，保证口径单一） */
  function makeEvent(
    appId: string,
    action: SurfaceRegistryLogEvent['action'],
    extra: { phase?: SurfaceErrorPhase; detail?: string } = {},
  ): SurfaceRegistryLogEvent {
    return { appId, action, instanceCount: records.size, ...extra }
  }

  /** 就地销毁一条已登记记录：先摘记账（并发 attach 立即失效），再 unmount，最后清容器 */
  async function destroyRecord(record: SurfaceAppRecord): Promise<void> {
    records.delete(record.appId)
    try {
      record.app.unmount()
    } catch (e) {
      // unmount 抛错不得留下容器或记账：记录后仍然完成清理，再让调用方可见
      logger.error(
        makeEvent(record.appId, 'error', {
          phase: 'lifecycle',
          detail: `unmount 失败：${errorText(e)}（容器与记账已清理）`,
        }),
      )
      throw e
    } finally {
      record.container.remove()
    }
  }

  async function performEnsure(
    appId: string,
    input: SurfaceAppEnsureInput,
    state: InflightCreate,
  ): Promise<SurfaceAppRecord> {
    try {
      const existing = records.get(appId)
      if (existing) {
        // 组件身份变化：先销毁旧实例并等它卸完（注册表至多一条，不挂旧组件）
        await destroyRecord(existing)
      }

      const active = ref(false)
      const container = document.createElement('div')
      container.className = 'surface-instance-host' // 铺满运行屏插槽的样式由壳提供

      let app: App
      try {
        app = createApp(input.component)
      } catch (e) {
        logger.error(
          makeEvent(appId, 'error', { phase: 'create', detail: `createApp 失败：${errorText(e)}` }),
        )
        container.remove()
        throw e
      }

      // 每实例独立错误处理：带 appId 与阶段、吞掉不冒泡（壳与其他应用不受牵连）
      app.config.errorHandler = (err, _instance, info) => {
        logger.error(
          makeEvent(appId, 'error', { phase: classifyRuntimePhase(info), detail: errorText(err) }),
        )
      }
      for (const plugin of input.plugins ?? []) app.use(plugin as Plugin)
      if (input.provides) {
        const entries = input.provides(active)
        for (const key of Reflect.ownKeys(entries)) {
          ;(app.provide as (k: PropertyKey, v: unknown) => void)(key, entries[key])
        }
      }

      try {
        // mount 会先清空容器：宿主的加载 / 失败态必须是容器的兄弟节点，不能放里面
        app.mount(container)
      } catch (e) {
        logger.error(
          makeEvent(appId, 'error', { phase: 'mount', detail: `mount 失败：${errorText(e)}` }),
        )
        // 半挂载实例不留：尽力卸载 + 清容器，下次打开可重新创建
        try {
          app.unmount()
        } catch (e2) {
          // 已在清理路径，二次失败不再传播（清理本身不能被卡死），但必须可观测
          logger.error(
            makeEvent(appId, 'error', {
              phase: 'lifecycle',
              detail: `mount 失败后兜底 unmount 失败：${errorText(e2)}`,
            }),
          )
        }
        container.remove()
        throw e
      }

      const record: SurfaceAppRecord = { appId, app, container, component: input.component, active }

      // 注册边界：创建完成 → 登记前的异步窗口。「创建在途」的 dispose 在这里被
      // 发现——记账已不在就不得重新登记，已创建的实例就地清干净
      await Promise.resolve()
      if (state.disposed) {
        try {
          app.unmount()
        } catch (e) {
          logger.error(
            makeEvent(appId, 'error', {
              phase: 'lifecycle',
              detail: `在途清理 unmount 失败：${errorText(e)}`,
            }),
          )
        }
        container.remove()
        logger.warn(
          makeEvent(appId, 'dispose', { detail: '创建在途被 dispose：实例未登记并已清理' }),
        )
        return record
      }

      records.set(appId, record)
      logger.info(
        makeEvent(appId, 'ensure', {
          detail: existing ? '组件身份变化，已重建实例' : '已创建并登记',
        }),
      )
      return record
    } finally {
      inflight.delete(appId)
    }
  }

  return {
    has(appId) {
      return records.has(appId)
    },

    get(appId) {
      return records.get(appId)
    },

    list() {
      return [...records.keys()]
    },

    ensure(appId, input) {
      const existing = records.get(appId)
      if (existing && existing.component === input.component) return Promise.resolve(existing)
      const pending = inflight.get(appId)
      if (pending) {
        // 并发合并：后到者等待同一次创建（组件身份以第一到者为准）
        return pending.promise
      }
      const state: InflightCreate = { promise: null!, disposed: false }
      // 先登记再启动：performEnsure 同步失败（createApp / mount 即抛）时其
      // finally 的 inflight.delete 必须发生在 set 之后，否则 rejected 的
      // 在途条目会永久残留——之后所有 ensure 都拿到同一个 rejection，
      // 「失败后重试 / 重开重建」从此失效
      inflight.set(appId, state)
      state.promise = performEnsure(appId, input, state)
      return state.promise
    },

    attach(appId, outlet) {
      const record = records.get(appId)
      if (!record) return false
      if (record.container.parentElement !== outlet) outlet.appendChild(record.container)
      // ref 同值赋值幂等：重复 attach 不重复触发下游（应用不会反复恢复轮询）
      record.active.value = true
      logger.info(makeEvent(appId, 'attach'))
      return true
    },

    detach(appId) {
      const record = records.get(appId)
      if (!record) return false
      record.container.remove() // 脱文档但整棵子树保留（不销毁、不 unmount）
      record.active.value = false
      logger.info(makeEvent(appId, 'detach'))
      return true
    },

    async dispose(appId) {
      const record = records.get(appId)
      if (record) {
        await destroyRecord(record)
        logger.info(makeEvent(appId, 'dispose', { detail: '实例已销毁' }))
        return true
      }
      // 没有已登记实例、但创建还在途：置位让在途 ensure 完成后就地清理
      const pending = inflight.get(appId)
      if (pending && !pending.disposed) {
        pending.disposed = true
        logger.warn(
          makeEvent(appId, 'dispose', { detail: '创建在途：创建完成后将就地清理' }),
        )
        return true
      }
      return false
    },
  }
}
