# 应用作用域共享服务租约（service leases）— 实施规格

> 状态：设计定稿，**已实施**（2026-10-22 用户确认四项裁决；实施记录见 §12）。
> 关联仓：能力仓 `wasmnest-lib`（机制 / 服务实现）、平台仓（双端宿主装配 / 桌面启动链）、
> 应用仓 `wasmnest-apps`（file-transfer 移动端补一次显式依赖请求）、跨端测试仓（rig / 场景）。
>
> 一句话：**依赖服务不再是宿主级常驻；由应用（插件 id）按引用记账，首个引用拉起、最后一个引用关停，双端同一套模板。**

## 1. 问题与根因（现状证据）

### 1.1 现象

移动端打开 BedCode，桌面端**没有打开 BedCode**，移动端仍能 mDNS 发现桌面并显示为可用设备。

### 1.2 根因（不是发现层，是桌面广播的生命周期）

| 事实 | 证据 |
| --- | --- |
| 桌面宿主 boot 无条件拉起 WS/HTTP 服务器（`auto_start = true` 且写死为产品决策） | `wasmnest-desktop/src-tauri/src/lib.rs:759-800` |
| 服务器 `start` 成功即广播 `_wasmnest._tcp.local.`，与「哪个应用在跑」无关 | `wasmnest-lib/wasmnest-server-core/src/supervisor.rs:231, 432-456` |
| 移动端 BedCode 发现链浏览的正是 `_wasmnest._tcp.local.` | `wasmnest-mobile/src-tauri/src/mdns/types.rs:7`；`discovery.rs` |
| 服务器只在宿主退出 / 手动 stop 时停播，不存在「应用关闭 → 停播」路径 | `system/lifecycle.rs:286-305`；`supervisor.rs:259-300` |

结论：**对外可见性 = 宿主进程活着**，而不是「有应用在提供该服务」。远程连接的实际能力（WS 端点 / HTTP 路由）由 BedCode 激活期注册，因此在「桌面没开 BedCode」时广播的是**空壳设备**。

### 1.3 同一个病灶的第二处：peer-net 节点是「单属主」，不是「多引用」

`_wasmnest-peer._tcp` 由 file-transfer 激活期 `host-peer.start-node` 拉起，生命周期方向正确，但记账是**单个 owner**：

- `PeerNetState.node_owner: Option<String>`（`wasmnest-lib/wasmnest-server-peer-net/src/lib.rs:186-187`）；
- 第二个应用请求 → `already owned by another plugin`（`lib.rs:711-735`）；
- 任意属主 `stop-node` / 停用 → 直接 `stop_locked` 关掉**所有应用共用**的节点（`lib.rs:740-762`）。

另外，移动端节点启动由宿主硬编码 `FILE_TRANSFER_PLUGIN_ID` 驱动（`wasmnest-mobile/src-tauri/src/plugin/manager.rs:696, 952, 541`），桌面端由插件自己请求（`wasmnest-apps/apps/file-transfer/rust/plugin/src/lib.rs:175-190` 有 `platform == Desktop` 分支）——双端不同构，且宿主带着产品 id（B1 风险）。

## 2. 用户裁决（2026-10-22，不再重开）

| # | 裁决 |
| --- | --- |
| Q1 | **零应用 = 零广播**（桌面完全不可被发现，不做「广播但标离线」） |
| Q2 | WS、HTTP 及其它依赖服务全部**按需启动**；WS 不再永久自启 |
| Q3 | 宿主侧**机制化抽象、双端同构**：lib 里定义 trait 标明这类服务，各自能力服务实现它，用模板方法统一处理引用记账 / 启停；允许跨仓改 lib |
| Q4 | 记账粒度 = **插件 id**（一应用一条）；同一服务被多个应用引用时记录全部应用，最后一个释放才真正关闭 |

未再单独确认、但已被上述裁决蕴含的两点（本 spec 按此实施）：

- **不做 manifest 依赖声明**：peer 依赖由既有原语 `host-peer.start-node` 表达；transport 的需求信号在认证中心拆出后改为**应用界面打开**（外壳挂载/卸载，见 §4.1 / §13），端点注册只预登记。**零 WIT / ABI / plugin.json 变更**，不引入跨版本契约成本。将来出现「应用依赖某个它不会调原语的服务」时，再加显式 acquire 原语或 manifest 声明（届时按契约流程走）。
- **宿主命令面不得创建无属主服务**：能绕过记账直接拉起服务的 `server_start` / `stop` / `restart`、`start_peer_node` / `stop_peer_node` 一并退役（均无前端 / 应用消费者，见 §7.2）。

## 3. 机制设计

### 3.1 落点

`wasmnest-lib/wasmnest-server-base/src/service.rs`（新模块）：

- `wasmnest-server-base` 已是 `server-core` / `-http` / `-websocket` / `-peer-net` / `wasm-core` 的共同底座，且已有 `async-trait`、`tracing`、tokio（现为 dev-dep，本次转普通依赖，仅 `sync` feature）；
- 不新建 crate（避免 manifest / tag / 依赖清单的额外跨仓成本），也不放 `host-kit`（`server-core` 默认形态不依赖 host-kit，放进去会破坏能力域「零宿主依赖」边界）。

### 3.2 trait（能力服务实现它，只写「怎么起、怎么停」）

