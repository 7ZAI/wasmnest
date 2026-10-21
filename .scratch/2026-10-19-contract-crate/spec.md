# 票据：契约常量收进 `wasmnest-contract` crate（消除跨 crate 目录 `include!`）

标签：`ready-for-agent`
日期：2026-10-19
影响仓：`wasmnest-lib`（主）、`wasmnest`（平台，submodule 指针 + 脚本）、`wasmnest-test`（一把锁的路径）

> 注：本仓未配置 issue tracker（无 `.github`、无 `gh`）。按项目既有票据惯例落 `.scratch/<date>-<slug>/spec.md`。

> **修订记录（2026-10-19 平台侧审核后修订）**：
> 1. **补第四消费点**——移动端锁 `mobile_wit_composition_lock.rs`（`wasmnest-mobile/src-tauri/tests/`）同样直接读 `packages/contracts/wasmnest-plugin-package.rs`，初稿仅列「三处」属遗漏（Problem 3 / Solution / D4 / D6 已同步）；
> 2. **`cargo package` 归因修订**——实测 `wasmnest-wasm-core` 的 `cargo package --list` 当前第一阻塞是 `wasmnest-plugin-api` 版本依赖未发布（crates.io 解析失败），随后才轮到 contracts `include!` 逃逸；本次只消除后者，User Story 2 与 Out of Scope 已按此校准；
> 3. **Seam 2 基线声明**——`pnpm run check:manifest` 当前已红（apps 仓 HEAD `fad580b` 无精确 tag），与本次改动无关，验收口径已注明；
> 4. **数字校准**——漂移锁为 19/19（非 9/9）；crate 数为 16 + `contracts/`（非 17，`contracts/` 不是 crate）。
>
> **二次审核修订（2026-10-19，实施前预审）**：
> 5. **消费点 5 → 6 处**——`rg "packages/contracts"` 全仓核对发现桌面侧存在第六处读者：`wasmnest-desktop/src-tauri/src/plugin/bindings.rs` 的内联 `#[cfg(test)]` 测试（`package_source()`，第 74 行读同一真源路径）——它与 `tests/wit_package_version_lock.rs` 是**两个独立测试文件**、同一断言形态（compose.json ↔ 白名单面），`contracts/` 删除必红；初稿与首版修订均漏列（Problem 3 / Solution / D4 / D6 / Seam 3 已同步）；
> 6. **跨仓登记义务补齐**——平台 `capability_crates_no_product_ids` 的 C-3 反向断言要求 `packages/` 下每个 `wasmnest-*` 目录归桶（`SCANNED_CRATES` 或 `PENDING_SCAN_CRATES`），新 crate 必须登记（D6 第 2 步补）；`SPLIT_CRATES` **明确不登记**并记录理由（新增 D8）；
> 7. **表述精确化**——「字面量无法从常量派生」修正为「版本嵌串的组合串无 const 插值机制」（跨 crate 纯拷贝派生可行）；D5 扫描面显性限定能力仓 crate，不扫宿主侧 `bindgen`（其路径按设计绑端 SDK 目录）。

---

## Problem Statement

契约包名与版本（`PACKAGE_NAME` / `PACKAGE_VERSION` / `PACKAGE`）是**全仓唯一手写真源**，但这份真源以「能力仓根目录下一个游离 `.rs` 文件」的形式存在，被内核 crate 用 `include!("../../contracts/wasmnest-plugin-package.rs")` **跨出 crate 目录**读入。

由此产生三个具体问题：

1. **`wasmnest-wasm-core` 无法被打包**。`cargo package` 的 `.crate` 归档只含 crate 目录内文件，`../../contracts/...` 不在归档里，验证构建必失败。这条路既是未来「发布到 crates.io / 私有 registry」的前置条件，也是当前「平台脱离 lib 源码构建」这一设想的硬阻塞。

    **归因修订（2026-10-19 实测 `cargo package --list --allow-dirty`）**：当前第一阻塞是依赖解析——`wasmnest-plugin-api = { version = "0.0.1", optional = true }`（desktop-assembly 启用）在 crates.io 上不存在，`cargo package` 在解析依赖图阶段就报 `no matching package named wasmnest-plugin-api found`，走不到 include! 的归档验证。本次改动只消除 include! 这一个阻塞；打包全流程仍受 wasmnest-plugin-api 未发布影响（见 User Story 2 / Out of Scope）。
