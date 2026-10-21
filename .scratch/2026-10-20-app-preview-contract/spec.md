# 票据：后台应用卡片显示应用自绘预览面（桌面多任务 · `mountPreview` 契约）

标签：`ready-for-agent`（平台机制已定；应用侧预览内容按 D11 落地）
日期：2026-10-20
影响仓：`wasmnest`（平台，主）、`wasmnest-apps`（四个桌面 app）、`wasmnest-test`（仅真实宿主目验，无代码改动）

> 注：本仓未配置 issue tracker。按项目既有票据惯例落 `.scratch/<date>-<slug>/spec.md`。
>
> 前置状态：2026-10-20 桌面多任务卡片已完成信息条上移（图标打头 + 名称 + 关闭键，去掉「运行中」chip）。本 spec 基于该形态，只解决卡片缩略区「只有品牌渐变 + 大图标、看不到应用界面」的问题。

> **结论**：新增可选 `mountPreview(root, env)` 导出；应用在卡片里自绘只读缩略预览；宿主只负责装载 / 3s 超时 / 卸载 / 回退品牌卡；不做截图、不保留后台 UI、不改 WIT / ABI / 权限。跨仓按 Phase A（平台可选能力）→ Phase B（四个 app 实现 + 新 tag）→ Phase C（平台收紧锁 + manifest）落地。

---

## Problem Statement

用户在多任务层里看到的是一排**品牌卡**，不是**应用卡**：每张卡只有应用图标和名称，缩略区是品牌色渐变 + 居中的大图标。用户无法从卡片判断「这个后台应用现在停在哪一页、正在做什么」，只能靠应用名记忆。

这不是样式偷懒，而是当前桌面宿主形态（机制 B）下的硬限制：

1. **离开应用面即卸载实例**。`ShellHost.vue` 只在 app 路由渲染 `AppMountSlot`；离开应用面（回主屏 / 进系统页 / 切到别的应用）时组件卸载，`AppMountSlot.onBeforeUnmount` 调 `unmountAppBundle(appId)`。
2. **卸载即销毁 UI**。`useAppMount.ts` 的 `mounted` 表只持有 `AppMountHandle`；`unmount()` 会销毁应用自己的 Vue 实例、路由、监听和 DOM。后台留下的是 wasm 实例 / 宿主生命周期，**没有 DOM 可截图**。
3. **打开多任务层本身不改变路由**。`ShellTaskSwitcher` 是 Teleport 到 body 的覆层，当前应用仍挂在遮罩后；但这只让**当前这一张卡**有活 DOM，其余后台应用早已在离开时卸载。宿主不能把当前应用的 DOM 克隆 / 截图分给其他卡，也无法保证所有卡一致。
4. **原生截图够不到后台应用**。WebKitGTK `webkit_web_view_get_snapshot`、WebView2 `CapturePreview`、`WKWebView.takeSnapshot` 都只截**当前 webview 的可见视口**；后台应用根本没有独立 webview，也没有挂载中的 DOM。对当前应用截图也只能得到「打开多任务前那一帧」，且平台实现各异、异步、易过期。
5. **`canvas` / `xterm` 等内容不可克隆**。即使把当前应用的 DOM 复制一份，canvas、WebGL、xterm 缓冲、iframe 等也无法通过 `cloneNode` / `innerHTML` 还原。

**当前实现里的大图标是机制 B 下唯一诚实的降级形态，不是可优化的占位符。** 要显示应用界面，必须由应用在卡片里**重新渲染一个预览面**，而不是由宿主去「抓取」一个已经不存在的界面。

证据落点：

| 事实 | 位置 |
| --- | --- |
| 离开应用面卸载挂载槽 | `wasmnest-desktop/src/shell/mount/AppMountSlot.vue`（`onBeforeUnmount`） |
| 卸载即销毁实例 | `wasmnest-desktop/src/shell/mount/useAppMount.ts`（`mounted` / `unmountAppBundle`） |
| 只有 app 路由挂载应用 | `wasmnest-desktop/src/shell/ShellHost.vue`（应用分支只渲染一个 `AppMountSlot`） |
| 卡片是路由键 / MRU 面，不是 UI 实例 | `wasmnest-desktop/src/shell/composables/useShellState.ts`（`cards`） |
| 机制 B 口径 | `docs/architecture.md` §2「装载即建、卸载即销毁」 |

---

## Solution

在桌面 app 挂载契约上增加一个**可选导出**：

```ts
export async function mountPreview(
  root: HTMLElement,
  env: AppPreviewEnv,
): Promise<AppPreviewHandle>
```

