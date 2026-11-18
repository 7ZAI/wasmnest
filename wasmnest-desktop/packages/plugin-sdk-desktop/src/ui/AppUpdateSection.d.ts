import type { DefineComponent } from 'vue'
import type { AppUpdateCheckResult } from '../types'

/** 默认更新卡片文案（应用可覆盖任意字段；`{version}` 由组件替换） */
export interface AppUpdateLabels {
  title: string
  check: string
  checking: string
  upToDate: string
  available: string
  incompatible: string
  failed: string
  unsupported: string
  reasonNoCompat: string
  reasonMountContract: string
  reasonHostRuntime: string
  reasonHostRuntimeInvalid: string
}

/** AppUpdateSection 组件 props */
export interface AppUpdateSectionProps {
  /** 当前版本（可选；不传时用检查结果的 currentVersion） */
  currentVersion?: string
  /** 自定义检查器；缺省使用宿主 `PluginContext.appUpdate.check` */
  check?: () => Promise<AppUpdateCheckResult>
  /** 文案覆盖（缺省按系统语言内置中 / 英） */
  labels?: Partial<AppUpdateLabels>
  disabled?: boolean
}

/**
 * 应用更新检查卡片（SDK 默认实现）
 *
 * 用法（应用设置页直接嵌入）：
 * ```vue
 * <AppUpdateSection />
 * ```
 * - 数据面 = 宿主 `PluginContext.appUpdate.check`（GitHub Release 统一判定）
 * - 应用自实现更新检查时传 `check` 覆盖，或完全不用本组件
 * - 更新动作统一在宿主应用管理页执行（需停用应用 + 换目录 + 重新审批）
 */
export declare const AppUpdateSection: DefineComponent<AppUpdateSectionProps>

export default AppUpdateSection
