# LayerFS 开发流程规范（四仓共享，强制）

> 本文件是 `docs/public/` 的组成部分，与各仓 AGENTS.md 的硬约束同级。
> 本机部署、工具参数、客户端可用性与排障见平台仓 `docs/layerfs.md`；本文件只写**流程与门禁**。

## 1. 铁律

1. **单项目**：一个 LayerFS project `wasmnest`，根 = 四仓父目录 `WasmNest/`（不是单个仓）。禁止按仓拆 project。
2. **项目文件只走 LayerFS**：读、写、搜索、跑命令一律 `layerfs_*`。宿主 Write/Edit 仅允许 §6 落地同步与 §7 bootstrap。
3. **工具不可用即停**：没有 `layerfs_*`、`layerfs_status` 失败、`sudo` 被 no_new_privs 拒绝 ⇒ 停手报告，禁止「先用宿主改完再补」。
4. **`main` 只读**：只 fork，不写、不 mount、不 commit；`main` 只接受 `layerfs_publish`。
5. **git 是交付面**：任务期间 git 只读（`status` / `diff` / `log`；`add` / `commit` / `reset` / `checkout` / `stash` / `clean` / `fetch` / `pull` / `push` 都禁止，否则落地 patch 会漏内容）；提交只在发布分支一次性完成（§5.4）；push 需用户授权。§5 / §6 的流程命令是明确例外。LayerFS 历史与 git 历史不必一一对应。
6. **项目根的非 git 文件**（`/.lww`、`WasmNest.code-workspace`）不参与逐仓落地，改动走 §7 例外并点名。
7. **健康检查必须真实调用**：只看到 `tools/list` 不算可用，必须成功调用一次 `layerfs_status`。客户端状态 / 超时见 `docs/layerfs.md` §3.1。

## 2. 分支与 Commit

- 一任务一分支：`layerfs_fork` 建 `feat-<slug>` / `fix-<slug>` / `docs-<slug>`，**不以 `c` 开头**（worker 会当 commit）。并行任务各自 fork。
- 每一步一个 Commit：`write/edit/apply/run` 的 message 写 `step N: 做了什么（结果）`，失败写退出码。只读操作不产生提交。
- 先读后写；`Conflict` / `HeadMoved` 会拒绝且不写入，重读当前版本再重做。
- 命令一律 `layerfs_run`；长命令自包 `timeout 110 …`。请求体 ≤ 65,519 字节，`layerfs_read` 每窗 ≤ 2000 行 / 48 KiB。
- `/.lww` 只在 bootstrap 建，绝不列源文件；普通任务不改。

## 3. 开工前置检查（每次任务）

1. `layerfs_status(project: "wasmnest")` 成功；无项目 → §7。
2. 宿主四仓在 `dev`（或约定分支）、`git status --porcelain` 为空；有非本任务在途改动 → 停手问用户。
3. **基线 tree 相等**：宿主与 LayerFS 当前 main（fork 出的任务分支同命令）逐仓比较
   `git -C <repo> rev-parse HEAD^{tree}`。任一不等 = 宿主与 LayerFS 漂移 → 停手，按 §5 rebase 或 §8 处置。

不比 commit SHA（LayerFS 内基线可能是合成提交），只比 **tree SHA**。

## 4. 任务流

```text
status → fork → read/list → write/edit/apply → run 验证
       → 同步 main + publish（§5）→ 落地 git（§6）→ status 复核
```

- 针对性单测 / 锁用 `layerfs_run`；命令失败把退出码写进 message（有文件变更才产生 Commit）。
- 重命令（Rust 全量构建 / 跨仓锁 / E2E）在**落地后的宿主**按 `testing.md` 跑；Sandbox 内跑 Rust 用 `CARGO_TARGET_DIR=/tmp/wasmnest-target` 避免 Store 膨胀。
- 禁止在 Sandbox 内 push、读宿主凭据、把 `.env` / keystore / token 写进项目。

## 5. 发布（同步 main + publish）