2. **编译器看不见这份依赖**。`include!` 是文本拼接：rust-analyzer 无法跳转、改常量不会触发正确的增量重编判定、`Cargo.toml` 里没有任何边记录这个文件属于哪个 crate，新人 review 时只能靠注释里的口头约定。
3. **真源位置与「crate」这个唯一有语义的边界不一致**。同目录下的 16 个 crate 都有明确归属（`contracts/` 目录**不是 crate**，AGENTS.md 口径为「16 个独立 crate + contracts/」），唯独契约常量悬在仓根，导致**六处**消费点各自硬编码这个路径（平台五处 + 测试仓一处）：WIT 拼装脚本（`scripts/compose-wit.mjs`）、发布清单锁脚本（`scripts/check-release-manifest.mjs`）、桌面版本锁（`tests/wit_package_version_lock.rs`）、**桌面端内联测试（`src/plugin/bindings.rs` 的 `#[cfg(test)] mod tests` 里的 `package_source()`，第 74 行读同一真源——与版本锁是两个独立测试文件、同一断言形态，二次审核补列）**、移动端组合锁（`mobile_wit_composition_lock.rs`，此前初稿漏列、首版修订补上的第三处同款）、测试仓 `file_transfer_wiring_lock.rs:403`。同一断言形态在 tests/ 与 src/ 内联 `#[cfg(test)]` 各有一份副本，是计数两次漏列的共同根因。

同时，前几轮讨论暴露出一个**必须被记录下来的设计否定项**：把所有 WIT 分片也收进同一个契约 crate 曾被当作「更干净」的方案，但它与各 crate 编译期的 `bindgen!({ path: "wit/<domain>.wit" })` 冲突 —— 见 Implementation Decisions 的 D2。

## Solution

在能力仓新增一个**只装常量、不装 WIT** 的 crate：`wasmnest-contract`。

- 契约三个常量移入其 `lib.rs`，注释整体迁移（含 bump 政策说明）——**含两处旧描述的修正**（第 2 条使用路径的 include! 说法、字面量派生限制的精确化，见 D1），不逐字搬运错误描述；
- 内核 crate 改为正常 `use` 依赖，`include!` 消失；
- 六处消费点（平台五处脚本/锁/内联测试 + 测试仓一把锁）的读取路径收敛到「这个 crate 的源文件」这一个事实；
- 各能力域 crate 的 WIT **原地不动**（`bindgen!` 要求 crate 相对路径），因此宿主、SDK、WIT 拼装产物、ABI 版本全部零变化。

结果：契约真源第一次拥有 crate 边界（编译器、Cargo、rust-analyzer、`cargo package` 全部认可），而**行为与产物与今天完全一致**。这是「发布到 registry」的可选前置，本身不改变发布方式。

## User Stories

