# 安全与日志红线

> **本文件是 `AGENTS.md` 的拆分文档（安全与日志）**：密钥 / 凭据禁令、fail-closed 认证、加密引擎中性原语、输入校验与权限仲裁位置、最小声明、前端封锁联动、调试面门控、日志分级与结构化字段。
> 本文件与 `AGENTS.md` 的硬约束**同级别**。权限闸门机制面见 `docs/architecture.md` §5；权限声明面见 `docs/contracts.md` §4；前端资源访问三类封锁见 `docs/frontend.md` §1。

## 1. 安全

- **禁止提交密钥 / 凭据**（含 `.env` 里的 `TAURI_SIGNING_PRIVATE_KEY_FILE`、Android `key.properties` / keystore、任何 token）；禁止进日志、进文档；**凭据只记长度不落明文**。
- **认证一律 fail-closed**：未在册 / 调用失败 / 拒绝 → 一律拒绝；**没有「查不到就放行」「传输失败就放行」的降级路径**。设备入场密码学与设备侧凭证材料归认证中心（应用侧），**宿主不得持有**（有反回接锁）。
- **宿主加密引擎只暴露无业务语义的中性算法原语**（裁剪线约束：`desktop/src-tauri/src/crypto.rs`）；认证编排 / 业务语义加密归插件。
- 输入校验与权限仲裁在 **Rust 端**，前端校验仅是 UX；WS / HTTP 接入必须过认证与过滤链。
- 高风险能力声明即信任但**最小声明**：`pty:spawn`（在宿主机执行任意命令）/ `process:run` / `app:cli` 同信任域，只发确有需求的应用；宿主全量审计。
- 前端资源访问三类封锁与豁免机制见 docs/frontend.md §1；不要为「临时调试」撤 capability——**撤 capability 与补宿主命令必须成对提交**。
- 调试面（bench channel、wdio 插件注册等）必须 `cfg(debug_assertions)` 门控，并有锁证明 release 不含。
- egress / 文件系统授权链的 fail-closed 口径见 docs/architecture.md §5（无 app_handle 的无头 / 测试上下文收紧为「判定失败」）。

### 1.1 前端信任边界（威胁模型真源 → ADR 0058）

- **当前真实边界 = 「后端按应用沙箱，前端同可信域」**：wasm 应用逻辑面的 wasmtime 沙箱成立；插件前端与宿主同 webview、共享 Tauri IPC 命令面，**不是**沙箱边界。事实基础、威胁声明与裁决（措辞诚实 + Rust 侧命令门禁 + `withGlobalTauri=false` spike；独立 webview 强隔离仅以「引入不可信第三方应用」为触发条件）逐条带代码证据落 **[ADR 0058](adr/0058-frontend-trust-boundary-and-command-surface-threat-model.md)**——本节只挂真源不复制。
- 与 §1 其余条目的分工：本节管「前端 JS 能触达什么」；三层封锁（docs/frontend.md §1）封的是前端直连网络 / 文件 / 导航原语，IPC `invoke` 不在其封锁面内。

## 2. 日志

- 统一 `tracing`：运行细节 `debug!` / 关键生命周期 `info!` / 可恢复异常 `warn!` / 影响功能的失败 `error!`。
- 三条硬规则：① panic hook 内只用 `eprintln!` ② 热路径克制（PTY 输出 / WS 每帧不打逐帧日志，命中 `hot_path_logging_lock`）③ guest 自报的可处理错误不升 `error!`。
- **结构化字段强制**：`session_id` / `device_id` / `plugin_id` / `request_id` / `batch_id` / `node_id` 一律 `key = %value`，**禁止拼进消息字符串**；错误信息必须带操作上下文。
- 前端落盘差异：**桌面 release 侧 error / warn 仍批量转发落盘**；移动 release 侧整体空实现（差异机制见各自 `frontendLogger.ts` 头注释，勿强行统一）。