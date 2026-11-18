# ADR 0061：WIT 按包拆分与按包版本化（发布门禁从 lib tag 全等改为逐包对齐）

- 状态：**已裁决（2026-11-07，用户拍板「走拆包」）；实施 A/B 阶段（能力仓 + 平台仓）已落地，
  C 阶段（全量重建 app 并回填清单）随下一次发布执行**
- 日期：2026-11-07
- 相关：`docs/contracts.md` §1 / §2 / §3、`docs/testing.md` §3、
  `release-manifest.json`、`scripts/compose-wit.mjs`、`scripts/vendor-apps.mjs`、
  spec `.scratch/2026-11-07-wit-package-split/spec.md`
- 前序：ADR 0051（WIT 包 semver 与单点版本真源）、ADR 0052（domain-owned contracts）

## 背景：单包版本化的级联

拆分前所有接口共享一个包 `wasmnest:plugin@<version>`（core import + 全部能力域/端扩展）。
两个独立机制共同造成「改任意一处 WIT = 全部应用重建重发」：

1. **共享包版本进 import 名**：改 `pty.wit` 也要 bump 全局版本 ⇒ 没 import `host-pty`
   的应用（如 file-transfer）原有的 `host-mdns@0.0.2` 变成 `@0.0.3`，实例化必失败；
2. **发布门禁按 lib tag 全等**：`scripts/vendor-apps.mjs` 要求 app 元数据
   `source.libRef == release-manifest.repos.lib.tag`，lib tag 因任意改动前进 ⇒ 旧 app
   包一律不能 vendor，即使代码没重建也得重发。

事实校正（决定拆包是否够用）：wasmtime 48 的 component linker 对 import instance 的
类型检查是「expected 的每个导出都在即可，实现多出来没关系」，所以**纯追加 import 函数**
本身不破坏旧产物；破坏来自**共享包版本 bump**。换包后，不 import 该包的应用连版本名都不变。

## 决策

1. **拆包**：`wasmnest:plugin` = core import + 全部 guest 导出面（公共轴）；其余每个能力域 /
   端扩展各一独立包，各自版本，改哪个包只 bump 哪个包。
2. **生成物布局**：顶层只放 `wasmnest:plugin` 包（`core.wit` / `plugin-face.wit` /
   生成的 `wasmnest.wit`），其余包写进 `deps/<pkg>/`（`wit-parser` 要求同目录顶层文件
   同属一个 package）。
3. **manifest**：`contract.version` = `wasmnest:plugin` 版本；新增 `contract.packages`
   （全包 → 版本）。`hostRuntime.witVersion` 继续等于 `contract.version`。
4. **app 元数据**：`compat.witVersion` 保持标量 = 插件面版本；新增 `compat.witPackages`
   （**构建期从组件二进制本身**经 `wit_component::decode` 提取，不读源码头）。
5. **vendor 门禁**：`compat.witVersion` 对齐 + `compat.witPackages` 逐包对齐
   `contract.packages`；`source.libRef` 降为溯源记录，不再做等值门禁。
6. **一次性全 app 重建**：`wasmnest:plugin` 0.0.2 → **0.1.0**（import 身份变化 = 破坏性），
   旧产物按版本在实例化期被点名拒绝。

## 包表（2026-11-07）

桌面 19 个能力/端扩展包 + 移动 10 个（详见 `compose.json` v2）：

| 端 | 包 | 初始版本 |
| --- | --- | --- |
| 双端 | `wasmnest:plugin`（core + 导出面） | **0.1.0** |
| 双端 | `pty` / `mdns` / `peer` / `http` / `ws` / `notify` / `clipboard` | 0.0.1 |
| 桌面 | `http-endpoint` / `ws-server` / `api-call` / `app` / `auth-center` / `connection-registry` / `crypto` / `fs-desktop` / `platform-desktop` / `process` / `task` / `timer` | 0.0.1 |
| 移动 | `notify-mobile` / `fs-mobile` / `terminal-stream` / `connection-target` / `auth-client` | 0.0.1 |

## 落地形态（改哪些文件）

- 能力仓：7 个能力分片改包名（`package wasmnest:<domain>@0.0.1;`）+ 每 crate `WIT_PACKAGE`
  常量与 package 行锁；`MODULE_INTERFACES` 字面量同步。
- 平台仓：`compose.json` v2（`core` / `face` / `caps.* = { file, package }`）；端
  `wit-src/` 由聚合 `cap-desktop.wit` / `cap-mobile.wit` 拆成每域一文件 + `plugin-face.wit`；
  `compose-wit.mjs` 重写（清空重建 + `deps/` + 文件集合校验）；
  SDK `generate!` 加 `generate_all` 并按包改写 import 路径；宿主 `MODULE_INTERFACES`
  / `impl wasmnest::<pkg>::host_*::Host` 同步；两把锁重写
  （`src-tauri/tests/wit_package_version_lock.rs`、移动 `mobile_wit_composition_lock.rs`）。
- 应用仓：组件化工具新增 `--list-packages`（只读解码）；`build-app.mjs` 写入
  `compat.witPackages` 并与 `compat.witVersion` 交叉校验；`host-runtime.lock.json`
  的 `witVersion` 随 manifest。

## 后果

**收益（验收矩阵）**

| 变更 | app 必须重建 / 重发 |
| --- | --- |
| 能力仓非 WIT 代码改动 / lib tag 前进 | 否（vendor 不再看 lib tag） |
| `wasmnest:pty` 改，app 未 import pty | 否 |
| `wasmnest:pty` 改，app import pty | 是（`witPackages` 与 `contract.packages` 不等） |
| 桌面独有包改，app 未 import | 否 |
| 移动包改，桌面 app | 否 |
| `wasmnest:plugin`（core / 导出面）改 | 全部是（公共轴，有意边界） |

**代价 / 边界**

- `wasmnest:plugin` 仍是全应用公共轴：core import 或导出面改动仍要求全量重建。放宽它需要
  「core 再拆包」或「导出面动态探测」单独立项（spec §11）。
- 生成物目录形状变复杂（`deps/`）；漂移锁从「逐文件 sha」扩到「文件集合」，残留旧扁平
  `cap-*.wit` 即红。
- Go SDK 的 wit 组装（`go/tools/assemble-wit.mjs`）需一并带出 `deps/`（已改）。
- `package-sdks.mjs` 的 SDK 附件从单文件 `wit/wasmnest.wit` 改为整目录（已改）。

## 备选方案与为何不选

- **只放宽 bump 政策（不拆包）**：任意 WIT 改动仍要 bump 共享包版本 ⇒ 级联照旧，
  等于放弃目标。
- **SDK feature 切片 / 导出面动态探测**：解决的是编译期 API 门禁与「加导出 = 全员重建」，
  与版本级联正交；本次不做（spec §8/§11）。
- **用 `source.libRef` 继续做门禁**：拆包后 lib tag 前进不再代表任何包变化，保留等值门禁
  会让目标失效。

## 迁移与回退

- 迁移顺序：能力仓（改包 + tag）→ 平台仓（拼装 / SDK / 宿主 / manifest / 锁）→ 应用仓
  （`--list-packages` + 元数据 + 全量重建）→ 发布验证。
- 回退：整体回退平台提交 + 能力仓 tag；应用重发旧产物（旧产物只对旧宿主有效，`0.0.2`
  插件面与 `0.1.0` 宿主不兼容是**故意**的 fail-visible）。