1. 作为**内核 crate 维护者**，我希望契约常量通过 `use` 而不是 `include!` 进来，这样改错路径或删掉常量时编译器立刻报错，而不是在别处出现莫名其妙的未定义符号。
2. 作为**内核 crate 维护者**，我希望 `wasmnest-wasm-core` 的 include! 结构阻塞被消除（`cargo package` 不再因跨目录 include! 在归档验证阶段失败）。**校准（2026-10-19）**：当前 `cargo package` 的第一阻塞是 `wasmnest-plugin-api` 版本依赖未发布（依赖解析阶段即报错），与 include! 无关；本次验收只验证「include! 逃逸消失 + Seam 1–5 全绿」，不承诺 `cargo package` 全流程成功——那是 Out of Scope 独立票据的事。
3. 作为**能力仓维护者**，我希望 `bump 契约版本` 仍然只改一个地方，这样不会出现「忘了同步另一个副本」的静默断链。
4. 作为**能力仓维护者**，我希望契约常量所在文件仍能被 node 脚本用同一套正则解析，这样 WIT 拼装脚本不需要引入 `cargo metadata`、不需要联网、不需要在 pre-commit 里解析整张依赖图。
5. 作为**平台宿主开发者**，我希望这次改动后 `pnpm run check:wit` 的输出与今天逐字节一致，这样我能确认拼装产物没被顺手改动。
6. 作为**平台宿主开发者**，我希望 `pnpm run check:manifest` 仍然能校验「契约版本 == 清单里记的版本」，这样发布装配的硬门禁不退化成口头约定。
7. 作为**平台宿主开发者**，我希望桌面的 `wit_package_version_lock` 与**移动端的 `mobile_wit_composition_lock`** 仍然能抓出「WIT 源文件里的版本字面量与真源不一致」，这样运行期实例化失败的静默坑继续被挡在编译前（两把锁同款断言、同步改路径）。
8. 作为**平台宿主开发者**，我希望 ABI 版本、`compose.json`、两端 SDK 的生成 WIT 一个字都不用改，这样这次重构的回归面只有一个 crate 的依赖边。
9. 作为**新加入的协作者**，我希望从 `repo 结构` 就能看出「契约真源在哪」，而不是靠 Cargo.toml 注释指路。
10. 作为**门禁维护者**，我希望有一条纯文件系统的检查能阻止任何人再写出「`include!` 跳到 crate 目录外」的代码，这样同类问题不会在下一个 crate 上复发。
11. 作为**跨端测试维护者**，我希望测试仓读取契约真源的路径有唯一更新点，这样能力仓搬迁文件时不会让另一仓的锁莫名其妙变红。
12. 作为**未来消费者**（第三方或另一套宿主），我希望 `wasmnest-contract` 是一个零依赖的最小 crate，这样它可以被单独依赖而不拖入 wasmtime / tauri / actix 这类重依赖。
13. 作为**评审者**，我希望 spec 里明确写下「为什么没有把所有 WIT 收进同一个 crate」，这样后续不会被同一个想法反复推翻。
14. 作为**发布负责人**，我希望这次改动以 `lib-vX.Y.Z` 新 tag + submodule 指针前移的方式落地，这样平台仓记录的是一个新的、可复现的提交，而不是工作树脏改动。

## Implementation Decisions

### D1 — 新建 crate，只放常量

- 位置：能力仓根，与 `wasmnest-host-kit` 等同级；包名 `wasmnest-contract`，零依赖，不含 `build.rs`、不含 `links`、不设 `publish = false`。
- 内容：现 `contracts/wasmnest-plugin-package.rs` 的三个常量与全部注释**整体迁移**（bump 政策那段尤其不能丢，它是唯一写下来的版本纪律）。**迁移注释时有两处旧描述要修正，不得逐字搬运**：
    - ① 第 2 条使用路径「能力域 crate 各自 `include!` 本文件」与现状不符——实测能力域 crate（如 `discovery-engine/src/routing.rs` 的 `EXPORTS`）是写死字面量、由锁断言，并无 include!。修正为「能力域 crate 写死导出名字面量，由锁断言」，迁完用 `rg include!` 核对一遍；
    - ②「字面量无法跨文件引用/派生」要写成精确版：**跨 crate 纯拷贝在 const 位置可行**（如 `const X: &str = wasmnest_contract::PACKAGE_NAME;` 合法），派生不了的是**版本嵌在串中段的组合串**（`concat!` 只收字面量、`format!` 非 const，无 const 插值机制）——既有锁钉住的恰是这些组合串，锁的价值不变、理由换准。`routing.rs` 同款表述顺带修正（文档字面 ≠ 事实）。