1. **发布串行**：同一 project 一次只允许一个 publish；publish 是覆盖式的，fork 后 main 动过就不能直接 publish。
2. **main 动过 → rebase**：任务分支导出 `git add -A && git diff --cached --binary HEAD`（按仓拆）→ 从最新 main fork `prepublish-<slug>` → 用 heredoc `git -C <repo> apply --3way -` 重放 → 解决冲突（§8）→ 重跑验证。
3. **生成并保存**落地 patch 与期望 tree，**必须在 §5.4 的 git commit 之前**：
   ```bash
   git -C <repo> add -A
   git -C <repo> diff --cached --binary HEAD   # 保存为落地 patch
   git -C <repo> write-tree                    # 保存为期望 tree
   ```
   §5.4 提交后工作树已干净，不能再从工作树重新生成 patch。
4. 每仓一个 git commit（宿主 `git config` 身份，消息按 `git.md`）；`rev-parse HEAD^{tree}` 必须等于期望 tree。
5. `layerfs_publish`；返回的 `overwrote` 必须为空，否则停手。
6. `layerfs_status` 复核 main head。

## 6. 落地 git（publish 后）

> 落地只做同步，不做二次编辑。patch 与期望 tree 来自 §5.3。

| 步 | 动作 | 门禁 |
| --- | --- | --- |
| 1 | 宿主四仓 clean，当前 tree == §3 基线 tree | 不满足 → 停手 |
| 2 | `git apply --check --binary <patch>`，再 `git apply --binary` | check 失败 → 宿主不动 |
| 3 | 宿主 `git add -A && git write-tree` == 期望 tree | 不等 → `git apply -R` 还原本次并报告 |
| 4 | 按 `git.md` 逐仓提交（跨仓顺序按 `git.md` §7） | husky 改文件 → 停 |
| 5 | 提交后 `rev-parse HEAD^{tree}` 仍 == 期望 tree | 不等 → 停手，按 §5.2 重做 |
| 6 | push（用户明确授权） | 禁止自动推、禁止 `--force` |

- 落地失败 / 宿主领先：停手报告；**落地未完成不得开始下一个任务**。
- 交付说明必须列出：LayerFS 分支、publish 结果、落地仓、tree 门禁、实际跑过的验证与未跑项。

## 7. Bootstrap（一次性；唯一允许宿主直改的窗口）

> 先提交本规范与工具配置到各仓 HEAD——种子只取 HEAD。业务代码仍不得走宿主。

```bash
WS=/home/binblink/project/tauriProject/WasmNest
SEED=/home/binblink/project/tauriProject/.layerfs-seed/wasmnest
rm -rf "$SEED" && mkdir -p "$SEED"
for r in wasmnest wasmnest-lib wasmnest-apps wasmnest-test; do
  git clone --local --branch dev "$WS/$r" "$SEED/$r"
done
cp "$WS/WasmNest.code-workspace" "$SEED/"
```

1. `layerfs_init(project: "wasmnest", folder: "$SEED")` → `layerfs_status` 复核。`Exists` = 项目已存在，不重复 init，先按 §3 核基线。
2. 在 `chore-layerfs-bootstrap` 分支写项目根 `/.lww`：

```text
.git/
node_modules/
target/
dist/
build/
coverage/
.cache/
resources/plugins/
*.log
%include wasmnest/.gitignore
%include wasmnest-lib/.gitignore
%include wasmnest-apps/.gitignore
%include wasmnest-test/.gitignore
```

3. `layerfs_publish` 该分支，再按 §3 核对四仓 tree。
4. 种子只用于 init，完成后可删，不入库。基线无法增量收口时新建 project（如 `wasmnest2`）重做；删旧 project 必须经用户授权。

## 8. 冲突、回退、并行

- **冲突**：先读两边再统一，重跑验证；`layerfs_merge` 只用于并行分支联合验证，发布前必须回到最新 main 派生的干净分支。
- **回退** = `layerfs_commits` 找历史点 → `layerfs_fork(fromRef=<commit>)`；禁止改写历史、禁止宿主 `reset --hard`。
- **并行**：一人一分支，协调者串行 publish；`Busy` 等当前操作结束再试；`Failed` / `Unknown` 先查 `status` / `commits` 再决定。
