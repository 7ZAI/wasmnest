/**
 * 通用应用调用桥（桌面 · `apps:control` 门控）
 * -----------------------------------------------------------------------------
 * spec §4.2：只有 manifest 声明 `apps:control` 的应用才拿到 `env.apps`。
 * 宿主做白名单与审计，不解释工具结果、不持有 AI 状态（宿主薄壳红线 B1–B6）。
 *
 * 三类拒绝各自点名缺什么（spec §4.2.2）：
 * - 目标未运行 → `app.not_running`
 * - 命令未声明 → `tool.not_declared`
 * - 参数不合 schema → `param.invalid`（附具体字段与原因）
 *
 * 审计只记 caller / target / command / risk / decision，**不**记录参数原文与返回值原文。
 */
import type {
  AppControlAPI,
  AppKind,
  AssistantAppDescriptor,
  AssistantToolDescriptor,
} from '@binblink/wasmnest-plugin-sdk-desktop'
import { invoke } from '@/utils/invoke'
import { appInvoke } from '@/utils/appCommands'
import { logger } from '@/utils/frontendLogger'

// ==================== 错误码与错误类 ====================

/** 目标应用未运行 */
export const APP_NOT_RUNNING = 'app.not_running'
/** 目标应用未声明该命令（白名单拒绝） */
export const TOOL_NOT_DECLARED = 'tool.not_declared'
/** 参数不合 argsSchema */
export const PARAM_INVALID = 'param.invalid'
/** 打开目标应用失败（壳激活失败 / 未安装 / 已停用） */
export const APP_OPEN_FAILED = 'app.open_failed'
/** 调用方未持有 apps:control（桥内二次校验，spec §4.2.2 step 1） */
export const CALLER_UNAUTHORIZED = 'caller.unauthorized'

/** 桥错误：带机器可读 code，供助手侧分流处理 */
export class AppControlError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AppControlError'
  }
}

// ==================== 宿主清单形状（与 useShellApps 同源） ====================

interface HostPluginInfo {
  id: string
  name: string
  version: string
  kind?: string
  state: { state: string; error?: string }
  permissions: string[]
  contributes: unknown
}

/** 解析 contributes.assistantTools（防御性：contributes 可能不是对象） */
function parseAssistantTools(contributes: unknown): AssistantToolDescriptor[] {
  if (!contributes || typeof contributes !== 'object') return []
  const tools = (contributes as { assistantTools?: unknown }).assistantTools
  if (!Array.isArray(tools)) return []
  return tools.filter(
    (t): t is AssistantToolDescriptor =>
      t !== null && typeof t === 'object' && typeof (t as AssistantToolDescriptor).id === 'string',
  )
}

// ==================== 基础 schema 校验（spec §4.2.2：type / required / additionalProperties / 枚举） ====================

/**
 * 最小 JSON Schema 校验：只校验顶层 object 的 type / required / additionalProperties / enum。
 * 目标命令仍须自行完整校验（桥不代裁）。
 *
 * @returns null = 通过；否则返回具体错误描述
 */
function validateSchema(
  schema: Record<string, unknown>,
  args: unknown,
): string | null {
  // undefined / null 视为空对象（invoke 的 args 可选，缺省 = 无参数）
  // argsSchema 形态异常（缺字段 / 非对象）不在这里判死：清单校验已在构建期保证，
  // 桥只做基础结构校验，兜底按「无约束」处理而不是抛 TypeError。
  const safeSchema = (schema && typeof schema === 'object' ? schema : {}) as Record<
    string,
    unknown
  >
  const obj = (args ?? {}) as Record<string, unknown>

  // type 校验（只处理 object；其他类型由目标命令自行校验）
  const expectedType = safeSchema.type
  if (expectedType === 'object' || expectedType === undefined) {
    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
      return '参数必须是 object'
    }
  }

  const props = (safeSchema.properties ?? {}) as Record<string, unknown>
  const required = Array.isArray(safeSchema.required) ? safeSchema.required : []
  const additionalProperties = safeSchema.additionalProperties

  // required 校验
  for (const key of required) {
    if (!(key in obj)) return `缺少必填参数: ${key}`
  }

  // additionalProperties 校验
  if (additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!(key in props)) return `不允许的额外参数: ${key}`
    }
  }

  // enum 校验（对每个有 enum 的属性）
  for (const [key, propSchema] of Object.entries(props)) {
    if (!propSchema || typeof propSchema !== 'object') continue
    const enumVals = (propSchema as Record<string, unknown>).enum
    if (Array.isArray(enumVals) && key in obj) {
      if (!enumVals.includes(obj[key])) {
        return `参数 ${key} 的值不在允许范围内: ${enumVals.join(', ')}`
      }
    }
  }

  return null
}

// ==================== 桥工厂 ====================

/**
 * 创建应用调用桥（注入 `env.apps`）。
 *
 * @param callerAppId 调用方应用 id（审计 + 桥内权限二次校验用）
 * @param openApp 壳的 openApp（返回 false = 激活失败，由桥转成 fail-visible 错误）
 */
