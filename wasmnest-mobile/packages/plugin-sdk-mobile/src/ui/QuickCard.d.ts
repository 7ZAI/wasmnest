import type { DefineComponent } from 'vue'

/** 卡片状态点语义（neutral 不显示） */
export type QuickCardTone = 'neutral' | 'success' | 'warning' | 'danger'

/** QuickCard 组件 props */
export interface QuickCardProps {
  /** 顶部标签（如「活跃会话」）；留空则只显示主体 */
  label?: string
  /** 主体数值 / 主文案（等宽数字排版） */
  value?: string | number
  /** 数值下方的一行状态说明（零值提示、补充信息等） */
  hint?: string
  /** 右上角装饰图标：24×24 视框的 SVG path d，可多条 */
  iconPath?: string | string[]
  /** 状态点语义：neutral 不显示；其余取对应语义色 */
  tone?: QuickCardTone
}

/**
 * 移动端公共快捷卡片（宿主壳首页）
 *
 * 用法（应用 activate 期注册，宿主壳首页渲染并负责点击跳转）：
 * ```vue
 * <QuickCard label="活跃会话" :value="count" :hint="count ? '正在运行' : '暂无会话'" />
 * ```
 * - 卡片内容由应用自持；宿主管布局、滚动与点击打开本应用，应用不处理导航
 * - 卡片内不得再放按钮 / 链接（整卡已是宿主按钮，嵌套交互会互相抢点击）
 * - 外观由 --mobile-* / --shell-radius-* token 驱动，跟随宿主主题与字号偏好
 */
export declare const QuickCard: DefineComponent<QuickCardProps>

export default QuickCard