- 宿主在多任务卡片缩略区给应用一个容器 `root`，应用在其中挂载一个**只读、轻量、非交互的预览面**；
- 预览面由应用自己决定内容（可以是当前页面的缩略视图、会话摘要、设备/任务状态等），宿主不解释、不投影、不持有任何业务状态；
- 应用未导出 `mountPreview`、挂载抛错或超时 → 宿主回退到现有的品牌渐变 + 大图标，**绝不白屏**；
- 预览面只在多任务层打开期间存在，卡片卸载 / 多任务关闭即 `unmount()`，不保留后台预览实例。

这不是「最后画面截图」，而是**应用在卡片里重新画一张当前状态的缩略图**。它是点时刻（mount 时）的，不保证像素级复刻离开前的瞬时 UI（打开中的菜单、滚动位置、未提交输入、xterm 缓冲等可能不在），但可以读取应用当前业务数据，做到「一眼认出这是什么、正在做什么」。

```text
打开多任务
  └─ ShellTaskSwitcher（v-for cards）
       └─ AppPreviewTile（仅 app 卡）
            ├─ 动态 import 同一 app 整包（URL 缓存命中，不重复下载）
            ├─ 有 mountPreview → 挂到缩略区 root
            │    ├─ 成功 → ready（应用自绘预览面）
            │    └─ 缺失 / 抛错 / 超时 → fallback（品牌渐变 + 图标）
            └─ 卡片卸载 / 多任务关闭 → handle.unmount()
```

---

## User Stories

1. 作为**用户**，我希望多任务卡片里看到后台应用当前页面的缩略视图，而不是只有一个应用图标，这样我能靠界面内容而不是记忆来找到应用。
2. 作为**用户**，我点击卡片任意位置仍然能切回该应用（并回到上次停留的页面），预览面不会抢走点击或键盘焦点。
3. 作为**用户**，如果某个应用没有实现预览或预览加载失败，我仍能看到一张完整的品牌卡，而不是空白、转圈或错误弹窗。
4. 作为**应用开发者**，我可以在 `entry.ts` 里增加一个 `mountPreview`，用现有 `appInvoke` / `appStorageGet` 读取本应用数据并画一个轻量预览，不需要改 WIT、Rust、SDK 生成物或宿主业务代码。
5. 作为**宿主维护者**，我希望宿主只负责给容器、装载、超时和卸载，不新增任何应用业务类型、状态、存储或默认值（AGENTS §2 三问全部通过）。
6. 作为**安全审查者**，我希望预览面不获得比主界面更高的权限：不主动换发令牌、不暴露宿主面 `invoke`、不新增权限位、不改变 Rust 侧权限仲裁。
7. 作为**用户**，当前前台应用的那张卡也能显示预览；即使它的主界面还在遮罩后面继续运行，预览面也不会和主实例互相踩状态。
8. 作为**用户**，系统页卡片（设置 / 应用管理 / 权限与授权）不受这次改动影响，仍保持现有呈现。
9. 作为**测试者**，我可以用单元测试分别验证「有预览 / 无预览 / 超时 / 卸载 / 晚到结果」五条路径，不需要真实启动四个应用。
10. 作为**发布负责人**，我希望这次改动不触发 WIT / ABI / 契约版本变化，只需要应用仓新 tag + 平台 `release-manifest.repos.apps.tag` 前移。

---

## Implementation Decisions

### D1 — 预览面是应用自绘的只读视图，不是截图

- 宿主**禁止**尝试截取 webview、克隆应用 DOM、用 `html2canvas` 或原生截图接口生成卡片内容。
- 预览面是应用 bundle 在卡片容器里新建的**独立 Vue 实例**（或等价轻量渲染），与主应用实例生命周期分离。
- 预览面是**点时刻渲染**：每次多任务打开重新 mount，不缓存上一次的卡片画面；应用可按自身数据决定展示「当前会话 / 最近会话 / 空态」。
- 预览面**不保证**像素级复刻离开前的界面；产品文案与验收口径都按「应用自绘的缩略摘要」表述，不承诺「最后画面」。

### D2 — 契约形状（宿主与四个 app entry 同形重复，drift 锁钉住）

宿主 `useAppMount.ts` 新增：

