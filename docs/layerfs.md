# LayerFS 使用文档

> **本文件记录 LayerFS 在本机的部署事实与工具面（标准 MCP 服务）接入用法**。LayerFS = 给 coding agent 用的持久化文件系统历史层（Ephemeral-AI-Lab/layerfs v1.0.0，MIT，仅源码发布）。与 WasmNest 互补：WasmNest 管「WASM 插件能力沙箱」，LayerFS 管「agent 工作区 + 文件系统历史」——多 agent 并行开发时每步都是可回退的快照，`node_modules` / lockfile / 构建产物随快照走，挂载即用免重装。

---

## 1. 核心概念

| 概念 | 含义 |
| --- | --- |
| Store | 一个项目全部历史所在的**单个 SQLite 文件**，只增不删 |
| main | 只读发布线，只接受 `publish` 产生 Layer |
| Branch | 一条提交线（fork 只记元数据，**不复制文件**） |
| Layer | main 上的一次 publish（一个冻结的项目状态） |
| Commit | 一次改动（每个 fs 写 / 每次命令）不可变 |
| Workspace | 一个分支在 Sandbox 容器里的可写挂载视图（跑命令用） |
| Sandbox | 一个容器（跑 layerfs-daemon），一个 Sandbox 最多 16 个 Workspace；闲置 2 分钟自关 |
| `/.lww` | 项目根的冲突规则文件（当 .gitignore 用，`%include .gitignore`，绝不列源文件） |

## 2. 本机部署事实（已装好）

| 项 | 位置/值 |
| --- | --- |
| LayerFS 源码 | `/home/binblink/layerfs`（sparse：core sdk dsh docs .agents） |
| bundle（daemon + native addon） | `~/layerfs-linux-build/` |
| runtime 镜像 | `layerfs-352-runtime:node24`（本地构建，不带 `@sha256` digest 的副本 Dockerfile；基础 `node:24.21.0-bookworm` digest 与官方一致） |
| Docker | docker-ce 29.x，**API 1.56**（需 ≥1.54；系统原 26.1.5 的 API 1.45 不兼容——binding 硬编码 `/v1.54` 且 streaming archive 有 broken pipe，已实测） |
| Docker data-root | `~/.docker-data`（daemon.json 配置；卷/镜像/容器数据全在用户目录，host 无需 root 读卷） |
| LayerFS 卷 | 每项目一个 `pi-<project>-store`，Store = `~/.docker-data/volumes/pi-<project>-store/_data/global/store.sqlite`（容器内固定 `/layerfs-store/global/store.sqlite`） |
| LayerFS home | `/root/.layerfs-pi`（**必须属主 = 进程用户且 0700**；本架构所有 SDK 调用以 root 跑，故落 root 的 home） |
| sudoers | `/etc/sudoers.d/binblink-layerfs`：`chown -R binblink:binblink …/volumes/*`、`chmod -R a+rwX …/volumes/*`（后两条已不需要，无害）、`/home/binblink/.config/nvm/…/bin/node /home/binblink/.pi/agent/extensions/layerfs/worker.mjs` |
| 权限模型 | **Store 操作进程必须与 daemon 同 uid=0**（`DAEMON_UID=0` 硬约束：install 必须 root，且非 root 进程打不开 root-owned Store）；所有 SDK 调用一律 `sudo <node> worker.mjs`（白名单 JSON RPC，不执行任意代码） |
| MCP 服务（工具面） | `~/.pi/agent/extensions/layerfs/mcp-server.mjs`（stdio，零依赖，唯一工具面）；接入手册同目录 `MCP.md`，已退役的 pi 原生扩展在 `legacy/` |

## 3. 工具面：标准 MCP 服务（唯一面，多 agent 通用）

**唯一工具面** = `~/.pi/agent/extensions/layerfs/mcp-server.mjs`（stdio MCP，零依赖，v1.1.0）：12 个工具 + 资源 `layerfs://discipline` + `initialize.instructions` 纪律。

