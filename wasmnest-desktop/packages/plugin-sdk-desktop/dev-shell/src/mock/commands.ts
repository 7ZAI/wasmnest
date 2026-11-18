/**
 * 命令 mock 表（桌面端 dev-shell）
 * -----------------------------------------------------------------------------
 * 浏览器里没有 Rust WASM 后端，app 经 `AppMountEnv.appInvoke` 发的插件面命令
 * 必须由前端 mock 顶上，否则 app 首屏就是空态 / 报错——而 dev-shell 的意义正是
 * 「不跑真后端也能调 UI」。
 *
 * 领域 mock（file-transfer）在这里注册命令 handler，种子数据来自
 * app 自己导出的 `devMock`（各 app 持有自己的演示数据，dev-shell 不写死业务内容）。
 *
 * 未注册的命令**显性失败**（reject + warn 日志），不静默返回 undefined：静默
 * undefined 会让 app 以为「后端返回了空」，开发者看不出是哪条命令缺 mock。
 */
import { pushLog } from '../registry'

/** 命令 handler（参数与 app 侧 `commands.execute(id, ...args)` 一致） */
export type CommandHandler = (...args: any[]) => unknown

const handlers = new Map<string, CommandHandler>()

/** 注册命令 mock（重复注册覆盖前者——切 app 时同域 mock 会重新注册） */
export function registerCommand(id: string, handler: CommandHandler): void {
  handlers.set(id, handler)
}

/** 注销一批命令（切 app / 卸载时调用，避免上一 app 的 handler 残留） */
export function unregisterCommands(ids: Iterable<string>): void {
  for (const id of ids) handlers.delete(id)
}

/** 已注册的命令 id（排障用：日志面板可列当前 mock 面） */
export function registeredCommandIds(): string[] {
  return [...handlers.keys()].sort()
}

/**
 * 分发一条插件面命令
 *
 * @throws 未注册的命令 → reject（错误文案点明「浏览器无 WASM 后端」）
 */
export async function dispatchCommand(appId: string, id: string, args: unknown[]): Promise<unknown> {
  const handler = handlers.get(id)
  if (!handler) {
    pushLog(
      'warn',
      appId,
      `命令 "${id}" 未注册 mock —— Rust WASM 后端不在浏览器运行；该路径需到真机验证`,
    )
    throw new Error(
      `[dev-shell] 命令 "${id}" 未注册 mock：浏览器无 Rust WASM 后端，请到真机验证该路径`,
    )
  }
  return handler(...args)
}
