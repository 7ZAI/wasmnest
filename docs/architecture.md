# 架构硬约束：宿主机机制、业务归应用（+ 数据 / 协议）

> **本文件是 `AGENTS.md` 的拆分文档（架构）**：宿主薄壳红线（B1–B6 判据与三问）、桌面挂载形态、退役面纪律、双端差异与锁步、权限与安全闸门总览、数据库、跨端协议。
> 本文件与 `AGENTS.md` 的硬约束**同级别**。机制实现落点见 `docs/codemap.md`；权限声明面见 `docs/contracts.md`；安全红线见 `docs/security.md`。

**一句话**：宿主只含「应用无关的通用引擎 + 安全闸门 + 装配机制」，一切产品概念（会话、终端、设备连接、文件传输、AI、Agent……）都是 wasm 应用。

## 1. 宿主侧无业务代码（强制红线）

**判定：宿主只回答「机制怎么做」，不回答「这件事是什么、给谁用、怎么组织」。**

### 1.1 口径：六条判据（命中任一即业务代码）

这是裁决词汇，报错信息与代码注释里直接用编号：

- **B1** 产品类型 / 字段：宿主以业务名词定义数据结构、枚举、状态、常量
- **B2** 业务编排 / 状态机：按产品语义推进的流程、队列、重试、封顶、状态迁移
- **B3** 业务真源：宿主持有产品事实的权威存储并对外读写
- **B4** 业务投影：把原语结果翻译成产品 wire 形状再对外消费
- **B5** 业务默认值 / 策略：宿主替插件决定「业务上该怎样」
- **B6** 业务生命周期挂钩：宿主解释产品事件并主动回调插件

### 1.2 归属裁决（三问，顺序不可颠倒）

1. **离宿主能实现吗？** 能（插件已有 `host-*` 存储 / 总线 / 事件 / 任务原语自建）→ **放插件**。
2. **携带产品语义吗？** 命中 B1–B6 → **放插件**。
3. 都不命中 → **放宿主**，且必须满足：WIT 纯增量（或走 ABI bump 流程，docs/contracts.md §3）、权限位有门禁落点、停用可回收。

「宿主已经能拿到这些数据」**不是**留在宿主的理由；判不准时从严判并停下问用户（AGENTS.md §0 优先级 2）。

### 1.3 宿主允许存在的四类薄壳

① **引擎实现** · ② **安全闸门**（权限判定、fail-safe 默认如「无应答 / 超时即拒」、配额仲裁）· ③ **通用注册表与寻址** · ④ **零解析窄转发**。四类之外的任何「顺手加的」业务逻辑都是越线。

### 1.4 强制执行机制

- **防回接锁**：越线回接会直接测红（锁清单见 docs/codemap.md §8）；新增退役面时同步补锁。
- **真源搬迁必配 fail-visible 三形态，缺一不可**：① 旧读路径删除或显性报错，**禁止**改成「查不到就返回空」② 旧 ABI 产物在实例化期点名缺失 interface 与重建版本 ③ 退役权限位 / 命令字眼加载即抛。
- **提交前自检**（改动落在宿主侧时逐条回答，答不出就停下问用户）：① 在宿主有第二个消费者吗？② 删掉它，第三方插件能用同一形状的既有原语自建吗？③ 是否新增了对产品事件的解释或回调（= B6）？
- **越线处理**：确需越线时停下向用户确认并记决策，禁止自行放松红线。
- **落地顺序**：ABI bump + 双端 WIT 副本同步 + 移动端影响评估（docs/contracts.md §3）。

## 2. 桌面端宿主形态（壳 + 挂载槽，机制 B / ADR 0057）