- 版本：crate 自身 `version` 与契约 `PACKAGE_VERSION` **不强制相等**。理由：前者是打包事实，后者是协议事实；强行绑定会让「只改打包元数据」也构成契约 bump。二者的一致性由断言在同一 crate 的测试里保证的是 `PACKAGE == PACKAGE_NAME@PACKAGE_VERSION` 这一条内部自洽，而非跨字段绑定。

### D2 — WIT 分片保持「各 crate 自持」，不集中进契约 crate

**这是被否决方案的正式记录。** 曾考虑把 7 份 WIT 源文件也收进契约 crate，理由是「契约面单点可读」。实测代码结构后否决：

- 6 处 `bindgen!` 用 **crate 相对路径**消费 WIT（内核绑 `wit/core.wit`；`pty` / `http` / `peer` / `mdns` 等能力域 crate 各自绑自家 `wit/<domain>.wit`）。这是编译期消费，不是脚本消费。
- 把 WIT 搬到 crate 外，这 6 处必须写成指向兄弟目录的路径（`../contract/wit/...`）。这会让**打包后的 crate 找不到 WIT 文件**，等于把本次要消除的「跨目录引用」缺陷复制到 6 个 crate 上，还叠加 `cargo package` 的硬失败。
- 结论：WIT 的归属地由 `bindgen!` 决定，不是由「契约面整洁」决定。契约 crate 只承载**纯数据常量**（无文件依赖、无宏、无路径），这是它能被安全独立打包的前提。

### D3 — 消费侧改造面

- 内核 crate 的契约模块：删掉内联 `mod package { include!(...) }` 与随之的 `pub use package::*`，改为直接 `pub use wasmnest_contract::{PACKAGE, PACKAGE_NAME, PACKAGE_VERSION}`；`Cargo.toml` 增加一条 path 依赖。对外 API（`export_item` / `interface_name` 等派生函数）签名与语义不变。
- `const` 上下文兼容性：`inventory` 静态自报要求编译期常量，跨 crate 的 `pub const &str` 在 const 位置可直接使用，无需任何额外机制 —— 这正是 `include!` 当初解决的约束，用 crate 边界解决得更正当。
- 能力域 crate 的 `routing.rs` 导出名字面量**保持字面量**（字面量无法从常量派生），继续由既有锁钉住，不引入新机制。

### D4 — 六处路径常量收敛（平台五处 + 测试仓一处）

读取契约真源的位置目前有六处（平台：两处脚本 + 桌面 `tests/` 一把锁 + 桌面 `src/` 一处内联测试 + 移动一把锁；测试仓：一把锁），改造后全部指向**契约 crate 的 `lib.rs`**：

| 消费点 | 现状 | 改造后 |
| --- | --- | --- |
| WIT 拼装（拼 package 行） | 能力仓根 `contracts/*.rs` | 契约 crate 源文件 |
| 发布清单锁（`contract.version` 断言） | 同上 | 同上 |
| 桌面版本锁（`tests/wit_package_version_lock.rs`，WIT 源 package 行断言） | 同上 | 同上 |
| 桌面内联测试（`src/plugin/bindings.rs` `#[cfg(test)]` 的 `package_source()`：compose.json ↔ 宿主白名单面） | 同上 | 同上 |
| 移动组合锁（`compose.json` + WIT 源 package 行断言） | 同上 | 同上 |
| 测试仓 `file_transfer_wiring_lock` | 平台仓 `packages/contracts/*.rs` | 同上 |

- **保持正则解析**：不为这六处引入 `cargo metadata`。原因：pre-commit 的 WIT 漂移锁必须保持「纯文件、毫秒级、离线」；一旦依赖 cargo，桌面宿主的依赖图（wasmtime / tauri / actix）会让门禁变慢且可能因网络失败。
- **跨语言文本契约**：契约 crate 的常量必须保留 `pub const <NAME>: &str = "<值>";` 的精确文本形状（含 `: &str` 类型注解、无 macro、无 `env!`）——compose-wit.mjs 与 check-release-manifest.mjs 的正则都以此形状为准，**形状变更 = 两脚本正则的破坏性变更，须同批改**。这条要写进 crate 注释与本仓 AGENTS.md，防止后人"优化"成 `env!("CARGO_PKG_VERSION")` 或 `concat!` 而把六处解析器全部打穿。

