# ADR 0058：前端信任边界与命令面威胁模型（后端按应用沙箱，前端同可信域）

- 状态：**已裁决（2026-10-24，用户按 spec §13 Q1 推荐项裁决）**；Phase 2 实施拆票见
  issue #19（质量收口 Phase 2 协调）。Rust 命令门禁**本 ADR 只定边界、不实施**。
- 日期：2026-10-24
- 相关：`docs/security.md` §1.1（前端信任边界，本文档的链接落点）、
  `docs/architecture.md` §2（桌面挂载形态）/ §5（权限与安全闸门总览）、
  `docs/frontend.md` §1（零资源访问三层封锁）、
  spec `.scratch/2026-10-23-quality-hardening/spec.md` §5.1–§5.2、§13 Q1
- 事实核对口径：文中行号以 2026-10-24 工作区为准（`git log` 可追溯）；引用前先
  `rg` 复核（AGENTS.md §0「文档字面 ≠ 事实」）。

## 背景：事实基础（逐条带代码证据）

**F1 · 后端（wasm 应用逻辑面）强沙箱成立。** 每个 wasm 应用是独立 wasmtime
Component 实例，能力即权限（`plugin.json` 声明 ∩ 用户批准，无默认授予；移动审批
按内容 SHA-256 钉扎）；宿主对插件的 Rust 命令调用面已做身份绑定——`plugin_invoke`
要求 `credential` 且目标必须等于令牌身份（`../wasmnest-lib/wasmnest-wasm-core/src/manager/host/api_bridge.rs` L389–L404，凭证机制见 `plugin/security/frontend_channel.rs`）。README「特性」表的沙箱承诺对**应用逻辑面**成立。

**F2 · 前端不是沙箱。**

- **同 webview**：桌面机制 B 把独立构建的应用包动态 import 进宿主壳的同一个
  webview（`wasmnest-desktop/src/shell/mount/useAppMount.ts` 头注释；「桌面所有
  应用共享一个 webview」——`docs/architecture.md` §2 表面保活条）；移动运行面同样
  跑在宿主壳 webview 内（Teleport 池，`docs/frontend.md` §2）。
- **`__TAURI__` 全局暴露**：双端 `tauri.conf.json` L12 `withGlobalTauri: true`
  （`wasmnest-desktop/src-tauri/tauri.conf.json`、`wasmnest-mobile/src-tauri/tauri.conf.json`）
  ——webview 内任意 JS（含任一插件前端）可经 `window.__TAURI__.core.invoke` 直调
  任意已注册 Tauri 命令。第一方宿主源码只有 `usePlatform` 探测裸读该全局
  （`wasmnest-desktop/src/composables/usePlatform.ts` L40；移动壳 L1 锁已禁，
  旧目录遗留同名文件除外），关闭它不影响宿主自身（宿主与 SDK 均走
  `@tauri-apps/api` 打包导入）。
- **invoke 透传**：宿主注入应用挂载环境的 `AppMountEnv.invoke` 自述
  「宿主面命令（invoke 原样，无附加凭证）」（`useAppMount.ts` L58）——挂载 env
  不构成边界；它给出什么，取决于命令层本身是否设防。
- **关闭 global 不等于安全边界**：插件前端可自带 `@tauri-apps/api`（IPC 走
  `__TAURI_INTERNALS__`），因此收窄全局暴露只是降低暴露面（spike），安全边界
  只能落 Rust 命令层。

**F3 · Tauri 命令层不按应用隔离（当前缺口）。** Tauri 2 的 `invoke_handler`
对同一 webview 内所有 JS 一视同仁。插件生命周期管理命令
`plugin_uninstall`（L726）/ `plugin_install_from_file`（L712）/
`plugin_activate`（L168）/ `plugin_deactivate`（L182）/ `plugin_preauthorize`
（L154）只收 `plugin_id` / `path` + `State`，**无 credential 参数、无来源校验**
——同 webview 内任一插件前端理论上可直接 `invoke('plugin_uninstall', { pluginId: '<别的应用>' })`。
对照组证明机制已存在、只是覆盖不全：授权管理面六命令
（`plugin_fs_auth_respond` / `plugin_network_auth_respond` / `plugin_auth_overview` /
`plugin_auth_set_strategy` / `plugin_auth_revoke` / `plugin_auth_remove_record`）
已过 `require_host_surface` 宿主面凭证门（api_bridge.rs L86–L108，调用点
L460/L501/L549/L601/L644/L682）；loader session「域内首个调用者生效」+
宿主 bootstrap 先占（L27–L40）使插件前端拿不到宿主面凭证——但管理命令根本
不查凭证，该先占对它们无效。

**F4 · 三层封锁不构成命令面边界。** ESLint 静态锁 + Tauri ACL + CSP
（`connect-src 'none'`，`docs/frontend.md` §1）封的是前端**直连**网络 / 文件 /
导航原语；IPC `invoke` 在三层封锁里明确**放行**（同节「允许 convertFileSrc 与
invoke / listen」）。所以「前端三层封锁」与 F2/F3 不矛盾——它们封的面不同。

**F5 · 同窗应用互探。** 桌面所有应用共享一个 webview 即共享 JS realm：DOM、
`window` 全局对象可互探（机制 B 固有代价）；移动运行面同宿主壳 webview。在
「个人本地小程序、应用来源受控」的产品定位下，本 ADR 将其**接受为已知风险**
并如实登记，不当作可依赖的隔离。