- **宿主壳**（`wasmnest-desktop/src/`）：主屏 + 系统页（`/sys/:pageId`：设置 / 应用管理 / 权限与授权）+ 挂载槽。**宿主零业务状态**——不持有任何 app 内部状态（装载即建、卸载即销毁）。
- **应用是独立构建的挂载包**：宿主经 `plugin_get_asset_dir` 拿到产物根目录，`useAppMount` 动态 import `<id>/index.js`，入口契约 `mountApp(root, env): Promise<AppMountHandle>`（`AppMountEnv`：`appId` / `invoke` / `appInvoke` / `appStorage*` / `locale` / `theme` / `initialRoute` / `onEvent`；`onEvent` 当前两事件：`'navigate'` 请求壳路由跳转、`'route'` 应用自报内部当前页）。**前端不拼产物路径**（resource 层级差一层就是 404 静默断裂，有锁）。
- **多任务卡片预览面（可选能力，2026-10-20）**：同一挂载包还可选导出 `mountPreview(root, env): Promise<AppPreviewHandle>`（`AppPreviewEnv`：`appId` / `lastRoute` / `appInvoke` / `appStorageGet` / `locale` / `theme` / `platform`；**无宿主 `invoke` / 写存储 / 事件出口**）。预览面 = 应用在卡片缩略区**自绘**的只读点时刻视图，**不是截图**——后台应用离开应用面即卸载、没有 DOM 可抓（机制 B 不受影响）。宿主只负责容器 / 装载 / 3s 超时 / 卸载；缺失 / 抛错 / 超时 → 回退品牌渐变 + 图标，不白屏。能力声明 = bundle 是否导出 `mountPreview`，宿主不维护预览名单；预览实例与主应用实例生命周期独立（当前前台应用的卡也会挂预览），预览路径**禁止换发通道令牌**（旁路展示不得改主实例身份绑定）。
- **路由真源**：`src/shell/composables/useShellApps.ts` 的 `SURFACE_ROUTES` + `src/router/index.ts` 逐条路由（应用路由全部指向 `AppMountSlot`；未匹配落显性 not-found，不白屏）。新增桌面应用必须同步（docs/codemap.md §6 任务路由行）。
- **传输面租约两种作用域**（`net.transport`，service-leases）：普通应用跟**界面挂载**（挂载 acquire / 卸载 release，`plugin_surface_open/close`）；服务端型应用（manifest `backgroundTransport: true`）跟**运行期**（启动成功 acquire、停用 / 启动失败 / Error 由内核 `release_all_for` 回收），界面开关在宿主命令层 no-op——服务端属性不随界面槽消失。声明必须与 `ws:server` / `network:http` 同声明（构建期 + 加载期双侧校验），且端点注册仍是预登记（注册本身不启动监听器）。spec：`.scratch/2026-10-22-app-scoped-service-leases/spec.md` §14。
- **热更新闭环**：改 app 源码 → vite rebuild → 复制进资源目录 → 宿主 watcher `plugin:dev-reload` 重载前端；`tauri:dev` 自带缺口预建（别在宿主冷构建期间手工往 `src-tauri/` 拷产物，会触发重启风暴，机制见 `scripts/dev-run.js` 头注释）。
- **壳标题栏常驻**：所有 app 页面共用壳标题栏，应用只占其下区域（`appChromeLock` 钉住）。

## 3. 退役面纪律（fail-visible 与防回接）

- 已退役的宿主面（如 `host-session` / `host-terminal` 词汇、旧贡献面 `registerSidebarPanel`、旧 UI 路由 / 按钮）**连同权限位整体退役**，不得回接；回接由锁与 Rust 测试双重拦截（如 `capability_crates_no_product_ids.rs`、移动 `retiredHostUIRetirementLocks`）。
- 退役路径上的异常必须**显性**：旧插件调用退役扩展点 → 桩函数当场点名报错（如移动 `src/plugin/context.ts` 的四点抛错桩），不得 undefined 崩溃或静默忽略。
- 调试点名与「墓碑」注释是团队惯例：注释里保留的退役说明是**设计资产**，不要顺手删除。

## 4. 双端差异与锁步（勿把桌面结论套到移动端）

- **单形态运行时（单一 crate · 一份壳）**：机制内核 = 能力仓 `../wasmnest-lib/wasmnest-wasm-core`（**无 common/bare 形态之分**）。桌面开 `desktop-assembly` 装配面；移动 `default-features = false` 拿统一机制 + 运行时壳。**WIT 绑定、端事实与端 SDK 依赖全部在各端宿主**（`src-tauri/src/plugin/**`）：宿主各域实现经统一注册汇入 Linker，`AbiPolicy` 由宿主装配时注入（桌面要求组件形态 `abi-form`，移动不约束）。
- **双端契约各自演进（compose 组合，不做 union）**：核心 WIT + 能力域分片可被任意端组合；端独有功能的声明与实现都住端宿主（桌面端：`cap-desktop.wit` 等端 cap；移动端：`cap-mobile.wit`）。**移动不跟演**桌面部分 ABI 破坏性变更；但**跨端协议（HTTP / WS / QR / 认证）改动必须两端同步部署**（§6）。
- **WASI 面是共享机制**：双端默认全开，开 / 关走运行期配置，不要把它当形态差异轴。
- **双端单产物（file-transfer）**：移动宿主为桌面专属 interface 提供 **fail-visible 桩**（`desktop-compat`，`Err("unsupported on mobile: …")`）——桩只为 import 闭合，**不是「移动端实现桌面能力」**；真实调用 = 平台探测失效，错误当场点名。
- **共享模块形态不同**：桌面挂载包**自带全部依赖**（无 externals；宿主锁禁止 `__WASMNEST_SHARED__`）；移动共享 vue / vue-i18n / pinia 于宿主全局 `__WASMNEST_SHARED__`（经 SDK 代理访问，插件不直接操作全局）。
- wasmtime 双端同版本（docs/commands.md §1）；升级先做双端影响评估。

## 5. 权限与安全闸门总览（宿主侧的唯一入口）

> 权限的**声明面**（plugin.json / 权限词汇真源 / egress 三层判定细节）在 docs/contracts.md §4；此处是机制总览与闸门清单。

