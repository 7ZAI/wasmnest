# 应用表面保活 + 服务型应用不进多任务（双端）— 实施规格

> 状态：**表面保活 = 双端已实施（自动测试通过，待 §6.2 手工验收）**；**服务型应用不进多任务 = 双端已实施（2026-10-23 二次澄清后当日补期，自动测试通过，待 §6.3 手工验收）**。
> 关系：在 `backgroundTransport` 运行期租约（`.scratch/2026-10-22-app-scoped-service-leases/spec.md` §14）之上，
> 补齐「后端在跑 → 前端也别死」与「服务型应用不进切换器」两条产品/机制口径。
>
> 一句话：**应用只要没被停用，切走就只是「藏起来」，不是「拆掉」；服务型应用（L1/L2）不产卡片，停用只走应用管理（后者仅登记，未实施）。**

## 1. 背景与结论

现状复盘：

| 维度 | 桌面 | 移动 |
| --- | --- | --- |
| 后端实例 | 切走保持（运行态与界面解耦） | 同 |
| 前端 DOM / 组件状态 | **切走即销毁**（`AppMountSlot` 离开 → `unmountAppBundle`） | **切走即销毁**（`ShellHost` 单屏 `<component :key>`） |
| 后台渲染 / 动画 | 无 | 无 |
| 服务型应用（L1/L2） | 打开会产多任务卡 | 运行中会出现在切换器 |

用户裁决（2026-10-23）：

1. **不理会 OS 层面的限制**（移动端进程保活另立票据）。
2. 只要应用没被关闭，无论怎么切换应用，后台应用都要保持运行，**包括前端的展示效果**；
3. 服务类型的 wasm 应用启动后**不出现在多任务切换器**；它们只能通过「应用管理」关闭，双端一致。
   **（2026-10-23 二次澄清后当日补期实施，见 §3.3。）**

## 2. 语义定义（本 spec 的「保持运行」）

「保持运行」分三层，本 spec 明确取第 1、2 层，**不取第 3 层**：

| 层 | 语义 | 本 spec |
| --- | --- | --- |
| 后端实例 / 租约 | wasm 实例、定时器、总线、传输面继续工作 | ✅ 已有 |
| 前端 DOM / 组件状态 | 切走后 DOM 与组件实例保留；回来时滚动 / 表单 / 列表 / 内存路由原样 | ✅ 新增 |
| 后台持续渲染 / 动画 | 切走后仍以 60fps 出帧（rAF / CSS 动画继续跑） | ❌ 不做 |

理由：

- 后台渲染是纯成本（GPU / CPU / 耗电），且对「切回来原样」没有贡献；
- 桌面所有应用共享同一个 webview，后台应用继续渲染会与前台应用抢主线程；
- 隐藏方式决定可见性语义：本 spec 用「脱离文档」/`display:none`，DOM 保留、渲染停止、JS 定时器继续（与「应用还在跑」一致）；
- 若将来要「活体缩略图 / 后台动画」，作为独立能力另裁（需要显式 opt-in 与配额）。

### 2.1 表面实例生命周期（两端同一口径）

```
首次打开（activate 成功 + 第一次进入应用面）
  → 创建表面实例（前端 Vue 实例 / 挂载包）
切换应用 / 回主屏
  → detach：DOM 保留、组件实例保留、从文档移除（不渲染）
  → 调 setActive(false)（可选契约，供应用暂停轮询）
再次打开
  → attach：同一实例放回挂载槽（不重新 import / 不重新 mount）
应用停用 / 卸载 / 进入不可服务终态
  → dispose：unmount + 移除 DOM + 释放界面租约
```

容量：实例数 = 「打开过且仍在运行」的应用数；停用即回收，不做 LRU 缓存淘汰（运行中应用是用户显式状态，不该被静默回收）。

### 2.2 与传输面租约的关系（行为变化，显式记录）