```ts
/** 应用预览环境（宿主注入；只读面） */
export interface AppPreviewEnv {
  appId: string
  /** 应用上次自报的内部路径；无记录 = undefined（应用自行回落落地页） */
  lastRoute?: string
  /** 本 app 插件面命令（与主界面同一令牌 / 权限；预览侧只读使用） */
  appInvoke: <T = unknown>(command: string, ...args: unknown[]) => Promise<T>
  /** 本 app 插件 KV 只读访问 */
  appStorageGet: <T = unknown>(key: string) => Promise<T | undefined>
  locale: string
  theme: string
  platform?: string
}

/** 应用预览句柄 */
export interface AppPreviewHandle {
  unmount(): Promise<void>
}

/** entry.ts 可选导出；未导出 = 不支持预览 */
export type MountPreview = (
  root: HTMLElement,
  env: AppPreviewEnv,
) => Promise<AppPreviewHandle>
```

宿主装载模块的形状：

```ts
interface AppBundleModule {
  mountApp?: (root: HTMLElement, env: AppMountEnv) => Promise<AppMountHandle>
  mountPreview?: MountPreview
}
```

约束：

- `mountPreview` **可选**；缺失不是错误，是「该应用不支持预览」。
- 不增加 `preview: true` 之类的 manifest / 注册表字段。**bundle 是否导出就是能力声明**，宿主不维护应用预览名单（否则又变成宿主侧产品注册表）。
- 不新增 `previewContractVersion` 字段：ESM 额外导出天然向后兼容（旧宿主忽略，新宿主对旧包回退），研发起步期不做版本协商。
- 预览环境**不提供** `invoke`（宿主面命令）、`appStorageSet` / `appStorageDelete`、`onEvent`。预览不能请求宿主导航、不能写存储、不能上报路由；只保留读数据所需的最小面。
- 应用侧**不要复用**现有的 `createAppContext(env)`（它要求完整 `AppMountEnv`，含 `invoke` / 写存储 / 事件出口）；预览应使用专用的最小 context，或直接把 `AppPreviewEnv` 作为 props / provide 注入。不要为了复用工厂而伪造不存在的 env 字段。

### D3 — 宿主生命周期：只活在多任务打开期间

新增 `AppPreviewTile.vue`（建议住 `src/shell/mount/` 或 `src/shell/components/`，与 `ShellAppTile` 同层）：

- props 只接收渲染所需事实：`appId`、`lastRoute`、`icon`、`iconFile`、`tone`；不读应用业务状态。
- 内部状态机：`fallback`（初始 / 失败）→ `loading` → `ready`；**初始立即渲染 fallback**，不出现空白或加载骨架。
- `onMounted`：
  1. 构建 `AppPreviewEnv`（见 D4）；
  2. 调 `mountAppPreview(root, env)`；
  3. 若模块无 `mountPreview` → 保持 fallback；
  4. 成功 → `ready`，预览层淡入（`prefers-reduced-motion` 下直接显示）；
  5. 失败 / 超时 → fallback + `logger.warn`。
- `onBeforeUnmount`：若已有 handle，调用 `handle.unmount()`；若 mount 尚未完成，标记代次作废，晚到的 handle 立即 `unmount()`，不得把 DOM 挂到已卸载的卡片上。
- **不做全局预览缓存**；不保留隐藏预览实例；不在多任务关闭后继续跑预览定时器 / 订阅。
- 预览装载超时 `PREVIEW_MOUNT_TIMEOUT_MS = 3000`；主应用装载仍用现有 `MOUNT_TIMEOUT_MS = 8000`。动态 import 与主应用共用同一 bundle URL 和模块缓存，但超时策略分开。
- **3s 超时只覆盖 `mountPreview` 返回 handle**，不覆盖预览内部的数据加载。应用应先挂出预览骨架 / 空态并立即返回 handle，再异步取数；不要把「等命令返回」放在 `mountPreview` 的 resolve 之前，否则慢命令会把整张卡打成 fallback。
- 预览装载失败不自动重试（避免每次打开多任务都打一轮失败日志）；下次打开多任务可重新尝试。

### D4 — 环境构建：不换发令牌，不产生生命周期副作用

`AppPreviewTile` 构建环境时必须：

- `appInvoke: (command, ...args) => appInvoke(appId, command, ...args)`；
- `appStorageGet: (key) => appStorageGet(appId, key)`；
- `lastRoute: lastRouteOf(appId)`（`appSession` 的应用自报路径，可能就是当前页）；
- `locale` / `theme` 取 `useSettingsStore`；`platform` 取 `usePlatform`。

**禁止**在预览路径调用 `refreshChannelToken(appId)`：该函数会作废并重签发通道令牌，而主应用实例可能正在用旧令牌跑命令；预览是旁路展示，不能改身份绑定。`appInvoke` / `appStorageGet` 自身的 `ensureChannelToken`（缓存命中优先、失败才签发）可以复用，但预览不应主动触发重签。

