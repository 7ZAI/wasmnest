import type { DefineComponent } from 'vue'

/** NumberField 组件 props */
export interface NumberFieldProps {
  /** 当前值；清空后以 null 回抛 */
  modelValue: number | null
  /** 下限（含） */
  min?: number
  /** 上限（含）；不传 = 不设上限 */
  max?: number
  /** 每次点击 / 方向键的变化量，默认 1 */
  step?: number
  /** sm：插件紧凑行（32px 高 / 12.5px 字 / 24px 步进列）；md：宿主表单默认（--input-height 36px / 28px 步进列） */
  size?: 'sm' | 'md'
  /** 文本对齐；设置页右侧控件用 right（默认），表单字段用 left */
  align?: 'left' | 'right'
  /** 宽度（CSS 长度）；不传则铺满父容器 */
  width?: string
  /** 等宽字体，默认 true（端口 / 秒数这类纯数字更整齐） */
  mono?: boolean
  disabled?: boolean
  readonly?: boolean
  /** 无障碍名称（没有外置 label 时必须给） */
  ariaLabel?: string
  /** 增 / 减按钮的无障碍名称，默认「增加」/「减少」 */
  labelIncrease?: string
  labelDecrease?: string
  testid?: string
}

/**
 * 数字输入（含右侧竖排步进按钮）共享组件
 *
 * 取代原生 `<input type="number">`：原生 spinner 的上下箭头只有 6px 左右，点不中、
 * 也不吃 token。本组件用 reka-ui 的 `Primitive` 原语下发元素（开源 headless），
 * 值、解析、钳制、提交时机全部在本组件内闭环，视觉绑定宿主 token。
 *
 * 用法：
 * ```vue
 * <NumberField v-model="ttl" :min="60" :max="3600" @commit="save" />
 * ```
 * - `update:modelValue`：合法键入 / 步进即时抛；清空为 null。
 * - `commit`：失焦或回车时抛，携带**已按 min/max 钳制**的最终值——落盘用它，
 *   不要在 `@blur` 里读事件值。
 * - 键位：↑/↓ 单步、PageUp/PageDown 十步、Home/End 到边界、Enter 提交。
 */
export declare const NumberField: DefineComponent<NumberFieldProps>

export default NumberField
