# 构建资源与 target 治理：落点全景 / 精确清理流程 / 验证

> **本文件是 `AGENTS.md` 的拆分文档（构建资源与 target 治理）**：讲**手工精确清理**——磁盘吃紧时人 / Agent 按步照做的流程。
> **自动治理**（宿主 `src-tauri/target` 15GB 阈值脚本、共享目录只报告）仍归 `docs/commands.md` §6 与 `wasmnest-desktop/scripts/check-target-size.js`；两边冲突时以脚本 + 本文实测为准，并回来修文档。
> **worktree 共用桶**（`.worktrees/**` 的 target 经软链落到 `<container>/target-shared/**`）由 `scripts/worktree-shared-target.mjs`（`pnpm run target:worktrees`）维护，见 §1.1。
> 命令与门禁全景见 `docs/commands.md`；磁盘相关的「改了没生效」排查见 `docs/codemap.md` §6。

## 0. 三条底层事实（先读，避免把磁盘问题当性能问题）

1. **清理从不加速构建。** cargo 的 fingerprint + 增量本来就只重编「改动 crate + 下游」，未改动的产物不会被碰。target 膨胀是**磁盘**问题，清理的收益是空间、代价是下次编译时间。
2. **sccache 只兜底 registry 依赖，不兜底本地 crate。** cargo 只对 workspace 成员传 `-C incremental`，sccache 对该标志直接判 non-cacheable（`sccache --show-stats` 的 `Non-cacheable reasons: incremental`）。所以「删了 target 依赖秒回」只在 sccache 温热时成立，删前先看 `Cache hits` 与缓存目录大小（`~/.cache/sccache`）。
3. **cargo 自报删除量偏高，包级清理会高一个数量级。** 硬链接重复计数：2026-11-04 全量 `cargo clean` 自报 12.6 GiB / 实删 11 GiB（高 10%–20%）；2026-11-07 Tier 2 `cargo clean -p` 桌面自报 19.3 GiB / 实删约 1.9 GB、移动自报 3.0 GiB / 实删约 0.4 GB（约 10 倍，`deps` 与 `debug/<bin>` 的硬链接被重复计入）。**统计一律以 `du -sb` 前后差为准。**

## 1. 落点全景（真源 = 各仓 `.cargo/config.toml` + 脚本）

四仓同场布局（`wasmnest` / `wasmnest-lib` / `wasmnest-apps` / `wasmnest-test`）下的全部 target 落点。平台仓**无根 workspace**，每个 crate 根各跑 cargo，因此 `cargo clean -p` 必须在**该 crate 目录内**执行。