预览面**不得**：

- 调 `invoke`（宿主面命令）；
- 写 / 删插件存储；
- 启动 / 停止插件、打开窗口、发通知、弹 toast、触发文件选择；
- 前端直连网络（全局红线本来就禁止）；需要远端数据时只能走应用既有后端命令，且预览侧只读；
- 嵌入 iframe / 新 webview / Teleport 到卡片外的全局层；
- 订阅会活过 `unmount()` 的全局事件 / 定时器 / `window` / `document` 监听。

这些是应用侧契约义务。宿主无法从通用 `appInvoke` 推断命令是否只读，因此不做运行期拦截；安全边界仍由 Rust 权限仲裁保证（预览没有新增权限）。

### D5 — 卡片结构、交互与无障碍：预览是装饰层，不是第二个操作面

现有卡片把 `.ts-meta` / `.ts-thumb` 包在 `<button class="ts-card-main">` 里。预览面是应用渲染的任意 DOM，可能包含按钮 / 链接 / 输入框；继续嵌在 button 里会产生嵌套交互元素，键盘和读屏都会出错。因此本次需要把卡片动作改成**单一覆盖层**：

```vue
<article class="ts-card">
  <div class="ts-meta">…图标 + 名称 + 异常 chip…</div>
  <div class="ts-thumb">
    <AppPreviewTile … />
  </div>
  <!-- 唯一打开动作：绝对定位覆盖整张卡，视觉层全部 pointer-events:none -->
  <button class="ts-card-main" :aria-label="…" :aria-current="…" @click="switchTo(key)" />
  <button class="ts-card-x" … />
</article>
```

- 卡片视觉层（信息条 + 预览 / fallback）**不承载点击**；`pointer-events: none`，点击落到覆盖层按钮；
- 一个绝对定位的 `.ts-card-main` 覆盖整张卡，作为唯一的「打开应用」按钮（`aria-label` / `aria-current` 保持不变）；
- 关闭键 `.ts-card-x` 保持为 article 的兄弟，`z-index` 高于覆盖层；
- 预览容器设置 `inert`、`aria-hidden="true"`、`pointer-events: none`、`user-select: none`；
- 预览面内部**禁止**出现可聚焦控件（契约要求；`inert` 是兜底，不是让应用随便放按钮的许可）；
- 焦点环画在覆盖层按钮上，形态与现有 `.ts-root button:focus-visible` 一致。

布局约束：

- 预览容器与 fallback 占同一个 `.ts-thumb` 盒子，尺寸由卡片决定（当前约 420 × 512 CSS px，随窗口缩放）；两者切换不得造成卡片高度 / 网格位置跳动。
- 预览面必须 `width: 100%; height: 100%` 填满容器，`overflow: hidden`；容器加 `contain: layout paint`，防止应用内的 `position: fixed` / 绝对定位弹层逃出卡片；内部自行使用容器查询 / 缩放，不假设桌面全屏尺寸。
- 预览面使用 scoped CSS 或带唯一根类名的样式；禁止全局选择器、`document.body` 样式、宿主 token 覆写。
- 预览面使用 `env.theme` / `env.locale` 适配主题和语言；宿主不为预览新增任何 i18n key。
- fallback 保持现有品牌渐变 + 92px 应用图标；加载中不显示 spinner，避免卡片闪烁；成功后短淡入。
- 实施前按 `docs/frontend.md` §4 加载 `ui-ux-pro-max` + `design-taste-frontend` 并做真实宿主视觉 / 无障碍审核；本 spec 只定机制与边界，不替代视觉验收。

### D6 — 宿主薄壳裁决（AGENTS §2 三问）

① **离开宿主能实现吗？** 能。预览内容完全由应用 bundle 实现，宿主只给容器和 `appId` / `lastRoute` / 语言 / 主题 / 既有命令通道。

② **携带产品语义吗？** 不。宿主不知道「会话」「任务」「对端」「模型」是什么，也不定义预览应显示什么；应用自己决定。

③ **是通用机制吗？** 是。任何桌面 app 都可选导出 `mountPreview`；没有新增权限位、WIT interface、业务状态、业务默认值或产品事件解释。

逐条对照 B1–B6：无新增业务类型 / 字段（B1）、无业务编排 / 状态机（B2）、无业务真源（B3）、无业务投影（B4）、无业务默认值（B5）、无业务生命周期回调（B6）。`mountPreview` 的调用时机是「多任务卡片挂载 / 卸载」这一 **UI 展示生命周期**，不是应用业务事件；宿主不解释应用状态，也不因业务事件主动回调应用。宿主唯一新增的是「在卡片里挂一个可选的应用自绘 UI」这一展示机制，和 `mountApp` 同级。