- pi 原生扩展已于 2026-10-24 **退役**（`legacy/index.ts.off`，恢复步骤见同目录 `legacy/README.md`）——pi 现在和其他 agent 一样走 MCP，避免两个工具面长期不同步。
- 底层 = `worker.mjs`（白名单 JSON RPC：stdin 一行 / stdout 一行），每次工具调用 `sudo -n <nvm-node> worker.mjs` 以 root 执行（§2 权限模型，复用既有 sudoers 授权，不需要新增提权）。
- `worker.mjs` 的绝对路径被 sudoers 钉死 ⇒ **不能挪位置**；`mcp-server.mjs` 自身可以换路径 / 软链（Node 会 realpath 到真实目录再拼 worker 路径）。
- **同 project 调用在服务内串行**（Sandbox 一次只建一个，同分支并发写会互撞），不同 project 并行。
- 纪律另有一份 pi skill：`~/.pi/agent/skills/layerfs-usage/SKILL.md`（服务内 instructions 与它同源）。

| 工具 | 作用 | 备注 |
| --- | --- | --- |
| `layerfs_init` | 把宿主目录**全量导入**新项目（含 `.git` 与 ignored 文件） | 仓库先清 `node_modules`/`target`，否则一层快照就吃掉大量磁盘 |
| `layerfs_status` | 项目概览：分支 / head / 最近提交 | 开始、恢复工作先看这个（一次顶 N 次） |
| `layerfs_fork` | 从 main 或任意 ref 建分支 | 一个任务一个分支 |
| `layerfs_commits` | 分支提交历史 | 找历史点回退用 |
| `layerfs_merge` | 三路合并两分支为新分支 | 冲突时**不创建任何东西**并给出冲突详情 |
| `layerfs_publish` | 分支 head → main 新 Layer | 覆盖式，先 merge main |
| `layerfs_write` / `edit` / `apply` | 写 / 精准替换 / 批量变更 | 一次调用 = 一个原子 Commit（apply 任一失败则全部不落） |
| `layerfs_read` / `list` | 读文件 / 列目录（含 glob） | 只读，不产生 Commit；每窗 ≤2000 行 / 48 KiB |
| `layerfs_run` | Sandbox 内跑命令并提交 | mount → exec → commit → unmount 一条龙；`/tmp` 与命令输出不进历史 |

### 3.1 各 agent 接入（本机实测状态）

| agent | 配置位置 | 状态 |
| --- | --- | --- |
| pi | `~/.pi/agent/mcp.json`（`exposure: "direct"`、`timeout: 900`） | ✅ `pi mcp list` = `connected, 12 tools (direct, global)` + resources；工具名为 `mcp__layerfs__layerfs_*` |
| OpenCode | `opencode.json` → `mcp.layerfs`（`type: "local"`） | ✅ v2.1.4 `✓ layerfs connected` |
| Codex CLI | `~/.codex/config.toml` → `[mcp_servers.layerfs]` | ✅ 0.160 `codex mcp get` 解析正常（`tool_timeout_sec`） |
| Qoder CLI | `~/.qoder/settings.json` → `mcpServers` | 文档形态，本机未装、未实测 |
| CodeBuddy Code | `~/.codebuddy/.mcp.json` → `mcpServers` | 文档形态，本机未装、未实测 |
| ZCode | `~/.zcode/cli/config.json` → `mcp.servers.layerfs`（用户级，session 启动自动连） | ✅ 2026-10-24 接入并实测（stdio 握手 12 工具）；方言字段 `timeoutMs`（ms），**schema 严格、未知键整条丢弃**——pi 方言 `exposure`/`description`/`timeout`（秒）不可照搬 |

公共部分只有 command/args 两行，其余是各家方言（完整片段见 `~/.pi/agent/extensions/layerfs/MCP.md`）：

```json
{
  "command": "/home/binblink/.config/nvm/versions/node/v24.20.0/bin/node",
  "args": ["/home/binblink/.pi/agent/extensions/layerfs/mcp-server.mjs"]
}
```

**超时预算（最容易踩的坑）**