| 落点 | 由谁写 | 可清 | 说明 |
| --- | --- | --- | --- |
| `wasmnest/wasmnest-desktop/src-tauri/target` | 桌面宿主 cargo | ✅ 三级都可 | 包名 `wasmnest-desktop-runtime`；全仓最大的桶（2026-11-04 实测 32 GB） |
| `wasmnest/wasmnest-mobile/src-tauri/target` | 移动宿主 cargo | ✅ 三级都可 | 包名 `wasmnest-mobile` |
| `wasmnest/wasmnest-desktop/target/fixtures`、`wasmnest/wasmnest-mobile/target/fixtures` | 两端 e2e 夹具（`CARGO_TARGET_DIR=../target/fixtures`） | ⛔ **禁止** | `src-tauri/tests/support/fixture_target.rs` 按 `../target/fixtures` 字面路径读写；删了等于让夹具测试下次全量重建（分钟级）且可能打断在途 e2e |
| `wasmnest/wasmnest-mobile/target/wasm-apps` | 移动 `scripts/plugin-build.js`（`--target-dir target/wasm-apps`） | ⚠️ 只清 `debug/` 侧 | `release/` 与 `wasm32-*/release/*.wasm` 是移动插件产物（`plugins:build` / e2e 输入）——**禁止删除**；当前只有 release 侧 |
| `<appsRoot>/target/wasm-apps` | 应用仓 `.cargo/config.toml` 统一重定向（各 app 的 `cargo build/test/build.js`、rust-analyzer 探针全落这里） | ⚠️ 只清 `debug/` 侧（Tier 1/3） | `wasm32-unknown-unknown/release/*.wasm`、`wasm32-wasip3/release/*.wasm` 是 `wasmnest-desktop/scripts/plugin-precheck.mjs` 按字面路径取的**插件产物（host:pack / e2e 输入）**——**禁止删除**；`release/` 目录下也不要动 |
| `<libRoot>/target/host-kits`、`<libRoot>/target/server-libs` | 能力仓各 crate 的 `.cargo/config.toml`（`wasm-core` / `pty-engine` / `host-kit` / `discovery-engine` → host-kits；`server-*` / `crypto-engine` / `p2p-engine` → server-libs） | ✅ 三级都可 | 平台仓构建**不读**这两个桶（平台经 path / git tag 在**自己**的 target 里编译），删它们只影响能力仓自己的 `cargo test` / 同场联调 |
| `<testRoot>/cross-end-tests/target` | 跨端测试工程（独立 workspace） | ✅ 三级都可 | `cargo clean -p` 需在 `cross-end-tests/` 内按 package 名执行 |
| `<testRoot>/target/perf` | `perf-tests/.cargo/config.toml`（`target-dir=../target/perf`） | ✅ Tier 1/3；⛔ **`fixtures/`** | 性能工程独立桶（与 cross-end-tests 分开避免 release 测量互相重编）；`fixtures/` 是性能夹具落点（约 146 MB），按 §4 禁删 |
| `<libRoot>/<crate>/target`（**无** `.cargo/config.toml` 的 crate：`link-crypto` / `wasmnest-contract` / `wasmnest-cli-engine` / `wasmnest-clipboard-engine` / `wasmnest-notify-engine` / `wasmnest-host-api-core` / `wasmnest-headless-host-probe` / `wasmnest-ws-client-engine`） | 各 crate 自己的 cargo 调用（无重定向） | ✅ 三级都可 | 独立桶，每个 crate 单独清；目前只有 `wasmnest-clipboard-engine/target` 有产物（7 MB 级） |
| `<libRoot>/wasmnest-wasm-core/target` | 迁移前 per-crate 残留 | ✅ 可删（legacy） | 该 crate 已用 `.cargo/config.toml` 指向 `../target/host-kits`，这仍是旧落点（删除前 `grep target-dir wasmnest-wasm-core/.cargo/config.toml` 确认） |
| `wasmnest-desktop` / `wasmnest-mobile` 的 `packages/<crate>/target`、`<appsRoot>/apps/<slug>/<end>/rust/target` | 历史错位残留 | ✅ 可删（legacy） | `pnpm run target:size`（在端目录跑）的 `[遗留]` 行即此类；标 `遗留·在用` 的一律不动 |
| `<container>/target-shared/<repo>/…`（容器根，**仓外**） | `scripts/worktree-shared-target.mjs` 建的软链目标：`.worktrees/**` 里的 target 全部指到这里 | ✅ 可删（删空桶内容即可，链接照旧） | 2026-11-08 引入，见 §1.1；宿主的 15GB 阈值脚本**不覆盖**这里，需手工按 §3 清 |

### 1.1 worktree 共用桶（软链机制，2026-11-08）

**为什么**：四仓 `.cargo/config.toml` 的相对 `target-dir`（`target/wasm-apps`、`../target/server-libs`）由 cargo 按 **config 所在目录**解析，worktree 里 config 随代码走 ⇒ 每棵 worktree 各长一整套 target（桌面 8~12G / 移动 8~9G / lib 9~24G）。一天内三棵 worktree 并行就能吃掉 190G+。

**为什么不用 cargo 自带开关**（2026-11-08 实测）：

- `target-dir` 的相对路径跨不出 checkout（主树 depth 0、worktree depth ≥ 2，深度不同，没有统一相对值）；
- `[env] CARGO_TARGET_DIR` **不影响** cargo 自己的 target 解析（实测产物仍落 `<crate>/target`）；改写各轮 `[env]` 无效。

**做法**：`node scripts/worktree-shared-target.mjs`（`pnpm run target:worktrees`，在平台仓根跑）——对每个**已登记且非主树**的 worktree，把 cargo 会写的那批路径建成软链：

- `<wt>/target` → `<container>/target-shared/<repo>/target`（`target/server-libs`、`target/host-kits`、`target/wasm-apps` 等子桶自动穿过链接）
- `<wt>/<crate>/target`（无 `target-dir` 配置的 crate，含两端宿主 `src-tauri`）→ `…/<repo>/<crate>/target`

主树布局零改动、CI 零影响（脚本只在仓外落 `target-shared/`，软链在各 worktree 里、被 `**/target/` 忽略）。

**纪律**：