### D7 — 失败语义：回退是设计的一部分，不是静默降级

| 情况 | 行为 |
| --- | --- |
| bundle 无 `mountPreview` | 直接 fallback；不报错（正常的不支持） |
| `mountPreview` 抛错 | fallback + `logger.warn('[AppPreview] mount failed: appId=...')` |
| 返回的 handle 形状不对（无 `unmount`） | 按失败处理：清空容器 + fallback + `logger.warn` |
| 3s 超时 | fallback + `logger.warn` |
| 卡片在装载完成前卸载 | 晚到 handle 立即 `unmount()`，不写 DOM |
| `unmount()` 抛错 | `logger.error`，不阻断多任务关闭 |
| 预览内部渲染报错 | 应用自己兜底；宿主只保证外层容器和卸载 |

- 失败 / 超时后宿主先清空预览容器（`root.replaceChildren()`，有 handle 则先 `unmount()`），再显示 fallback，避免半挂载内容残留。
- 不弹 toast、不显示错误 chip、不影响卡片打开 / 关闭。预览是「识别辅助」，不是安全 / 功能闸门；失败不能让用户失去切回应用的能力。
- 为了可测试，预览容器带 `data-preview-state="fallback|loading|ready"`；失败原因只进日志，不落到用户可见面。
- 若应用处于降级 / 待审批 / 错误状态，现有异常 chip 继续显示；预览失败不覆盖这些真实状态。

### D8 — 契约 drift 锁：L5

在 `wasmnest-desktop/src/__tests__/hostAppBoundaryLock.test.ts` **Phase C 增加最终 L5**（沿用现有纯文件扫描形态）：

- 四个内置桌面 app 的 `entry.ts` 必须导出 `mountPreview`（最终态；第三方面向的契约仍是可选）；
- 四个 entry 必须出现契约关键字段：`appId`、`appInvoke`、`appStorageGet`、`lastRoute`、`locale`、`theme`；
- 宿主 `useAppMount.ts` 必须声明 `AppPreviewEnv` / `AppPreviewHandle`，且模块类型里 `mountPreview` 是可选属性；
- 反向守卫：预览路径（`AppPreviewTile` 及其 env 构建模块）不得 import / 调用 `refreshChannelToken`，不得调用 `appStorageSet` / `appStorageDelete`；
- 保持 `APP_ENTRIES.length === 4` 的非空转断言。

**先红后绿**：Phase C 写最终 L5 时，先用 **Phase B 之前**的应用树跑一次（临时 worktree / 尚未合入的 app 分支），必须因四个 entry 缺失而红且逐一点名；Phase B 的应用改动落地后再跑必须绿。红灯输出摘录留在交付说明里，证明锁不是恒真。

### D9 — 跨仓顺序：三阶段，每阶段可独立绿

1. **Phase A（平台，先落可选能力）**
   - `useAppMount.ts`：新增 `AppPreviewEnv` / `AppPreviewHandle` / `mountAppPreview`，抽出 `loadAppModule()` 复用 bundle URL 与 import 超时；
   - 新增 `AppPreviewTile.vue`；`ShellTaskSwitcher.vue` 的 app 卡改用该组件，system 卡保持现状；
   - 卡片动作改为覆盖层按钮（D5）；
   - 文档更新（D10）；
   - Phase A 只加宿主侧行为测试，**不把 L5 设为四个 app 必选**（应用尚未实现，避免为了锁而锁）；L5 在 Phase C 以最终形态落地；
   - 此时旧应用全部走 fallback，用户可见行为不回归。

2. **Phase B（应用仓）**
   - 四个桌面 app 各自新增 `mountPreview` + 专用预览组件 + 测试；
   - **首版只改前端**：不改 Rust 命令面 / `plugin.json` 权限；预览复用现有命令 / KV，不新增权限位。若某 app 确实缺只读快照命令，另开应用仓后端票，不夹带进本 spec；
   - 预览只读，不得启动通知、轮询、全局监听；
   - 各 app `pnpm run test:run` / `build:frontend` 通过；应用仓打 `apps-vX.Y.Z` tag。

3. **Phase C（平台收口）**
   - 新增最终 L5：四个内置 app 必须导出 `mountPreview`（D8）；
   - `release-manifest.json` 的 `repos.apps.tag` 前移到新 tag；
   - 跑平台全量前端测试 + `check:manifest`；真实宿主目验；
   - 平台提交（是否打 tag 按发布流程 / `docs/public/versioning.md` 决定，日常改动不 bump）。

