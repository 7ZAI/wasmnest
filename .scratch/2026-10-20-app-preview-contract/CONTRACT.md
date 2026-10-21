# 实施契约（mountPreview 卡片预览 · 2026-10-20）

> 本文件是 spec 的**施工图**，描述本轮实施中所有协作者共享的精确形状 / 行为 / 验收。
> 与 `spec.md` 冲突时以 `spec.md` 为准并回来修本文件；与代码真源冲突时以代码为准。
> 各协作者只改自己写作用域内的文件（§0），跨域改动先回报 Lead。

## 0. 写作用域

| 角色 | 可写文件 |
| --- | --- |
| Lead | `wasmnest-desktop/src/shell/mount/useAppMount.ts`；三处平台 docs；应用仓 docs；本 `.scratch/` |
| host-ui | `wasmnest-desktop/src/shell/mount/AppPreviewTile.vue`（新建）；`wasmnest-desktop/src/shell/components/ShellTaskSwitcher.vue` |
| host-tests | `wasmnest-desktop/src/__tests__/shell/appPreviewTile.test.ts`（新建）；`wasmnest-desktop/src/__tests__/shell/recentsWiring.test.ts`；`wasmnest-desktop/src/__tests__/hostAppBoundaryLock.test.ts` |
| apps-agent-hub | `wasmnest-apps/apps/agent-hub/desktop/src/`（entry.ts + 新建 `preview/` + 新建 `__tests__/preview.test.ts`） |
| apps-ai-chatbox | `wasmnest-apps/apps/ai-chatbox/desktop/src/`（同上） |
| apps-bedcode | `wasmnest-apps/apps/bedcode/desktop/src/`（同上） |
| apps-file-transfer | `wasmnest-apps/apps/file-transfer/desktop/src/`（同上） |

禁止：改 WIT / Rust / SDK 生成物 / `release-manifest.json` / i18n 宿主文案 / 移动端；改别人写作用域；顺手重构。

## 1. 共享契约（宿主 `useAppMount.ts` 与四个 app `entry.ts` **逐字同形**）

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
export type MountPreview = (root: HTMLElement, env: AppPreviewEnv) => Promise<AppPreviewHandle>
```

预览环境**没有** `invoke` / `appStorageSet` / `appStorageDelete` / `onEvent` / `initialRoute`。
预览侧**禁止**调用 `refreshChannelToken`（宿主侧由 L5 反向守卫钉住）。

## 2. 宿主 `useAppMount.ts` 新增面（Lead 已实现）

```ts
/** 预览装载超时（毫秒）；只覆盖 mountPreview 返回句柄，不覆盖预览内部取数 */
export const PREVIEW_MOUNT_TIMEOUT_MS = 3000

interface AppBundleModule {
  mountApp?: (root: HTMLElement, env: AppMountEnv) => Promise<AppMountHandle>
  mountPreview?: MountPreview
}

/**
 * 在 root 里挂载 app 自绘只读预览面。
 * - bundle 未导出 mountPreview → 返回 null（正常的不支持，不报错、不 warn）
 * - bundle import 失败 / mountPreview 抛错 / 返回 handle 无 unmount → reject
 * - 超时由调用方（AppPreviewTile）控制，本函数不做超时
 */
export async function mountAppPreview(
  root: HTMLElement,
  env: AppPreviewEnv,
): Promise<AppPreviewHandle | null>
```

- bundle URL / 动态 import 与主应用共用：抽出 `loadAppModule(appId)`（成功缓存、失败不缓存，import 超时仍 8s）。
- `mountAppBundle` 也改走 `loadAppModule`，行为不变。
- `useAppMount()` 返回值带上 `mountAppPreview`（与既有命名导出并存）。

## 3. `AppPreviewTile.vue`（host-ui 实现，host-tests 按此断言）

位置：`wasmnest-desktop/src/shell/mount/AppPreviewTile.vue`

Props（只给渲染事实，不读业务状态）：

```ts
defineProps<{
  appId: string
  lastRoute?: string
  icon: string
  iconFile?: string
  tone: AppTone | 'system'
}>()
```

DOM 契约（测试直接依赖）：

```vue
<div class="app-preview" :data-preview-state="phase">
  <!-- 品牌渐变 fallback（初始 / 失败 / 不支持）；ready 后隐藏 -->
  <div class="app-preview-fallback" :class="[{ 'is-hidden': phase === 'ready' }, 'tone-' + tone]"
       :style="fallbackStyle">
    <ShellAppTile :icon="icon" :plugin-id="appId" :icon-file="iconFile" :tone="tone" :size="92" />
  </div>
  <!-- 应用自绘预览面挂载点：装饰层，永远不可交互 / 不可聚焦 / 不进无障碍树 -->
  <div ref="previewEl" class="app-preview-surface" inert aria-hidden="true"
       style="pointer-events: none; user-select: none"></div>
