/**
 * 设置页分组（静态表，D4：设置页合并，无贡献注册面）
 *
 * 桌面宿主前端整体下沉后，设置分组是 app 内的单一事实源：宿主内置六分组
 * （外观 / 链路加密 / 系统 / 日志 / 授权入口 / 关于）与本 app 的两个业务分组
 * （配对设置 / 会话设置，原经设置分组贡献面注册）合并为一张静态表，
 * 按 order 升序渲染。
 *
 * 分组标题两种形态：宿主分组组件自带 `<section>` 外壳与标题（selfTitled）；
 * app 业务分组只渲染正文（旧扩展点约定：外壳与标题由宿主统一渲染），故本表
 * 为它们携带 titleKey，由设置页统一包外壳。
 */

import { computed, type ComputedRef } from 'vue'
import SettingsAppearanceSection from '@/shell/settings/SettingsAppearanceSection.vue'
import SettingsAuthorizationSection from '@/shell/settings/SettingsAuthorizationSection.vue'
import SettingsLinkCryptoSection from '@/shell/settings/SettingsLinkCryptoSection.vue'
import SettingsSystemSection from '@/shell/settings/SettingsSystemSection.vue'
import SettingsLoggingSection from '@/shell/settings/SettingsLoggingSection.vue'
import SettingsAboutSection from '@/shell/settings/SettingsAboutSection.vue'

/** 设置分组排序槽位（桌面 UI 宿主修正后：宿主六分组；业务分组随 app 走） */
export const SECTION_ORDERS = {
  appearance: 100,
  linkCrypto: 300,
  system: 500,
  logging: 600,
  authorization: 700,
  about: 9999,
} as const

/** 设置页下传的共享状态（语言 / 动画），外观分组按需消费，不得自行推导 */
export interface SettingsSharedState {
  /** 语言选项列表 */
  languageOptions: { value: string; label: string }[]
  /** 当前语言 */
  currentLanguage: string
  /** 全局动画总开关 */
  animationsEnabled: boolean
  /** 切换语言（含淡出过渡编排） */
  onSwitchLanguage: (value: string) => void
  /** 切换动画开关 */
  onToggleAnimations: () => void
}

/** 统一设置分组条目（静态表的单一形状） */
export interface SettingsSectionEntry {
  /** 唯一 key（渲染 :key） */
  key: string
  /** 排序值，升序排列 */
  order: number
  /** 渲染组件 */
  component: any
  /** 传给组件的 props */
  props: Record<string, unknown>
  /**
   * 分组标题 i18n key（完整 key）；缺省 = 组件自带 `<section>` 外壳与标题，
   * 设置页直接渲染；非空 = 仅正文组件，设置页统一包外壳 + 标题
   */
  titleKey?: string
}

/**
 * 设置分组静态表（单一事实源：宿主六分组——外观 / 链路加密 / 系统 / 日志 / 授权 /
 * 关于；业务分组（配对 / 会话）随 bedcode app 独立界面走——桌面 UI 宿主修正
 * 2026-10-17，设置页平台面归系统页，业务设置归 app）。
 */
export const settingsSections: Omit<SettingsSectionEntry, 'props'>[] = [
  {
    key: 'appearance',
    order: SECTION_ORDERS.appearance,
    component: SettingsAppearanceSection,
  },
  {
    key: 'linkCrypto',
    order: SECTION_ORDERS.linkCrypto,
    component: SettingsLinkCryptoSection,
  },
  {
    key: 'system',
    order: SECTION_ORDERS.system,
    component: SettingsSystemSection,
  },
  {
    key: 'logging',
    order: SECTION_ORDERS.logging,
    component: SettingsLoggingSection,
  },
  {
    key: 'authorization',
    order: SECTION_ORDERS.authorization,
    component: SettingsAuthorizationSection,
  },
  {
    key: 'about',
    order: SECTION_ORDERS.about,
    component: SettingsAboutSection,
  },
]

/**
 * 设置分组组合子（静态表按 order 升序稳定排列）
 *
 * @param getShared 共享状态取值器：在 computed 内调用，从而把语言/动画的
 *   响应式依赖挂到本 computed 上（传值而非取值器会丢失依赖）
 */
export function useSettingsSections(
  getShared: () => SettingsSharedState,
): { sections: ComputedRef<SettingsSectionEntry[]> } {
  const sections = computed<SettingsSectionEntry[]>(() => {
    const shared = getShared()
    return [...settingsSections]
      .sort((a, b) => a.order - b.order)
      .map((entry) => ({
        ...entry,
        props:
          entry.key === 'appearance'
            ? {
                languageOptions: shared.languageOptions,
                currentLanguage: shared.currentLanguage,
                animationsEnabled: shared.animationsEnabled,
                onSwitchLanguage: shared.onSwitchLanguage,
                onToggleAnimations: shared.onToggleAnimations,
              }
            : {},
      }))
  })

  return { sections }
}