## 威胁声明（诚实版本）

**当前真实边界 = 「后端按应用沙箱，前端同可信域」。** 信任边界在两处：
wasm IPC 进程边界（wasmtime + 能力仲裁，F1 成立）与 Rust 命令实现内部；
**webview 内的一切 JS（宿主壳、任一插件前端）属于同一信任域，互相不设防。**

推论（按不深信主体对待插件前端）：

1. 任何**无凭证参数**的 Tauri 命令都必须按「任意前端 JS 可调用」设防——当前
   `plugin_uninstall` 等管理命令不满足（F3），这是本项目当前**已知且已登记**的
   最大安全缺口（spec §3 #2），收敛方案见下节裁决 A。
2. 有凭证机制的命令面（`plugin_invoke` 身份绑定、`require_host_surface` 宿主门）
   是正确方向，Phase 2 沿用该机制补齐，不另起炉灶。
3. 在门禁落地前的窗口期，本 ADR 即该风险的如实声明；文档与审批文案不得再作
   「前端隔离」表述。
4. 同窗互探（F5）按产品定位接受；一旦引入**不可信第三方应用**，该接受失效，
   触发下节 B 的前置条件。

## 裁决（spec §13 Q1，2026-10-24 按推荐项裁决）

**C（措辞诚实）+ A（Rust 侧命令门禁）+ `withGlobalTauri=false` spike**；
B（独立 webview / iframe + postMessage）登记为「引入不可信第三方应用」的
**前置条件**，本期不实施。分期：

| 项 | 内容 | 期次 |
| --- | --- | --- |
| **C 措辞诚实** | README 沙箱表述与实现一致（后端成立 / 前端同可信域如实）；本 ADR 成文；`docs/security.md` §1.1 挂链接 | **本期已完成**（issue #15） |
| **A 命令门禁** | 主体在 Rust：四条生命周期管理命令（F3 列举）要求 loader session 令牌（沿用 `frontend_channel` 凭证机制）+ fail-visible 拒绝，无论调用来自 `env.invoke` 还是裸 IPC；前端 `AppMountEnv.invoke` 收窄为白名单代理，仅作审计 / DX 面，**不当作安全边界** | Phase 2，issue #19 拆票 |
| **spike 全局收敛** | 双端 `withGlobalTauri=false`：跑宿主前端构建 + 全部随包 app 构建 + 关键 e2e；绿则关闭并写锁，红则逐条记录依赖点再回退——**不接受「默认保留」**。spike 是暴露面收缩，不是安全边界（F2） | Phase 2，1–2 天 |
| **B 前端强隔离** | 独立 webview / iframe + postMessage 受控消息桥，插件前端彻底隔离 DOM 与 Tauri IPC | **不实施**。触发条件 = 引入不可信第三方应用（应用来源不再受控），或产品要求前端强隔离；届时挂载契约与双端锁步重做（spec §5.2 评估为高成本） |

C 中「安装审批 UI 明示本应用前端可访问宿主命令面」随 Phase 2 落地；若牵出
UI / 文案 / i18n 超出工程收口范围，按 spec §5.5 砍到「日志 + fail-visible」，
UI 交互另立票。

## Phase 2 实施边界（拆票输入，issue #19）

- **门禁落点**：`../wasmnest-lib/wasmnest-wasm-core/src/manager/host/api_bridge.rs`
  的 `plugin_uninstall` / `plugin_install_from_file` / `plugin_activate` /
  `plugin_deactivate` 四命令——从「参数直达」改为「loader session 令牌 +
  来源判定」，门禁失败 fail-visible（点名缺什么，不静默降级）。
- **白名单真源**：与 `docs/frontend.md` §1 三层封锁对齐，白名单表落 Rust 侧
  常量（真源）+ 前端代理复用（经 SDK 生成物或契约锁钉住，生成物不手改，
  `docs/contracts.md` §6）；白名单以**存量调用盘点**为起点（全部随包 app 对
  `invoke` 的实调清单，repo 内 `rg` 可得），不拍脑袋。
- **契约影响**：`AppMountEnv.invoke` 形状收窄是挂载契约破坏性变更——研发起步期
  允许直接破坏（`docs/contracts.md` §1），但需双端锁步 + 受影响 app 全量重建
  验证。
- **验收**（承接 spec §5.4）：恶意插件前端（测试模拟）调用管理类命令被拒——
  Rust 门禁单测（无 session / session 错 app → Err）+ 前端代理单测（白名单外
  命令被拒且 fail-visible）；README 措辞与本 ADR 一致。

## 后果

- **文档口径统一**：全仓描述「沙箱」时必须区分**后端 wasm 应用逻辑面**（沙箱
  成立）与**前端面**（同 webview 同可信域，非沙箱边界）；单一真源为本 ADR，
  `docs/security.md` §1.1 只挂链接不复制。
- **不影响既有成立事实**：F1 后端沙箱、三层封锁（F4）、权限审批闸门
  （`docs/architecture.md` §5）均不受本裁决影响——本 ADR 收敛的是命令面，
  不是另起一套权限体系。
- **已知残留风险（接受并登记）**：同窗互探（F5）；Phase 2 门禁落地前无凭证
  管理命令保持可达（窗口期由本 ADR 与 issue #15 评论如实声明）。
- **登记义务**：引入不可信第三方应用前必须先重开 B（前端强隔离）裁决。