```rust
/// 应用作用域共享服务的机制契约。
/// 记账 / 幂等 / 回滚 / 串行化 / 顺序 / 日志全部由 [`ServiceRegistry`] 模板方法完成；
/// 实现者只提供两个真正与领域相关的动作。
#[async_trait]
pub trait ScopedService: Send + Sync + 'static {
    /// 稳定服务键（机制词汇，全仓唯一；由定义服务的能力 crate 导出常量）
    fn key(&self) -> &'static str;

    /// 0→1：真正拉起服务。模板保证只在「引用集合从空变为非空」时调用一次。
    /// 实现必须幂等（已被拉起时返回 Ok），且失败时自行回滚半成品。
    async fn start(&self) -> Result<(), String>;

    /// 1→0：真正关停服务。模板保证只在「最后一个引用释放」时调用一次。
    /// 实现必须幂等（未运行时返回 Ok）。
    async fn stop(&self) -> Result<(), String>;
}
```

### 3.3 注册表（模板方法：唯一处理引用记账的地方）

```rust
pub struct ServiceRegistry { /* key -> Arc<Slot> */ }

struct Slot {
    service: Arc<dyn ScopedService>,
    state: tokio::sync::Mutex<SlotState>,
}

struct SlotState {
    holders: BTreeSet<String>,   // 插件 id 集合（Q4：按应用记录）
    running: bool,
}
```

对外 API（全部 `pub`，能力域 / 宿主只经这些入口）：

| API | 语义 |
| --- | --- |
| `register(Arc<dyn ScopedService>) -> Result<(), ServiceError>` | 同 key 重复注册 = 显性错误（装配期编程错误）；生产装配点唯一 |
| `acquire(key, holder) -> Result<AcquireOutcome, ServiceError>` | 幂等：已持有 → `AlreadyHeld`；他人持有且 running → `Attached`；空集 → 调 `start()`，成功才落 holder（`Started`）；`start` 失败 → **不落 holder** + 返回 `StartFailed`（下次可重试） |
| `release(key, holder) -> Result<ReleaseOutcome, ServiceError>` | 未持有 → `NotHeld`（调用方决定是否翻错误）；释放后非空 → `Released`；空集 → 调 `stop()`（`Stopped`）；`stop` 失败 → 保留 `running = true`（服务可能仍在跑）+ 返回 `StopFailed`（fail-visible，不假装已停） |
| `release_all_for(holder) -> Vec<ReleaseReport>` | 插件停用 / 激活失败 / 进入 Error 态的通用回收：按 key 字典序逐个 release；单个失败只记录并继续（不阻断停用流程） |
| `shutdown_all() -> Vec<ReleaseReport>` | 宿主退出兜底：无论 holder 集合是否为空，对 `running` 的槽位执行 stop（含之前 stop 失败的槽）；清空 holder |
| `snapshot() -> Vec<ServiceSnapshot>` | `{ key, running, holders }`（诊断 / 测试 / 日志） |

模板不变量（每条都有单测）：

1. **启动恰好一次**：0→1 才调 `start`；
2. **关停恰好一次**：1→0 才调 `stop`；
3. **多应用共享**：`{A, B}` 中释放 A 不停服务；释放 B 才停；
4. **失败不污染记账**：`start` 失败时 holder 集合保持原样（不允许「半启动 + 已记账」）；
5. **stop 失败不撒谎**：保留 `running = true`，下一次 `acquire` 只挂引用不再 `start`；`shutdown_all` 或「重新取得引用后再释放」会重试 stop；
6. **串行化**：同一 key 的 acquire/release 经该槽位的 `tokio::sync::Mutex` 串行（允许跨 await 持锁），不同 key 互不阻塞；
7. **确定性**：`release_all_for` / `shutdown_all` 按 key 字典序处理，日志可复现；
8. **结构化日志**：`service key / holder / holders / outcome` 字段（AGENTS §8），不使用产品名词。

`ServiceRegistry` 是**实例**（`ServiceRegistry::new()`），不是全局单例：

- 桌面 / 移动各持一份，经 `WasmHostContext` 的晚绑槽位给内核与宿主适配器使用；
- 测试各自 new，互不干扰；无头进程天然没有注册表。

### 3.4 服务清单与键（本版）

| 键 | 实现位置 | start / stop 做什么 | 端 |
| --- | --- | --- | --- |
| `net.transport` | `wasmnest-lib/wasmnest-server-core/src/service.rs`（`TransportService`） | `ServerSupervisor::start(当前配置端口)` / `ServerSupervisor::stop()`——覆盖 **WS + HTTP 同一 Actix 端口、mDNS `_wasmnest._tcp` 广播、防休眠、指标采样**（后三者本来就是 supervisor 的 start/stop 副作用，整体作为 transport 的生命周期） | 桌面 |
| `net.peer-node` | `wasmnest-lib/wasmnest-server-peer-net/src/service.rs`（`PeerNodeService`，持 `Arc<PeerCtx>`） | 引擎 `start_locked`（节点监听 + `_wasmnest-peer._tcp` 广播 + host service 登记） / `stop_locked`（排水连接 + 退订 browse + 注销广播） | 双端 |

键是机制词汇，不含产品名；键常量住在实现该服务的能力 crate（`TRANSPORT_SERVICE_KEY` / `PEER_NODE_SERVICE_KEY`），宿主只 import，不另写字符串。

