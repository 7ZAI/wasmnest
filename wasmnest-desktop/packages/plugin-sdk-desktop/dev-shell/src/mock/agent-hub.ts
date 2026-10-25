/**
 * Agent Hub 插件领域 mock（dev-shell 专用，纯通用接线）
 *
 * 浏览器中 Rust WASM 后端不可用，app 经 `env.appInvoke` 发的命令只能由前端
 * mock 顶上。本模块注册 agent-hub 五个领域（探测/安装/Skills/供应商/使用统计）
 * 的命令 handler 骨架（经 `DomainContext` 落到全局命令表），并模拟事件回流
 * （`plugin:agent-hub:*` 全量状态推送，经 Tauri 事件垫片送达 app 的 listen），
 * 使插件在 dev-shell 中展示「有数据」的完整形态：
 * - 探测：detect 逐 CLI 延时推进 detecting → 终态（种子为终态目标）
 * - 安装：run 剧本逐行回显输出、测速/检查更新延时出结果、换源改写 npmrc 状态
 * - Skills：扫描动画、编辑保存（hash 重算 → 分发转 stale）、分发/GitHub 安装/本地导入
 * - 供应商：预设 CRUD、反向导入（种子发现条目）、应用（claude 桥接冲突演示）
 * - 使用统计：扫描 syncing → ok、看板聚合、会话分页、日志详情读取
 *
 * 本模块不包含任何具体业务 mock 数据：全部演示种子由插件工程持有（入口导出
 * devMock：detection / install / skills / providers / usage 五个子域），
 * 注入时按 pluginId 经 getDevMock 取种子驱动命令返回值与事件；未导出对应
 * 子域的插件不受影响（各子域命令不注册）。
 *
 * 2026-10-25：命令实现（种子派生状态 / 安装模拟 / 五域 handler）拆至
 * agent-hub-commands.ts，本文件只做种子查找门面。
 */
import { getDevMock } from '../registry'
import type { DomainContext } from './domain-context'
import { registerAgentHubMockImpl, type AgentHubSeed } from './agent-hub-commands'

/**
 * 注册 agent-hub 领域命令 mock（loader 在 activate 前调用）
 *
 * 仅注册种子中存在的子域命令；返回 Disposable 供插件 deactivate 清理定时器
 */
export function registerAgentHubMock(context: DomainContext, pluginId: string): {
  dispose(): void
} {
  // SAFETY: dev-shell 刻意不收录插件包类型（SDK 不依赖插件），种子形状按
  // 插件 devMockTypes.ts 的领域接口本地镜像后 cast——运行期种子字段是这些
  // 接口的超集（额外字段经索引签名透传），cast 只收窄不丢字段
  const seed = getDevMock(pluginId) as unknown as AgentHubSeed | undefined
  if (!seed) return { dispose() {} }

  return registerAgentHubMockImpl(context, seed)
}