**不涉及**：`wasmnest-lib` 改动、WIT 组合、SDK 生成物、`contract.version` / `contract.witSha256`、ABI。`apps` 段只需按现有发布流程更新 tag（应用源码变了，正常重建产物）。

### D10 — 文档同步

- `docs/architecture.md` §2：挂载契约补一句可选 `mountPreview`，并写明「预览面 = 应用自绘只读视图，不是截图；缺失 / 失败回退品牌卡」。
- `docs/frontend.md` §2：桌面 `entry.ts` 契约补可选导出、只读环境、禁止令牌换发。
- `docs/codemap.md` §6 / §8：新增 `AppPreviewTile.vue`、`mountAppPreview`、L5 锁的任务路由与锁索引。
- 应用仓 `docs/FRONTEND.md` / `docs/CODE-MAP.md` / `AGENTS.md`：桌面挂载契约处补 `mountPreview`，并链接本 spec。
- 不新增用户可见文案，因此不改双端 i18n；不改 SDK 生成物 / WIT。

### D11 — 应用侧预览内容建议（由应用仓 owner 最终裁决）

平台不规定内容，但建议四个内置 app 首版至少做到「可识别 + 真实数据 + 轻量」：

| 应用 | 建议最小预览内容 | 数据来源 | 明确不要做 |
| --- | --- | --- | --- |
| `bedcode` | 最近 / 当前会话标题、连接 / 工作区状态、最近任务摘要 | `lastRoute` + 现有会话 / 任务命令或 KV | 不要复刻 xterm 缓冲 / 终端像素 |
| `agent-hub` | CLI 检测概览（已装 / 版本 / 会话数） | 现有 detection / usage 命令 | 不要启动检测轮询 |
| `ai-chatbox` | 当前对话标题 + 最近 2–3 条消息摘要 / 未配置供应商空态 | 现有会话 KV / 命令 | 不要发真实模型请求 |
| `file-transfer` | 对端在线状态 + 当前传输任务 / 速度摘要 | 现有 peer / task 命令 | 不要发起连接 / 传输 |

通用要求：

- 首选现有只读命令 / KV 组装摘要；若某个 app 确实缺少可用的只读快照命令，按应用仓后端规范单独评估，**不得为了预览新增写命令、放宽权限或引入后台轮询**。
- 预览是**缩略摘要**，不是完整应用；使用专用轻量组件，不挂主 `App.vue` / 主 router / 主 pinia。
- **当前前台应用的卡片也会挂预览**：此时主实例仍在遮罩后运行，预览可能与主实例**同时存在**。预览不得依赖模块级单例的可变状态（`vueApp`、主 router、主 pinia、全局通知句柄等），也不得假设自己是该应用唯一实例。
- 数据拿不到时显示应用自己的诚实空态，不编造「运行中」内容。
- 不产生业务副作用；不弹窗、不 toast、不发通知、不写存储、不启动进程。
- 预览组件内的 DOM 不应包含可聚焦控件；所有交互由外层卡片覆盖层承接。

### D12 — 否决方案（记录理由，防止反复推翻）

| 方案 | 否决理由 |
| --- | --- |
| A. 离开时截最后帧（DOM / 原生） | 后台应用已卸载，没有 DOM；原生截图只覆盖当前 webview 视口；平台实现分裂、异步、易过期；只能覆盖当前应用，卡片之间不一致 |
| B. 后台保持应用 UI 挂载（隐藏实例 / keep-alive） | 直接违反机制 B「装载即建、卸载即销毁」与宿主零业务状态；隐藏实例继续跑定时器 / 订阅 / 命令，内存与安全生命周期都失控 |
| C. DOM 克隆 / `html2canvas` | canvas、WebGL、xterm、iframe 不可克隆；引入重依赖；CSP / 样式隔离复杂；宿主还要理解应用 DOM |
| D. 复用 `mountApp` + `mode: 'preview'` | 会跑完整应用挂载副作用（router / pinia / 通知 / 监听）；各 app entry 的模块级 `vueApp` 单例会与主实例冲突；「是否支持预览」也无法从导出面判断 |
| E. iframe / 每个应用独立 WebviewWindow | iframe 里的 bundle 拿不到宿主注入的 env；独立窗口是另一套窗口 / 权限 / 生命周期模型，不是卡片缩略图 |
| F. 构建期静态截图 | 不反映当前状态；应用更新后过期；仍需应用提供素材 |