**非本版服务**（明确不做，见 §8）：mDNS 共享守护空闲关停、指标采样独立服务、PTY/存储等按插件句柄回收域（已经是 owner + purge 模型）。

## 4. 生命周期接线

### 4.1 acquire（谁表达了「我需要这个服务」）

**认证中心拆出后的修订（2026-10-22 用户裁决）**：端点注册只写宿主内存路由表，
**不启动监听器**；`net.transport` 的需求信号 = **应用界面打开**（外壳挂载应用整包），
由外壳调用 `plugin_surface_open` / `plugin_surface_close` 驱动。这样 L2 基础设施
（认证中心 / BedCode 等）在 boot 期注册路由不会造成对外广播；用户真正打开应用界面
时才启动传输面，关闭最后一个界面即停播。

| 端 | 调用点 | 动作 |
| --- | --- | --- |
| 桌面 | `host-http-endpoint.register_endpoint` / `host-websocket-server.register_endpoint` 宿主 impl | **只登记路由**（能力域注册表），不 acquire |
| 桌面 | 外壳 `useAppMount.mountAppBundle` / `unmountAppBundle` → Tauri `plugin_surface_open` / `plugin_surface_close` | 仅当该插件已注册 HTTP/WS 端点 (`count_by_owner > 0`) 时 `acquire` / `release(TRANSPORT_SERVICE_KEY, plugin_id)`；无网络面应用为 no-op |
| 双端 | `wasmnest-lib/wasmnest-server-peer-net/src/plugin_binding.rs`（`peer_start_node` / `peer_stop_node`） | 经 `PeerPorts::service_registry()` 取注册表：`start` = `acquire(PEER_NODE_SERVICE_KEY, plugin_id)`，`stop` = `release(...)`；`NotHeld` 映射为「not holder」错误（保持旧「非属主拒绝」语义） |

`PeerPorts` 新增一个**带默认实现**的方法（避免破坏现有测试替身）：

```rust
/// 应用作用域服务注册表（宿主机制）；None = 无头 / 测试装配，走直连引擎的兼容路径
fn service_registry(&self) -> Option<Arc<ServiceRegistry>> { None }
```

- 生产桌面（`plugin/peer.rs`）/ 移动（`plugin/peer_ports.rs`）返回 `Some`；
- 无头 / rig / 单测返回 `None` → 绑定层退化为直接调引擎（不记账），并在首次路径落一条 `warn!` 说明「无租约装配」。这是**装配形态差异**，不是静默降级：生产装配有锁测试钉住（§9）。
- 应用界面租约薄壳同款：注册表缺失（无头测试）→ no-op + 首次 `warn!`；生产 boot 注入注册表（§4.4）。

### 4.2 release（谁保证「应用关了服务就关」）

统一入口是 `ServiceRegistry::release_all_for(plugin_id)`，挂在**所有离开运行态的路径**，而不是让各服务自己监听插件事件：

| 端 / 位置 | 时点 | 说明 |
| --- | --- | --- |
| `wasmnest-lib/wasmnest-wasm-core/src/manager/host/activation.rs:672-680` | `deactivate_plugin` 成功之后（内层 guest `on_shutdown` / `deactivate` 已跑完） | **替换**现有 `release_peer_node_if_owned`（peer 专属分支删除，内核回归零产品耦合） |
| 同上 `activation.rs:88-98` | `activate_plugin` 失败之后 | 激活半程已 acquire 的租约回收 |
| `wasmnest-lib/wasmnest-wasm-core/src/manager/host/errors.rs:48` | `mark_error` 置 Error 态时 | 运行时 trap 自动重载失败等「活实例已不可服务」的路径；释放幂等 |
| `wasmnest-mobile/src-tauri/src/plugin/manager.rs` `deactivate` / `activate_impl` 失败 / `mark_error` 等价路径 | 移动端内核不经 `PluginHost`，由 `PluginManager` 直接调 | 同时删除 `manager.rs:696, 952, 541` 的 file-transfer 硬编码分支与 boot 对账 |
| 桌面 `system/lifecycle.rs` 关闭链 / 移动退出链 | 宿主退出 | `registry.shutdown_all()`（Holder 已空也停 running 槽，兜住 Error 态 / stop 失败） |

顺序语义：**先 guest 清理，再 release**。不要在已有 `purge_for_plugin`（ws/http/mdns 域回收）时 release——那个时点 guest 还没 deactivate。

### 4.3 注册表注入（晚绑，不改 `PluginHost::new` 签名）

`wasmnest-lib/wasmnest-wasm-core/src/host_api/context.rs` 的 `WasmHostContext` 增加：

```rust
service_registry: Arc<RwLock<Option<Arc<ServiceRegistry>>>>,
pub fn set_service_registry(&self, registry: Option<Arc<ServiceRegistry>>)
pub fn service_registry(&self) -> Option<Arc<ServiceRegistry>>
```

- 桌面：`PluginHost::new` 返回后、`apply_autostart()` 之前注入（与 `set_host_facts` / `set_peer_ctx_provider` 同款两阶段；`PluginHost::new` 内不会激活 L3 应用——桌面在 `new` 之前已清空 activation snapshot，`lib.rs:636-650`）；
- 移动：`PluginManager::init_wasm_runtime_with` 创建 `WasmHostContext` 后立刻注入，早于 `load_all` 自启；
- 无头 / 测试不注入 → 内核 release 为 no-op，宿主适配器走兼容路径。

