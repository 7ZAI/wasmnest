/**
 * 声明契约校验：`contributes.assistantTools` / `contributes.globalEntries`
 * -----------------------------------------------------------------------------
 * 票 01 / spec §4.2、§4.3：应用声明「可被系统助手调用的命令」与「壳全局入口」。
 *
 * 非法条目会让调用桥「列得出来、调不通」或绕过白名单，故一律判死。
 * 规则在本模块单点维护，两个入口共用：
 *   1. `wasmnest-plugin build` / `dev`（build.js，`manifest-gen` 自动填充之后）；
 *   2. `wasmnest-plugin validate`（scaffold.js）。
 *
 * 只校验 contributes 里的这两段；plugin.json 其余字段的校验仍归 `cmdValidate`。
 */

const RISK_LEVELS = ['read', 'ui', 'write', 'danger']
const OUTPUTS = ['text', 'json']

/** 命令 id 集合（assistantTools.command 必须已声明） */
function declaredCommandIds(contributes) {
  const commands = Array.isArray(contributes?.commands) ? contributes.commands : []
  return new Set(commands.map((c) => (c && typeof c === 'object' ? c.id : undefined)))
}

/**
 * 校验 contributes.assistantTools（通用应用调用桥的能力声明）
 *
 * @returns {string[]} 错误列表（空数组 = 通过）
 */
export function validateAssistantTools(contributes) {
  const errors = []
  const tools = contributes?.assistantTools
  if (tools === undefined || tools === null) return errors
  if (!Array.isArray(tools)) {
    errors.push('contributes.assistantTools 必须是数组')
    return errors
  }
  const commandIds = declaredCommandIds(contributes)
  const ids = new Set()
  for (const entry of tools) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`contributes.assistantTools 条目形态非法: ${JSON.stringify(entry)}`)
      continue
    }
    if (typeof entry.id !== 'string' || entry.id.trim() === '') {
      errors.push(`contributes.assistantTools 条目缺非空 id: ${JSON.stringify(entry)}`)
    } else if (ids.has(entry.id)) {
      errors.push(`contributes.assistantTools 重复 id: ${entry.id}`)
    } else {
      ids.add(entry.id)
    }
    if (typeof entry.title !== 'string' || entry.title.trim() === '') {
      errors.push(`contributes.assistantTools 条目缺非空 title: ${JSON.stringify(entry)}`)
    }
    if (typeof entry.description !== 'string' || entry.description.trim() === '') {
      errors.push(`contributes.assistantTools 条目缺非空 description: ${JSON.stringify(entry)}`)
    }
    if (typeof entry.command !== 'string' || entry.command.trim() === '') {
      errors.push(`contributes.assistantTools 条目缺非空 command: ${JSON.stringify(entry)}`)
    } else if (!commandIds.has(entry.command)) {
      errors.push(
        `contributes.assistantTools 条目 command 未在 contributes.commands 声明: ${entry.command}`,
      )
    }
    if (!entry.argsSchema || typeof entry.argsSchema !== 'object' || Array.isArray(entry.argsSchema)) {
      errors.push(`contributes.assistantTools 条目 argsSchema 必须是 object: ${JSON.stringify(entry)}`)
    }
    if (!RISK_LEVELS.includes(entry.risk)) {
      errors.push(
        `contributes.assistantTools 条目 risk 越界（须为 ${RISK_LEVELS.join(' | ')}）: ${JSON.stringify(entry)}`,
      )
    }
    if (entry.output !== undefined && !OUTPUTS.includes(entry.output)) {
      errors.push(
        `contributes.assistantTools 条目 output 越界（须为 ${OUTPUTS.join(' | ')}）: ${JSON.stringify(entry)}`,
      )
    }
  }
  return errors
}

/**
 * 校验 contributes.globalEntries（全局入口声明）
 *
 * 只登记 id / title / icon / order；入口是否渲染由壳按权限与启停状态决定。
 *
 * @returns {string[]} 错误列表（空数组 = 通过）
 */
export function validateGlobalEntries(contributes) {
  const errors = []
  const entries = contributes?.globalEntries
  if (entries === undefined || entries === null) return errors
  if (!Array.isArray(entries)) {
    errors.push('contributes.globalEntries 必须是数组')
    return errors
  }
  const ids = new Set()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`contributes.globalEntries 条目形态非法: ${JSON.stringify(entry)}`)
      continue
    }
    if (typeof entry.id !== 'string' || entry.id.trim() === '') {
      errors.push(`contributes.globalEntries 条目缺非空 id: ${JSON.stringify(entry)}`)
    } else if (ids.has(entry.id)) {
      errors.push(`contributes.globalEntries 重复 id: ${entry.id}`)
    } else {
      ids.add(entry.id)
    }
    if (typeof entry.title !== 'string' || entry.title.trim() === '') {
      errors.push(`contributes.globalEntries 条目缺非空 title: ${JSON.stringify(entry)}`)
    }
    if (entry.order !== undefined && !Number.isFinite(entry.order)) {
      errors.push(`contributes.globalEntries 条目 order 非法（须为数字）: ${JSON.stringify(entry)}`)
    }
  }
  return errors
}

/**
 * 两段一起校验（构建期 / validate 的统一入口）
 *
 * @param {object} manifest 已解析的 plugin.json
 * @returns {string[]} 错误列表（空数组 = 通过）
 */
export function validateContributions(manifest) {
  return [
    ...validateAssistantTools(manifest?.contributes),
    ...validateGlobalEntries(manifest?.contributes),
  ]
}