### D5 — 结构性防复发锁

新增一条**纯文件系统**的检查（node 测试，进 `pnpm run test:run`）：

- **扫描面 = 平台仓 `packages/**/*.rs`**（能力仓全部 crate，经 submodule 挂载读取）——**不扫平台宿主侧源码**：桌面/移动宿主的 `bindgen!`（如桌面 `src/plugin/bindings.rs` 的 `path: "../packages/plugin-sdk-desktop/rust/wit"`）按设计绑端 SDK 生成物目录、本就逃出 src-tauri crate，归 compose.json 路径校验管；扫进来会误伤合法形态。
- 扫描面内：若 `include!` / `include_str!` 的参数是相对路径且解析后逃出该文件所属 crate 根目录 → 失败并点名文件；
- 同时校验 `bindgen!` 的 `path:` 值解析后仍在 crate 内（D2 的边界）；
- 顺带校验双端 `compose.json` 里声明的每个 WIT 路径真实存在。

不新增 cargo 侧门禁（`cargo package --list` 作为可选人工验证项，不进 pre-commit，避免拉长提交时间）。

### D6 — 跨仓顺序（三仓）

能力仓改动不能先于平台仓落地，否则平台构建立刻红。顺序固定：

1. `wasmnest-lib`：新建 crate、迁移常量、删旧 `contracts/` 目录、内核切 `use`、更新本仓 `AGENTS.md` 与 crate 注释；提交并打新 tag（`lib-vX.Y.Z`，patch 位）。
2. `wasmnest`：移动 submodule 指针到该 tag；改**五处**路径常量——两处脚本 + **桌面 `tests/wit_package_version_lock.rs`** + **桌面 `src/plugin/bindings.rs` 内联测试（`package_source()`，二次审核补列）** + **移动锁（`mobile_wit_composition_lock`，初稿漏列）**；`capability_crates_no_product_ids` 的 **`SCANNED_CRATES` 归桶 `wasmnest-contract`**（零产品语义直接转正，参照 host-api-core 2026-10-14 补登记先例——C-3 反向断言要求 `packages/` 下每个 `wasmnest-*` 目录归桶）；更新 `docs/contracts.md` 的真源链、`docs/codemap.md` 的仓结构树、`packages/AGENTS.md` §2.2 与 §5 路由表；跑门禁（桌面锁 + 此 crate 根下再跑 `cargo test --lib` 覆盖 `bindings.rs` 内联锁）。
3. `wasmnest-test`：`cross-end-tests` 里读取契约真源的那把锁（`file_transfer_wiring_lock`，第 403 行）改成新路径。

任何一步未完成都视为**半迁移状态**，必须 fail-visible（读不到真源即报错，不允许静默跳过断言）。

### D7 — 保持不变的接口与产物

以下全部零改动，且是本次改造的验收边界：

- 双端 `compose.json` 的内容（含 `core` / `caps` 路径、`worlds`、`abi.version`）；
- 生成的 `wasmnest.wit` / `core.wit` / `cap-*.wit` 的字节内容；
- 两端 SDK 的 `rust/wit/**` 生成物；
- `release-manifest.json`（除 `repos.lib.tag` 指针随 tag 变化外）；
- 宿主 `Cargo.toml` 里 23 处对能力 crate 的 path 依赖；
- 契约版本号本身（除非同一提交另有 WIT 变更）。

### D8 — `SPLIT_CRATES` **不登记**（否定项，二次审核补记）