> 若实施时发现 `PluginHost::new` 仍存在激活内路径（例如 L1 系统组件激活期注册端点），则把注册表前移为 `PluginHost::new` 参数，并同步改测试夹具——以实测为准，**不得**靠「大概不会」放过。

### 4.4 桌面 boot 启动链改造

`wasmnest-desktop/src-tauri/src/lib.rs:759-800` 当前行为：spawn → `init_link_crypto_at_startup` → `supervisor.init_config(port, true)` → `ws_manager.init()` → `supervisor.start(port)`。

改为：

1. **删除 `supervisor.start`**（不再永久启动）；保留 `ws_manager.init()`（纯内存装配，不监听）；传输面由应用界面租约启动（§4.1）；
2. 保留链路加密初始化（无监听面，不属于依赖服务）；
3. 端口可用性检查（`server/host_port.rs`）与 `wasmnest-port.txt` 写入保留在 boot（现状：占用时弹窗让用户改端口；写 port file 仅作开发线索，无生产消费者）；
4. `ServerSupervisor`：
   - 去掉「永久自启动」产品决策与 `auto_start` 状态（`supervisor.rs:72-84, 103-130, 348-355`）；
   - `init_config(port, auto_start)` → `init_config(port)`（唯一调用点：boot + 跨端 rig `desktop_ctx.rs:374`）；
   - 保留 `start(port)` / `stop()` / `restart()` / `update_port()`（内部与调试用）；`TransportService` 启动时从 supervisor 当前端口读取（`get_status_info().port`）；
   - `ServerStatusInfo.auto_start` 字段删除（无 TS 消费者）；
5. `TransportService` 注册到注册表 & 注入 `WasmHostContext`（§4.3），`PeerNodeService::new(peer_ctx(&app))` 在 `install_server_ports_with` **之后**注册（避免 `peer_ctx` 在端口未装配窗口里装配 fallback 端口集）。
6. `peer_ctx` 是「四个共享 state 句柄 + 端口」的轻量袋，多次装配共享同一底层状态；服务实现的 `Arc<PeerCtx>` 与绑定层按调用现装配的 `PeerCtx` 指向同一份 `PeerNetState`，不存在两份节点状态。

### 4.5 mDNS 广播的确定性（顺带修正 fire-and-forget）

`MdnsAdvertiserPort::advertise / stop` 现为同步方法、内部 `tokio::spawn`（`wasmnest-desktop/src-tauri/src/server/ports_impl.rs:215-252`），导致 supervisor.start 返回时广播可能还没登记、stop 返回时还没注销。

改为 `#[async_trait]` 的 async 端口（server-base 已有 async-trait）：

- `supervisor.start` 在 server 起来后 `await advertise(...)`（登记失败 → start 失败并回滚 server，fail-visible）；
- `supervisor.stop` 在停 server 后 `await stop()`；
- 跨端 rig 的 supervisor.start 路径行为不变（仍会广播），只是时序确定性提高。

这与「最后一个引用释放 → 立刻停播」直接相关，属于本次范围。

## 5. 为什么这是宿主机制，不是业务（B1–B6 自检）

| 判据 | 结论 |
| --- | --- |
| B1 产品类型 / 字段 | 只有 `key`（机制词汇）+ `holders`（插件 id）。零会话 / 终端 / 设备 / 传输类型 |
| B2 业务编排 | 只有通用 holder 集合与 0↔1 启停，无产品状态机 / 重试策略 / 封顶 |
| B3 业务真源 | holder 集合是运行期机制事实，不是产品事实的权威存储 |
| B4 业务投影 | 不翻译任何产品 wire 形状；服务自己的既有返回形状零变化 |
| B5 业务默认值 | 不替应用决定「该不该用」；应用调原语才 acquire |
| B6 业务生命周期挂钩 | 只响应**通用插件生命周期**（deactivate / 激活失败 / Error），不解释产品事件、不回调插件 |

三问：① 离宿主能实现吗？——不能，服务本体（socket / mDNS / 节点）必须由宿主能力域持有；② 携带产品语义吗？——不携带，键与引用集合都是机制；③ 放宿主：WIT 零变更、无新权限位（沿用 `ws:server` / `network:http` / `peer` 既有门禁）、停用可回收（`release_all_for` + `shutdown_all`）。

## 6. 跨仓改动清单与顺序

按 `docs/git.md` §1/§2：**能力仓（tag）→ 平台仓（manifest 指针）→ 应用仓（tag）→ 跨端测试仓**。

### 6.1 能力仓 `wasmnest-lib`（tag `lib-v0.0.x`）