export function createAppControlBridge(
  callerAppId: string,
  openApp: (appId: string) => Promise<boolean>,
): AppControlAPI {
  /** 拉取宿主清单（含 contributes.assistantTools） */
  async function listPlugins(): Promise<HostPluginInfo[]> {
    return invoke<HostPluginInfo[]>('plugin_list_with_prefs')
  }

  /**
   * 桥内二次校验调用方权限（spec §4.2.2 step 1）。
   *
   * 注入点已按 manifest 门控，但运行期权限可被收回（应用管理页改策略）；
   * 这里按宿主当前清单再判一次，不依赖注入时的快照。调用方不在清单里
   * （已卸载）同样拒绝——fail-closed，不静默降级。
   */
  function assertCallerAuthorized(infos: HostPluginInfo[]): void {
    const caller = infos.find((i) => i.id === callerAppId)
    if (!caller || !(caller.permissions ?? []).includes('apps:control')) {
      logger.warn(
        `[AppControl] audit caller=${callerAppId} command=* risk=unknown decision=denied reason=${CALLER_UNAUTHORIZED}`,
      )
      throw new AppControlError(
        CALLER_UNAUTHORIZED,
        `调用方未持有 apps:control 权限: ${callerAppId}`,
      )
    }
  }

  return {
    /** 列已安装/已加载应用及其声明给助手的工具 */
    async list(): Promise<AssistantAppDescriptor[]> {
      try {
        const infos = await listPlugins()
        // 调用方权限二次校验（spec §4.2.2 step 1）：未持权不返回应用清单
        assertCallerAuthorized(infos)
        return infos.map((info) => ({
          id: info.id,
          name: info.name,
          version: info.version,
          kind: (info.kind as AppKind) ?? 'business-app',
          state: info.state.state,
          tools: parseAssistantTools(info.contributes),
        }))
      } catch (e) {
        logger.error(`[AppControl] list failed: caller=${callerAppId}`, e)
        throw e
      }
    },

    /** 调目标应用已声明的命令 */
    async invoke<T = unknown>(
      appId: string,
      command: string,
      args?: unknown,
    ): Promise<T> {
      // 1. 拉取宿主清单（同一份结果用于调用方权限 + 目标运行态 + 白名单）
      let infos: HostPluginInfo[]
      try {
        infos = await listPlugins()
      } catch (e) {
        logger.error(`[AppControl] invoke: list failed: caller=${callerAppId} target=${appId}`, e)
        throw e
      }

      // 1.5 调用方权限二次校验（spec §4.2.2 step 1；与目标检查同一次 IPC）
      assertCallerAuthorized(infos)

      const targetInfo = infos.find((i) => i.id === appId)
      if (!targetInfo) {
        logger.warn(
          `[AppControl] audit caller=${callerAppId} target=${appId} command=${command} risk=unknown decision=denied reason=not_installed`,
        )
        throw new AppControlError('app.not_installed', `目标应用未安装: ${appId}`)
      }

      // 2. 运行态检查
      if (targetInfo.state.state !== 'activated' && targetInfo.state.state !== 'degraded') {
        logger.warn(
          `[AppControl] audit caller=${callerAppId} target=${appId} command=${command} risk=unknown decision=denied reason=${APP_NOT_RUNNING}`,
        )
        throw new AppControlError(APP_NOT_RUNNING, `目标应用未运行: ${appId}（可先 open）`)
      }

      // 3. 白名单：目标必须声明该 command 对应的 tool
      const tools = parseAssistantTools(targetInfo.contributes)
      const tool = tools.find((t) => t.command === command)
      if (!tool) {
        logger.warn(
          `[AppControl] audit caller=${callerAppId} target=${appId} command=${command} risk=unknown decision=denied reason=${TOOL_NOT_DECLARED}`,
        )
        throw new AppControlError(
          TOOL_NOT_DECLARED,
          `目标应用未声明命令: ${command}（白名单拒绝，不回退任意命令）`,
        )
      }

      // 4. 基础 schema 校验
      const schemaErr = validateSchema(tool.argsSchema, args)
      if (schemaErr) {
        logger.warn(
          `[AppControl] audit caller=${callerAppId} target=${appId} command=${command} risk=${tool.risk} decision=denied reason=${PARAM_INVALID} detail=${schemaErr}`,
        )
        throw new AppControlError(PARAM_INVALID, `参数不合 schema: ${schemaErr}`)
      }

      // 5. 执行：经 appInvoke 调目标（复用 appCommands 的 plugin_invoke 路由）
      const risk = tool.risk
      try {
        const result = await appInvoke<T>(appId, command, args ?? null)
        logger.log(
          `[AppControl] audit caller=${callerAppId} target=${appId} command=${command} risk=${risk} decision=allowed`,
        )
        return result
      } catch (e) {
        // 目标命令执行失败：审计记 denied，错误信封原样上交
        logger.warn(
          `[AppControl] audit caller=${callerAppId} target=${appId} command=${command} risk=${risk} decision=denied reason=exec_error`,
          e,
        )
        throw e
      }
    },

    /** 打开/切到目标应用（用户可见动作；激活失败 fail-visible，不假装成功） */
    async open(appId: string): Promise<void> {
      const infos = await listPlugins()
      assertCallerAuthorized(infos)
      const ok = await openApp(appId)
      if (!ok) {
        logger.warn(
          `[AppControl] audit caller=${callerAppId} target=${appId} command=open risk=ui decision=denied reason=${APP_OPEN_FAILED}`,
        )
        throw new AppControlError(
          APP_OPEN_FAILED,
          `打开应用失败: ${appId}（未安装 / 已停用 / 激活被拒）`,
        )
      }
      logger.log(
        `[AppControl] audit caller=${callerAppId} target=${appId} command=open risk=ui decision=allowed`,
      )
    },
  }
}