- `wasm-core/src/crate_boundary_lock.rs` 的 `SPLIT_CRATES` 登记表还驱动「宿主清单声明全部拆分产物」的对偶断言：若把 `wasmnest-contract` 登记进去，平台宿主治理锁会要求宿主 `Cargo.toml` **直接声明**它——而宿主只允许经 wasm-core 的 re-export 消费契约（不得直接依赖），锁必红。
- 政策：**不登记**。`SPLIT_CRATES` 的语义是「宿主 bin 拆分产物」的回归管辖面（原宿主代码抽出的 crate）；`wasmnest-contract` 是新建契约 crate，谱系不同。该否定理由写进能力仓 `AGENTS.md`，防止未来协作者「为完整性顺手登记」触发误红。
- 新 crate 的结构管辖落点 = 本票 D5 的结构防复发锁 + 平台 `capability_crates_no_product_ids` 的 C-3 归桶（D6 第 2 步），不在 SPLIT_CRATES。

## Testing Decisions

**好测试的判据**：只断言外部可观察行为 —— 「门禁跑绿 / 产物逐字节不变 / 读不到的路径会红」。不断言「内部用 `use` 而不是 `include!`」这类实现细节（那由 D5 的结构锁从**输入形状**侧挡，而不是从行为侧断言）。

### Seam 1（既有，最高点）：WIT 拼装漂移锁

`pnpm run check:wit` —— 覆盖「拼装输入 → 生成物」整条链。改造前后都必须全绿（当前实测 19/19 ok：desktop 11 + mobile 8；初稿写的「9/9」是过时数字，以实际输出为准），且生成物 sha256 不变。这是本次唯一能证明「重构没碰到产物」的检查，必须最先跑。

### Seam 2（既有）：发布清单锁

`pnpm run check:manifest` —— 覆盖「契约版本 == 清单记录」「submodule tag == 清单 tag」「WIT 指纹」。改造后 `CONTRACTS_PATH` 指向新位置仍须全绿；预期发生变化的只有 `repos.lib.tag` 一项（随新 tag）。

**基线声明（2026-10-19 实测）**：本锁**当前已红**——失败项是「应用仓 tag 校验」：apps 仓 HEAD `fad580b` 无精确 tag（`apps-v0.0.1` 打在 init 提交 `fe7c8ac` 上，HEAD 已前移）。这与本次改动无关，验收时须先记录基线红、与本次改动引入的红区分，或实施前先补 apps tag（另办，不在本票范围）。

### Seam 3（既有）：桌面契约版本锁

`cd wasmnest-desktop/src-tauri && cargo test --test wit_package_version_lock` —— 覆盖「11 个 WIT 源文件的 package 行 == 真源」「端清单只声明包名」「能力域导出名字面量与真源一致」。这把锁是**本次风险最高的一处**（它同时断言真源形状与 WIT 源文件），必须在新路径下全绿。**同 crate 根下另跑一次 `cargo test --lib`**（覆盖 `src/plugin/bindings.rs` 内联 `#[cfg(test)]` 的 `package_source()`——六处消费点之一所在面；本票改它，此跑是验收的一部分）。

### Seam 3b（既有，初稿漏列）：移动端组合锁

`cd wasmnest-mobile/src-tauri && cargo test --test mobile_wit_composition_lock` —— 移动端同款断言（`mobile_wit_composition_lock.rs:54` 同样 `read(root.join("packages/contracts/wasmnest-plugin-package.rs"))`，另断言 `compose.json` 的 `package` 与移动侧 2 份 WIT 源文件 package 行）。`contracts/` 目录删除后此锁必红，必须与新路径同步改——这是初稿遗漏的第四消费点，纳入 Seam 验证。

> 移动端锁当前未在平台仓 CI 里实跑（移动 vitest/cargo 不在现有门禁链路），但它仍是「真源搬迁后必红的既有断言」，验收时手动跑一次即可，不需要为此引入移动 CI。

### Seam 4（既有）：内核 crate 自身测试