- 界面租约（`plugin_surface_open/close`）的 acquire 点从「每次挂载」变为「**首次创建表面实例**」，release 点从「每次卸载」变为「**dispose（停用/卸载）**」。
- 连带结果：**打开过一次且仍在运行的应用，即使回到主屏，也继续持有界面租约**；只有停用才停播。
- `backgroundTransport`（manifest opt-in）仍是另一条独立路径：**从未打开界面也要在线**（例如 boot autostart 的服务端应用）；两者都只对已注册 HTTP/WS 端点的应用生效。
- 「零应用 = 零广播」不变：全部应用停用 / 宿主退出 → 无 holder → 停服。

## 3. 双端机制

### 3.1 桌面（机制 B 的「保活半边」）

应用前端仍是**独立构建的挂载包 + 独立 Vue 实例**，宿主不 import 应用源码。变化只在「往哪里挂、什么时候销毁」：

- `useAppMount` 维护 `appId → { host(容器), handle, active }` 注册表（新模块 `appSurfaceRegistry.ts`，纯 DOM 逻辑，可单测）；
- 首次打开：创建 `.app-instance-host` 容器 → `module.mountApp(host, env)`；
- 切走：`detachAppBundle(appId)` 把容器从挂载槽移除（保留引用与实例）；
- 切回：`attachAppSurface(slotEl, appId)` 把同一容器放回槽位（**不刷新通道令牌 / 不重建实例**）；
- 停用 / 卸载：`disposeAppBundle(appId)` 真销毁；由 `ShellHost` 监听运行态（`useShellApps.plugins` 的 state）触发，覆盖「应用管理停用 / 全部关闭 / 卸载 / 错误终态」所有路径；
- `ShellHost` 的应用挂载槽改为**常驻渲染**（`v-show="isAppRoute"`），不再随路由分支销毁——这是「切 home 不卸载」的关键；
- 挂载契约新增**可选** `setActive?(active: boolean)`（`AppMountHandle`），detach/attach 时调用；旧应用不实现零影响，`MOUNT_CONTRACT` 不 bump（新增可选成员是兼容变更）。

### 3.2 移动（运行面池 + Teleport）

移动端的应用表面是 Vue 组件（`ui.registerSurface` / 数据源解析），不能用桌面那套「移动容器」：

- 新增 `useAppSurfaces`（模块级单例）：`opened`（打开过的 appId）、`outletEl`（当前运行屏提供的插槽）、`isSurfaceActive`；
- `ShellAppRunScreen` 不再直接渲染 `ShellAppSurface`，只提供**插槽 DOM** 并在挂载 / 卸载时登记 / 注销；
- `ShellHost` 在壳根渲染一个 `display:none` 的**运行面池**：对每个「打开过且运行中」的应用，用一个 `<Teleport>` 渲染 `ShellAppSurface`；
  - 当前应用在运行屏：`Teleport` 目标 = 运行屏插槽（DOM 移过去，组件实例不重建）；
  - 其他应用 / 不在应用面：`Teleport disabled` → 内容留在池里（`display:none`，实例与状态保留）；
- 应用停用 / 卸载 → 从「运行中」集合消失 → 池内条目移除（组件 unmount），并清掉 `opened` 记录（下次启动是全新实例）；
- 可选 `provide(SURFACE_ACTIVE_KEY, computed(boolean))`：应用 surface 可注入该响应式布尔值，在后台暂停轮询/动画（不注入也不影响保活）。

### 3.3 服务型应用不进多任务（已实施，2026-10-23 当日补期）

> 2026-10-23 二次澄清后当日实施：桌面 `useShellState` 增 `enterServiceFace` / `isServiceFace`（`openApp` + `syncFromRoute` 同判据不入卡）、`ShellContextMenu` 隐藏「停用」；移动 `ShellSwitcherScreen` 双来源过滤。验收见 §6.3。

判定 = manifest `type`（装配角色）`basic-service` / `internal-business`（`isServiceKind`）。

- 桌面：
  - `useShellState.openApp` 对服务型应用**不调 `enterFace` 入卡**，改用 `enterServiceFace`（只置 `activeCard` / `screen='card'`，不动 `cards`）；
  - `syncFromRoute`（外部路由跳转的入口）同判据，避免直达服务路由时补卡；
  - 多任务切换器 / 「全部关闭」天然只消费 `cards` → 服务型应用不出现、也不会被「全部关闭」误杀；
  - 右键菜单**隐藏「停用」项**（服务型应用的关闭只留应用管理页）；
  - 应用管理页（`SysAppsView`）保留「停用」按钮 = 唯一关闭入口。
