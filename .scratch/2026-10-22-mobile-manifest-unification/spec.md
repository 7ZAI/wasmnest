# 移动端 manifest 统一到 wasm-core（前置 spec）

> 状态：**已实施（2026-10-22）**。解除对 `.scratch/2026-10-22-monitor-system-service/spec.md` 与
> `wasmnest-apps/.scratch/2026-10-22-monitor-system-service/spec.md`。
>
> 关联：能力仓 `wasmnest-lib`（`wasmnest-wasm-core/src/manifest.rs`）、平台仓
> `wasmnest-mobile`（宿主 + SDK + 前端壳）、应用仓（monitor 迁移与系统服务区）。

## 1. 问题

同一个 `plugin.json` 在仓内有三份 Rust 类型：

| 位置 | 谁在用 | 是否有 `kind`（`type`） |
| --- | --- | --- |
| `wasmnest-lib/wasmnest-wasm-core/src/manifest.rs:37` | 桌面宿主 / 机制层 | 有：`kind` 在 `:87`，枚举在 `:186` |
| `wasmnest-desktop/packages/plugin-sdk-desktop/rust/src/types.rs:104` | 桌面 SDK（guest 构造） | 有（`:244`） |
| `wasmnest-mobile/packages/plugin-sdk-mobile/rust/src/types.rs:95` | **移动宿主实际解析用** | **没有** |

移动宿主虽然依赖 `wasmnest-wasm-core`（`wasmnest-mobile/src-tauri/Cargo.toml:26`），
但 `wasmnest-mobile/src-tauri/src/plugin/loader.rs:281-286` 仍用移动 SDK 的
`PluginManifest` 解析 `plugin.json`；`MobilePluginInfo`
（`wasmnest-mobile/src-tauri/src/plugin/types.rs:42`）与前端 `PluginInfo` 也没有
`kind`。因此移动端写 `"type": "internal-business"` 会被 serde **静默忽略**，
系统服务分组 / 服务类型监控都拿不到分类。

`wasm-core` 的 `manifest.rs` 从设计上就是双端 manifest 的**宿主侧中性超集**
（模块头注释：SDK 副本是 guest 面 wire 形状，宿主只消费中性形态）。移动宿主
违背了这条边界。

## 2. 裁决

1. **移动宿主（`wasmnest-mobile/src-tauri`）的 manifest / pluginType / pluginState /
   contributes 一律改用 `wasmnest_wasm_core::manifest` 的类型**，与桌面宿主同源。
2. **退役移动宿主的 SDK manifest 消费**：删除
   `wasmnest-mobile/src-tauri/src/plugin/types.rs` 里
   `pub use wasmnest_plugin_api_mobile::types::PluginManifest;` 以及对 SDK
   `PluginType` / `PluginState` / `PluginContributes` 的宿主消费。
3. **guest SDK 的 wire 镜像保留**（`plugin-sdk-mobile/rust/src/types.rs`）：SDK 编到
   wasm32，不能依赖带 wasmtime / tauri 的 `wasm-core`。该镜像按 ADR 0018 是 guest
   面 wire 形状，补 `kind` 并加漂移锁——**它不再是宿主的解析类型**。
   - 这是本 spec 里唯一保留的重复定义；若未来要彻底删掉它，需要把 manifest 词汇
     抽成零重依赖的独立契约 crate 并随 SDK 发布（另开票，不在本轮）。
4. 移动前端 `PluginInfo` / `ShellApp` 透出 `kind`，供系统服务区与服务监控消费。
5. 移动宿主 `plugin_is_autostart` 的缺省值改为**按角色**：未显式设置时
   `kind.is_role_driven()`（L1 / L2）为 `true`，L3 为 `false`；显式 `false` 优先。
   与桌面同口径（默认开 = 系统服务；用户可关）。
6. 移动 CLI 清单校验接受并校验 `type`（`basic-service` / `internal-business` /
   `business-app`，兼容 `system` / `application`），避免「写了不生效」。

## 3. 实施落点

### 3.1 移动宿主

- `src-tauri/src/plugin/types.rs`
  - `LoadedPlugin.manifest: wasmnest_wasm_core::manifest::PluginManifest`
  - `LoadedPlugin.state: wasmnest_wasm_core::manifest::PluginState`
  - `MobilePluginInfo`：`plugin_type` / `state` / `contributes` 用 core 类型；
    新增 `kind: PluginKind`（serde camelCase，与桌面 `HostPluginInfo` 同形）。
  - 删除 SDK manifest / type / state / contributes 的 re-export。
- `src-tauri/src/plugin/loader.rs`
  - 解析 `plugin.json` 用 core `PluginManifest`；platform 校验用
    `PluginPlatform::supports(PluginPlatform::Mobile)`（与桌面同判据）。
  - `PluginType` / `PluginState` 比较改用 core 类型。
- `src-tauri/src/plugin/downloader.rs`、`manager.rs`、`approval.rs`、`registry.rs`
  与所有经 `crate::plugin::types::*` 取 manifest 词汇的调用点同批切换。
- 移动 `boot` 自启候选：保持现有「只认 autostart 偏好」；缺省值按 §2.5 由
  `is_autostart` 派生，不新增第二套启动源。L1 → L2 → L3 的确定性顺序作为
  **非目标**（桌面角色驱动加载顺序不在本 spec；若需要另开票）。

### 3.2 移动 SDK（guest wire 镜像）