- **幂等、可随时重跑**：**正在构建的 worktree 自动整体跳过**（按 `/proc/<pid>/cwd` 判定）——不要在活构建里换链接，会直接打断对方（2026-11-08 两次实测事故）。
- 新建 worktree 后跑一次；`--dry-run` 先看、`--migrate` 把既有实体 target 并入共享桶、`--force` 替换指错地方的链接。
- **清理**：删 `<container>/target-shared` 下的内容；删 worktree 里的 `target` 只删掉软链，不省空间。
- **并发放开逃生阀**：同 repo 多棵 worktree 共用一个桶时，同时构建会互相等 cargo 的 target 锁；确需并行让该会话自带桶：`CARGO_TARGET_DIR=/tmp/wt-<name> …`（env 压过一切 config / 软链），用完自行清理。

发现新落点先查这三处再动手：`find <repo> -maxdepth 4 -name target`、该 crate 的 `.cargo/config.toml` 的 `[build] target-dir`、以及 `scripts/check-target-size.js` 的 `sharedTargetDirs` / `rootTargetDirs` 名单（改名单要同步注释）。
> 能力仓另有一条规则：**没有 `.cargo/config.toml` 的 crate 就写自己的 `<crate>/target`**（当前 8 个），所以「lib 只有两个桶」是错的——`ls -d <libRoot>/*/target` 核实再判断。

## 2. 前置检查（未过不得动手）

```bash
cd /home/binblink/project/tauriProject/WasmNest

# ① 有没有人在构建（IDE / rust-analyzer / tauri dev / 另一个会话的 cargo test 都算）
pgrep -af "cargo|rustc|rust-analyzer" | grep -v pgrep

# ② 四仓 target 现状
for r in wasmnest wasmnest-lib wasmnest-apps wasmnest-test; do
  find "$r" -maxdepth 4 -type d -name target \
    -not -path "*/node_modules/*" -not -path "*/.worktrees/*" \
    -exec du -sh {} \; 2>/dev/null
done
du -sh wasmnest/*/target wasmnest/*/src-tauri/target 2>/dev/null
df -h /home | tail -1
```

- **① 非空则停**：共享 target（尤其 `<appsRoot>/target/wasm-apps`）同一时刻只容许一个构建者。清它的 `incremental/` / 测试产物会打断在途构建（对方看到一次多余的整编或失败重跑，产物本身不损坏）。
- **② 先记基线**，清理后填 §5 的记录表；没有基线就无法证明回收量（见 §0 第 3 条）。
- 清理**不动工作树**：不需要 `git status` 干净，但涉及 legacy 目录时要确认不是别人正在读的落点（`legacyTargetLive` 机制，见 `check-target-size.js` 注释）。

## 3. 三级阶梯（按「零风险 → 需权衡」排序，可只做前一两级）

### 3.1 Tier 1 · 测试可执行产物（零风险，性价比最高）

只删 `debug/deps/` 里的**可执行测试产物**（每个 250–450 MiB，因为链入了整份宿主 SDK）。依赖 rlib / `.rmeta` / `.so` / `build/` / incremental 全部保留，只连同该二进制的 `.d` 一起删；下次跑该测试时 cargo 发现输出缺失自动重建（实测：删后 `cargo test --test <x> --no-run` 直接重编，秒级）。

```bash
cd /home/binblink/project/tauriProject/WasmNest
DIRS=(
  wasmnest/wasmnest-desktop/src-tauri/target/debug
  wasmnest/wasmnest-mobile/src-tauri/target/debug
  wasmnest-lib/target/host-kits/debug
  wasmnest-lib/target/server-libs/debug
  wasmnest-apps/target/wasm-apps/debug
  wasmnest-test/cross-end-tests/target/debug
  wasmnest-test/target/perf/debug
)
python3 - "${DIRS[@]}" <<'PY'
import glob, os, sys
total = cnt = 0
for d in sys.argv[1:]:
    freed = n = 0
    for f in glob.glob(os.path.join(d, 'deps', '*')):
        if os.path.basename(f).endswith(('.d', '.rlib', '.rmeta', '.so', '.a', '.wasm', '.json')):
            continue
        st = os.lstat(f)
        if not os.path.isfile(f) or not (st.st_mode & 0o111):
            continue
        if st.st_nlink > 1:  # 与 target/debug/<bin> 共 inode：删了不省空间，留着更安全
            continue
        freed += st.st_size; n += 1
        os.unlink(f)
        if os.path.exists(f + '.d'):
            os.unlink(f + '.d')
    print(f'{d}: 删除 {n} 个 = {freed / 2**30:.2f} GiB')
    total += freed; cnt += n
print(f'合计 {cnt} 个 / {total / 2**30:.2f} GiB')
PY
```

