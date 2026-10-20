# 双端「运行监控」应用（monitor）— 实施规格

> 状态：机制侧 + 应用侧已实施（2026-10-21）。发布清单 / tag 收口待用户授权。
> 关联：能力仓 `wasmnest-lib`（WIT / host-kit / wasm-core）、平台仓（宿主装配 / SDK / 路由）、
> 应用仓 `wasmnest-apps/apps/monitor`。

## 1. 决策（已裁决，不再重开）

| # | 决策 |
| --- | --- |
| Q1 | 监控 = **独立 wasm 应用** + 宿主新增**只读** WIT 原语（不是宿主壳内置页、不是 debug 面板） |
| Q2 | 「系统应用」= 普通 L3 wasm 应用，仅「随包分发 + 主屏默认在场」；**不新增** `system: true`、不归 L1 `basic-service`、不做不可卸载守卫 |
| Q3 | 首版指标 = 透传现有 `snapshot()` + 6 项低成本补齐（trap 原因、grow 被拒、配额上限、激活耗时、in-flight、当前状态 / 最后变更） |
| Q4 | 双端同版，同一 WIT + 同一前端整包；桌面先合入、移动跟随；指标按端裁剪（移动不展示桌面宿主任务池） |
| Q5 | 单一 `metrics:read` 权限位，**一次授权看全部插件**；不做逐插件授权、不做免授权；权限描述写明侧信道 |
| Q6 | v1 纯实时（页面打开才 1s 轮询），无历史持久化、无系统通知告警；阈值只做页内高亮 |
| Q7 | 文档 = 本 spec + 平台 `docs/architecture.md`「运行监控」节 |

### 次级决策

- WIT：`snapshot: func() -> result<string, string>`（JSON 字符串；失败 fail-visible）。
- 权限串：`metrics:read`；API 审计名：`metrics.snapshot`。
- 应用 id：`com.wasmnest.monitor`；`rustLibrary`：`wasmnest_plugin_monitor`；目录 slug：`monitor`。
- 轮询周期：1s（前端 `setInterval`，卸载即清；页面隐藏时跳过）。
- 桌面路由：`/monitor`；移动：`ui.registerSurface` 整页运行面。

## 2. 机制侧（能力仓 / 平台仓）

### 2.1 WIT 与权限

`wasmnest-lib/wasmnest-wasm-core/wit/core.wit`：

```wit
/// 只读指标快照（JSON 字符串）
/// - 全局可见：授权一次即可读所有已加载插件的聚合指标；
/// - 快照源未装配（无头 / 测试上下文）时 Err（fail-visible，不返回空对象冒充）。
interface host-metrics {
    snapshot: func() -> result<string, string>;
}
```

- `world core` import 数 8 → 9。
- 权限词汇四份同步：能力仓 `permission.rs`（宿主真源）/ 桌面 SDK `permission.rs` / 移动 SDK
  `permission.rs` / 桌面生成物 `permission-vocabulary.json`（33 条）。
- 门禁落点 = 内核 `core_binding.rs` 的 `impl host_metrics::Host for WasmPluginState` 首行
  `check_permission(PERMISSION_METRICS_READ)`；未声明 / 未批准即 `Err`。
- 桌面 `bin/manifest-gen.js` 的 `RUST_PERMISSION_RULES` 增加 `metrics_snapshot → metrics:read`
  （构建期自动把权限位补进 manifest，减少手抄漂移）。

### 2.2 快照数据形状（宿主契约）

顶层：

```json
{
  "plugins": { "<plugin_id>": { ...PluginMetricsSnapshot } },
  "task": { "jobsSubmittedTotal": 0, "...": "宿主任务池（系统维度段）" }
}
```

`PluginMetricsSnapshot`（snake_case，字段形状即契约）：

- `memory_current_bytes` / `memory_peak_bytes`
- `calls_total` / `calls_in_flight`
- `fuel_consumed_total`
- `call_duration_us_total` / `call_duration_us_max` / `call_duration_buckets`（6 桶）
- `lifecycle`（instantiate / activate_ok / activate_fail / deactivate / trap / degraded）
- `lifecycle_last_unix`
- `trap_reasons`（fuel_exhausted / stack_overflow / memory_out_of_bounds / unreachable /
  host_error / other）
- `memory_grow_denied_total` / `table_grow_denied_total`
- `activation_us_total` / `activation_us_max`
- `quota`（fuel_per_call / memory_bytes / table_entries / instances / memories / tables）
- `authz`（allow / deny / require_approval / records_dropped）
- `bus`（dropped / format_rejected）

**诚实边界**：`quota.*` 是宿主配额**上限**，不是实时占用（wasmtime 不暴露每 Store 的
memories/tables 实时数量）。页面只拿内存 `current / quota.memory_bytes` 做占用条，其余
只展示上限并明示「不是实时占用」。

### 2.3 装配与失败语义