| crate | 改动 |
| --- | --- |
| `wasmnest-server-base` | 新 `service` 模块（trait + registry + outcomes + snapshot）；`MdnsAdvertiserPort` 转 async；tokio 转普通依赖（`sync`）；模块文档 / `lib.rs` 导出 |
| `wasmnest-server-core` | 新 `service::TransportService` + 键常量；`supervisor` 去永久自启 / `auto_start` / `init_config` 参数；`start` 幂等化（已在 running → Ok）；`stop` 对 "not running" 幂等 Ok |
| `wasmnest-server-peer-net` | 新 `service::PeerNodeService` + 键常量（`async-trait` 从 dev-dep 转普通依赖）；`PeerPorts::service_registry()` 默认方法；`peer_start_node` / `peer_stop_node` 走注册表；删除 `node_owner` / `start_node_owned` / `stop_node_owned` / `release_node_for` 与 `stop_locked` 里的 owner 清账 |
| `wasmnest-wasm-core` | `WasmHostContext` 注册表槽位；`deactivate_plugin` / 激活失败 / `mark_error` 调 `release_all_for`；删除 `release_peer_node_if_owned` 与对 `wasmnest_server_peer_net::release_node_for` 的调用 |
| 锁 | 能力域依赖方向锁若因新增依赖变化同步更新；`crate_boundary_lock` 的 peer 消费点清单同步（wasm-core 不再点名 peer 生命周期） |

**不需要**：WIT / core.wit / 权限表 / `release-manifest.json` 的 contract 段（零契约变更）。租约实现本身不含这些改动；同仓历史提交 `bb66b42` 捆绑的契约 0.0.2 / `app:path` / 内存上限属另行工作流，见 §13.6。

### 6.2 平台仓 `wasmnest`

| 位置 | 改动 |
| --- | --- |
| `wasmnest-desktop/src-tauri/src/lib.rs` | boot 去 server 自启；构造注册表 + 注册 `TransportService` / `PeerNodeService` + 注入 `WasmHostContext`；`init_config` 调用改单参 |
| `plugin/http.rs` / `plugin/ws.rs` | `register_endpoint` **只登记路由**（不 acquire / 不启动监听器）；传输面由应用界面租约触发 |
| `plugin/peer.rs` | 实现 `PeerPorts::service_registry()`（取 `WasmHostContext` 槽位） |
| `plugin/services.rs`（新） | 应用界面租约薄壳：`plugin_uses_transport`（按端点注册表判定）/ `acquire_for_surface` / `release_for_surface`；`commands.rs` 新增 `plugin_surface_open` / `plugin_surface_close`，外壳 `useAppMount` 挂载/卸载调用 |
| `server/peer_net_cmds.rs` / `lib.rs` 命令表 | 退役 `start_peer_node` / `stop_peer_node` 命令（无消费者）；`peer_ctx` 保留（服务装配 + 适配器用） |
| `commands.rs` / `lib.rs` 命令表 | 退役 `server_start` / `server_stop` / `server_restart` / `update_server_auto_start`（无前端 / 应用消费者）；保留 `get_server_status` / metrics / port / 网络配置（只读或纯配置） |
| `system/lifecycle.rs` | 关闭链加 `registry.shutdown_all()`（优先级建议 25，位于 deactivate 之后、server stop 之前） |
| 锁 / 测试 | boot 注入锁（生产装配点存在注册表注入）；`command_vocabulary_lock` / `crate_boundary_lock` 清单同步 |
| `wasmnest-mobile/src-tauri/src/plugin/manager.rs` | 注入注册表；deactivate / 激活失败 / Error 路径 `release_all_for`；删除 file-transfer 硬编码分支与 `sync_node_with_plugin_state` boot 对账 |
| `wasmnest-mobile/src-tauri/src/plugin/peer_ports.rs` | 实现 `service_registry()`（managed 注册表） |
| `wasmnest-mobile/src-tauri/src/lib.rs` | 注册 `PeerNodeService::new(peer_ctx(&app))`；boot 后台执行一次 `peer::ports::prewarm_platform(app)`（过去由 `start_node_owned` 顺手做；注销该入口后必须显式补，否则设备名等待 / 下载目录预热丢失） |
| `wasmnest-mobile/src-tauri/src/peer/net.rs` | 删除 `start_node_owned` / `stop_node_owned` / `release_node_for` / `node_owner` / `ensure_node_started` / `stop_node_for_plugin` / `sync_node_with_plugin_state`（改由注册表 + 绑定层承担；`prewarm_platform` 上移到 boot） |
| 移动退出链 | `shutdown_all()` |

### 6.3 应用仓 `wasmnest-apps`（tag `apps-v0.0.x`）

- `apps/file-transfer/rust/plugin/src/lib.rs`：删掉 `platform == Desktop` 门槛，**双端 activate 都调 `peer_start_node()`**（移动端过去由宿主代劳；现在依赖由应用自己表达，双端同构）。
- 无 plugin.json / 权限 / 版本语义变更（不需改 manifest 的权限段；版本是否 bump 按发版节奏）。

### 6.4 跨端测试仓 `wasmnest-test`

- `cross-end-tests/tests/common/desktop_ctx.rs:374`：`init_config(port)` 单参；
- `cross-end-tests/tests/mdns_health_flow.rs`：文件头「为什么走 supervisor」与 M-001 的来源注释同步（广播仍由 supervisor start 触发，语义改为 transport 服务启动）；断言不变；
- 可选新增场景 `service_lease_flow.rs`（桌面 acquire/release ↔ 移动 browse 看到/看不到）——若成本高，先由桌面集成测试 + 真机手验覆盖（§9）。

## 7. 行为细节与边界

### 7.1 端口冲突（按需启动的固有代价）

boot 时仍做端口检查 / 用户改端口；但服务真正 bind 发生在首次 acquire。若此刻端口已被占用：

