/**
 * 设置页静态分组表契约（宿主侧；桌面 UI 宿主修正 2026-10-17 改写）
 *
 * 桌面 UI 宿主修正后设置页拆分：宿主系统页（/sys/settings）承载平台分组
 * （外观 / 链路加密 / 系统 / 日志 / 授权 / 关于）；业务分组（配对 / 会话）
 * 随 bedcode app 独立界面走（app 工程 useSettingsSections 自持）。本测试钉：
 * - 宿主六个分组的 key 序列与 order 升序（外观 100 → 链路加密 300 → 系统 500
 *   → 日志 600 → 授权 700 → 关于 9999）；
 * - 宿主分组自带外壳与标题（titleKey 缺省）；
 * - 共享状态下传只给外观分组（语言 / 动画语义单源）。
 */

import { describe, it, expect } from 'vitest'
import {
  settingsSections,
  SECTION_ORDERS,
  useSettingsSections,
  type SettingsSharedState,
} from '@/composables/useSettingsSections'

const SHARED: SettingsSharedState = {
  languageOptions: [
    { value: 'zh-CN', label: '中文' },
    { value: 'en', label: 'English' },
  ],
  currentLanguage: 'zh-CN',
  animationsEnabled: true,
  onSwitchLanguage: () => {},
  onToggleAnimations: () => {},
}

describe('useSettingsSections（宿主静态表）', () => {
  it('六个平台分组按 order 升序，序列锁死', () => {
    const { sections } = useSettingsSections(() => SHARED)
    expect(sections.value.map((s) => s.key)).toEqual([
      'appearance',
      'linkCrypto',
      'system',
      'logging',
      'authorization',
      'about',
    ])
    expect(sections.value.map((s) => s.order)).toEqual([100, 300, 500, 600, 700, 9999])
  })

  it('槽位常量与表内 order 同值（改常量不改表 = 漂移）', () => {
    expect(SECTION_ORDERS).toEqual({
      appearance: 100,
      linkCrypto: 300,
      system: 500,
      logging: 600,
      authorization: 700,
      about: 9999,
    })
  })

  it('宿主分组自带外壳与标题（titleKey 缺省；业务分组不在宿主表内）', () => {
    for (const s of settingsSections) {
      expect(s.titleKey, `宿主分组 ${s.key} 不应带业务标题 key`).toBeUndefined()
    }
    expect(settingsSections.some((s) => s.key === 'pairing')).toBe(false)
    expect(settingsSections.some((s) => s.key === 'session')).toBe(false)
  })

  it('共享状态只下传给外观分组（语言 / 动画语义单源，其余分组 props 为空）', () => {
    const { sections } = useSettingsSections(() => SHARED)
    const appearance = sections.value.find((s) => s.key === 'appearance')!
    expect(appearance.props).toEqual({
      languageOptions: SHARED.languageOptions,
      currentLanguage: 'zh-CN',
      animationsEnabled: true,
      onSwitchLanguage: SHARED.onSwitchLanguage,
      onToggleAnimations: SHARED.onToggleAnimations,
    })
    for (const s of sections.value.filter((x) => x.key !== 'appearance')) {
      expect(s.props, `分组 ${s.key} 不应收共享状态`).toEqual({})
    }
  })
})
