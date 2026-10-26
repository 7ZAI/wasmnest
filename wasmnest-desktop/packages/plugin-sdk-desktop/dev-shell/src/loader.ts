/**
 * 调试对象加载器（桌面端 dev-shell · 挂载包形态）
 * -----------------------------------------------------------------------------
 * 加载的是**桌面宿主同一种对象**：独立构建的 app 挂载包（机制 B）。dev-shell 与
 * 宿主的差别只有「拿的是源码还是产物」：
 *
 * - 宿主：动态 import 产物整包（`convertFileSrc(<plugins>/<appId>/index.js)`）
 * - dev-shell：vite 直接把 app 的 `src/entry.ts` 解析进构建图（改代码即 HMR）
 *
 * 每个 app 的挂载包模块与其领域种子（`src/index.ts` 导出的 `devMock`）**分开取**：
 * 前者是界面，后者是演示数据。app 只导出 `src/entry.ts`（无 `src/index.ts`）时
 * 种子缺省——不影响挂载。
 *
 * 领域 mock（命令 handler + 事件推送）**在挂载时**才注册（不是加载时）：app 的
 * 事件订阅发生在挂载后的组件里，提前推送的种子事件会被错过（表现为「设备列表
 * 空着」这种像坏了的现象）。
 */
import { markRaw, reactive, ref } from 'vue'
import type { PluginDevMock } from '../../src/types'
import type { AppBundleModule } from './shell/types'
import { apps, getDevMock, pushLog, registerDevMock, type DevAppState } from './registry'
import { createDomainContext } from './mock/domain-context'
import { registerFileTransferMock } from './mock/file-transfer'
import { registerAgentHubMock } from './mock/agent-hub'

export const ready = ref(false)

/** vite 虚拟模块给出的一个被调试 app 的说明 */
interface DevSpec {
  /** app 工程目录 */
  dir: string
  /** 源清单（plugin.json） */
  manifest: Record<string, unknown>
  /** 挂载包模块（app 的 `src/entry.ts`；缺失 = null） */
  entry: AppBundleModule | null
  /** 领域种子模块（app 的 `src/index.ts` 导出的 devMock；缺失 = null） */
  devMock: PluginDevMock | null
}

/** 发现全部被调试 app（幂等） */
export async function loadApps(): Promise<void> {
  if (ready.value) return
  try {
    const specs = (await import('virtual:dev-plugins')).default as DevSpec[]
    for (const [index, spec] of specs.entries()) {
      const manifest = spec.manifest ?? {}
      const id =
        typeof manifest.id === 'string' && manifest.id ? manifest.id : `dev-app-${index}`
      const name = typeof manifest.name === 'string' && manifest.name ? manifest.name : id

      // 挂载包模块不经响应式代理（模块命名空间对象被代理后身份会变）
      const module = spec.entry ? markRaw(spec.entry) : null
      const record = reactive({
        id,
        name,
        manifest,
        module,
        dir: spec.dir,
        state: 'loaded' as DevAppState,
        error: undefined as string | undefined,
      })

      if (spec.devMock) {
        registerDevMock(id, spec.devMock)
        pushLog('info', id, '已注册 devMock（领域种子数据）')
      }

      if (!module || typeof module.mountApp !== 'function') {
        record.state = 'error'
        record.error = '挂载包未导出 mountApp（契约不匹配）'
        pushLog('error', id, '挂载包未导出 mountApp —— 入口应为 src/entry.ts（机制 B 挂载包）')
      } else {
        pushLog('info', id, `已发现挂载包（${spec.dir}）`)
      }

      apps.value.push(record)
    }
  } catch (e: any) {
    pushLog('error', 'dev-shell', `加载调试对象失败：${e?.message || e}`)
  }
  ready.value = true
}

/**
 * 为即将挂载的 app 准备领域 mock（命令 handler + 事件推送）
 *
 * 每次挂载**重新注册**：领域 mock 的状态是模块级的（种子派生），换 app 或重新
 * 挂载时必须回到种子初始态，否则上一个 app 的残留状态会串进下一个。
 */
export function prepareAppMocks(appId: string): { dispose(): void } {
  const seed = getDevMock(appId)
  if (!seed) return { dispose() {} }
  const context = createDomainContext()
  const disposers: Array<{ dispose(): void }> = []
  // 是否注入由 app 的 devMock 种子子域决定，dev-shell 不写死 app 身份
  if (seed.peer || seed.transfer) {
    disposers.push(registerFileTransferMock(context, appId))
    pushLog('info', appId, '已注册领域命令 mock（通用接线，种子来自 app devMock）')
  }
  if (seed.detection || seed.install || seed.skills || seed.providers || seed.usage) {
    disposers.push(registerAgentHubMock(context, appId))
    pushLog('info', appId, '已注册领域命令 mock（通用接线，种子来自 app devMock）')
  }
  return {
    dispose() {
      for (const d of disposers) d.dispose()
    },
  }
}