</div>
```

- `phase: 'fallback' | 'loading' | 'ready'`；**初始 `fallback`**（首帧就有完整品牌卡，不空白、不 spinner）。
- `onMounted`：`phase='loading'` → 构建 env → `mountAppPreview(previewEl, env)`：
  - 返回 `null` → `phase='fallback'`（不 warn）；
  - 返回 handle → `phase='ready'`；
  - 超时（`PREVIEW_MOUNT_TIMEOUT_MS`）/ 抛错 / 形状不对 → `phase='fallback'` + `previewEl.replaceChildren()` + `logger.warn('[AppPreview] mount failed: appId=...')`，不重试、不弹 toast。
- env 构建（**不调 `refreshChannelToken`**）：
  ```ts
  { appId, lastRoute, appInvoke: (cmd, ...args) => appInvoke(appId, cmd, ...args),
    appStorageGet: (key) => appStorageGet(appId, key),
    locale: settingsStore.settings.ui.language || 'zh-CN',
    theme: settingsStore.settings.ui.theme || 'dark',
    platform: platformInfo.value.isDesktop ? 'desktop' : 'mobile' }
  ```
- 超时由组件实现（`Promise.race` 语义，常量从 useAppMount 导入）；超时后晚到 handle 必须立即 `unmount()`，不得把 DOM 留在已卸载卡片上；`onBeforeUnmount` 里已有 handle 必须 `unmount()`（抛错只 `logger.error`，不阻断）。
- 预览面填满容器：`width/height:100%`、`overflow:hidden`；容器 `contain: layout paint`；不做全局选择器 / `document.body` 样式。
- 淡化：`ready` 时预览层短淡入；`@media (prefers-reduced-motion: reduce)` 下无动画。

## 4. `ShellTaskSwitcher.vue` 卡片结构（host-ui 实现）

app 卡与 system 卡共用单一动作层（D5）：

```vue
<article class="ts-card" ...>
  <div class="ts-meta">… 图标 + 名称 + 异常 chip …</div>
  <div class="ts-thumb" :class="…">
    <AppPreviewTile
      v-if="kindOf(key) === 'app'"
      :app-id="idOf(key)"
      :last-route="lastRouteOf(key)"
      :icon="entryOf(key)?.icon ?? 'grid'"
      :icon-file="entryOf(key)?.iconFile"
      :tone="toneOf(key)"
    />
    <span v-else class="glyph-box tone-system ts-sys-glyph">…</span>
  </div>
  <!-- 唯一打开动作：绝对定位覆盖整卡（视觉层 pointer-events:none） -->
  <button class="ts-card-main" :aria-label="…" :aria-current="…" @click="switchTo(key)" />
  <button class="ts-card-x" … />
