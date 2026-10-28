# ADR 0060：桌面壳快捷键的 capture 抢占契约

- 状态：已实施（2026-10-28，用户两轮裁决后落地）
- 影响面：`wasmnest-desktop/src/shell/**`（ShellHost / 快捷键模块 / 设置二级页）、
  i18n、键位存储（壳偏好 localStorage）

## 背景

桌面壳的键盘纪律一直是「应用态键盘归应用，壳不抢」：ShellHost 的全局 keydown
是 window 冒泡监听，应用态直接 return（仅覆层开着收 Esc）。用户要求快捷键在
「系统使用 WasmNest 时」**全局生效**——包括焦点在 wasm 应用内时——用于切换
后台应用、打开设置、快速切明暗等壳操作，同时避免与系统快捷键冲突。

这与旧口径正面相撞：沿用冒泡监听，焦点在应用内时壳永远收不到键（事件早被应用
消费）；不设边界地抢，应用（终端这类需要完整键面的场景）会被壳吃掉按键。

## 裁决

1. **纯应用内快捷键，不注册 OS 全局键。** 不引入 tauri-plugin-global-shortcut
   （capabilities 被 Rust 锁钉住，零新增权限面）；快捷键只在 WasmNest 窗口内
   生效——「系统使用 WasmNest 时」由 webview 聚焦天然保证，与 OS 快捷键零冲突面。
2. **capture 抢占 + 白名单放行。** 壳在 window capture 阶段监听 keydown：命中
   「已注册组合」才 preventDefault + stopPropagation；未注册按键完全放行，应用
   照常收到。应用想用某个组合 → 用户在设置里清空对应绑定（清空 = 组合归还应用），
   壳侧没有「永久占用」。
3. **组合按物理键位（`e.code`）规范化**，修饰键固定序 Ctrl+Alt+Shift+Meta；
   规范化串同时是存储格式与比较格式，匹配侧没有第二个解析器。组合必须含 Ctrl
   或 Alt（杜绝打字误触）；读档侧对不合规范的存量值 fail-safe 丢弃回落默认。
4. **录制期间整体让位。** 设置页录键时挂起 capture 监听（`suspendShortcutCapture`
   模块级单标记）——否则用户按下的新组合会先被抢占逻辑吞掉（命中已注册组合时
   还会误触发动作），录制框永远收不到事件。
5. **动作面闭合在宿主壳功能**：九个动作（下一个 / 上一个应用、多任务视图、
   回主屏、打开设置、打开应用管理、切换明暗、字号增 / 减），全部调用既有壳
   原语（`useShellState` / settings store / `useFontSize` 档位表）；不新增对
   产品事件的解释（薄壳六判据 B1–B6 不命中）。切换应用只轮换 `app:*` 卡
   （MRU 序，系统页卡不参与，<2 张 no-op）。
6. **存储走壳偏好轨。** `ShellUiPrefs.shortcuts` sparse 覆盖（只存用户改过的
   动作；`''` = 显式清除），与壁纸 / 主题预设同轨 localStorage；恢复初始设置
   （AppConfig 轨）不清快捷键，快捷键复位在子页内自含。
7. **让位例外不进注册表**：IME 合成期（isComposing / keyCode 229）、启动画面期、
   Esc 逐层收语义维持现状——它们是输入 / 导航机制，不是可改绑的用户配置。

## 后果

- ShellHost「应用态键盘归应用」注释口径更新为「已注册组合壳先收，其余归应用」；
  硬编码 Ctrl+, 分支退役（成为注册表默认绑定，行为不变且扩展到应用态）。
- 新文件：`shortcutsModel.ts`（纯模型，直测）/ `useShellShortcuts.ts`（capture
  装配 + 动作执行）/ `SysShortcutsView.vue`（配置二级页 `/sys/settings/shortcuts`，
  设置页第二张入口卡）。
- 保留键（Ctrl+W/T/N/Q 及 Shift 变体、F5/F11/F12、Alt+F4）允许绑定但行内警示：
  部分系统 Webview 可能截获、宿主无法保证送达——按用户裁决警示不禁止（fail-visible
  由用户取舍）。
- 已知边界：`e.code` 规范化锚定物理键位，非美式布局的键帽刻字与展示名可能不一致
  （布局无关匹配是有意为之）；应用若依赖与默认绑定相同的组合（如终端的
  Ctrl+Shift 组合），用户清空对应绑定即可归还。
- 移动端不同步：无常驻物理键盘场景，本特性仅桌面。