选定方案：**G. 应用导出 `mountPreview`，宿主在卡片内挂载只读预览面**。

### D13 — 范围边界

- **只做桌面**。移动端多任务使用 `registerSurface` / 宿主全局共享模块，没有桌面这种独立挂载包；移动预览是另一张票。
- **只做应用卡**。系统页卡（设置 / 应用管理 / 权限与授权）由宿主页面渲染，没有 app bundle；首版继续用现有图标卡。
- **只做点时刻预览**。多任务打开期间不要求实时刷新；应用可自行订阅并清理，但宿主不提供刷新通道。
- **不做交互**。预览内不能点按钮、滚动、选择文本；点击卡片 = 打开应用。
- **不做隔离边界**。预览和主应用同源、同 webview，安全边界仍由应用安装信任 + Rust 权限仲裁决定；不新增 sandbox / iframe。应用不得在预览里读取或展示超出主界面权限的数据。

---

## Testing Decisions

**好测试的判据**：只断言外部可观察行为——「有预览时显示预览 / 没有时显示 fallback / 关闭时卸载 / 失败不阻断 / 契约字段在场」。不断言应用内部用了哪个组件、哪条命令。

### Seam 1（新增，Phase C）：契约 drift 锁

- 位置：`wasmnest-desktop/src/__tests__/hostAppBoundaryLock.test.ts` L5。
- 覆盖：四个 `entry.ts` 的 `mountPreview` 导出与关键字段、宿主类型声明、预览路径不换发令牌。
- **先红后绿**：最终 L5 写好后，先用 Phase B 之前的应用树跑一次，必须逐个点名四个 entry；Phase B 的应用改动落地后全绿。红灯输出摘录进交付说明（Seam 3 纪律）。

### Seam 2（新增）：`AppPreviewTile` 行为单测

建议文件：`wasmnest-desktop/src/__tests__/shell/appPreviewTile.test.ts`（happy-dom + `@vue/test-utils`）。

至少覆盖：

1. **无 `mountPreview`**：不抛错、不空白，fallback 图标可见，`data-preview-state="fallback"`。
2. **挂载成功**：调用参数含 `appId` / `lastRoute` / `locale` / `theme`；预览 root 被填入内容；fallback 隐藏；状态变 `ready`。
3. **挂载抛错**：fallback 保持；`logger.warn` 被调用；没有未处理 rejection。
4. **超时**：假定时器推进 3000ms；fallback；不再等待。
5. **卸载**：组件 unmount 调用 `handle.unmount()`。
6. **晚到结果**：mount promise 在组件卸载后才 resolve；晚到 handle 必须立即 `unmount()`，不能写入已卸载 DOM。
7. **不换发令牌**：mock `appCommands`，断言 `refreshChannelToken` 未被调用；`appStorageSet` / `appStorageDelete` 未被调用。
8. **装饰层属性**：预览容器有 `inert` / `aria-hidden="true"` / `pointer-events: none`（后两者可从 class/style 断言）。

### Seam 3（既有 + 扩展）：多任务接线锁

- 文件：`wasmnest-desktop/src/__tests__/shell/recentsWiring.test.ts`。
- 断言 app 卡缩略区使用 `AppPreviewTile`，system 卡仍走原 glyph 分支；信息条仍在缩略区之前、图标打头、无「运行中」chip（保留 2026-10-20 的既有断言）。
- 断言预览容器不在 `<button class="ts-card-main">` 内部（D5 的单动作层），避免以后顺手把预览塞回按钮里。

### Seam 4（应用仓）：四个 app 各自验证

每个 `apps/<slug>/desktop`：

- `pnpm run test:run` 全绿；
- `pnpm run build:frontend` 成功（证明单文件 bundle 仍能产出，`mountPreview` 被包含）；
- 预览组件测试至少覆盖：正常数据渲染、空态 / 命令失败、无副作用（不启动通知 / 轮询）、unmount 清理；
- 预览 DOM 内无可聚焦控件（`button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])` 为空）。

### Seam 5（平台 + 跨仓）：全量门禁与真实宿主