| 客户端 | 默认单次工具超时 | 要改成的值 |
| --- | --- | --- |
| pi | 60 s | `"timeout": 900` |
| Codex | 60 s | `tool_timeout_sec = 900` |
| OpenCode | **5 s**（`McpLocalConfig.timeout`，ms） | `"timeout": 900000` |
| ZCode | 30 s（`timeoutMs`） | `"timeoutMs": 900000` |
| Qoder / CodeBuddy | 各自不同 | 找到 timeout 字段调到 900 s 级别 |

服务端兜底 `LAYERFS_MCP_TIMEOUT`（默认 900 000 ms）；不调客户端侧，`layerfs_run`（npm install / build）必被掐断。

**接入自检**：`node ~/.pi/agent/extensions/layerfs/mcp-server.mjs --doctor` —— 打印 node/worker 路径、worker realpath 与 sudoers 对齐情况、docker.sock、协议版本、工具清单、`sudo -n` + worker RPC 通路（`selftest` 的两种正常结果：`通路 OK` / `通路 OK（探测项目不存在，属正常）`）。

**规范合规**（官方 `@modelcontextprotocol/sdk` 1.32.2 客户端实测全绿）：protocolVersion 协商覆盖 2024-11-05 / 2025-03-26 / 2025-06-18 / 2025-11-25；`tools/list` 带 `title` + `annotations`（readOnlyHint / destructiveHint / openWorldHint，供客户端做权限门禁）；执行失败回 `isError` 内容而非 JSON-RPC error（模型可自纠）；`notifications/cancelled` 按**进程组**停掉 worker 且不回响应；stdout 只写协议行（日志仅 `LAYERFS_MCP_DEBUG=1` 进 stderr）。

## 4. 快速上手（第一个项目）

```text
1. 启动会话（pi 自动连 MCP；改过 mcp.json 后 /reload 重连）
2. layerfs_init(project: "wasmnest", folder: "/…/wasmnest")   # 先清 node_modules/target！
3. layerfs_status(project: "wasmnest")                        # 看 main 现状
4. layerfs_fork(project, name: "feat-x")                      # 新任务分支
5. layerfs_write / layerfs_apply                              # 改代码（每步一个 Commit）
6. layerfs_run(project, branch: "feat-x", command: "pnpm run test:run")   # 验证
7. layerfs_merge(a: "feat-x", b: "main", name: "merge-main") # publish 前同步 main
8. layerfs_publish(project, branch: "merge-main")             # 进 main
```

## 5. 使用纪律（硬规则）

1. **main 只读**：只读、fork 它，绝不 write/mount/commit 到它（会拒绝）。
2. **一个任务一个分支**：写任何东西前先 fork；并行任务各自 fork。
3. **每一步都是 Commit**：write/edit/apply/run 自动提交，消息说明这一步做了什么（失败点也是历史）。
4. **命令用 `layerfs_run`**（npm install/test/build/git 都在命令里改文件，随命令提交）；长命令自包 `timeout 110 …`（exec 无超时）。
5. **publish 前先 merge main**（publish 覆盖式，会跳过 fork 后 main 的新 Layer）。
6. **冲突先读两边再合并**：merge 冲突不落任何东西，读出错行、解决、再合并。
7. **回退 = fork 旧 commit**（历史不可改写）；`layerfs_commits` 找历史点，`layerfs_fork(fromRef=<commit>)` 重试。
8. **第一步建 `/.lww`**：一行 `%include .gitignore`（当 .gitignore 用，绝列源文件）。
9. **世界隔离**：项目文件一律走 layerfs 工具（pi 里叫 `mcp__layerfs__layerfs_*`）；宿主工具（read/write/find/grep 等，含 fff 覆盖的 `find`/`grep`）看不到 Store 里的项目文件——只管宿主自己的临时/配置工作。
10. **请求体上限**：paths+edit 文本+消息合计 ≤ 65,519 字节；大改动用 `layerfs_apply` 分批或命令处理。

## 6. 多 agent 并行工作流

