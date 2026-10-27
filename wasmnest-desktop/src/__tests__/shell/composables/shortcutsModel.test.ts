/**
 * 快捷键纯模型测试（无 Vue 依赖，直测 shortcutsModel）
 *
 * 决策逻辑全在纯函数（useFontSize 范式）：组合键规范化 / 结构与策略校验 /
 * 默认表自洽 / 绑定合并 / 应用卡轮换。装配层（capture 监听）的行为测试见
 * useShellShortcuts.test.ts（dispatch KeyboardEvent 驱动）。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BINDINGS,
  SHORTCUT_ACTIONS,
  SHORTCUT_ACTION_IDS,
  comboFromEvent,
  comboIsBindable,
  comboIsWellFormed,
  cycleAppCards,
  effectiveBindings,
  validateBinding,
  type ShortcutActionId,
} from '@/shell/composables/shortcutsModel'

function ev(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

describe('comboFromEvent（e.code 规范化）', () => {
  it('修饰键按 Ctrl+Alt+Shift+Meta 固定序拼串，与按下顺序无关', () => {
    expect(comboFromEvent(ev({ code: 'KeyD', ctrlKey: true, shiftKey: true }))).toBe(
      'Ctrl+Shift+D',
    )
    expect(comboFromEvent(ev({ code: 'KeyD', shiftKey: true, ctrlKey: true }))).toBe(
      'Ctrl+Shift+D',
    )
    expect(comboFromEvent(ev({ code: 'KeyD', metaKey: true, ctrlKey: true }))).toBe('Ctrl+Meta+D')
  })

  it('符号 / 功能 / 导航键落在映射表（Ctrl+, / Ctrl+Shift+= / Ctrl+Tab）', () => {
    expect(comboFromEvent(ev({ code: 'Comma', ctrlKey: true }))).toBe('Ctrl+,')
    expect(comboFromEvent(ev({ code: 'Equal', ctrlKey: true, shiftKey: true }))).toBe(
      'Ctrl+Shift+=',
    )
    expect(comboFromEvent(ev({ code: 'Minus', ctrlKey: true, shiftKey: true }))).toBe(
      'Ctrl+Shift+-',
    )
    expect(comboFromEvent(ev({ code: 'Tab', ctrlKey: true }))).toBe('Ctrl+Tab')
    expect(comboFromEvent(ev({ code: 'F5' }))).toBe('F5')
    expect(comboFromEvent(ev({ code: 'ArrowLeft', altKey: true }))).toBe('Alt+Left')
  })

  it('字母取物理键位（不随符号层漂移），数字取 Digit', () => {
    expect(comboFromEvent(ev({ code: 'KeyA', altKey: true }))).toBe('Alt+A')
    expect(comboFromEvent(ev({ code: 'Digit1', ctrlKey: true }))).toBe('Ctrl+1')
  })

  it('纯修饰键 / 未收录码返回 null（不构成组合）', () => {
    expect(comboFromEvent(ev({ code: 'ControlLeft', ctrlKey: true }))).toBeNull()
    expect(comboFromEvent(ev({ code: 'ShiftLeft' }))).toBeNull()
    expect(comboFromEvent(ev({ code: 'CapsLock' }))).toBeNull()
    expect(comboFromEvent(ev({ code: 'Numpad1', ctrlKey: true }))).toBeNull()
    expect(comboFromEvent(ev({ code: 'IntlBackslash' }))).toBeNull()
  })
})

describe('comboIsWellFormed / comboIsBindable', () => {
  it('结构合法：白名单修饰键 + 规范序 + 合法主键', () => {
    expect(comboIsWellFormed('Ctrl+Shift+D')).toBe(true)
    expect(comboIsWellFormed('Ctrl+,')).toBe(true)
    expect(comboIsWellFormed('Shift+Meta+D')).toBe(true)
    // 乱序 / 重复 / 缺主键 / 缺修饰键 / 未知主键
    expect(comboIsWellFormed('Shift+Ctrl+D')).toBe(false)
    expect(comboIsWellFormed('Ctrl+Ctrl+D')).toBe(false)
    expect(comboIsWellFormed('Ctrl')).toBe(false)
    expect(comboIsWellFormed('D')).toBe(false)
    expect(comboIsWellFormed('Ctrl+Numpad1')).toBe(false)
    expect(comboIsWellFormed('Ctrl++')).toBe(false)
  })

  it('可绑定 = 结构合法且含 Ctrl 或 Alt（Meta/Shift 独占不算）', () => {
    expect(comboIsBindable('Ctrl+Shift+D')).toBe(true)
    expect(comboIsBindable('Alt+H')).toBe(true)
    expect(comboIsBindable('Shift+D')).toBe(false)
    expect(comboIsBindable('Meta+D')).toBe(false)
    expect(comboIsBindable('F5')).toBe(false)
    // 结构非法的一律不可绑定（含「裸主键」，读档 fail-safe 依赖它）
    expect(comboIsBindable('Ctrl+Bad Key')).toBe(false)
  })
})

describe('validateBinding（标准策略三查）', () => {
  const bindings: Record<ShortcutActionId, string> = {
    ...DEFAULT_BINDINGS,
    'settings.open': 'Ctrl+D',
  }

  it('缺 Ctrl/Alt 修饰键：不可保存', () => {
    expect(validateBinding('Shift+K', bindings, 'home')).toEqual({ ok: false, missingModifier: true })
    expect(validateBinding('F5', bindings, 'home')).toEqual({ ok: false, missingModifier: true })
  })

  it('动作间重复：不可保存并指出对方动作（fail-visible）', () => {
    expect(validateBinding('Ctrl+D', bindings, 'app.next')).toEqual({
      ok: false,
      conflict: 'settings.open',
    })
    // 与自己同键不叫冲突（录制中未改动时的幂等提交）
    expect(validateBinding('Ctrl+D', bindings, 'settings.open').ok).toBe(true)
  })

  it('保留键：可保存但警示', () => {
    expect(validateBinding('Ctrl+W', bindings, 'app.next')).toEqual({ ok: true, reserved: true })
    expect(validateBinding('Alt+F4', bindings, 'app.next')).toEqual({ ok: true, reserved: true })
    expect(validateBinding('Ctrl+J', bindings, 'app.next')).toEqual({ ok: true, reserved: undefined })
  })
})

describe('默认表自洽（出厂键位必须全部通过标准策略）', () => {
  it('九个动作齐全、键位互不重复', () => {
    expect(SHORTCUT_ACTIONS).toHaveLength(9)
    expect(new Set(SHORTCUT_ACTIONS.map((a) => a.id)).size).toBe(9)
    expect(new Set(Object.values(DEFAULT_BINDINGS)).size).toBe(9)
    for (const id of SHORTCUT_ACTIONS.map((a) => a.id)) {
      expect(SHORTCUT_ACTION_IDS.has(id)).toBe(true)
    }
  })

  it('每个默认键位：合法、含修饰键、不踩保留键、与其它动作不冲突', () => {
    for (const a of SHORTCUT_ACTIONS) {
      const verdict = validateBinding(a.defaultBinding, DEFAULT_BINDINGS, a.id)
      expect(verdict, `${a.id} = ${a.defaultBinding}`).toEqual({ ok: true })
    }
  })
})

describe('effectiveBindings（sparse 覆盖合并）', () => {
  it('无覆盖 = 全默认；覆盖生效；\'\' = 显式清除；未知 id 忽略', () => {
    expect(effectiveBindings(undefined)).toEqual(DEFAULT_BINDINGS)
    expect(effectiveBindings({})).toEqual(DEFAULT_BINDINGS)

    const merged = effectiveBindings({ home: 'Alt+H', 'theme.toggle': '', ghost: 'Ctrl+G' })
    expect(merged.home).toBe('Alt+H')
    expect(merged['theme.toggle']).toBe('')
    expect(merged['settings.open']).toBe(DEFAULT_BINDINGS['settings.open'])
    expect(Object.keys(merged)).toHaveLength(9)
  })
})

describe('cycleAppCards（仅 app 卡 MRU 轮换）', () => {
  const cards = ['app:hub', 'sys:settings', 'app:chat', 'app:monitor'] as const

  it('向后：当前卡的下一张（MRU 序，跳过系统页卡）', () => {
    expect(cycleAppCards([...cards], 'app:hub', 1)).toBe('app:chat')
    expect(cycleAppCards([...cards], 'app:chat', 1)).toBe('app:monitor')
  })

  it('环绕：最后一张向后回第一张，第一张向前到最后一张', () => {
    expect(cycleAppCards([...cards], 'app:monitor', 1)).toBe('app:hub')
    expect(cycleAppCards([...cards], 'app:hub', -1)).toBe('app:monitor')
  })

  it('当前不在应用卡上（主屏 / 系统页 / null）：向后取第一张、向前取最后一张', () => {
    expect(cycleAppCards([...cards], 'sys:settings', 1)).toBe('app:hub')
    expect(cycleAppCards([...cards], 'sys:settings', -1)).toBe('app:monitor')
    expect(cycleAppCards([...cards], null, 1)).toBe('app:hub')
    expect(cycleAppCards([...cards], null, -1)).toBe('app:monitor')
  })

  it('少于两张应用卡：无可切换（no-op）', () => {
    expect(cycleAppCards(['app:hub', 'sys:settings'], 'app:hub', 1)).toBeNull()
    expect(cycleAppCards([], null, 1)).toBeNull()
  })
})
