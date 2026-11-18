/**
 * 首页快捷卡片选择（纯函数）
 *
 * 钉住三件事：注册顺序摊平、展示上限截断、key 稳定（appId:slotId）。
 */
import { describe, it, expect } from 'vitest'
import { markRaw } from 'vue'
import { SHELL_SLOT_MAX_CARDS, selectSlotCards } from '@/shell/slotCards'
import type { ShellApp } from '@/shell/types'

const Card = markRaw({ template: '<div />' })

function appWithSlots(id: string, slotIds: string[]): ShellApp {
  return {
    id,
    name: id,
    version: '1.0.0',
    state: 'running',
    permissions: [],
    contributions: {
      slots: slotIds.map((slotId) => ({ id: slotId, component: Card })),
    },
  }
}

describe('快捷卡片选择', () => {
  it('should_flattenInRegistrationOrder_when_appsAndSlotsExist', () => {
    const cards = selectSlotCards([
      appWithSlots('a', ['s1', 's2']),
      appWithSlots('b', ['s1']),
    ])

    expect(cards.map((c) => c.key)).toEqual(['a:s1', 'a:s2', 'b:s1'])
    expect(cards.map((c) => c.app.id)).toEqual(['a', 'a', 'b'])
  })

  it('should_capToDisplayLimit_when_slotsExceedMax', () => {
    const cards = selectSlotCards([
      appWithSlots('a', ['s1', 's2', 's3']),
      appWithSlots('b', ['s1', 's2', 's3']),
      appWithSlots('c', ['s1', 's2']),
    ])

    expect(SHELL_SLOT_MAX_CARDS).toBe(5)
    expect(cards).toHaveLength(5)
    expect(cards.map((c) => c.key)).toEqual(['a:s1', 'a:s2', 'a:s3', 'b:s1', 'b:s2'])
  })

  it('should_returnEmpty_when_limitDisabled', () => {
    expect(selectSlotCards([appWithSlots('a', ['s1'])], 0)).toEqual([])
  })

  it('should_skipAppsWithoutSlots_when_flattening', () => {
    const cards = selectSlotCards([
      { ...appWithSlots('a', []), contributions: {} },
      appWithSlots('b', ['s1']),
    ])

    expect(cards.map((c) => c.key)).toEqual(['b:s1'])
  })
})