```text
协调者（main 会话）：
  layerfs_init / status → 给每个 subagent 一个任务名
  layerfs_fork(name: "agent-a") / layerfs_fork(name: "agent-b") …   # 各 agent 独立分支

各 subagent（独立会话，各自 branch）：
  layerfs_read / write / apply / run 在各自分支上推进（每步 Commit）

协调者合并：
  layerfs_merge(a: "agent-a", b: "agent-b", name: "integrate")
  → 有冲突：读两边、解决同一行、再 merge
  → layerfs_merge(a: "integrate", b: "main", name: "pre-release")
  → layerfs_run(branch: "pre-release", command: "pnpm run test:run")   # 发布前全量验证
  → layerfs_publish(branch: "pre-release")
```

要点：所有 agent 连的是**同一个 MCP 服务定义**（各自 spawn 一个 server 进程，底层共用 sudo+worker）；服务内按 project 串行，因此各 agent 各用自己分支、串行使用自己的 Sandbox（Sandbox 一次只建一个，撞了报 `Busy`）；一个进程对同一 Sandbox ≤6 并发。不同 project 之间可真正并行。

## 7. 回退 / 冲突处理

- **回退一步**：`layerfs_commits` 找目标 commit → `layerfs_fork(name: "try-again", fromRef: <commit>)` → 从那里继续。旧提交留在历史里（不可改写）。
- **同分支并发写**：另一 writer 改了同一路径 → 拒绝 `Conflict` / `HeadMoved`（什么都没写），先 `layerfs_read` 当前版本再重做。
- **merge 冲突**：冲突详情给出 `sources` / `mergeBase` / `conflicts`（路径列表）；两边都改了同一行 → 读两边的版本、统一、再 merge。
- **不盲目重试**：`Failed` / `Unknown` 的结果不确定——先 `layerfs_status` / `layerfs_commits` 查证再决定。

## 8. 排障（本机实测过的坑）

| 现象 | 原因 / 处理 |
| --- | --- |
| `sudo: 需要密码` 在 worker 里 | sudoers 授权未生效：检查 `/etc/sudoers.d/binblink-layerfs` 语法（`visudo -c`），注意 sudoers 里**裸冒号是语法错误必须 `\:`**；文件权限 440；node 路径必须是 nvm 完整路径（`/usr/bin/node` 不存在） |
| `Unsupported: … must be owned by this user and private` | home 目录属主/权限不对：LayerFS home 必须属主 = 进程用户且 0700（root 进程用 `/root/.layerfs-pi`） |
| `Store install runs as user 1000; it must run as user 0` | install 必须 root：所有 SDK 调用走 `sudo <node> worker.mjs` |
| `Malformed: pack persistence`（host 打开 Store） | 非 root 进程打不开 root-owned Store：统一 root 跑 |
| `client version 1.54 is too new. Maximum supported API version is 1.45` | docker 太旧：需 docker-ce ≥ 27（本机 29.x / API 1.56）；26.1.5 另外有 sandbox upload broken pipe（streaming archive），仅升级解决 |
| `private directory ownership/mode/type`（daemon 启动） | store 父目录权限被放宽（如 chmod a+rwX）——卷内目录必须 owner root、0700/0600，**不要 chown/chmod 放宽** |
| `sandbox create stopped at Upload / Broken pipe` | docker API 太旧（见上）；另确认 `/dev/fuse` 存在（本机有） |
| `Busy`（sandbox create） | 同项目另一个 create 在跑：等它结束再建（一次只建一个） |
| docker 命令 permission denied | 当前会话用户未在 docker 组（或组集合未刷新）：用 `sg docker -c '…'` 包装（已在组则免密） |
| Docker Hub 拉镜像超时 | 直连被墙：`docker pull docker.m.daocloud.io/library/<img>:<tag>` 再 `docker tag` 成本地名；npm/pnpm 代理 env `npm_config_proxy/npm_config_https_proxy=http://127.0.0.1:10811` |
| pi 里找不到 `layerfs_*` 工具 | 原生扩展已退役：实际工具名是 `mcp__layerfs__layerfs_*`；`pi mcp list` 应显示 `connected, 12 tools`（否则看 mcp.json 与 `--doctor`） |
| 客户端报 `-32001` / `request timeout` | 客户端侧 MCP 超时太小（**OpenCode 默认 5 s**）：按 §3.1 调到 900 s 级别；服务端兜底是 `LAYERFS_MCP_TIMEOUT` |
| 取消后 `docker ps` 还看到 sandbox | 正常：取消只停本地 worker（按进程组），LayerFS sandbox 本就随项目常驻；该分支可继续 `layerfs_run`（实测取消后同分支 exit=0） |
| `worker 无输出，退出码 1` | `sudo -n` 失败：sudoers 里 worker/node 路径漂移、文件权限不是 440；跑 `--doctor` 看 worker realpath 是否对齐 |
| `tools/call` 卡着直到超时 | 命令真的在跑（长命令）；自己包 `timeout 110 …` 并把客户端超时调大（§3.1），别靠取消代替超时 |