- `start` 失败 → `acquire` 返回 `StartFailed` → 注册端点原语返回 `Err`，BedCode 现状是 `log_error` 后保持激活（应用侧行为不改）；
- 结果：应用在跑但服务未起、无广播（**不会出现空壳设备**），日志 fail-visible；
- 不自动重试（避免后台弹窗 / 隐式换端口）；用户重开应用或改端口后自然恢复。已记录为已知缺口。

### 7.2 命令面退役（避免绕过记账）

退役：`server_start` / `server_stop` / `server_restart` / `update_server_auto_start` / `start_peer_node` / `stop_peer_node`。

理由：它们能在没有任何应用持有服务时把服务拉起来（违反 Q1/Q4）。`get_server_status` / metrics / `update_server_port` / 网络配置命令保留（只读或纯配置，不创建 holder）。**应用侧消费者（2026-10-22 复核）**：BedCode `/server` 诊断页已同步改为只读（移除启停 / 重启 / 自启动控件；端口变更下次服务启动生效），不再 invoke 退役命令。

### 7.3 与防休眠 / 指标的关系（显式决策）

`power.enable/disable` 与指标采样本来就是 supervisor start/stop 的副作用，**随 `net.transport` 一起按需生效**：没有应用使用传输面时，不再阻止系统休眠、不再采样。宿主设置页的「防止休眠」偏好只在 transport 运行期间生效（与「服务随应用」原则一致）。若未来需要「宿主级常驻防休眠」，应作为独立的宿主机能立项，不得偷偷挂回 transport。

### 7.4 与「应用启用 / 自启」偏好的关系

不变：`plugin.autostart.{id}` 决定 boot 是否激活应用；应用激活 → 原语 acquire → 服务起。零自启应用 = boot 后零监听 / 零广播（满足 Q1）。

### 7.5 Error 态 / 崩溃

- 宿主进程内的插件进入 `Error`：`mark_error` 释放租约（应用已不可服务，不得继续对外广告）；
- 插件激活失败：外层补偿释放；
- 宿主进程崩溃 / 被强杀：进程退出自然断 socket；mDNS 记录靠对端 TTL（~120s）或 goodbye 收敛——**这部分不是本次能消除的协议事实**，移动端列表在 TTL 内可能残留；如需更快收敛，另开「移动端 stale 记录」票据（不在本次范围）。

## 8. 非目标

1. mDNS 共享守护（UDP 5353 / Android multicast lock）空闲关停 —— 它是浏览/广播的共享底座，没有对外身份；后续可作为 `net.mdns-daemon` 服务再议；
2. 指标采样 / PTY / 存储等已按插件 owner + purge 回收的域 —— 已是正确模型，不套租约；
3. manifest 依赖声明 / 新 WIT acquire 原语 / ABI bump；
4. 移动端 stale mDNS 记录提前收敛；
5. 「广播但标记不可用」形态（Q1 已否决）。

## 9. 测试与验收

### 9.1 单元测试（能力仓，模板本身）

`wasmnest-server-base/src/service.rs`（或独立 tests）：

| 用例 | 断言 |
| --- | --- |
| 0→1 启动一次 / 1→0 关停一次 | fake `ScopedService` 计数 |
| 多引用 | A、B 先后 acquire → start=1；release A → stop=0；release B → stop=1 |
| 幂等 | 重复 acquire 同 holder；release 未持有 → `NotHeld` 且无调用 |
| start 失败 | 不落 holder、start 调用 1 次、下次 acquire 重试 |
| stop 失败 | `running` 保留、后续 acquire 不再 start、`shutdown_all` 重试 stop |
| 未注册 key | `acquire` 返回显性错误（点名 key） |
| 重复 register | 报错（装配期编程错误） |
| release_all_for | 只释放该 holder 的 key，按字典序，单 key 失败不影响其它 |
| 并发 acquire | 同 key 并发两 holder → start 恰好 1 次 |
| 无产品词 | 模块源码 / 键常量不含应用 id（可加轻量锁） |

`wasmnest-server-core`：`TransportService` 对 `ServerSupervisor` 状态机映射（running 幂等、not-running stop 幂等、start 失败透传）。

`wasmnest-server-peer-net`：`PeerNodeService` 与绑定层 outcome 映射（`Started/Attached → bool`，`NotHeld → not holder` 错误），用 fake registry + fake service（不启真实网络）。

`wasmnest-wasm-core`：deactivate / 激活失败 / `mark_error` 调 `release_all_for` 的调用点（注入 fake registry）。

### 9.2 桌面集成（真组件，关键验收）

新增 `wasmnest-desktop/src-tauri/tests/service_lease_lifecycle.rs`（单文件单测试二进制，避免全局单例冲突）：

1. 构造 AppContext + server ports + 注册表 + `TransportService` + mdns advertiser；
2. 零 holder：`supervisor.is_running() == false`，advertiser 未广播；无传输端点的应用界面 acquire 为 no-op；
3. `acquire("net.transport", "app.a")` → 服务器 running、广播登记、端口可连；
4. `acquire(..., "app.b")` → 只启动一次（断开 / 状态不变）；
5. `release("app.a")` → 仍 running / 仍广播；
6. `release("app.b")` → 端口关闭（新连接被拒）、广播注销、`is_running() == false`；
7. 再次 acquire → 重新启动（可复用）；
8. 插件路径：用真实 `PluginHost` + 注册表激活最小 fixture 插件 → **注册端点只预登记**（无 holder / transport 未启动）；`acquire_for_surface`（界面打开）→ holder 出现、transport 启动；`release_for_surface`（界面关闭）→ holder 清空、transport 停；`deactivate_plugin` 回收兜底；
9. 激活失败补偿由 wasm-core 单测（fake registry）覆盖；原「注册端点后 panic 的 fixture」在预登记模型下不再产生租约，item 9 改为 §9.1 的内核单测，不再需要桌面 fixture。

