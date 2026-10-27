/**
 * 桌面壳快捷键纯模型（无 Vue 依赖，可直接单元测试）
 *
 * 职责边界（AGENTS §2 宿主薄壳）：动作全集是宿主自有壳功能（切应用 / 多任务 /
 * 主屏 / 系统页 / 明暗模式 / 字号），不携带 wasm 应用产品语义；组合键按 `e.code`
 * 规范化（物理键位，不随大小写 / 符号层漂移），规范化串同时是**存储格式**与
 * **比较格式**——录制动效只发生在这里，匹配侧不需要第二个解析器。
 *
 * 抢占契约（ADR 0060）：宿主在 window capture 阶段先收「已注册组合」，命中即
 * preventDefault + stopPropagation；未命中按键完全放行（应用照常收到）。用户
 * 清空某动作绑定（''）= 该组合归还应用。IME 合成期 / 启动画期间整体让位（装配
 * 层守卫，见 useShellShortcuts）。
 */
import type { CardKey } from '../types'
import { cardKind } from './state'

/** 快捷键动作 id（闭合集合；持久化以 id 为键，新增动作只改这张表） */
export const SHORTCUT_ACTIONS = [
  {
    id: 'app.next',
    nameKey: 'shell.shortcuts.action.appNext.name',
    descKey: 'shell.shortcuts.action.appNext.desc',
    defaultBinding: 'Ctrl+Tab',
  },
  {
    id: 'app.prev',
    nameKey: 'shell.shortcuts.action.appPrev.name',
    descKey: 'shell.shortcuts.action.appPrev.desc',
    defaultBinding: 'Ctrl+Shift+Tab',
  },
  {
    id: 'multitask.toggle',
    nameKey: 'shell.shortcuts.action.multitask.name',
    descKey: 'shell.shortcuts.action.multitask.desc',
    defaultBinding: 'Ctrl+Shift+O',
  },
  {
    id: 'home',
    nameKey: 'shell.shortcuts.action.home.name',
    descKey: 'shell.shortcuts.action.home.desc',
    defaultBinding: 'Ctrl+Shift+H',
  },
  {
    id: 'settings.open',
    nameKey: 'shell.shortcuts.action.settings.name',
    descKey: 'shell.shortcuts.action.settings.desc',
    defaultBinding: 'Ctrl+,',
  },
  {
    id: 'apps.manage',
    nameKey: 'shell.shortcuts.action.appsManage.name',
    descKey: 'shell.shortcuts.action.appsManage.desc',
    defaultBinding: 'Ctrl+Shift+M',
  },
  {
    id: 'theme.toggle',
    nameKey: 'shell.shortcuts.action.theme.name',
    descKey: 'shell.shortcuts.action.theme.desc',
    defaultBinding: 'Ctrl+Shift+D',
  },
  {
    id: 'font.increase',
    nameKey: 'shell.shortcuts.action.fontUp.name',
    descKey: 'shell.shortcuts.action.fontUp.desc',
    defaultBinding: 'Ctrl+Shift+=',
  },
  {
    id: 'font.decrease',
    nameKey: 'shell.shortcuts.action.fontDown.name',
    descKey: 'shell.shortcuts.action.fontDown.desc',
    defaultBinding: 'Ctrl+Shift+-',
  },
] as const

export type ShortcutActionId = (typeof SHORTCUT_ACTIONS)[number]['id']

/** 出厂键位（Ctrl 系；全部避开 Linux 桌面 OS 全局键，如 Alt+Tab） */
export const DEFAULT_BINDINGS = Object.fromEntries(
  SHORTCUT_ACTIONS.map((a) => [a.id, a.defaultBinding]),
) as Record<ShortcutActionId, string>

/** 动作 id 白名单（localStorage 读取侧丢弃未知 id，不扩散） */
export const SHORTCUT_ACTION_IDS: ReadonlySet<string> = new Set(
  SHORTCUT_ACTIONS.map((a) => a.id),
)

// ==================== 组合键规范化 ====================

/** 修饰键规范序（存储 / 比较统一按此序拼串；乱序 = 不合规范） */
const MODIFIER_TOKENS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

/** 修饰键物理码（按下修饰键本身不构成组合，返回 null） */
const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'AltGraph',
  'CapsLock',
])

/** 非字母 / 数字主键的 code → 展示名映射（字母 KeyA→A、数字 Digit0→0、F 键原样直取） */
const PRIMARY_BY_CODE: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
}

const F_KEY_RE = /^F([1-9]|1[0-9]|2[0-4])$/

function primaryOf(code: string): string | null {
  if (MODIFIER_CODES.has(code)) return null
  if (PRIMARY_BY_CODE[code]) return PRIMARY_BY_CODE[code]
  if (F_KEY_RE.test(code)) return code
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  // 小键盘 / IME / Intl 等未收录码不参与绑定（绑定面收敛，避免布局歧义）
  return null
}

