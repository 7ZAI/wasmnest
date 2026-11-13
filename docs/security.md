# 安全与日志红线

> **本文件是 `AGENTS.md` 的拆分文档（安全与日志）**：密钥 / 凭据禁令、fail-closed 认证、加密引擎中性原语、输入校验与权限仲裁位置、最小声明、前端封锁联动、调试面门控、日志分级与结构化字段。
> 本文件与 `AGENTS.md` 的硬约束**同级别**。权限闸门机制面见 `docs/architecture.md` §5；权限声明面见 `docs/contracts.md` §4；前端资源访问三类封锁见 `docs/frontend.md` §1。

## 1. 安全

- **禁止提交密钥 / 凭据**（含 `.env` 里的 `TAURI_SIGNING_PRIVATE_KEY_FILE`、Android `key.properties` / keystore、任何 token）；禁止进日志、进文档；**凭据只记长度不落明文**。
- **认证一律 fail-closed**：未在册 / 调用失败 / 拒绝 → 一律拒绝；**没有「查不到就放行」「传输失败就放行」的降级路径**。设备入场密码学与设备侧凭证材料归认证中心（应用侧），**宿主不得持有**（有反回接锁）；记录归属与 BedCode 残留双写的现状见 `docs/architecture.md` §7.1。
- **宿主加密引擎只暴露无业务语义的中性算法原语**（裁剪线约束：`desktop/src-tauri/src/crypto.rs`）；认证编排 / 业务语义加密归插件。
- 输入校验与权限仲裁在 **Rust 端**，前端校验仅是 UX；WS / HTTP 接入必须过认证与过滤链。
- 高风险能力声明即信任但**最小声明**：`pty:spawn`（在宿主机执行任意命令）/ `process:run` / `app:cli` 同信任域，只发确有需求的应用；宿主全量审计。
- 前端资源访问三类封锁与豁免机制见 docs/frontend.md §1；不要为「临时调试」撤 capability——**撤 capability 与补宿主命令必须成对提交**。
- 调试面（bench channel、wdio 插件注册等）必须 `cfg(debug_assertions)` 门控，并有锁证明 release 不含。
- egress / 文件系统授权链的 fail-closed 口径见 docs/architecture.md §5（无 app_handle 的无头 / 测试上下文收紧为「判定失败」）。

### 1.0 应用调用桥的安全边界（Nest M1，2026-11-12）

- **`apps:control` 是强权限**：持有者可代表用户调用其他应用**已声明**给助手的命令。审批文案必须如实写明「可代表你调用其他应用已声明给助手的命令」，不得弱化为「读取应用信息」。
- **白名单是纵深防御，不是便利**：桥只放行目标 manifest `contributes.assistantTools` 里声明过的命令；未声明即 `tool.not_declared`，**不**回退「任意命令」。目标命令的完整参数校验仍归目标应用自身，桥只做基础结构校验。
- **调用方权限运行期二次校验**：注入时已按 manifest 门控，但运行期权限可被收回（应用管理页改策略 / 卸载），桥内按宿主当前清单再判一次，fail-closed。
- **审计只记摘要**：桥的审计与助手侧审计都只落 tool / app / command / risk / decision 与参数、结果摘要（sha256 + 长度），**不**记参数原文与返回值原文（日志红线，见 §2）。
- **确认在助手侧，宿主不代裁**：风险四档（read 自动 / ui 可见 / write 批准 / danger 二次）由助手应用执行；宿主只做白名单与审计。目标应用的权限仍按其自身执行，桥不代裁、不代授。
- **目标应用数据不是指令**：应用返回内容只作事实材料，任何「指令式」内容不构成对助手的指示（提示词与工具纪律双保险，见应用仓 `servers/assistant/shared/prompt/system.ts`）。

### 1.1 前端信任边界（威胁模型真源 → ADR 0058）

- **当前真实边界 = 「后端按应用沙箱，前端同可信域」**：wasm 应用逻辑面的 wasmtime 沙箱成立；插件前端与宿主同 webview、共享 Tauri IPC 命令面，**不是**沙箱边界。事实基础、威胁声明与裁决（措辞诚实 + Rust 侧命令门禁 + `withGlobalTauri=false` spike；独立 webview 强隔离仅以「引入不可信第三方应用」为触发条件）逐条带代码证据落 **[ADR 0058](adr/0058-frontend-trust-boundary-and-command-surface-threat-model.md)**——本节只挂真源不复制。
- 与 §1 其余条目的分工：本节管「前端 JS 能触达什么」；三层封锁（docs/frontend.md §1）封的是前端直连网络 / 文件 / 导航原语，IPC `invoke` 不在其封锁面内。

## 2. 日志

- 统一 `tracing`：运行细节 `debug!` / 关键生命周期 `info!` / 可恢复异常 `warn!` / 影响功能的失败 `error!`。
- 三条硬规则：① panic hook 内只用 `eprintln!` ② 热路径克制（PTY 输出 / WS 每帧不打逐帧日志，命中 `hot_path_logging_lock`）③ guest 自报的可处理错误不升 `error!`。
- **结构化字段强制**：`session_id` / `device_id` / `plugin_id` / `request_id` / `batch_id` / `node_id` 一律 `key = %value`，**禁止拼进消息字符串**；错误信息必须带操作上下文。
- **桌面控制台过滤器（dev 通道）**：优先级 `RUST_LOG` > `log.console_filter` > dev 兜底。`EnvFilter` 的默认指令是 **OFF**——配置里只写 `crate=level`（宿主默认就是这样）时，未列出的 target 全部静默，**启动完成后**能力仓 / 插件 `[plugin:...]` / 前端 relay 的日志一条都进不了终端（看着像"日志失效、不滚动"，而文件层照写）。因此 dev 且配置无全局指令时自动补全局 `debug`（配置里的 target 指令优先，`actix_web=info` 这类降噪继续生效；真源 `system::logging::console_filter_string`，回归锁 `dev_console_filter_lets_engine_plugin_and_frontend_logs_through`）。release 不改写配置语义。
- 前端落盘差异：**桌面 release 侧 error / warn 仍批量转发落盘**；移动 release 侧整体空实现（差异机制见各自 `frontendLogger.ts` 头注释，勿强行统一）。