### 9.3 移动 / 双端

- 移动 `cargo test`：`PluginManager` 激活 / 停用 → `release_all_for` 调用（fake registry）；peer 绑定路径 registry 装配存在性锁；
- 跨端 rig 已知路径不改语义：`mdns_health_flow` 仍绿（supervisor 直启）；
- 真机手验（必做）：
  1. 桌面只开宿主壳、不开 BedCode → 移动端 BedCode 设备列表**看不到**桌面；
  2. 桌面打开 BedCode → 数秒内出现，`/api/health` 端口 = 配置端口；
  3. 桌面关闭 BedCode → 设备消失（goodbye 或 ≤ TTL），且再点连接失败（端口已关）；
  4. 桌面同时开 BedCode + 其它应用（若将来也持有 transport）→ 关 BedCode 不断服务（多引用）；
  5. file-transfer：打开 → `_wasmnest-peer` 出现；关闭 → 消失（双端）。

### 9.4 门禁命令（实施后实跑并贴结果）

```bash
# 能力仓
(cd ../wasmnest-lib/wasmnest-server-base && cargo test)
(cd ../wasmnest-lib/wasmnest-server-core && cargo test)
(cd ../wasmnest-lib/wasmnest-server-peer-net && cargo test)
(cd ../wasmnest-lib/wasmnest-wasm-core && cargo test)

# 平台仓（Rust；部分桌面 e2e 需先构建随包插件）
(cd wasmnest-desktop/src-tauri && cargo test)
(cd wasmnest-mobile/src-tauri && cargo test)

# 前端 / 锁
(cd wasmnest-desktop && pnpm run test:run)
(cd wasmnest-mobile && pnpm run test:run)
pnpm run check:wit        # 预期绿（零 WIT 变更）
pnpm run check:manifest   # 依赖 lib tag 钉版；tag 未推送时按既有环境红说明

# 跨端（按改动面选跑）
(cd ../wasmnest-test/cross-end-tests && cargo test --test mdns_health_flow -- --nocapture)
```

## 10. 风险与已知缺口

| 风险 | 处理 |
| --- | --- |
| 注册表注入晚于首次激活（窗口内 acquire） | 实测 `PluginHost::new` 是否激活；必要时前移为构造参数；桌面测试覆盖「new 之后立刻激活」 |
| 端口延迟 bind 冲突 | fail-visible 日志，不自动换端口；用户重开 / 改端口恢复（§7.1） |
| stop 失败留下 running 槽 | 模板保留 `running = true` 并在 `shutdown_all` / 下次 release 重试；不假装已停 |
| 无头 / rig 走兼容路径，生产误漏注入 | 双端 boot 锁测试（源码断言生产装配点写注册表 + 注入）+ 桌面集成测试 |
| 应用界面租约依赖外壳挂载/卸载接线 | 装配锁钉 `useAppMount` 的 `plugin_surface_open/close` + 桌面集成测试；无界面应用不触发传输面 |
| transport 自崩后注册表不自愈 | supervisor 崩溃监控只改自身状态；`running` 槽位在租约释放前不会重新 start。当前记录为已知风险（应用界面关闭→重开会重新 acquire；`shutdown_all` 兜底），后续可加健康探测 |
| 跨仓 tag / manifest 收口 | 遵循 docs/git.md；manifest 当前受「lib/apps tag 未推送」环境红影响（历史已知），实施交付里如实说明 |
| 并发会话未提交改动 | 平台仓当前混有多条并行改动：`shell-dist` / `lifecycle.rs`、`useShellApps` enabled 缺省可见（2026-10-21 裁决）、auth-center 路由与 `release-manifest.json` 条目、移动 `manager.rs` 的 manifest 类型迁移 + `is_autostart` 角色缺省（mobile-manifest-unification）。实施/提交时必须**显式按文件 + hunk 暂存**，禁止 `git add -A`；冲突处停下确认 |
| 历史提交捆绑 | `bb66b42` 同提交带入了契约 0.0.2 / `app:path` / 默认线性内存 128MiB（另行工作流）。租约的「零 WIT」只描述租约本体；后续按票据拆分追溯，勿再混入 |
| 防休眠语义变化 | §7.3 显式记录，若用户要求宿主级常驻另立项 |

## 11. 实施顺序（小步可验证）

1. `server-base::service` + 单测（无宿主接线）；
2. `server-core TransportService` + supervisor 去自启 + async advertiser port；
3. `wasm-core` 注册表槽位 + 三条 release 路径（删 peer 专属分支）；
4. 桌面：boot 改造 + ws/http acquire + 注册表注入 + 集成测试；
5. `peer-net PeerNodeService` + 绑定 / ports 改造 + 删除 owner 模型；
6. 移动：注册表注入 + manager 去硬编码 + 释放路径；
7. 应用仓 file-transfer 双端 start-node；
8. 跨端 rig / 文档 / 锁同步；全量验证 + 跨仓提交 / tag / manifest 指针。

