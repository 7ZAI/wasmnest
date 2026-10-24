# Git 提交规范（四仓共享）

> **本文件是 `docs/public/`（四仓通用规范）的组成部分**；各仓 AGENTS.md 引用本文件，不复制。
> 与各仓 AGENTS.md 的硬约束同级别。仓特有的 git 细则（如平台仓的能力仓 sibling 钉版纪律）见各仓对应文档（平台仓：`docs/git.md`）。

## 1. Commit 格式

- conventional commits：`<type>(<scope>): <subject>`，例如 `fix(desktop): …` / `refactor(lib): …` / `chore(apps): …`。
- scope 用仓内既有口径：平台仓先用例 `desktop` / `mobile` / `docs` / `scripts` / `sdk`；能力仓先例 `(lib)` 前缀（`refactor(lib):`）；应用仓先例 app slug（`(file-transfer)` 等）；测试仓先例 `(cross-end-tests)`。
- **禁止 AI 协作者标记**（Co-Authored-By / 类似署名一律不加）；commit message 只描述人话能懂的改动。

## 2. 推送与远程

- 分支 / 推送遵循各仓现有口径，**禁止 `--force` 覆盖远端**。
- 远程分叉时立即停手问用户（不自行 rebase / merge 抢占）。

## 3. 开工自检

- 任何改动前先 `git status` 认领改动来源：**非本任务的在途改动一律不碰、不回滚**。
- LayerFS 工作面（`layerfs.md`）：开工前先过其 §3 的工具 / 基线 tree 核对；落地提交只在 tree 门禁通过后进行（§6），LayerFS 内的 step Commit 不等于 git 提交。
- 含他人 / 此前会话在途改动的文件，编辑时只动自己那行，不整文件覆盖。

## 4. 只提交源码

- 产物 / 生成物 / 缓存不入库：`node_modules/`、`dist/`、`**/target/`、`resources/plugins/**`、`*.local` 等（各仓 .gitignore 已覆盖；新增生成物目录前先确认 .gitignore）。
- 锁文件 `pnpm-lock.yaml` / 被跟踪的 `Cargo.lock` **只经包管理器变更，禁止手编**。
- 不提交密钥 / 凭据 / token（含 `.env` 里的签名私钥、Android keystore / key.properties、任何 token）；凭据只记长度不落明文。

## 5. 文件回滚规范

- 回滚前先 `git status <file>` + `git diff <file>` 确认不含本次会话之外的未提交改动。
- 含他人在途改动的文件**禁止** `git checkout --` / `git restore` 整文件回滚——用编辑工具逐段逆向替换。
- 误覆盖立即停手上报，不得猜测重建。

## 6. 四仓 tag 规则（发布装配）

- 平台仓：`vX.Y.Z`
- 能力仓：`lib-vX.Y.Z`
- 应用仓：`apps-vX.Y.Z`
- 测试仓：`test-vX.Y.Z`
- 跨仓引用一律用**精确 tag**（不用分支名 / 短哈希）；发布装配按该 tag 取对应仓，未打 tag 的本地改动不进发布。
- **tag 与版本号一样是发布动作**：只有发布时打新 tag + bump 版本号；dev 不因提交累积打 tag / bump（版本号设置纪律见 `versioning.md`）。

## 7. 跨仓特性提交顺序（同一特性跨仓时）

1. **能力仓**（真源 + 打 tag）；
2. **平台仓**（更新 `release-manifest.json` 的跨仓 tag / SDK 生成物）；
3. **应用仓**（按当前 SDK 重建产物）；
每一仓各自可回退；平台仓的 `release-manifest.json` 跨仓 tag 变更必须与能力仓 / 应用仓的实际 tag 同步（细则见平台仓 `docs/git.md`）。