- **权限**：无默认授予；生效权限 = manifest 声明 ∩ 用户批准（移动审批 = 内容 **SHA-256 钉扎**，批准后目录被替换 → 批准自动撤销，必须重新人工审批）；词汇真源 = 本端 SDK `permission.rs`。
- **egress（出站）**：三层判定（目标白名单 → 声明 `preauthUrls` → 记忆）+ 未命中一次授权弹窗；无 app_handle 的无头 / 测试上下文 **fail-closed**（收紧为「判定失败」而非放行）。
- **文件系统**：三层授权链（预授权目录 → 已授权前缀 → 弹窗授权，「记住」按目录落账）；`fs:pick` 与 `fs:read/write` 分域。
- **能力层（Tauri ACL）与 CSP**：引擎级封禁前端直连（docs/frontend.md §1），ACL 未写即运行期拒。
- **错误信封（ADR 0030）**：跨进程失败一律 `{ code, request_id, params? }`；`code` 即前端 i18n key，技术细节（错误原文 / 堆栈）不出产生方、只进宿主日志。

## 6. 跨端协议

- HTTP / WS / QR / 认证 / 文件传输协议的改动**必须两端同步部署**，遵循「老端忽略未知字段」的增量原则，禁止破坏性替换。
- 真实互连门禁在 `../wasmnest-test/cross-end-tests`（同进程 path 依赖两端 `src-tauri`，零 mock）——改传输 / 认证 / 配对面必去跑。
- wasmtime 升级必须两端同步（ADR 0019，docs/commands.md §1）。

## 7. 数据库

- 主库 schema 单一事实源在能力仓 `../wasmnest-lib/wasmnest-wasm-core`（`db.rs` + `db/schema.sql`）；迁移**必须幂等**；禁止手改生产库；改 schema 必须补幂等测试。
- 插件存储隔离：插件 KV 走 `plugin_storage` 表（属主分区 / 前缀纵深 / 护栏）；系统空间 `__system__` 只用于宿主机制（如审批记录），不占插件命名空间。

## 8. 运行监控（host-metrics）

- **机制**：能力仓 WIT `host-metrics` 只暴露一个只读原语 `snapshot: func() -> result<string, string>`（JSON 字符串），world core 的 import 数 8 → 9。快照内容 = 内核 `MetricsRegistry::snapshot()`：每插件 Store 线性内存当前 / 峰值、导出调用次数 / 在飞 / 耗时直方图、燃料、生命周期计数与最近时间、trap 原因分布、grow 被拒、激活耗时、授权决策、总线背压、配额上限；另含注册制系统段（当前 `task`）。
- **不是业务**：指标是宿主机制对自身运行时的观测（B1–B6 均不命中）；宿主只做原子记账与快照拼装，不解释「监控应用要展示什么」。
- **权限**：单一 `metrics:read`（`PERMISSION_METRICS_READ`），一个授权位可读**所有已加载插件**的聚合指标——这是监控用途的必要面，也意味着可据此推断其他应用活跃度（侧信道），权限描述已写明。门禁落点 = 内核 `core_binding.rs` 的 `host-metrics` Host impl 首行 `check_permission`；未声明 / 未批准即 `Err`。monitor 是随包应用（`PluginSource::Wasm`），宿主审批门对非 `UserInstalled` 来源跳过 ⇒ 该权限由 manifest 自动授予，没有用户可见审批窗；若产品要求随包应用也弹同意，需新增授权形态。
- **装配**：快照源由装配面注入 `WasmHostContext::set_metrics_snapshot_source(runtime.monitor())`（桌面 `manager/host.rs`、移动 `plugin/manager.rs`）。未装配（无头 / 测试上下文）返回 `Err`，**不返回 `{}`**——否则监控应用会把断链显示成「没有插件」。
- **卸载语义**：卸载插件时同步 `MetricsRegistry::remove(plugin_id)`，快照与已加载插件集合保持一致；停机重载 / 重装不清空（累计计数延续）。
- **应用**：`wasmnest-apps/servers/monitor`（id `com.wasmnest.monitor`）是 **L2 系统服务**（`type: internal-business`），随包分发、不可卸载、默认自启（用户可关）；桌面路由 `/monitor`，移动 `ui.registerSurface`。前端 1s 轮询 `monitor.snapshot`，指标快照覆盖**所有** wasm 应用（目标应用不能拒绝）；`plugin_meta` 段附带 name / kind 供移动端做服务 / 应用分类。自定义监控面板由其他应用在 `contributes.monitorPanels` 注册、宿主中介装载。`task` 段按端裁剪。
- **诚实边界**：`quota.*` 是配额**上限**不是实时占用（wasmtime 不暴露每 Store 的 memories / tables 实时数量）；当前运行态不在快照里，桌面经既有 `plugin_list_loaded` 合并，不为监控新增宿主业务状态。
- **fail-visible**：指标命令失败 / 未授权 / 快照源缺失时监控页显示明确错误与重试，保留旧数据时标记「已过期」，不使用空表冒充正常。
- 规格与决策记录：`.scratch/2026-10-21-monitor-app/spec.md`。