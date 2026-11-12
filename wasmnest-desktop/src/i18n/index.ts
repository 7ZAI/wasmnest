/**
 * 宿主前端 i18n 实例（新 UI 宿主 = 方案 C 壳恢复后的宿主消息集）
 *
 * 桌面 UI 宿主修正（2026-10-17 用户裁决，ADR 0055 下沉做法撤销）：壳回到宿主
 * `wasmnest-desktop/src/`。宿主机制文案（host-zh-CN / host-en）只属于宿主面：
 * 全局错误信封 errors.*、通用 common.*、设置页平台分组 settings.*、工作台/
 * 服务器/启动画面/退出确认/授权弹窗 desktop.*、壳 shell.*。
 *
 * app 域消息（session.* / pairing.* / task.* 等）由各 wasm app 独立打包
 * （app 前端是独立构建的挂载包，不再与宿主共享同一消息集——见 useAppMount）。
 */
import { createI18n } from 'vue-i18n'
import hostZhCN from './host-zh-CN'
import hostEn from './host-en'

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': hostZhCN,
    en: hostEn,
  },
})

export default i18n