</article>
```

- `.ts-meta` / `.ts-thumb` 不再在 `<button>` 内；`.ts-card-main` 是 `position:absolute; inset:0` 的空按钮，`z-index` 低于 `.ts-card-x`。
- 预览容器不进无障碍树（`inert` + `aria-hidden`），卡片按钮仍以应用名播报。
- system 卡保持现有品牌渐变 + 36px glyph（渐变 `thumbStyle` 只用于 system 卡）。
- `lastRouteOf(key)` 从 `@/shell/mount/appSession` 取 `lastRouteOf(idOf(key))`。
- 不改动作转发（`state.activateCard` / `closeCard` / `stopAllCards`）。

## 5. 宿主测试（host-tests）

### Seam 2 — `src/__tests__/shell/appPreviewTile.test.ts`（happy-dom + @vue/test-utils）

mock：`@/shell/mount/useAppMount`（`mountAppPreview` + `PREVIEW_MOUNT_TIMEOUT_MS: 3000`）、`@/utils/appCommands`（`appInvoke` / `appStorageGet` / `refreshChannelToken` / `appStorageSet` / `appStorageDelete`）、`@/stores/settings`、`@/composables/usePlatform`、`@/utils/frontendLogger`；`@/utils/invoke`（ShellAppTile → appIcons 会调）。必要时 mock `@/shell/composables/appIcons`。

至少 8 条：①无 mountPreview（返回 null）→ fallback 可见 + `data-preview-state="fallback"`；②成功 → env 含 appId/lastRoute/locale/theme，root 有内容，fallback 隐藏，`ready`；③抛错 → fallback + `logger.warn` + 无 unhandled rejection；④假定时器推进 3000ms → fallback；⑤卸载 → `handle.unmount()`；⑥晚到结果（卸载后才 resolve）→ handle 被 `unmount()`；⑦`refreshChannelToken` / `appStorageSet` / `appStorageDelete` 均未被调用；⑧容器 `inert` / `aria-hidden="true"` / style 含 `pointer-events: none`。

### Seam 3 — `recentsWiring.test.ts` 扩展

- app 卡缩略区使用 `AppPreviewTile`，system 卡仍走 glyph 分支；
- 预览容器**不在** `<button class="ts-card-main">` 内部（D5 单动作层）；
- 保留既有断言（信息条在缩略区前、图标打头、无「运行中」chip、`.ts-thumb { flex: 1`、3 列网格）。

### L5 — `hostAppBoundaryLock.test.ts` 追加

- `APP_ENTRIES.length === 4` 非空转断言保留；
- 四个 `entry.ts` 均导出 `export async function mountPreview(` 且含 `appId` / `appInvoke` / `appStorageGet` / `lastRoute` / `locale` / `theme` 字段；
- 宿主 `useAppMount.ts` 声明 `AppPreviewEnv` / `AppPreviewHandle`，且 `AppBundleModule` 里 `mountPreview` 为**可选**（`mountPreview?:`）；
- 反向守卫：`AppPreviewTile.vue` 与 `useAppMount.ts` 预览路径不得出现 `refreshChannelToken` / `appStorageSet` / `appStorageDelete`（`AppPreviewTile.vue` 里出现即红）。
- 先红后绿证据：Phase B 落地前的应用树必须逐一点名四个 entry 缺失；落地后绿。

## 6. Phase B — 四个 app（每个 app 一个 teammate）

### 6.1 `entry.ts` 追加（在既有 `AppMountHandle` 之后）

§1 的 `AppPreviewEnv` / `AppPreviewHandle` / `MountPreview` 三段**逐字照抄**，然后：

```ts
/** 多任务卡片只读预览面（宿主在卡片缩略区挂载；失败 / 超时宿主回退品牌卡） */
export async function mountPreview(
  root: HTMLElement,
  env: AppPreviewEnv,
): Promise<AppPreviewHandle> {
  if (env.locale === 'en' || env.locale === 'zh-CN') i18n.global.locale.value = env.locale
  const app = createApp(PreviewCard, { env })
  app.use(i18n)
  app.mount(root)
  return {
    async unmount() {
      app.unmount()
    },
  }
}
```

（`i18n` 是该 app 既有 i18n 实例；PreviewCard 路径按 §6.2。）

### 6.2 预览组件 `src/preview/PreviewCard.vue`

- props：`{ env: AppPreviewEnv }`（由 entry 传入；也可再拆 `:app-id` 等，但 env 必须真传）。
- **只读、点时刻、轻量**：`onMounted` 里用 `env.appInvoke` / `env.appStorageGet` 拉一次数据；先渲染骨架 / 空态，**不要 await 完数据才 resolve mountPreview**。
- 禁止：`invoke` / 写删存储 / `onEvent` / 启动通知 / 轮询 / 定时器残留 / 全局事件监听 / iframe / 主 App.vue / 主 router / 主 pinia / 主 stores / 模块级可变单例依赖。
- 渲染 DOM **不得含可聚焦控件**：`button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])` 必须为空。
- 数据拿不到 / 命令失败 → 应用自己的诚实空态（不编造运行中内容），不抛错、不弹 toast。
- 只读摘要（D11）：bedcode 会话标题/连接状态；agent-hub CLI 检测概览；ai-chatbox 当前对话标题 + 最近 2–3 条消息摘要 / 未配置空态；file-transfer 对端在线 + 活动任务摘要。
- 样式：scoped / 唯一根类名；用 app 既有 CSS 变量与字号档；不写全局选择器；`width/height:100%` 填满容器；`env.theme` / `env.locale` 适配。
- 文案走 app i18n（en + zh-CN 都加；遵守各 app 既有 i18n 前缀纪律）。

### 6.3 测试 `src/__tests__/preview.test.ts`

至少：①正常数据渲染（mock env，断言关键文本 / 数量）；②空态或命令失败 → 诚实空态且不抛；③无副作用（不调 `invoke` 之外写面；无 interval/listener）；④`unmount` 清理（挂载 → 卸载 → 无残留时机 / 断开标志）；⑤预览 DOM 无匹配 §6.2 选择器的可聚焦控件；⑥`entry.ts` 源码导出 `mountPreview`（文件扫描）。

### 6.4 每个 app 的验收命令

```
cd apps/<slug>/desktop
pnpm run test:run          # 全绿
pnpm run build:frontend    # 成功（bundle 含 mountPreview）
pnpm exec vue-tsc --noEmit  # 无新增错误（app 若有既存错误，记录基线后只保证不新增）
cd ../../.. && pnpm exec eslint apps/<slug>/desktop/src   # 0 error
```

## 7. 平台验收命令（Lead 收口）

```
cd wasmnest-desktop && pnpm run test:run
cd wasmnest-desktop && pnpm exec vue-tsc --noEmit
cd wasmnest-desktop && pnpm exec eslint src
cd wasmnest && pnpm run check:manifest      # 未前移 apps tag 时应保持现状通过
```

真实宿主目验（`pnpm run tauri:dev`）由用户执行，交付说明列出步骤与未跑项。
