# 版本号管理最佳实践（四仓共享）

> **本文件是 `docs/public/`（四仓通用规范）的组成部分**；各仓 AGENTS.md 引用本文件，不复制。
> 与各仓 AGENTS.md 的硬约束同级别。本文件只讲**版本号（version / 契约版本）的设置纪律**；tag 前缀与跨仓提交顺序见 `git.md` §6 / §7；平台仓发布装配细则见平台仓 `docs/contracts.md` 与 `release-manifest.json`；能力仓契约版本（ABI）变更流程见能力仓 AGENTS.md §2.2。

## 1. 核心规则：版本号是发布语义，不是开发状态

- **只有发布版本时才需要设置 / 重新设置版本号。dev 日常开发一律不 bump**——不因一次提交、一个功能、一批修复、一次重构而改任何版本号字段；版本号始终保持上一发布值。
- 发布 = 打 release tag 的提交（`git.md` §6）。**bump 版本号是发布动作的一部分**，与打 tag、更新平台仓 `release-manifest.json` 同批执行、同一（组）提交内完成。
- 「改了很多 / 感觉该出版本了」不是 bump 理由；**是否发布、何时发布由用户决策**，协作者不自行 bump。
- 发布完成后回到「不 bump」状态：dev 分支后续提交继续沿用该发布版本号，直到下一次发布。

## 2. 何时 bump：发布时按内容选号（semver 判据）

- **破坏性变更 / 契约 ABI 变更** → major（`X`）。
- **新功能（向后兼容）** → minor（`Y`）。
- **修复 / 内部调整** → patch（`Z`）。
- 当前项目阶段（研发起步期）：版本线沿 `0.0.x` 递增（当前 `0.0.1`）；是否升 `0.1.0` / `1.0.0` 由发布内容与用户决策，不自动推定。
- **契约版本与 crate/package 版本解耦**：契约版本（`wasmnest:plugin@X.Y.Z`，真源 = 能力仓 `wasmnest-contract/src/lib.rs` 的 `PACKAGE_VERSION`）**只随 ABI / WIT 变更流程走**（能力仓 §2.2，含全仓 `@X.Y.Z` 字面量同步、WIT 指纹、插件产物重建），不随普通功能 / 修复发版联动；普通发版无需动契约版本。

## 3. 各仓版本号设置点（发布时逐点核对；真源以仓内为准）

> 版本通常从各仓都处于 `0.0.1` 起步；发布时逐点 bump。**普通开发（dev）无需看此表**——只有发布流程才打开它。

| 仓 | 版本号设置点 | 说明 |
| --- | --- | --- |
| 平台仓 `wasmnest` | `package.json` `version` | 与 `release-manifest.json` 的 `product` 一致（`check:manifest` 判据） |
| | 双端 `wasmnest-{desktop,mobile}/src-tauri/tauri.conf.json` `version` | 桌面 / 移动 app 显示与安装版本 |
| | `release-manifest.json`（`product` / `contract.version` / `repos.lib.tag` / `repos.apps.tag`） | 跨仓版本唯一表达（真源注释见文件头） |
| | Android `gen/android/.../build.gradle.kts` 的 `versionCode` / `versionName` | 生成物，**不手改**，随构建核对 / 重生成 |
| 能力仓 `wasmnest-lib` | `wasmnest-contract/src/lib.rs` `PACKAGE_VERSION` | 契约版本唯一手写真源（仅 ABI / WIT 变更流程动，§2.2） |
| | 各 crate `Cargo.toml` `version` | 普通 crate 版本（当前全部 `0.0.1`） |
| 应用仓 `wasmnest-apps` | `package.json` `version` / 各 app `Cargo.toml` `version` | 宿主装配按 tag 取应用仓，不读应用版本号——应用版本号只作显示 / 标识语义 |
| 测试仓 `wasmnest-test` | `cross-end-tests` workspace / `desktop-harness` Cargo.toml `version` | 当前 `0.0.1`，不对外装配、无 product 语义；对外表达主要靠 tag（`test-vX.Y.Z`） |

## 4. dev 中明确不要做（常见误改场景）

- **不因任何开发活动修改版本号字段**（§1）——如「这次改了很多，顺手 bump 一下」。
- 不手改 `Cargo.lock` / `pnpm-lock.yaml` 里的版本（锁只经包管理器变更，`git.md` §4）。
- 不因「`release-manifest.json` 的 `product` / `tag` 落后于提交」而自己改 manifest——manifest 只由平台仓发布流程更新（`check:manifest` 红时照 §5 交付说明点名，不自行动手）。
- 不因普通发版顺手改契约版本 `PACKAGE_VERSION` / `@X.Y.Z` 字面量（§2 解耦；能力仓 §2.2 明文列出的同步副本由平台锁断言）。
- 不打发布 tag、不 bump 后留「半发布」状态（版本号与 tag / manifest 不一致即失配）。

## 5. 发布动作清单（bump 与 tag 联动，跨仓顺序见 `git.md` §7）

1. 确定发布内容与号段（§2；号段由用户确认）。
2. 各涉及仓按 §3 设置点 bump → 提交。
3. 各仓打**精确 tag**（前缀规则 `git.md` §6：`v` / `lib-` / `apps-` / `test-`）。
4. 平台仓更新 `release-manifest.json`（`product` / `contract.version` / `repos.*.tag`）→ `pnpm run check:manifest` + 对应锁。
5. 发布流程走完后回到「不 bump」状态（§1 末条）。

## 6. 「这是不是版本号问题」判据速查

- 改功能、修 bug、加文件 → 与版本号无关，dev 正常提交。
- 要出给用户 / 装配的包 → 发布流程，按 §5。
- ABI / WIT / 跨仓契约变化 → 契约版本流程（能力仓 §2.2），与普通 bump 分开执行。
- 预发布后缀（`-alpha` / `-beta` / `-rc` 等）→ **当前不引入**（个人项目无对外分发场景，`0.0.x` 本身即「未稳定」信号）；如将来需对外分发测试版，在发布流程引入（注意预发布版本永远低于同号正式版、依赖解析默认不选中）。