- `cd wasmnest-desktop && pnpm run test:run` 全绿（当前基线约 60 个文件 / 574 个测试，以实际输出为准）；
- `cd wasmnest-desktop && pnpm exec vue-tsc --noEmit` 通过；
- 桌面 ESLint 0 error；应用仓根 `pnpm run lint` 0 error；
- Phase C：`cd wasmnest && pnpm run check:manifest` 全绿（apps tag 已前移）；
- **真实宿主目验**：`cd wasmnest-desktop && pnpm run tauri:dev`，逐个打开四个应用 → 回主屏 → 打开多任务：
  - 四张 app 卡显示预览；卡片布局不跳、无横向滚动条；
  - 点卡片任意位置能切回，且回到上次页面；
  - 关闭单卡 / 全部关闭 / Esc 后无预览残留、无控制台错误；
  - 断网 / 命令失败时预览显示诚实空态或 fallback，不白屏；
  - 当前前台应用的卡片与其他后台卡表现一致。
- 本次不改 WIT / ABI，不需要 `check:wit`；若实施中意外发现 WIT 变更，停下另开票，不夹带。

### Seam 6（人工 / 性能与无障碍）

- 四张预览同时挂载时，多任务打开无可感知卡顿；fallback 首帧立即出现，预览淡入不造成布局位移。
- 卡片带内键盘 Tab：焦点只落在卡片覆盖按钮和关闭键；预览内容不可聚焦。
- 读屏：预览内容 `aria-hidden`，卡片按钮仍以应用名播报；关闭键有独立 aria-label。
- `prefers-reduced-motion: reduce` 下无淡入动画。

### 先例（prior art）

- 契约 drift 锁：`hostAppBoundaryLock.test.ts` 既有 L1–L4（纯文件扫描 + 关键字段）。
- 挂载生命周期测试：`shell/mount/appMountSlotSwitch.test.ts`（晚到代次、卸载、换 app）。
- 多任务形态锁：`shell/recentsWiring.test.ts`（模板顺序、全屏层、动作转发）。
- 应用入口测试：各 app 现有 `entry.ts` / `appContext` 测试形态。

---

## Out of Scope

- **像素级实况截图 / 最后帧**。本 spec 明确不做；若产品坚持要「和离开时一模一样的画面」，需要另立架构票（保留后台 UI 或独立 webview），不在本次范围。
- **移动端多任务预览**。移动端是共享运行时 + `registerSurface`，没有桌面挂载包；另立票。
- **系统页卡片预览**。系统页是宿主页面，不是 app bundle；首版保持图标卡。
- **预览交互**。不做预览内按钮、滚动、文本选择、悬浮菜单。
- **宿主驱动的预览实时刷新 / 视频 / 动画流**。宿主只做点时刻 mount，不提供 `refresh()` API、不要求实时；应用如自行订阅数据，必须随 `unmount()` 清理，且不得变成后台轮询。
- **静态缩略图 / 构建期截图管线**。
- **iframe / 独立 WebviewWindow / 宿主侧截图接口**。
- **WIT / ABI / SDK 生成物 / 权限位变更**。
- **桌面 SDK `README` / `template` / `dev-shell` 的旧贡献面漂移修复**（已知债，独立票；本 spec 只更新与挂载契约直接相关的文档段落）。
- **发布版本 bump**（只在发布时按 `docs/public/versioning.md` 处理）。

---

## Further Notes

- **为什么叫「预览面」而不是「快照」**：快照暗示「离开时那一帧的副本」，会制造无法兑现的验收预期；预览面是应用按当前数据重新画的缩略视图，允许有取舍。UI 上也不需要加「预览」字样，卡片本身就是预览。
- **为什么不让宿主统一渲染**：一旦宿主按 appId 写「终端卡显示什么 / 聊天卡显示什么」，就命中 B1/B4/B5，业务语义回流宿主。应用自绘是唯一符合薄壳红线的形态。
- **为什么预览面必须非交互**：卡片本身是一个「打开应用」的动作。预览里再放按钮会产生嵌套交互、焦点竞争和「点了预览里的按钮却没打开应用」的歧义。把预览当装饰层，是保持卡片语义单一的最简单办法。
- **已知取舍**：bedcode 的终端画面、ai-chatbox 的未发送输入、file-transfer 的临时选择等瞬时状态，在离开应用面后本来就不存在；预览面不应假装它们还在。若未来产品要求「切回后连终端滚屏都不丢」，那是应用侧状态持久化 / 后台保活的问题，不是卡片预览能解决的。
- **后续可选增强**（不在本票）：卡片多时用 `IntersectionObserver` 只挂可见预览；预览面支持 `refresh()`；移动端同构契约；应用侧把预览内容做成可配置的「卡面摘要」。
- **实施交付说明必须点名**：Phase A/B/C 各自改了什么、跑了哪些命令、真实宿主目验结果、哪些应用预览是空态 / 降级、未跑什么与风险。跨仓同步项（apps tag、manifest、锁）逐项列出。
