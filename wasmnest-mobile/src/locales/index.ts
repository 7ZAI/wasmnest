/**
 * i18n 实例
 *
 * vue-i18n@9 Composition API 模式，支持 zh-CN（默认）和 en。
 *
 * **只装宿主壳 / 机制文案**（shell.* / settings.* / common.* / mobile 域下
 * 宿主引擎与插件管理文案）。应用可见文案由各 wasm app 自持并经
 * `context.i18n.registerMessages` 注册（2026-10-27 迁移：bedcode / ai-chatbox
 * 应用文案已全部搬回各自应用仓）。
 */
import { createI18n } from 'vue-i18n'
import zhCNCommon from './zh-CN/common'
import zhCNMobile from './zh-CN/mobile'
import zhCNSettings from './zh-CN/settings'
import zhCNShell from './zh-CN/shell'
import enCommon from './en/common'
import enMobile from './en/mobile'
import enSettings from './en/settings'
import enShell from './en/shell'

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': {
      ...zhCNCommon,
      ...zhCNMobile,
      ...zhCNSettings,
      ...zhCNShell,
    },
    en: {
      ...enCommon,
      ...enMobile,
      ...enSettings,
      ...enShell,
    },
  },
})

export default i18n