## 9. 维护 / 清理

- **删项目**：worker 提供 `project.remove`（删 home 记录 + 删卷，幂等）；Sandbox 容器若还占用卷，先 `docker rm -f layerfs-<project>-<n>`。
- **磁盘**：Store 只增不删（无 GC），大仓提前规划；编译缓存卷 `layerfs-cargo`/`layerfs-target` 可删（需要重编译时才重建）；`docker image prune` 清旧镜像。
- **重装/升级 LayerFS**：Store 格式不跨版本迁移——升级 = 新项目重来（旧 Store 会被拒绝而非迁移）。
- **改完配置先自检**：动过 `mcp.json` / node 路径 / 服务目录后跑 `node ~/.pi/agent/extensions/layerfs/mcp-server.mjs --doctor`（路径、sudo 通路、工具清单一次看全）。

## 10. 已知限制

1. **单机单内核**：所有打开 Store 的进程必须同一台 Linux + 同一内核 + 本地 ext4/xfs/btrfs；NFS / VM 边界 / 第二台机器一律 `Unsupported` 且无降级。
2. **不承诺持久性**：Store 跑 Disposable profile（SQLite WAL + `synchronous=OFF`），OS 崩溃 / 掉电可能丢最近历史——重要内容在项目内额外 `git push` 备份。
3. **没有 GC**：历史只增不删。
4. **`project.init` 全量导入**：连 `.git` 和 ignored 文件一起（导入前清大目录）。
5. **dsh web 的 Init 也要 root**（同 uid-0 约束）：本机 dsh web 仅作查看，建项目用 pi 的 `layerfs_init`（worker 走 root）即可。
6. **不保存运行态**：进程 / 内存 / socket / 命令输出不在历史里；Sandbox 容器死掉 → 未提交改动全丢。
7. **只有 stdio transport**：LayerFS 要求进程与 Store 同机同内核 ⇒ 不能做远程 / HTTP MCP 部署，也不能跨主机共享 Store。
8. **每次调用 ≈130–450 ms**（spawn node + 打开 Store 的固定开销）；要压到毫秒级必须改常驻 root daemon + unix socket，目前未做。
9. **未暴露 `branch.diff*`**：worker 里「ref 以 `c` 开头就当 commit」的启发式会误判 `codex-*` 这类分支名，要加得先给它传显式 kind。

## 11. 参考

- 源码与官方 skill：`/home/binblink/layerfs/.agents/skills/layerfs-js-sdk/SKILL.md`（SDK 调用全参考，dsh 内用法）
- 官方文档：https://layerfs.ai/docs/ 、https://github.com/Ephemeral-AI-Lab/layerfs
- pi 集成细节（worker 协议 / 卷布局 / 权限 / 多 agent 配置片段与超时表）见 `~/.pi/agent/extensions/layerfs/MCP.md`；服务与 worker 源码 `~/.pi/agent/extensions/layerfs/{mcp-server.mjs, worker.mjs}`；已退役的 pi 原生扩展在 `legacy/`（含恢复步骤）；纪律 skill `~/.pi/agent/skills/layerfs-usage/SKILL.md`