- `plugin-sdk-mobile/rust/src/types.rs`
  - `PluginManifest` 增加 `kind`（`#[serde(rename = "type", default)]`，枚举
    `PluginKind` 与 core 同 serde 拼写 + 历史别名）。
  - 可按需补 `api`（当前 guest 镜像缺；与 core 对齐后再锁）。
  - 文件头注释改为「guest wire 镜像，宿主不消费」。
- `plugin-sdk-mobile/bin/cli.js`
  - `validateManifest` 增加 `type` 取值域校验 / 历史别名告警。
  - `manifest-gen` 不得丢掉 `type`。

### 3.3 移动前端壳

- `src/plugin/types.ts`：`PluginInfo` 增加 `kind?: string`。
- `src/shell/types.ts`：`ShellApp` 增加 `kind?: string`。
- `src/shell/adapters/pluginAppSource.ts`：`toShellApp` 透传 `kind`。
- 后续系统服务区（main spec）消费该字段，不在适配器里做产品分组。

### 3.4 漂移锁

- 平台仓新增/扩展测试：
  - 移动 SDK `PluginKind` 词表与 `wasm-core::manifest::PluginKind` 一致
    （serde 序列化值集合）。
  - 移动宿主 `MobilePluginInfo` 序列化包含 `kind`，且与核心 manifest 的
    `type` 解析一致（`internal-business` / `system` 别名 / 缺省）。
  - 移动 loader 对 `"type"` 的解析回归：`internal-business`、`system` → L1、
    `application` → L3、缺省 → L3。
- SDK 侧测试：`PluginManifest` with `type` JSON round-trip。

## 4. 验证

- `cargo test --manifest-path wasmnest-mobile/src-tauri/Cargo.toml`（或平台现有
  移动宿主测试入口；至少 `cargo check` + 受影响的单测）。
- `cargo test --manifest-path wasmnest-mobile/packages/plugin-sdk-mobile/rust/Cargo.toml`
- 平台前端：`pnpm --dir wasmnest-mobile run test:run`（或该仓既有测试命令）。
- 语义验证：移动 `plugin.json` 写 `"type": "internal-business"` →
  `plugin_list_loaded` 返回 `kind: "internal-business"`；不写 → `business-app`。
- 不要求 Android 真机；改动进入 main spec 的 E2E 前必须至少过一次移动构建。

## 5. 非目标

- 桌面 SDK 的 manifest 镜像不在此 spec（桌面宿主已经经 `from_sdk_json` 消费 core；
  若要同批退役，另开票）。
- 不新增 `/apps` 或 `/servers` 的运行时概念；`kind` 仍是 manifest 装配角色。
- 不实现系统服务区 / monitor 迁移 / 面板注册（main spec）。


---

## 6. 实施记录（2026-10-22）

- 移动宿主 `wasmnest-mobile/src-tauri/src/plugin/types.rs` 改为从
  `wasmnest_wasm_core::manifest` re-export `PluginManifest` / `PluginKind` /
  `PluginType` / `PluginState` / `PluginContributes` 等；`LoadedPlugin` 与
  `MobilePluginInfo` 同步切换，`MobilePluginInfo.kind` 透出。
- `loader.rs` / `downloader.rs` / `manager.rs` 的 manifest 解析与比较全部走 core
  类型；测试夹具改用 `..Default::default()`。
- 移动 SDK guest 镜像（`plugin-sdk-mobile/rust/src/types.rs`）补 `PluginKind` /
  `kind` / `api`，serde 拼写与 core 对齐（缺省 L3 不落 `type` 键）；
  `tests/pluginmanifest.rs` 覆盖当前拼写 / 历史别名 / 缺省。
- 移动 CLI `validateManifest` 校验 `type`；历史拼写只告警。
- 移动前端 `PluginInfo.kind` / `ShellApp.kind` / `pluginAppSource` 透传。
- 自启缺省按角色：两端 `is_autostart` 未写偏好时 L1/L2 = true、L3 = false；
  显式 `false` 优先；桌面 / 移动单测覆盖。
- 漂移锁：
  - `wasmnest-mobile/src-tauri/tests/mobile_manifest_kind_lock.rs`（core / SDK
    kind 拼写、别名、缺省、`MobilePluginInfo.kind`、`monitorPanels` 解析）
  - `wasmnest-desktop/src-tauri/src/plugin/lifecycle.rs::autostart_fallback_is_role_driven`
  - `wasmnest-mobile/src-tauri/src/plugin/manager.rs::test_auto_start_defaults_on_for_role_driven_services`
- `wasmnest-wasm-core/src/manifest.rs::LifecycleContribution` 补齐移动事件字段与
  `is_declared`（中性超集此前漏了移动端 lifecycle 字段）。

### 验证

- `cargo check`（mobile / desktop 宿主）通过。
- `cargo test --lib`（mobile 宿主）267 passed。
- `cargo test --test mobile_manifest_kind_lock` 6 passed。
- 移动 SDK `cargo test --features wasm` 全绿。
- 移动前端 `pnpm run test:run` 748 passed；`vue-tsc --noEmit` 无错误。
- 桌面 `pnpm run test:run` 664 passed（另有一条并发工作树
  `server::crate_boundary_lock` 红，与本次改动无关）。

### 残留

- guest SDK 的 wire 镜像按 ADR 0018 保留（wasm32 不能依赖 wasm-core）；若要彻底
  删除，需要独立零重依赖契约 crate 并随 SDK 发布（另开票）。
- 未跑 Android 真机 / 全量移动构建；进入 main spec 的 E2E 前需补一次。