- 移动：
  - `ShellSwitcherScreen` 的卡片集合（运行中 + 最近使用）过滤 `isServiceKind`；
  - 应用详情页已有「停用」= 唯一关闭入口；
  - 服务型应用仍可从主屏「服务」区打开，回主屏后按 §2 保活。

排期时需补的验收：桌面「打开 monitor 不产卡 / 多任务无此卡 / 右键无停用 / 应用管理可停」；移动「运行中与最近使用两张来源都过滤服务型 / 详情页可停」。

## 4. 契约与文档变更

| 面 | 变更 |
| --- | --- |
| `AppMountHandle`（桌面宿主声明 + app `entry.ts` 同形重复） | 新增可选 `setActive?(active: boolean): void`；不 bump `MOUNT_CONTRACT` |
| 移动 surface 环境 | 可选 `provide(SURFACE_ACTIVE_KEY)`；不新增 WIT / 权限位 |
| `useAppMount` 公开面 | 新增 `attachAppSurface` / `detachAppBundle` / `disposeAppBundle` / `hasAppSurface` / `listAppSurfaces`；`unmountAppBundle` 退化为 `disposeAppBundle` 的兼容别名 |
| 文档 | `docs/architecture.md` §2、`docs/frontend.md` §2、`AGENTS.md` §2 的「装载即建、卸载即销毁」改为「停用即销毁；切换只隐藏」；补充服务型应用不进多任务 |
| 传输面 | 见 §2.2：界面租约释放点移到 dispose；`backgroundTransport` 语义不变 |

## 5. 非目标

- 不做后台持续渲染 / 动画（见 §2）；
- 不做移动端 OS 级保活（前台服务 / 开机自启，另立票据）；
- 不做「服务型应用无界面启动」的新 UI 入口（仍靠打开或 autostart）；
- 不做多任务活体缩略图（现有 `mountPreview` 点时刻预览不变）；
- 不改变 `backgroundTransport` 的清单/权限门禁。

## 6. 验收

### 6.1 单元 / 锁

- 桌面 `appSurfaceRegistry.test.ts`：attach / detach / dispose / setActive 调用序；detach 不销毁、dispose 才 unmount；重复 attach 幂等。
- 桌面 `appSurfaceKeepAlive.test.ts`（源码锁）：`ShellHost` 常驻挂载槽 + 运行态 disposer；`AppMountSlot` 离开只 detach。
- 移动 `useAppSurfaces.test.ts`：mark / drop / outlet / active 判据。
- 移动 `shellAppRunScreen.test.ts`：运行屏提供 surface 插槽并登记 opened；不再直接渲染 surface。

### 6.2 手工验收

1. 桌面打开 BedCode → 回主屏 → 再开别的应用：BedCode 的 wasm 实例与传输面不停；切回 BedCode，输入框 / 滚动 / 页面停在上次位置。
2. 移动打开任一应用 → 回主屏 → 进另一个应用 → 切回：界面状态原样（不重新加载）。
3. 停用应用后：其表面实例销毁（不在内存中残留），再次打开是全新状态；界面租约按 §2.2 释放。

### 6.3 服务型应用不进多任务（单测已过，待手工验收）

自动测试（2026-10-23 全绿）：

- 桌面 `useShellState.test.ts`：openApp 服务面不产卡 / syncFromRoute 直达服务路由不补卡 / 业务应用守卫不外溢 / 「全部关闭」不误杀无卡服务应用。
- 桌面 `shellCtxMenuServiceGuard.test.ts`：运行中服务无「停用」也无「启动」；未运行服务可「启动」；业务应用不变。
- 移动 `shellRecents.test.ts`（C-S24）：运行中与最近使用两个来源都过滤服务型。

手工验收（待跑）：

- 桌面：打开 monitor（L2）不产卡；多任务里没有它；右键无「停用」；应用管理页可停。
- 移动：运行中与最近使用两个来源都过滤服务型；详情页可停。