## 12. 实施记录（2026-10-22）

与设计的偏差（均为实测驱动，按 §4.3 / §10 风险预案处理）：

1. **注册表改为 `PluginHost::new` 末参注入**：`PluginHost::new` 内部会先激活
   L1/L2 角色驱动组件（`activate_role_driven_components`），BedCode（L2）在
   该窗口内注册 HTTP 路由（**§13 起不再 acquire**，传输面由应用界面租约触发）。
   原计划「new 返回后注入」不成立，故新增第 10 个参数
   `service_registry: Option<Arc<ServiceRegistry>>`，在 `new` 内、任何激活之前写入
   `WasmHostContext`。
2. **桌面 boot 前置装配**：`install_server_ports_with` / `WebSocketManager::init` /
   链路加密初始化 / mDNS advertiser 托管 / `ServerSupervisor::init_config` 均
   前移到 `PluginHost::new` 之前（否则 L2 激活期的首次 acquire 会因缺端口而
   `StartFailed`）。`HostMdnsAdvertiserPort` 改为优先取 Tauri managed 句柄
   （该时点 AppContext 尚未注册）。
3. **移动端注册表由 `PluginManager` 持有**：`PluginManager::new` 内创建并
   暴露 `service_registry()`，`init_wasm_runtime_with` 注入宿主上下文、boot 用
   同一份注册 `PeerNodeService`；未改 `PluginManager::new` 签名。
4. **已知架构债（用户 2026-10-22 裁决，暂不实施）**：**认证中心应独立成一个
   wasm 应用**，不应继续由 L2 内部业务组件 `com.wasmnest.terminal-session`
   兼任。当前架构的问题有两层：
   - 认证中心生命周期与 BedCode 后端绑死（同一个 L2 插件既是裁决方又是业务面）；
   - L2 角色驱动组件 boot 即激活并注册 HTTP 路由——按原 acquire 点会在 boot
     持有 `net.transport`。**§13 已改为应用界面租约：注册只预登记，打开界面才
     acquire**，因此该冲突已消解（认证中心独立后亦然）。
   本次**保持现状**：本 spec 的四项裁决（按插件 id 记账、原语调用处 acquire）
   按原文实施，未自行改 L2 激活时机或豁免 L2 的 acquire。后续立项「独立认证中心
   wasm 应用」时，需一并重新裁决：L2 是否仍角色驱动、独立认证中心如何被拉起、
   L2 路由是否 acquire 传输面。跨会话跟踪建议开 GitHub issue（尚未创建，待用户确认）。

## 13. 实施记录（2026-10-22 复核后修订）

1. **认证中心已独立为 `servers/auth-center`（L2）**：boot 期 `http_routes::register_all`
   只预登记路由，不再触发 transport 启动。
2. **acquire 点改为应用界面租约**（用户 2026-10-22 裁决）：`register_endpoint` 只写
   路由表；外壳 `useAppMount` 在挂载/卸载时调用 `plugin_surface_open` /
   `plugin_surface_close`，仅对已注册 HTTP/WS 端点的插件 acquire/release。
   L2 基础设施 boot 注册不再造成广播；打开应用界面才启动，关闭最后一个界面即停播。
3. **BedCode `/server` 页改只读**：移除启停 / 重启 / 自启动控件与退役 invoke；
   保留状态、指标、端口与网络配置展示；端口变更下次服务启动生效。
4. **复核修复**：注册表注入注释同步构造参数；能力仓注释移除平台仓 `.scratch` 路径；
   `TransportService::register_global` → `register`；peer 无租约兼容路径恢复
   「本次是否真正拉起」bool 语义；移动端租约释放日志去重；桌面 peer 端口装配锁补齐。
5. **仍未闭合**：能力仓 tag / `release-manifest.json` 指针按发版流程待推（当前工作树
   经平台仓 `.cargo/config.toml` patch 编译）；真机手验（§9.3）待执行。
6. **同仓历史提交捆绑说明（2026-10-22 复核）**：能力仓 `bb66b42` 在租约实现之外
   还带入了三条不属于本 spec 裁决的工作流——
   - 契约版本 0.0.1 → 0.0.2（host-runtime / monitor 收口）；
   - `app:path` 权限位与 `register-path` / `unregister-path`（agent-hub node bootstrap P1，
     见应用仓 `.scratch/2026-10-22-agent-hub-node-bootstrap`）；
   - 默认线性内存上限 256MiB → 128MiB（**未找到独立票据/裁决记录**，需补）。
   本 spec §2/§6.1 的「零 WIT / ABI / 权限表变更」只描述租约本体；上述三项应按各自
   票据单独追溯，不得据此认为租约引入了契约变更。平台仓随之再生成的 WIT 0.0.2 /
   permission-vocabulary 同理属于该捆绑的跨仓跟随。
   **派生波纹**：`PluginServices` 新增 `register_path` / `unregister_path` 两个无默认
   实现的方法，`task_e2e.rs` 的 `MockTaskServices` 被迫加桩——这是 app:path 工作流的
   波纹，不应由租约测试承担；拆分时应给 trait 方法提供 fail-visible 默认实现，或把
   该 trait 扩展随 app:path 票据单独提交。默认线性内存 256→128MiB 目前**无独立票据**
   （检索未见裁决记录），发版前需补。
