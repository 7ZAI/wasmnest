/**
 * 桌面壳扩展点契约
 *
 * 归属：宿主允许的「通用注册表与寻址」薄壳（docs/architecture.md §1.3 ③）。
 * 这里只定义「可被挂在壳上的通用形状」——状态栏项 / 设置项 / 主题皮肤，
 * 不携带任何产品词汇，也不替扩展决定业务默认值。
 *
 * 桌面应用是独立构建的挂载包（机制 B），当前没有跨包 UI 贡献通道；本契约先
 * 服务壳内模块与宿主装配，未来接入应用贡献时只需在装载环境里转发注册调用，
 * 壳内 UI 无需改动。
 */
import type { Component } from 'vue'

/** 可释放句柄：注册扩展点的返回值，dispose 即摘除该注册 */
export interface ShellExtensionHandle {
  dispose(): void
}

/** 状态栏左右分区（缺省 start） */
export type ShellStatusBarAlign = 'start' | 'end'

/**
 * 状态栏项
 *
 * 二选一：
 * - 文本项：`label`（可带 `icon` / `onSelect`），由壳渲染成状态栏按钮或静态文本；
 * - 自定义项：`component`，由扩展自绘内容（壳只提供容器与排序）。
 */
export interface ShellStatusBarItem {
  id: string
  /** 文本项文案；与 component 二选一 */
  label?: string
  /** ShellIcon 图标名；仅文本项使用 */
  icon?: string
  /** 自定义内容；提供后忽略 label / icon / onSelect */
  component?: Component
  /** 排序权重，小者靠前；缺省 100 */
  order?: number
  /** 左右分区；缺省 start */
  align?: ShellStatusBarAlign
  /** 点击动作；缺省渲染为静态文本（不造点了没反应的按钮） */
  onSelect?: () => void | Promise<void>
}

/**
 * 设置页扩展项
 *
 * 壳统一渲染成设置行（标题 + 可选摘要 + 可选动作）；扩展只提供描述，
 * 不重复实现卡片边框、分组间距与焦点样式。
 */
export interface ShellSettingsEntry {
  id: string
  label: string
  /** 右侧摘要文案（当前值 / 状态说明） */
  hint?: string
  /** ShellIcon 图标名；缺省用通用齿轮 */
  icon?: string
  /** 排序权重，小者靠前；缺省 100 */
  order?: number
  /**
   * 点击动作；缺省渲染为静态行。
   * 有动作 = 按钮，无动作 = 纯文本行，不造点了没反应的死行。
   */
  onSelect?: () => void | Promise<void>
}

/**
 * 主题皮肤
 *
 * 皮肤只提供 CSS 自定义属性覆盖，作用在壳根（`.shell-root`）——平台外壳跟随
 * 皮肤，应用仍可自持配色（应用根容器自己声明的变量优先）。壳不解释颜色语义，
 * 只做「token 表 → 根样式」的机械应用。
 */
export interface ShellThemeSkin {
  id: string
  label: string
  description?: string
  /** 排序权重，小者靠前；缺省 100 */
  order?: number
  /** 浅色 / 共用 token（键必须是 -- 开头的 CSS 自定义属性） */
  tokens?: Record<string, string>
  /** 深色主题下覆盖的 token（与 tokens 合并，后者优先） */
  darkTokens?: Record<string, string>
}