`cd packages/wasmnest-wasm-core && cargo test` —— 覆盖契约派生函数（`export_item` / `interface_name`）与 `crate_boundary_lock`。`include!` → `use` 之后这些测试必须零改动通过。

### Seam 5（新增，纯 fs）：结构防复发锁

新增 node 测试并纳入根 `pnpm run test:run`。断言：

1. 不存在逃出 crate 目录的 `include!` / `include_str!`（本次问题的回归锁）；
2. `bindgen!` 的 `path:` 仍在本 crate 内（D2 的边界）；
3. `compose.json` 声明的每个 WIT 路径存在。

**先证不空转**：实施时先在**改造前**的代码上跑一次，必须因 `wasm-core/src/contract.rs`（行 31 的 `include!` 逃逸，当前唯一命中）而红，且报错须**点名该文件**——能定位即同时证明扫描器不是「任意红即算」，排除假阳性；改完再跑必须绿。这是本仓既有的「锁跑红一次证明不空转」纪律。

### 先例（prior art）

- 结构型锁：能力仓既有 `crate_boundary_lock` / `boundary_lock`（扫描源码文本断言边界），本锁沿用同一形态；
- 契约一致性锁：桌面 `wit_package_version_lock`（读文件 + 正则 + 逐字比对）；
- 脚本层测试：根 `scripts/*.test.mjs`（`node --test`）。

## Out of Scope

- **发布到 crates.io / 私有 registry**。本 spec 只解除 include! 这一个结构阻塞，不改变发布方式；16 个 crate 的版本约束迁移、发布顺序、`[patch]` 收口是另一张票。**尤其：`wasm-core` 的 `cargo package` 全流程成功依赖 `wasmnest-plugin-api` 发布（当前第一阻塞，见 Problem 1），不在本次达成范围。**
- **删除根 `packages/` submodule**。依赖 registry 之后才可能；本次不讨论。
- **清偿 `wasm-core` 对桌面 SDK 的反向依赖**（`desktop-assembly` → `wasmnest-plugin-api`）。已知架构债，独立票据——它与 `cargo package` 阻塞是同一根源，若要真正打通发布四条路径，须先办此票。
- **`check-release-manifest` 的 `describe --tags --exact-match` 在 shallow clone 下误红**（另一独立面：apps 仓 HEAD 无精确 tag 的既有红见 Seam 2 基线声明）。独立小修，不在本次范围。
- **把 WIT 集中到单一 crate**。已在 D2 明确否决并记录理由。
- 任何 ABI 变更、契约版本 bump（除非实施中意外发现必须，另开票）。

## Further Notes

- 这次改造的价值不在「少一个文件」，而在**把一条隐式约定变成编译器强制的事实**；它同时是 registry 路线的必要前置，但**不必等 registry 定案才做**。
- 迁移完成后，`docs/contracts.md` 的「真源」表述要从「能力仓根 contracts 文件」改为「`wasmnest-contract` crate」；`packages/AGENTS.md`（能力仓侧）§0 定位、§1 结构树、§2.2 真源链与三条使用路径的路径表同步，并新增一条「SPLIT_CRATES 不收录本 crate（D8）」的说明；`docs/codemap.md` 结构树同步。文档字面 ≠ 事实，改完用 `ls` / `rg` 核对一次。
- 迁移必须保持「三仓同一步」：能力仓新 tag、平台指针、测试仓锁路径。**平台仓内是五处消费点（两脚本 + 桌面 tests 锁 + 桌面 src 内联测试 + 移动锁），测试仓一处，共六处**——任一处漏改都会让对应锁红，且报错信息指向的是 `expect()` / 文件不存在，容易被误判为「仓坏了」——实施说明里要点名这一点。
- 若实施时发现内核 crate 之外还有第二个 `include!` 消费者（当前 grep 只命中内核一处），应回到本 spec 更新 D3 再继续，不得就地发挥。

## 实施记录（2026-10-19）

