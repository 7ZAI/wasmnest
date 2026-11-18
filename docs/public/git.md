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

## 8. worktree 与 target 共享桶（新建 worktree 后必做）

四仓的 `.cargo/config.toml` 用相对 `target-dir`（`target/wasm-apps`、`../target/server-libs`），cargo 按 **config 所在目录**解析，worktree 里 config 随代码走 ⇒ **每棵 worktree 各长一整套 target**（桌面 8~12G / 移动 8~9G / 能力仓 9~24G）。2026-11-08 一天内清了三轮共 ~190G，全是这个原因。

因此**新建（或重新启用）worktree 后必须做第一步，再开始构建**：

```bash
cd <容器根>/wasmnest && pnpm run target:worktrees     # = node scripts/worktree-shared-target.mjs
```

- 脚本把该 worktree 里 cargo 会写的路径（`<wt>/target`、`<wt>/<crate>/target`、`<wt>/<host>/src-tauri/target`）软链到 `<容器根>/target-shared/<repo>/…`；仓内相对 `target-dir` 穿链落进共享桶，主树与 CI 零改动。
- **幂等、可随时重跑**：正在构建的 worktree 按 `/proc/<pid>/cwd` 自动整体跳过——**绝不在活构建里换链接**（会直接打断对方）。
- 已有实体 target 目录时用 `pnpm run target:worktrees --migrate` 并入共享桶；先看用 `--dry-run`。
- **清理**：删 `<容器根>/target-shared` 下的内容；删 worktree 里的 `target` 只删掉软链、不省空间。
- 需要并行构建（同 repo 多棵 worktree 共用一把 cargo target 锁）时，给该会话自带桶：`CARGO_TARGET_DIR=/tmp/wt-<name> …`（env 压过一切 config / 软链），用完自行清理。
- 机制与落点全景：平台仓 `docs/target-governance.md` §1.1。
