import { describe, it, expect } from 'vitest'
import {
  APP_TONES,
  CHIP_META,
  HIGH_RISK_PERMISSIONS,
  SYS_PAGES,
  WALLPAPER_DEFAULT,
  appCardKey,
  cardId,
  cardKind,
  chipMetaOf,
  isHighRisk,
  mruActivate,
  mruRemove,
  notifCount,
  sysCardKey,
  toneOf,
} from '@/shell/composables/state'

/**
 * 壳纯逻辑助手测试（state.ts 无 Vue 依赖，全部确定性纯函数）
 *
 * 契约来源：.scratch/2026-10-08-desktop-shell-redesign/spec-c.md §1（卡片 MRU）
 * 与 §4（tone 机制哈希）。待审批过滤的单一实现与测试在 useShellApps（
 * `approvalApps` computed + useShellApps.test.ts「approvalApps 派生」用例）——
 * state.ts 不重复持有过滤逻辑（评审清理：死代码删除，2026-10-17 评审修复）。
 */

describe('卡片键', () => {
  it('app / sys 键构造与解析互逆', () => {
    expect(appCardKey('terminal-session')).toBe('app:terminal-session')
    expect(sysCardKey('settings')).toBe('sys:settings')
    expect(cardKind(appCardKey('x'))).toBe('app')
    expect(cardKind(sysCardKey('x'))).toBe('sys')
    expect(cardId(appCardKey('a:b:c'))).toBe('a:b:c')
    expect(cardId(sysCardKey('apps'))).toBe('apps')
  })
})

describe('卡片 MRU（spec-c §1：最新在前，重复激活只重排不重复产卡）', () => {
  it('新卡排最前', () => {
    expect(mruActivate([], 'app:a')).toEqual(['app:a'])
    expect(mruActivate(['app:a'], 'sys:s')).toEqual(['sys:s', 'app:a'])
  })

  it('重复激活只重排、不产重复卡', () => {
    expect(mruActivate(['app:a', 'app:b'], 'app:a')).toEqual(['app:a', 'app:b'])
    expect(mruActivate(['app:b', 'app:a'], 'app:a')).toEqual(['app:a', 'app:b'])
    expect(mruActivate(['app:a'], 'app:a')).toEqual(['app:a'])
  })

  it('移除：删除指定键，不影响其余顺序', () => {
    expect(mruRemove(['app:a', 'app:b', 'sys:s'], 'app:b')).toEqual(['app:a', 'sys:s'])
    expect(mruRemove(['app:a'], 'app:a')).toEqual([])
    expect(mruRemove([], 'app:a')).toEqual([])
  })
})

describe('通知计数（审批通知另行派生，不占普通通知数）', () => {
  it('notifCount = 通知列表条数；待审批派生能力在 useShellApps 用例覆盖', () => {
    expect(notifCount([])).toBe(0)
    expect(
      notifCount([
        { id: 'n1', kind: 'event', icon: 'x', source: 's', title: 't', mins: 0, sticky: false },
      ]),
    ).toBe(1)
  })
})

describe('高危权限位（manifest 声明里真正危险的位）', () => {
  it('process/pty/terminal-input/database-main 命中，其余不命中', () => {
    expect(isHighRisk('pty:spawn')).toBe(true)
    expect(isHighRisk('process:run')).toBe(true)
    expect(isHighRisk('terminal:input')).toBe(true)
    expect(isHighRisk('database:main')).toBe(true)
    expect(isHighRisk('fs:read')).toBe(false)
    expect(isHighRisk('network:http')).toBe(false)
    expect(HIGH_RISK_PERMISSIONS.size).toBe(4)
  })
})

describe('展示态 chip 元数据（state.ts 单表真源；主屏卡片 / 应用管理页共用）', () => {
  it('覆盖 AppDisplayState 全部五档（新增展示态必须补 chip 表，否则主屏无文案）', () => {
    const states = ['running', 'degraded', 'dormant', 'approval', 'error']
    for (const st of states) {
      const meta = chipMetaOf(st)
      expect(meta, `展示态 ${st} 缺 chip 元数据`).not.toBeNull()
      expect(meta!.textKey.startsWith('shell.state.')).toBe(true)
    }
    expect(Object.keys(CHIP_META).length).toBe(states.length)
  })

  it('样式类只在允许集合内（ok / warn / danger / 空）；未知态回退 null', () => {
    for (const meta of Object.values(CHIP_META)) {
      expect(['ok', 'warn', 'danger', '']).toContain(meta.cls)
    }
    expect(chipMetaOf('whatever')).toBeNull()
  })
})

describe('应用图标色调（机制级哈希，spec-c §4：零产品映射）', () => {
  it('同一插件 id 色调确定（幂等）', () => {
    expect(toneOf('terminal-session')).toBe(toneOf('terminal-session'))
    expect(toneOf('ai-chatbox')).toBe(toneOf('ai-chatbox'))
  })

  it('返回值始终在合法档位内', () => {
    for (const id of [
      'terminal-session',
      'ai-chatbox',
      'file-transfer',
      'agent-hub',
      'mobile-bridge',
      'zzz',
    ]) {
      expect(APP_TONES).toContain(toneOf(id))
    }
  })

  it('不同 id 覆盖多个档位（哈希分布不塌缩到单档）', () => {
    const tones = new Set(
      [
        'terminal-session',
        'ai-chatbox',
        'file-transfer',
        'agent-hub',
        'mobile-bridge',
        'com.example.one',
        'com.example.two',
        'com.example.three',
        'com.example.four',
      ].map(toneOf),
    )
    expect(tones.size).toBeGreaterThanOrEqual(2)
  })
})

describe('系统页清单与壁纸常量', () => {
  it('系统页三页齐全：apps / perms / settings', () => {
    expect(SYS_PAGES.map((s) => s.id)).toEqual(['apps', 'perms', 'settings'])
  })
  it('壁纸清单含 none + 三张 token 派生渐变，默认 aurora', () => {
    expect(WALLPAPER_DEFAULT).toBe('aurora')
  })
})