1. **D3 成立**：`rg include!` 全能力仓只命中内核 `contract.rs` 那一处（其余是 `include_str!`，均在本 crate 树内），无第二消费者。
2. **D5 的 crate 根判定按「`packages/<顶层目录>`」落地，而非「最近 Cargo.toml」**（对应 issues/01 的写法）。原因：夹具 crate（`wasmnest-wasm-core/fixtures/**`）按设计绑定父 crate 的 `wit/core.wit`，按最近 manifest 会把 `include_str!("../../wit/core.wit")` 误报成逃逸；采用顶层 crate 根后，改造前唯一命中恰为 `wasm-core/src/contract.rs`（与 D5 的「先红」预期一致）。
3. **`bindgen!` 保留一条既有例外**：`wasmnest-server-websocket/src/plugin_binding.rs` → `../wasmnest-ws-client-engine/wit/ws.wit`（ADR 0052 D2/D4 的共享契约真源）。结构锁按「文件 + path 值」精确登记并在每次运行时反向自检；它不是本次迁移期的临时例外（那条已随 `contracts/` 删除而不存在）。
4. **`wit/core.wit` 的注释未改**：该文件被 `compose-wit.mjs` 逐字节拷入双端生成物，改注释会破坏 D7「生成物字节不变」与 Seam 1/2 的验收边界。真源路径改述只落在代码 / 文档面；WIT 头注里的旧路径待下一次合法 WIT 变更（必须 bump）时顺带修正。
5. **平台仓 `packages/` 工作树当前承载同一份改动**（submodule 克隆与 `../wasmnest-lib` 以 `diff -r` 核对逐字节一致）；提交后以 submodule 指针 + `release-manifest.json` 收口，`check:manifest` 的「submodule 脏」红即消失，剩余基线红仍是 apps 仓 HEAD 无精确 tag。
6. **Seam 5 的「改造前先红」已补实证**：用 `git worktree add --detach` 检出迁移前提交 `bcbd823`，以同一 `scanCrateBoundaries()` 扫描旧树，输出恰好 1 条违规：
   `wasmnest-wasm-core/src/contract.rs:31 include!("../../contracts/wasmnest-plugin-package.rs") 逃出 crate 目录（crate 根 = wasmnest-wasm-core）`。
   与 D5 的「当前唯一命中」一致；扫描器未误伤夹具 / 其余 crate。临时 worktree 已删除。

## 后续架构裁决（2026-10-19，覆盖 D6 的 submodule 部分）

用户裁决：**`wasmnest-lib` 维护一切内部依赖 crate 是强事实**；删除平台仓 `packages/` submodule，平台直接以 Cargo sibling path 消费；工程结构与高内聚低耦合优先于测试，不为测试保留旧结构。

- 删除 `wasmnest/packages`：`git submodule deinit -f` + `git rm --cached` + 删 `.gitmodules` + 删 `.git/modules/packages`；删前 `diff -r` 与 `../wasmnest-lib` 为空。
- 23 处宿主 Cargo path → `../../../wasmnest-lib/<crate>`；测试仓 `cross-end-tests` / `desktop-harness` → `../../wasmnest-lib/...` / `../../../wasmnest-lib/...`；双端 `compose.json` 的 core/caps → `../wasmnest-lib/...`。
- 新增 `scripts/lib-paths.mjs`（`WASMNEST_LIB_ROOT` 或 R1 兄弟目录）；`compose-wit.mjs` / `check-release-manifest.mjs` / `crate-structure-lock.test.mjs` 走 lib root。
- `check:manifest` 第 2 判据改为「能力仓 HEAD 精确 tag + 工作树干净」；`release-manifest.json` 的 `repos.lib.tag` 成为唯一跨仓钉版表达（平台仓不再记录 gitlink）。
- 测试按新结构跟随修改；lib 内部的 `include!`/`bindgen!` 结构约束计划迁回 lib（平台只保留 compose 路径与宿主侧断言），避免平台 node 锁跨仓维护 lib 源码布局。
