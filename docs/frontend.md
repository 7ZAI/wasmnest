# 前端规范（宿主壳 / SDK UI / 挂载包前端面）

> **本文件是 `AGENTS.md` 的拆分文档（前端规范）**：零资源访问红线、三层封锁、移动宿主壳优先、挂载包 / 运行面前端形态、注释命名与 i18n、UI 设计强制前置技能。
> 本文件与 `AGENTS.md` 的硬约束（「必须 / 禁止」字样）**同级别**；静态锁真源 = 根 `eslint.config.js` + 各端 `src/__tests__/**` 锁测试 + 双端 `src-tauri/tests/capabilities_lock.rs`。

## 1. 零资源访问红线（前端只做 UI）

- 前端**禁止** `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `navigator.sendBeacon`，禁止 `window.open` / `location.href=` 等导航原语，禁止裸 `__TAURI__`，禁止 import `@tauri-apps/plugin-{http,fs,shell,updater,opener}`。
- 一切 HTTP / WS / 文件访问由 Rust 端发起并经权限仲裁：走 `invoke(...)` → 宿主命令 / `appInvoke(...)` → 插件命令面。允许 `convertFileSrc`（既定产物 / 图标加载路径）与 `invoke` / `listen`。
- **三层封锁**：① 源码 ESLint 静态锁（根 `eslint.config.js`）② Tauri ACL 运行期拒（ACL 未写即拒）③ CSP 引擎级封（`connect-src 'none'`；`index.html` 不得内联 `<style>` / `<script>`，nonce 会令 `'unsafe-inline'` 失效——锁在 `src-tauri/tests/capabilities_lock.rs`）。**ACL 与 CSP 两层无豁免机制**：要开就改锁并写清理由。
- 唯一豁免路径：ESLint 层逐行 `eslint-disable-next-line` 并注明理由（豁免随 code review 可见，不静默放行）。
- 错误处理：统一 `logger`（真源 `src/utils/frontendLogger.ts`，双端头注释写明 release 落盘差异——**桌面 release 侧 error/warn 仍转发落盘、移动 release 侧整体空实现，勿强行统一**）；禁止静默 `catch`；IPC 调用统一走 `src/utils/invoke.ts`（带超时，失败承载为 ADR 0030 错误信封）；用户可见文案一律走 i18n。
- 禁止用 viewport 宽度 / UA 字符串推断平台；平台判断统一走 Tauri API / `usePlatform`。

## 2. 挂载包 / 运行面前端形态（双端 app 前端纪律）

- 桌面 app 前端：`build.lib` 单文件 `index.js`、CSS inline、**无 externals**（宿主锁禁止 `__WASMNEST_SHARED__`）；各 app 自持 tailwind 配置，类名自编译（宿主 Tailwind 不再扫 app，`tailwindContentCoverage` 锁钉住）。
- 移动 app 前端：经 SDK `wasmnestPlugin()` 构建（共享 vue / vue-i18n / pinia 外置宿主全局 `__WASMNEST_SHARED__`，经 SDK 代理访问，插件不直接操作全局），入口 `src/index.ts` 导出 `activate(context)` / `deactivate()`；贡献面收拢为运行面 + 少量注册点，退役方法调用即显性报错（fail-visible）。
- **桌面 app 入口契约（`src/entry.ts`）**：导出 `mountApp(root, env): Promise<AppMountHandle>`；**可选**导出 `mountPreview(root, env): Promise<AppPreviewHandle>`（多任务卡片缩略区的应用自绘只读预览面；缺失 = 不支持预览，宿主回退品牌卡）。`hostAppBoundaryLock` 逐字校验 `mountApp` 契约，**L5** 校验 `mountPreview` 契约（五个内置桌面 app 必须导出；第三方面向契约仍可选）。预览环境是**收窄面**：仅 `appId` / `lastRoute` / `appInvoke` / `appStorageGet` / `locale` / `theme` / `platform`——无宿主 `invoke`、无写 / 删存储、无事件出口；应用侧禁止在预览路径调 `refreshChannelToken`（会作废主实例正在用的令牌），预览 DOM 不得含可聚焦控件、不得启后台轮询 / 全局监听、不得挂主 `App.vue` / 主 router / 主 pinia。入口不是 lib 形态的 `activate(context)`；`src/index.ts` 若存在只作 dev-shell 兼容出口。
- 双端 app 均**自足 i18n**；移动端样式经 `?inline` 注入（宿主不加载插件 CSS）。
- **表面保活（双端同一口径，2026-10-23；移动承载 2026-10-24 升级）**：应用只要没被停用，切走就只是「藏起来」——前端 DOM / 组件实例 / 滚动 / 表单 / 内存路由原样保留，**禁止**在切走路径上卸载实例（双端同为 `detach` 不 `dispose`）。停用 / 卸载才是唯一销毁点（桌面 `ShellHost` 运行态 disposer；移动 `useShellApps.stop` / `removeApp` 显式「先 dispose UI 再拆插件上下文」+ refresh 兜底对账）。移动承载 = 每应用一个**独立 Vue 应用**（`surfaceAppRegistry` 容器注册表 + `ShellAppSurface` 适配器 attach/detach + `ShellHost` 对账；壳卸载只 detach）。多实例解决的是应用上下文与错误边界（每实例独立 `errorHandler` 带 appId），**不是** CSS / DOM / window / IPC 隔离（同 webview 同信任域，ADR 0058）。后台**不渲染**（容器脱文档），不做后台动画 / 活体缩略图。前后台契约：桌面 `AppMountHandle.setActive?(active)`、移动运行面内 `inject(SURFACE_ACTIVE_KEY)`（注册表按 attach/detach 推动，应用可据此暂停后台轮询，不实现零影响）。spec：`.scratch/2026-10-24-mobile-app-surface-vue-instances/spec.md`。
- **服务型应用不进多任务（双端同一口径，2026-10-23）**：`isServiceKind`（`basic-service` / `internal-business`）的应用不产多任务卡——桌面服务面不入 `cards`（`enterServiceFace`）+ 右键菜单隐藏「停用」；移动 `ShellSwitcherScreen` 运行中与最近使用两个来源都过滤。关闭唯一入口 = 应用管理页（桌面）/ 应用详情页（移动）的「停用」。
- 壳标题栏常驻：所有 app 页面共用壳标题栏，应用只占其下区域（`appChromeLock` 钉住；应用不得自绘标题栏 / 窗口控制 / 拖拽区）。

## 3. 移动宿主壳优先（强制）

- 移动宿主前端的新功能 / 重构 / 样式调整，默认落 `wasmnest-mobile/src/shell/**`（`/mobile/shell`）；既有旧页面目录（`src/{components,views,composables,stores}`）只接受**缺陷修复**，直到被彻底替换。
- 壳内自足：壳不得 import 旧目录（L7 锁拦截）；壳内需要的组件 / 机制**复制进壳**再改造。
- **业务不落壳**：终端 / 文件 / 会话 / 设备 / AI 等业务页面归各 wasm 应用（`registerSurface` / `registerSlot`）；壳只提供挂载、生命周期与权限闸门。壳自持三类：运行面挂载与生命周期、平台机制与安全闸门、宿主公共组件。
- 迁移面不许缩水：壳内复制面文件清单被锁正面钉住（`shellConstraintLocks`），新增复制件同步登记锁内清单。

## 4. UI 设计强制前置技能（开发与审核均必须使用）

> **规则**：任何前端 UI 相关元素的**开发与审核**（宿主壳 / 系统页 / 挂载包 / SDK 组件 / 样式 / 交互 / 动效 / i18n 文案呈现），启动前与完成审核时**必须**先装载并遵循以下两个用户级 skill；不满足即视为未完成交付。

### 4.1 `ui-ux-pro-max`（主查工具，全平台适用）

- skill 落点：`~/.agents/skills/ui-ux-pro-max/SKILL.md`。web / mobile / desktop 全覆盖：设计系统（样式 / 配色 / 字体配对 / 排版）、无障碍、交互、响应式、暗色模式、图表、组件栈实践。
- **用法（加载 skill 后按其 Query Contract 走）**：新建页面 / 设计系统 → `--design-system`；组件 / 具体关切 → 单个 `--domain`；已知栈 → `--stack`（Vue 3 + Tailwind = `vue` / `tailwind` 栈）。写查询时**一个主导意图 + 2–5 个有意义的词**，不要混杂无关清单。
- **适用场景映射**：宿主壳与挂载包都是应用形态（dashboard/app screens）——这正是本 skill 的对象（它的 `description` 覆盖 dashboards 与 app 界面）。
- 无障碍类工作：一次只查一个可观察结果，先查语义 UX 结果再查组件域 / 栈，禁止用通用无障碍结果代替具体交互的 WCAG 判据。

### 4.2 `design-taste-frontend`（anti-slop 方法论，必查）

- skill 落点：`~/.agents/skills/design-taste-frontend/SKILL.md`（tasteskill v2，源自 247 个精选站点研究）。
- **必须执行的方法论层**（对应用 UI 同样适用）：① 先读 brief 与项目实际情况（证据、品牌、真实素材），禁止靠「模型平均审美」默认样式 ② 设计决策来自主题本身而非套模板 ③ 无装饰的房子风格 + 真实浏览器检查 ④ 截图三宽度审阅 → 修正 → 再审（look-and-fix 循环）。
- **边界（如实标注，避免误导）**：该 skill 自带脚本流程（`draw.mjs` / `inspect.mjs` / `assets.mjs` 与 `.taste-skill/` 工作区）面向**营销 / 公开页面**，其 description 声明不适配 dashboard / app screens。因此宿主壳与挂载包（应用 UI）以 **§4.1 ui-ux-pro-max 为主查工具**，本 skill 取其方法论（anti-slop 决策、真实浏览器检查、审阅循环）；网页形态的公开面（若有）则完整走其脚本流程。
- 任何页面如果显得「模板化 / AI 味 / 平庸」（用户原话或自评命中），必须以本 skill 的方法重新设计，不得靠加阴影 / 渐变糊弄。

### 4.3 工作流锚点

1. **动手前**：加载两个 skill → `ui-ux-pro-max` 检索设计系统 / 领域 / 栈判据 → 形成设计与交互决策（写进实现说明）→ 才允许写 CSS / 组件。
2. **完成审核时**：对照两个 skill 的检查项逐项过（无障碍 / 响应式 / 触摸目标 / 排版 / 配色对比 / 状态与错误 / 动效），发现问题按 §1 原则修复；交付说明里列出「跑了哪个 skill、查了什么、怎么裁决的」。
3. 知识沉淀：把本项目的 UI 决策（配色 / 排版 / 组件口径）沉淀到项目自身 token / 样式资产，不把 skill 输出当设计真源——设计真源仍是双端 `tailwind.config.js` / CSS token / 组件库。

### 4.4 布局自解释：避免多余的次级标签与描述

> **规则**：布局本身能说明的，不再用文字重复——**避免多余的次级标签与描述，让布局自己说明**（Let the layout do the explaining）。

- 位置、分组、层级、图标、控件类型或选中态已表达的信息（是什么 / 属于哪 / 当前状态）**禁止**再加次级文字复述：分组标题已言明的内容不加引导语；图标 + 位置可自明的不加冗余 `<label>`；状态已由颜色 / 徽标 / 高亮表达的不用文字补一句。
- 文字只承担布局表达不了的信息：值、动作、命名、警告与异常。「不加」先于「加」——新增任何次级标签 / 帮助性描述前先自检「删掉它界面是否依旧自明」，是即删。
- 审核必查的高发区：卡片标题下的重复说明、图标旁的冗余标签、空状态里复述已有结构的引导文案。

## 5. 注释、命名与 i18n（前端面）

- **注释规则（解释为什么 / 中文 / 禁票号引用 / 同步修正）与命名规则（组件 PascalCase / composable `use` 前缀）的通用部分真源 = `docs/public/commenting.md`**——本端只补充平台特有增量：Vue 组件 / 目录结构跟随既有双端的同构惯例。
- i18n：桌面 `src/i18n/host-{zh-CN,en}.ts`（+ `index.ts`）、移动 `src/locales/{zh-CN,en}/`；**新增 / 修改 key 必须双语同步**；用户可见文案禁止硬编码。
- **宿主消息集只装宿主壳文案**：应用可见文案（含 bedcode 桌面自带机制副本 `errors.*` 与业务文案）归各应用仓自持，宿主不提供 app 文案副本（2026-10-27 迁移；原 `i18nDriftLock` 随之退役）。

## 6. 桌面壳扩展点（状态栏 / 设置项 / 主题皮肤）

真源 = `wasmnest-desktop/src/shell/extensions/`（`types.ts` 契约、`registry.ts` 注册表、`index.ts` 公共入口）。

- **三类贡献**：`registerStatusBarItem`（状态栏项，左右分区 + order + 可选动作）、`registerSettingsEntry`（设置页扩展行）、`registerThemeSkin`（壳 token 皮肤）。全部返回 Disposable，停用 / 卸载时 `dispose()` 摘除；同 id 重复注册覆盖旧项，旧句柄不得误删新项。
- **注册表只做注册 / 撤销 / 排序 / 查询**：不感知贡献者是谁，不解释 `label` / `hint` / `onSelect` 的业务语义，不替扩展决定默认值。设置项**没有独立「扩展设置」分组**（用户 2026-10-22 裁决）：别的应用对系统设置的动态扩展，有注册才在「系统设置」卡内渲染，无固定占位；状态栏只显示宿主机制事实，皮肤区只保留内置默认皮肤。
- **状态栏是宿主 chrome**：常驻应用面与系统页底部（`bareWindow` 独立窗口除外），只展示宿主机制事实（运行时就绪 / 应用数 / 待审批）与注册项；扩展动作失败只进日志，不拖垮壳。
- **主题皮肤是纯 token 表**：键必须是 `--` 开头的 CSS 自定义属性，浅色 `tokens` / 深色 `darkTokens` 在壳根（`.shell-root`）合并生效；内置 id `default` 保留且始终排在首位，未知持久化 id 渲染时回落 default。皮肤只覆盖壳 chrome，应用根容器自己声明的 token 优先（应用配色仍归应用）。
- **设置页顺序是产品裁决**：界面 → 背景 → 皮肤 → 系统 → 日志 → 授权入口 → 恢复初始设置 → **关于（固定最后）**；`settingsOrderLock.test.ts` 钉住，插入新分组时不得把关于挤回中间。