- 保留项：**与 `target/debug/<bin>` 共 inode 的主二进制**（`st_nlink > 1`，脚本直接跳过——删了不省空间还会逼你重建宿主）；`.rlib` / `.rmeta` / `.so` / `.wasm` / `build/` / `incremental/`。
- 代价：每个被删的测试目标在下次运行时重编（含链接，约几十秒/个）；产物会重新长回来，属于**周期性成本**，不是一次性节省。
- Windows：等价操作用 PowerShell 枚举 `debug\deps` 下 `.exe` 文件删除（`Get-ChildItem -File | Where-Object { $_.Name -notmatch '\.(d|rlib|rmeta|so|a|wasm|json)$' }`）。

### 3.2 Tier 2 · 包级 `cargo clean -p`（只删本包，依赖 rlib 全留）

语义：删「该 package 的全部产物」——lib rlib/so、bin、**全部 test target 的二进制**、该包的 `incremental/` 与本包 `build/` 脚本输出；**第三方依赖 rlib 一个不动**。这是「只清和源码改动相关」最贴切的官方通道（实测：scratch crate `cargo clean -p` 后 `regex`/`libc`/`aho_corasick` 的 rlib 全在）。

```bash
# 必须在该 crate 根（无根 workspace，包名见 §1 表）
cd wasmnest/wasmnest-desktop/src-tauri
cargo clean -p wasmnest-desktop-runtime -n     # 先预览（cargo 1.98 支持 -n/--dry-run）
cargo clean -p wasmnest-desktop-runtime        # 再执行

cd wasmnest/wasmnest-mobile/src-tauri
cargo clean -p wasmnest-mobile -n && cargo clean -p wasmnest-mobile
```

- 附带影响：**uplifted 的可执行也被删**（`target/debug/wasmnest-desktop` / `wasmnest-mobile` 不再存在）。E2E / `host:pack` / 手工起宿主前必须先 `cargo build`（依赖已热，约 1–2 分钟）。
- 只删特定 profile / 交叉目标：加 `--release` / `--profile <name>` / `--target <triple>` / `--doc`；**不要用 `--workspace`**（本仓无根 workspace，且会把共享落点一起带走）。
- 能力仓 / 跨端仓同样按 crate 执行（`cd <crate> && cargo clean -p <name>`），但它们各自有共享桶，注意 §2.①。

### 3.3 Tier 3 · `incremental/`（只影响编辑后的增量重编速度）

`incremental/` 是「源码改动 → 重编」的加速缓存，**不承载任何可执行产物**：删掉不丢 rlib、不丢 bin、不需要立刻重编；代价是下次编辑该 crate 时从零编一次（宿主编译约 30–60 s，不是整份依赖图）。

```bash
cd /home/binblink/project/tauriProject/WasmNest
find wasmnest/wasmnest-desktop/src-tauri/target wasmnest/wasmnest-mobile/src-tauri/target \
     wasmnest-lib/target wasmnest-apps/target wasmnest-test/cross-end-tests/target \
     wasmnest-test/target/perf \
     -maxdepth 3 -type d -name incremental -print -exec rm -rf {} + 2>/dev/null
```

> 深度说明：`target/debug/incremental` 是 2 层，`target/wasm-apps/debug/incremental` 是 3 层——`-maxdepth 3` 覆盖全部；**不要 `-maxdepth 2`**（会漏掉 apps 桶里最大的一份）。

## 4. 禁止项（命中即停，报给用户）

- **全量 `cargo clean`**（不带 `-p`）：唯一例外是重建环境 / 依赖图彻底错乱；会连带 `deps`（wasmtime / tauri / actix，数 GB）与 `build/`，而 sccache 若不在温热态就是 30–40 分钟级重编。
- **手删 `debug/deps/` 里的 `.rlib` / `.rmeta` / `.so` / `build/`**：这些是依赖产物，删它们与「只清源码改动相关」相反，且绕过了 cargo 的删除通道。
- **按 `.d` 手工算 diff 再删**：技术上能拼（每个 unit 的 `.d` 列了源文件），但 cargo 没有这条通道，fingerprint 与输出不一致只会换来重编，收益为 0、风险非 0。要「按改动清」就用 §3.2 的包级粒度。
- **删 `<appsRoot>/target/wasm-apps`、`wasmnest-mobile/target/wasm-apps` 的 `release/` 与 `wasm32-*/` 目录**（插件 wasm 产物 = host:pack / e2e 输入）、**删两端 `target/fixtures`**（e2e 夹具共享落点）。
- **在有构建进行时清共享 target**（§2.①）。
- 与自动脚本冲突：`prebuild` 的 15GB 阈值脚本会对**宿主** target 跑全量 `cargo clean`；手工清理不能替代它，也不要为绕开它去调阈值（改阈值前先读 `scripts/check-target-size.js` 头注释）。