- 桌面：`manager/host.rs` 构造 `WasmHostContext` 后注入
  `set_metrics_snapshot_source(wasm_runtime.monitor())`。
- 移动：`wasmnest-mobile/src-tauri/src/plugin/manager.rs` 同形注入。
- 未装配 → `UnimplementedMetricsSnapshot` 返回 `Err`（**不返回 `{}`**；否则监控页会把断链
  显示成「没有插件」）。

## 3. 应用侧（`wasmnest-apps/apps/monitor`）

### 3.1 清单

| 端 | plugin.json |
| --- | --- |
| desktop | `platform: "desktop"`, `pluginType: "rust-ts"`, `permissions: ["metrics:read"]`, `contributes.commands = [monitor.snapshot]` |
| mobile | `platform: "mobile"`, `pluginType: "wasm"`, 同上 |

Rust 命令面：`monitor.snapshot` → `WasmHost::metrics_snapshot()` 原样返回
`serde_json::Value`；`activate` 只 `log_info`（不读文件、不弹授权、不启动轮询）。

### 3.2 桌面前端

- `src/entry.ts`：`mountApp(root, env)` + `mountPreview(root, env)`（平台 L3/L5 锁钉住）。
- `src/appContext.ts`：`PluginContext` 适配 + 额外 `hostInvoke`（读 `plugin_list_loaded`
  合并应用名 / 运行态）。运行态不在指标快照里，**不为它新增宿主业务状态**。
- `src/composables/useMonitor.ts`：
  - 1s 轮询 `context.commands.execute('monitor.snapshot')`；
  - 并行 `hostInvoke('plugin_list_loaded')`（失败是软失败：只降级名称 / 状态）；
  - 同一时刻最多一个在飞请求；`stop()` 清定时器；页面隐藏时跳过刷新；
  - 指标失败保留旧数据（stale 标记），不用空表冒充正常。
- 界面：
  - KPI：插件数（运行中 / 总数）、调用总数、在飞、Trap 总数、内存峰值合计；
  - 每插件卡：状态 / id / 内存当前 / 峰值 / 上限占用条、调用数与平均 / 最大耗时、
    直方图、Trap 原因分布、生命周期计数 + 最近事件、授权决策、总线背压、配额上限（折叠）；
  - 明确错误 banner（`metrics:read` 未授权 / 快照源未装配）+ 重试；
  - 空态仅在「无错误且无数据」时出现；
  - 预览面：一次只读取数，展示插件数 / 调用 / 在飞 / Trap / 内存峰值；无可聚焦控件、无定时器。
- i18n：zh-CN / en 同步（`MessageSchema` 编译期约束）。

### 3.3 移动前端

- `src/index.ts`：注册 i18n → `ui.registerSurface({ component: MonitorView })`；`deactivate` 只落日志。
- 组件经 `inject('pluginContext')` 取命令面；`useMonitor` 同桌面（无宿主清单、`task` 段裁掉）。
- **移动端拿不到宿主插件清单**：标题显示 plugin_id（短形式），不伪造应用名 / 运行态。
- 每插件卡默认展示内存 / 调用 / Trap；生命周期、授权、总线、直方图、配额收进「更多指标」
  （原生 `<details>`，触控目标 ≥44px）。
- 指标按端裁剪：移动不展示 `task` 宿主任务池。

### 3.4 测试覆盖

- 桌面 43 项：纯函数（快照校验 / 合并 / 格式化 / 汇总）、轮询生命周期与在飞去重、
  界面成功 / 错误 / 空态 / 重试 / 卸载清定时器、挂载契约、预览只读与晚到数据。
- 移动 14 项：纯函数、轮询、界面成功 / 错误 / 空态 / 卸载、activate/deactivate 契约。
- 平台：`hostAppBoundaryLock`（L3/L5 五 app）、router、useShellApps、桌面全量 635 项。

## 4. 发布收口（待用户授权）

- `release-manifest.json`：`apps` 段加 `com.wasmnest.monitor`（`path: apps/monitor`，
  `ends.desktop/mobile.artifact: wasmnest_plugin_monitor.wasm`）。
- 能力仓 commit + 新 `lib-v*` tag → 应用仓 commit + `apps-v*` tag → manifest `repos.*.tag`
  更新 → `pnpm run check:manifest`。
- 在完成 tag 之前 `check:manifest` 必然红；不要为了变绿改判据。

## 5. 已知限制 / 后续可选

- 移动端没有宿主插件清单命令 → 只显示 plugin_id；若未来需要名称 / 状态，应走「新增宿主
  只读原语」的正规流程，不在应用里硬编码映射。
- v1 无历史曲线 / 持久化 / 告警；阈值只做页内高亮。历史/导出属新设计分叉，需重新开一轮评审。
- `quota` 是上限不是占用；不要把 instances / memories / tables 当实时数量展示。