/** 合法主键全集（comboIsWellFormed 校验用） */
const VALID_PRIMARIES: ReadonlySet<string> = new Set([
  ...Object.values(PRIMARY_BY_CODE),
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(i)),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
])

/**
 * 键事件 → 规范化组合串（如 `Ctrl+Shift+D` / `Ctrl+,`）；纯修饰键或未收录码返回 null。
 * 注意：本函数不做策略校验（是否含 Ctrl/Alt 是 validateBinding 的事），只做规范化。
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const primary = primaryOf(e.code)
  if (!primary) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  parts.push(primary)
  return parts.join('+')
}

/** 结构合法性：修饰键白名单内、规范序、无重复、主键合法（策略与否不在此查） */
export function comboIsWellFormed(combo: string): boolean {
  const tokens = combo.split('+')
  if (tokens.length < 2) return false
  let prevIdx = -1
  for (const tok of tokens.slice(0, -1)) {
    const idx = MODIFIER_TOKENS.indexOf(tok as (typeof MODIFIER_TOKENS)[number])
    if (idx <= prevIdx) return false
    prevIdx = idx
  }
  return VALID_PRIMARIES.has(tokens[tokens.length - 1])
}

/** 可绑定 = 结构合法且含 Ctrl 或 Alt（规范序保证 startsWith 判定可靠）。
 *  读档侧用它做 fail-safe：违反策略的存量值一律丢弃回落默认，绝不让「裸主键」
 *  有机会在打字时触发动作。 */
export function comboIsBindable(combo: string): boolean {
  return comboIsWellFormed(combo) && (combo.startsWith('Ctrl+') || combo.startsWith('Alt+'))
}

// ==================== 绑定合并与校验 ====================

/** 生效绑定：默认表 + sparse 覆盖（'' = 显式清除；未知 id 忽略） */
export function effectiveBindings(
  overrides: Partial<Record<string, string>> | undefined,
): Record<ShortcutActionId, string> {
  const out = { ...DEFAULT_BINDINGS }
  if (overrides) {
    for (const id of Object.keys(DEFAULT_BINDINGS) as ShortcutActionId[]) {
      const v = overrides[id]
      if (typeof v === 'string') out[id] = v
    }
  }
  return out
}

/** 绑定裁决（标准策略，2026-10-28 用户裁决）：可保存性 + 两类行内提示 */
export interface BindingVerdict {
  /** 可保存（含带保留键警示的可保存） */
  ok: boolean
  /** 缺 Ctrl/Alt 修饰键（不可保存） */
  missingModifier?: boolean
  /** 与其他动作冲突（不可保存；值为对方动作 id） */
  conflict?: ShortcutActionId
  /** Webview / 系统常见保留键（可保存但警示：部分环境可能截获，不保证生效） */
  reserved?: boolean
}

/** 系统桌面 / Webview 常见保留键（允许保存但警示；规范序串） */
const RESERVED_COMBOS: ReadonlySet<string> = new Set([
  'Ctrl+W',
  'Ctrl+T',
  'Ctrl+N',
  'Ctrl+Q',
  'Ctrl+Shift+W',
  'Ctrl+Shift+T',
  'Ctrl+Shift+N',
  'F5',
  'F11',
  'F12',
  'Alt+F4',
])

export function validateBinding(
  combo: string,
  bindings: Readonly<Record<ShortcutActionId, string>>,
  self: ShortcutActionId,
): BindingVerdict {
  if (!comboIsBindable(combo)) return { ok: false, missingModifier: true }
  const conflict = (Object.keys(bindings) as ShortcutActionId[]).find(
    (id) => id !== self && bindings[id] !== '' && bindings[id] === combo,
  )
  if (conflict) return { ok: false, conflict }
  return { ok: true, reserved: RESERVED_COMBOS.has(combo) || undefined }
}

// ==================== 应用卡轮换（切换后台应用） ====================

/**
 * MRU 顺序轮换 app:* 卡（系统页卡不参与「切换应用」；<2 张应用卡无可切换）。
 * 当前不在任何应用卡上（主屏 / 系统页）时：向后取 MRU 第一张、向前取最后一张。
 */
export function cycleAppCards(
  cards: readonly CardKey[],
  activeKey: CardKey | null,
  dir: 1 | -1,
): CardKey | null {
  const appCards = cards.filter((k) => cardKind(k) === 'app')
  if (appCards.length < 2) return null
  const idx = activeKey ? appCards.indexOf(activeKey) : -1
  if (idx === -1) return dir === 1 ? appCards[0] : appCards[appCards.length - 1]
  return appCards[(idx + dir + appCards.length) % appCards.length]
}