## 5. 标准流程（照抄即可）

1. §2 前置检查（构建进程为空 + 记基线）。用了 §1.1 软链后，worktree 的 target 实为链接：`du` 不跟随（报 4K），真实占用量以 `<container>/target-shared` 为准。
2. 决定做到哪一级：**只要空间 → Tier 1 + Tier 3**（零风险；2026-11-04 实测这两级拿回 33.8 GiB / 85.5 GiB，剩余大头是三方依赖 rlib 与 `build/`，属刻意保留）；**宿主源码大改过或要做干净基线 → 再加 Tier 2**（记得 E2E 前重建 bin）。
3. 逐级执行（§3.1 → §3.3），每级后 `du -sb` 记录实际回收量。
4. 完成验证（§6）。
5. 按模板记录：

```md
| 时间 | 落点 | 前 | 后 | 回收 | 做的 Tier | 未做/理由 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-04 09:20 | 四仓全部 target | 85.5 GiB | 36 GiB | 49.5 GiB | 1+2+3 | 未动 deps/build/fixtures/wasm 产物 |
```

## 6. 完成验证（清理后必跑，贴结果）

```bash
# ① 两端宿主健康：预期只有本包重编（deps 不重编）；出现整份依赖图重编 ⇒ 说明误动了 deps/build
cd wasmnest/wasmnest-desktop/src-tauri && time cargo check --lib
cd ../../wasmnest-mobile/src-tauri && time cargo check --lib

# ② 关键产物存在性（本次清理不应触碰）
cd /home/binblink/project/tauriProject/WasmNest
ls -la wasmnest/wasmnest-desktop/target/fixtures wasmnest/wasmnest-mobile/target/fixtures >/dev/null && echo fixtures-ok
ls ../wasmnest-apps/target/wasm-apps/wasm32-*/release/*.wasm | wc -l   # 数量随应用清单变化，当前 10（wasip3 插件 6）

# ③ 回收量对账
du -sh <各落点>; df -h /home | tail -1
```

判据：`cargo check --lib` 桌面 ≈ 30 s / 移动 ≈ 50 s（2026-11-04 实测，deps 完整时）；明显更长说明清到了依赖层。

## 7. 事后影响与交接（写进交付说明）

- 宿主 bin 被 Tier 2 删过 ⇒ **E2E / `host:pack` / 手工启动前先构建**。
- 测试二进制按需重建，且会重新长回来（单个数百 MiB）；`cargo test` 跑过的目标越多，target 长回越快——这是正常的，不是泄漏。
- sccache 状态会变化：若本次清理前缓存已空，下一次**依赖**真有升级时是全量重编（与清理无关，别误判）。
- 并发会话：如清理期间发现别的会话在同一共享 target 上构建，交付说明里点名，让对方重跑一次。

## 8. 实测基线（2026-11-04，cargo 1.98.1，本机 16 核 / 13 GiB）

清理前构成（用于判断「值不值得清」）：

| 落点 | 总量 | deps | incremental | build |
| --- | --- | --- | --- | --- |
| 桌面宿主 target | 32 GB | 21.6 | 8.0 | 1.3 |
| 移动宿主 target | 14 GB | 7.4 | 5.1 | 1.1 |
| `lib/target/host-kits` | 19 GB | — | 8.9 | 1.6 |
| `lib/target/server-libs` | 7.5 GB | — | 2.0 | 1.3 |
| `apps/target/wasm-apps` | 6.6 GB | debug 5.7 / release 0.75 | 1.4 | 1.1 |
| `cross-end-tests/target` | 6.9 GB | — | 1.8 | 1.9 |

三级实际回收：Tier 1 = 78 个可执行 / **13.4 GiB**；Tier 2 = 桌面 11 GiB + 移动 4 GiB；Tier 3 = 20.4 GiB。总计 **85.5 GiB → 36 GiB，`/` 99% → 80%（剩 4.8 G → 53 G）**。
保留未动：三方依赖 rlib（桌面 `deps` 仍 5.7 GiB）、`build/`（1.2 GiB）、插件 wasm 产物、两端 `target/fixtures`。
