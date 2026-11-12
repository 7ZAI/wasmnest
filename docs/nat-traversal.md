# 内网穿透（NAT Traversal）——实现原理、部署与配置

> **读者**：要部署中继节点的运维，要配置/排查穿透链路的开发与集成测试。
> **真源优先级**：能力仓实现（`wasmnest-relay` / `wasmnest-p2p-engine` / `wasmnest-server-peer-net`）> 本文件 > 设计稿。
> 选型论证、票面与评审记录在应用仓 `../wasmnest-apps/docs/design/nat-traversal.md`，本文不重复论证，只讲「怎么实现的 / 怎么配 / 怎么用 / 怎么查」。

---

## 0. 一页速览

**一句话**：两端都在 NAT 后面、拨不到对方时，各自主动连一台**公网中继**并让它转发 Noise 密文；中继只是转发器，不持有任何明文，也不决定谁能访问谁。

| 铁律 | 含义 | 违反后果 |
| --- | --- | --- |
| **中继不是授权点** | reservation / 中继白名单只表示「可以经我转发」，访问权始终由**目标宿主**的 peer 信任列表裁决 | 把 relay allowlist 当成权限控制 = 任意设备可访问目标业务面 |
| **只转发密文** | libp2p Noise 在两端完成，中继看不到 payload / 文件名 / 路径；但能看到元数据（哪个 PeerId 连哪个、时长、字节数） | 把敏感信息放进 multiaddr / 文件名 / 日志 |
| **身份即地址** | 客户端拨号串里钉住 relay 的 PeerId；同 IP 换 PeerId 一律拒绝 | 中继被顶替后 Noise 只保护到假中继，「端到端」名不副实 |

| 项 | 值 |
| --- | --- |
| 传输 | TCP only（v1 不启 UDP/QUIC） |
| 端口 | 中继监听 `4001/tcp`；指标 `127.0.0.1:9090`（默认不对公网） |
| TLS 证书 | 不需要（Noise 已在 libp2p 层完成加密与身份校验） |
| 中继版本轴 | 独立于 `lib-vX.Y.Z` / `apps-vX.Y.Z`；当前只由 `wasmnest-relay/Cargo.toml` 的 crate 版本与镜像 tag 表达，**尚未进 `release-manifest.json`**（见 §8） |
| 客户端开关 | 宿主能力 crate `wasmnest-server-peer-net` 的 `relay` feature（双端宿主均显式开启） |
| 配置真源 | 应用仓 `net-config` 插件的私有 KV：`network.relay`（地址）+ `network.wanPolicy`（逐业务放行） |

---

## 1. 为什么需要中继

两台设备各自在 NAT 后面时，「A 拨 B」在物理上不可能：NAT 没有为 B 建映射，B 的私网地址在公网不可路由。穿透的工程解法只有两条：

| 路径 | 触发条件 | 数据路径 | 依赖 |
| --- | --- | --- | --- |
| `lan-direct` | 双方在同一可达网段（mDNS 发现 / 已知 LAN 地址） | A ⇄ B 直连 | 无 |
| `wan-relay` | 无 LAN 可达性 | A ⇄ relay ⇄ B，两段独立 Noise 会话，中继做 circuit 转发 | 一台公网中继 |

v1 **不做** QUIC / DCUtR 打洞升级：它们能省中继带宽，但引入 UDP 穿透、打洞成功率与移动端 feature 面问题，与「先让跨网可用且可运维」的验收口径冲突。中继在 v1 就是唯一 WAN 路径，这也是配额（尤其单 circuit 1 GiB）必须调准的原因。

---

## 2. 实现原理

### 2.1 Circuit Relay v2 的三段动作

libp2p 的 Circuit Relay v2 是**中继服务端 + 客户端行为**的成对协议，中继侧只做 HOP（转发），不做发现、不做授权。

```text
① 预留（reservation）——两端各自主动连中继，请求「请替我保留一个可被拨的入口」
   客户端监听：/ip4/<relay-ip>/tcp/4001/p2p/<relayPeerId>/p2p-circuit
   中继动作  ：记下该 PeerId + 有效期（默认 3600s），到期需续期

② 中继拨号（relayed dial）——A 要连 B 时，拨「中继地址 + 目标 PeerId」
   拨号地址  ：/ip4/<relay-ip>/tcp/4001/p2p/<relayPeerId>/p2p-circuit/p2p/<targetPeerId>
   中继动作  ：查目标是否有有效 reservation → 有则把两段流接起来（一条 circuit）

③ circuit 判据——中继只搬字节：
   每端与中继之间各是独立 Noise + Yamux 会话；中继看到的是密文帧，
   不知道应用层是 HTTP、WS 还是文件分片。
```

两条约束来自实现（`wasmnest-p2p-engine/src/relay.rs`）：

- **relay 端点必须钉住 PeerId**：`.../tcp/<port>/p2p/<relay-id>` 形状，且不得含 `/p2p-circuit`（那是预留/拨号地址，不是端点地址）。调用方若传入期望 PeerId，必须与地址里的逐字一致。
- **引擎不启用 `dns` feature**（Android feature 面纪律）：`/dns4|dns6|dns` 地址由**宿主层**用 `tokio::net::lookup_host` 解析成 IP 后再进引擎；引擎见到 DNS 组件显性拒绝，不静默失败。

### 2.2 中继到底看得到什么

| 中继可见 | 中继不可见 |
| --- | --- |
| 双方 PeerId（公钥摘要）、连接 IP、circuit 建立/关闭时间、流量规模与时长（可在传输层观测；当前未以指标导出，见 §2.6）、预留与拒绝计数 | payload、HTTP 路径、WS 消息、文件名、分享目录、token 明文、JWT |

因此纪律是：**不要把秘密放进 multiaddr、文件名或日志字段**；中继侧指标只做聚合计数（见 §2.6）。

### 2.3 客户端状态机与传输形态

引擎把「预留」建模成四态，供宿主状态栏与 `status` 取数（`RelayState`）：

| 状态 | 事件字面 | 含义 |
| --- | --- | --- |
| `Idle` | `relay-idle` | 未配置中继，或已显式释放 |
| `Connecting` | `relay-connecting` | 预留请求在飞（含指数退避重试等待） |
| `Reserved` | `relay-reserved` | 预留已建立（**只代表控制面可用**，不代表有数据流量） |
| `Lost` | `relay-lost` | 中继不可达 / 预留丢失，按退避重试 |

连接级传输形态只有两种（`Transport`）：`lan-direct`（地址不含 `/p2p-circuit`）与 `wan-relay`（含）。两者可以并存——LAN 可达时优先直连，中继预留保留作为兜底入口。

### 2.4 宿主侧：预留是引用计数，不是开关

宿主 `host-tunnel` 不按「应用配了地址」就建预留，而是按**实际需求**统一记账（`wasmnest-server-peer-net/src/tunnel/manager.rs::recount`）：

```text
某插件满足以下全部条件才算「需要 WAN 入口」：
  allowWan = true
  且 relayAddrs 非空
  且 该插件有活的 expose 规则（服务端）或入站 WAN 会话（客户端）

需要 → 全局唯一一条 reservation；不需要 → 释放
地址变化 → 以新地址重建（引擎的 reserve 是幂等替换：先释放旧预留再试新端点）
重建失败 → 标记 Lost + 告警，保留旧状态可见，下一次 recount 重试；LAN 入口不受影响
需要但没有地址 → 告警 + status 里 reservation=false（不回滚已生效的 LAN 入口）
```

`configure` / `expose` 侧还有一层前置校验（错误在写入时就点名，不拖到 reserve）：

```text
allowWan = true 但地址为空 → 直接报 wan-disabled（不静默降级成 LAN only）
域名地址在 configure 时由宿主解析（引擎不开 dns feature）
端点形状（缺 /p2p/<relay> / 带 /p2p-circuit / 残留域名）当场点名拒绝
```

这条设计决定了三个常见误判：

- **配置了中继地址 ≠ 一定会建预留**：`allowWan` 关着、或没有 expose 规则时，`relayIdle` 是正常状态，不是故障。
- **`Reserved` ≠ 数据在走中继**：LAN 可达时数据仍走 `lan-direct`，预留只是入口。
- **关闭 `allowWan` 的生效时点取决于引用计数**：单业务关闭只减计数，只有「没有任何业务还需要」时才真正释放预留。

### 2.5 两层信任（不要混为一谈）

| 层 | 凭据 | 存储 | 决定什么 |
| --- | --- | --- | --- |
| 传输层 | 宿主 peer 身份（Ed25519 / node_id）+ 信任列表 + 一次性配对票据 | 宿主 `trusted_nodes.json` | 这个节点能不能开隧道 / 开流 |
| 应用层 | 认证中心 JWT / 配对码 / QR token | 应用自己的认证库 | 这个设备能不能调这个 API |

中继的 `access.mode`（open / allowlist）只用于**防滥用**（别让人白蹭带宽），属于第三层且**不能替代**上面两层。首次配对走「短命、单用途」窗口：`issue-pairing-ticket` 签发票据（绑定目标端口、TTL ≤ 120s），窗口内只放行配对端点，成功后写入信任；票据明文不得落日志。

### 2.6 中继服务端：准入、配额、指标

| 能力 | 口径 |
| --- | --- |
| 准入 `open` | 任何人可预留，靠配额防滥用（自建默认） |
| 准入 `allowlist` | 只有白名单 PeerId 或**已兑换 enrollment token** 的 PeerId 可预留；白名单外的设备仍能连上来（否则无法自助开通），但请求被拒并计数 |
| enrollment token | `token create` 生成，明文**只显示一次**，落盘只有 `sha256` 摘要；默认一次兑换失效（`--max-uses N` 放宽）；兑换结果写 `enrolled-peers.json`（重启仍有效） |
| 控制协议 | `/wasmnest/relay-control/1`：版本/模式查询 + token 兑换 |
| 指标 | `GET /healthz`（PeerId / 指纹 / 准入 / 通告地址）与 `GET /metrics`（Prometheus 文本，只含计数） |

配额默认值（`src/quota.rs`，口径 = 「跨 NAT 传 1 GB 文件」）：

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `max_reservations` / `max_reservations_per_peer` | 1024 / 4 | 预留总量 / 单 peer |
| `reservation_ttl_secs` | 3600 | 预留有效期 |
| `max_circuits` / `max_circuits_per_peer` | 512 / 64 | 并发 circuit 总量 / 单 peer |
| `max_circuit_duration_secs` | 3600 | 单 circuit 最长存活 |
| `max_circuit_bytes` | 1 GiB | **单条** circuit 字节上限（0 = 不限） |
| `max_connections_per_ip` | 32 | 单 IP 入站连接上限（一个 NAT 后多台设备） |

- `max_circuit_bytes` 必须留在 GiB 量级：libp2p 上游默认只有 128 KiB，照抄会让大文件传输**中途随机失败**（现象是「传到一半断了」，极难定位）。断线重连会新建 circuit，每条按自己的配额重新计，不需要调到 10 GB。
- 指标不含字节数：上游 `CircuitClosed` 事件不带字节数，宁缺不造假；补齐属非破坏性扩展。

---

## 3. 组件落点

| 组件 | 仓库 / 路径 | 职责 |
| --- | --- | --- |
| `wasmnest-relay` | 能力仓 `wasmnest-relay/` | 独立 Linux 守护进程：Relay v2 HOP 服务端 + 准入 + 配额 + 指标 + CLI。零内部 crate 依赖（`src/boundary_lock.rs` 锁死），可脱离能力仓单独构建 |
| 部署资产 | 能力仓 `deploy/relay/`（`Dockerfile` / `docker-compose.yml` / `install.sh` / `wasmnest-relay.service` / `config.example.toml` / `README.md`） | 服务端交付物 |
| `wasmnest-p2p-engine` | 能力仓 `wasmnest-p2p-engine/src/relay.rs`（地址面）+ `engine.rs`（运行时，`relay` feature） | 客户端：地址校验、预留/释放、退避重试、状态快照 |
| `wasmnest-server-peer-net` | 能力仓 `wasmnest-server-peer-net/src/tunnel/` | `host-tunnel` WIT 实现：引用计数、`/wasmnest/tunnel/1` 流、端口 ACL、对等 HTTP/WS 面 |
| `wasmnest:tunnel@0.0.1` | 能力仓 `wasmnest-server-peer-net/wit/tunnel.wit` | 对插件暴露的契约（`configure` / `expose` / `connect` / `status`…） |
| `net-config` 插件 | 应用仓 `servers/net-config/desktop/` | 配置中心：`network.relay` 地址真源 + `network.wanPolicy` 逐业务放行 + 部署文本/导入校验 |
| 宿主装配 | 平台仓 `wasmnest-desktop` / `wasmnest-mobile` 的 `src-tauri/Cargo.toml` | 开 `wasmnest-server-peer-net` 的 `common-host` + `relay` 两个 feature |
| 中继 ↔ 客户端实测 | 测试容器仓 `cross-end-tests/relay-transport/`（2026-11-10 新增） | 真实 `wasmnest-relay` 服务端 + 真实引擎客户端：预留 → 中继侧指标 → `/p2p-circuit` 拨号 → 具名流 64 KiB 往返 |
| 引擎自持用例 | 能力仓 `wasmnest-p2p-engine/src/engine.rs`（`relay` feature 的 `relay_flow`） | 裸 libp2p relay behaviour 当服务端；覆盖预留 / 释放 / 退避 / 1 MiB 与 100 MiB 吞吐 |
| 隧道管理器用例 | 能力仓 `wasmnest-server-peer-net/src/tunnel/manager/tests.rs` | `TunnelEngine` 端口替身（`reserve_relay` 打桩），只验引用计数与状态机，**不建真实 circuit** |

---

## 4. 部署中继（服务端）

前置：Linux（amd64 / arm64）+ Docker；一个公网可达地址（域名或 IP）；只需放行 **TCP 4001**。

### 4.1 最短路径（Docker Compose）

```bash
cd deploy/relay
# 1) 首次生成身份与配置（advertise = 客户端可拨的公网域名或 IP 字面量）
docker compose run --rm relay init --dir /data --advertise relay.example.com
# 2) 起服务
docker compose up -d
# 3) 取客户端导入串
docker compose exec relay wasmnest-relay print-addrs --config /data/config.toml
```

生产建议把 `image:` 换成 digest 钉住形态（`...@sha256:<digest>`），避免上游 tag 漂移。

### 4.2 单命令

```bash
docker run -d --name wasmnest-relay --restart unless-stopped \
  -p 4001:4001 -v wasmnest-relay-data:/data \
  ghcr.io/7zai/wasmnest-relay:<version>
```

### 4.3 systemd（不用 Docker）

```bash
./install.sh --advertise relay.example.com --binary ./wasmnest-relay
```

脚本四件事：装二进制到 `/usr/local/bin`、建系统用户 `wasmnest-relay`、在 `/etc/wasmnest-relay` 生成身份与配置（已有则保留）、装 unit 并启动。卸载 `./install.sh --uninstall`（**不删**配置目录，里面有 PeerId）。

### 4.4 网络与防火墙

| 项 | 值 |
| --- | --- |
| 入方向 | `TCP 4001`（云安全组 + 宿主防火墙两层都要放行） |
| 出方向 | 默认放通即可，中继不主动外连 |
| `9090` | **不要开公网**：默认只绑 `127.0.0.1`，里面是 PeerId 与用量 |

判据（三层由外到内，逐层排除）：

```bash
# 从外部机器
nc -vz <public-ip> 4001            # 通 → 安全组 OK
# 在服务器宿主
ss -lnt | grep 4001                # 有 docker-proxy/relay 监听
curl -s http://127.0.0.1:9090/healthz   # relay 进程活着
```

### 4.5 两个容器专属坑

**① 数据卷名必须钉死。** Docker Compose 默认给卷加项目前缀（`wasmnest-relay_relay-data`），若先用 `docker run -v wasmnest-relay-data:/data ... init` 生成身份、再 `docker compose up`，容器挂的是另一个空卷 → `config.toml` 不存在 → 容器反复重启（`Restarting`），且**身份实际存在但没被用上**。修法：compose 里显式声明

```yaml
volumes:
  relay-data:
    name: wasmnest-relay-data   # 身份/配置/白名单都在这，改名 = PeerId 变 = 所有客户端重导
```

**② 容器里的指标端点语义。** `metrics.listen = "127.0.0.1:9090"` 时，Docker 端口映射（含 `127.0.0.1:9090:9090`）**打不通**——DNAT 指向容器 eth0，不是容器回环。两种取数方式：

```bash
# A. 容器内取（默认配置即可）
docker compose exec relay wget -qO- http://127.0.0.1:9090/metrics

# B. 宿主/监控抓取：把 config 改成下面两行，compose 里发布到宿主回环
#    [metrics] listen = "0.0.0.0:9090" + expose_public = true（= 容器内所有网卡，不是公网）
#    ports:   - "127.0.0.1:9090:9090/tcp"
```

要公网抓取指标，则**必须**另加反代 TLS 或额外 token，否则等于公开 PeerId 与用量。

### 4.6 收紧准入（可选）

```bash
# 生成 enrollment token（明文只显示一次，带外交付给设备方）
docker compose exec relay wasmnest-relay token create --config /data/config.toml --label phone
# 改准入模式（改完重启容器即生效；restart: unless-stopped 下用 docker compose restart relay）
#   [access] mode = "allowlist"   # 允许：静态 PeerId 白名单 + 已兑换 token 的 PeerId
```

`init` 阶段也能直接定模式：`--mode open|allowlist --allowlist <PeerId>[,<PeerId>]`。

### 4.7 自检 `doctor`

```bash
docker compose exec relay wasmnest-relay doctor --config /data/config.toml
```

口径是**本机能查的实检，本机不能自证的如实标 `unknown`**：`identity`（密钥可解析 / ed25519 / 权限 600）、`config`（版本 / 地址形状 / 配额组合）、`listen`（真实 bind 一次，占用即提示「relay 正在运行？」）、`clock`（早于 2025-01-01 视为严重错误）、`data_dir`（真实写探针，只读卷在此现形）、`tokens`、`metrics`（非回环必须显式 `expose_public`）、`reachability`（私网/回环通告 → 警告，否则 `unknown`）、`version`（单 circuit < 1 GiB 时警告）。退出码：有 `Fail` 即 1。

### 4.8 升级与身份纪律

```bash
docker compose pull && docker compose up -d          # Docker
./install.sh --advertise <host> --binary ./wasmnest-relay   # systemd（保留现有身份）
```

- 升级**不换** PeerId：只要 `identity.key` 不动。
- `init --force` 才会覆盖身份；覆盖后**所有客户端必须重新导入**中继地址。
- 备份只需 `identity.key`（配置可重建、token 可重发、enrollment 可重做）。

---

## 5. 客户端配置

### 5.1 配置真源：`network.relay`

中继地址不在各应用私有配置里，而是集中在应用仓 `net-config` 插件的私有 KV（键 `network.relay`，schema `version = 1`）。读取方经只读互调 api `relay-config` 取用；写入只走该插件的命令面与设置页（不让任意插件改全局地址）。

| 字段 | 约束 |
| --- | --- |
| `relayAddrs` | 1–16 条（`MAX_RELAY_ADDRS = 16`），每条是 `主机 + TCP + /p2p/<relayPeerId>` 的**端点**地址 |
| `peerId` / `peerIdSha256` | base58 PeerId 与指纹；导入时**本地复算** sha256，不信任载荷自报值 |
| `accessMode` / `relayVersion` / `quota` | 展示用（来自 `print-addrs --json`），缺失不阻断 |
| `importedAt` / `source` | 导入时间与来源（`json` / `text`） |

校验口径（导入即拒，不静默清洗）：载荷版本只认 `v = 1`；`relayAddrs` 必须 1–16 条且每条是 relay **端点**（带 `/p2p-circuit` 的是拨号目标，直接拒绝）；每条地址尾部的 `/p2p/<id>` 必须与声明的 `peerId` 逐字一致（否则客户端会拨到「证书对不上」的节点）；`peerId` 必须能解出 ed25519 公钥（base58 + identity multihash + protobuf key）；`peerIdSha256` 必须 64 位小写十六进制且与**本地复算**值一致；`accessMode` 只认 `open` / `allowlist`。

### 5.2 导入载荷：两种形态

```bash
# JSON 契约（设置页粘贴/扫码内容就是它）
wasmnest-relay print-addrs --config /data/config.toml --json
# {"v":1,"kind":"wasmnest-relay","relay_version":"0.0.1","peer_id":"12D3KooW…",
#  "peer_id_sha256":"…","control_protocol":"/wasmnest/relay-control/1",
#  "addrs":["/ip4/203.0.113.10/tcp/4001/p2p/12D3KooW…"],
#  "access":{"mode":"open"},"quota":{"max_circuit_bytes":1073741824,
#  "max_circuit_duration_secs":3600}}

# 文本形态（每行一个地址 + 四行元数据：peerId / peerIdSha256 / access / controlProtocol）
wasmnest-relay print-addrs --config /data/config.toml
```

桌面端路径：应用「网络配置」（`com.wasmnest.net-config`，内部名 `net-config`，装配层 L2）——四张卡片：**当前中转配置**（地址 / PeerId / 本地复算指纹 / 准入模式 / 配额 / 版本 / 导入时间）、**导入 relay 地址**、**生成部署命令**（只产文本，不执行远端命令、不碰凭据、不带 token）、**检测连通性**（目前按钮**禁用**：宿主尚未提供 relay 拨号探测能力，卡片如实给出服务器侧 `doctor` 命令作为替代路径）；下方是**业务外网注册表**（`allowWan` 开关）。

### 5.3 WAN 策略：`network.wanPolicy`

逐业务放行表（键 `network.wanPolicy`，schema `version = 1`），只有两个语义：

| 字段 | 含义 |
| --- | --- |
| `apps.<plugin-id>.allowWan` | 该业务是否允许经 WAN（中继）暴露；关闭时即使有 expose 规则也不建立/保留预留 |
| `note` / `updatedAt` | 运维备注与时间 |

**这张表统一的是「配置与策略来源」，不是「穿透执行」**：业务仍按自己的 `tunnel:serve` / `tunnel:connect` 权限与时机调宿主 `host-tunnel`；配置中心不代任何业务 `expose` / `connect` / 签发票据。**未登记的业务按允许处理**（前端唯一取数口径 `effectiveAllowWan(entry) = entry?.allowWan ?? true`，界面徽标与会话计数都走它，不要直接读 `entry?.allowWan`），只有显式关闭才拦截。

### 5.4 插件侧接线（WIT `wasmnest:tunnel@0.0.1`）

```wit
record tunnel-config {
    allow-wan: bool,
    relay-addrs-json: string,   // multiaddr 字符串数组，空 = 未配置中继
}
configure: func(config: tunnel-config) -> result<bool, string>;   // 幂等全量替换
status:    func() -> result<string, string>;                      // JSON，只读
```

- `configure` 只改隧道管理器的配置与引用计数，**不直接**建立/释放 reservation（那是宿主按 §2.4 统一记账）。
- `status` 里的关键字段：`allowWan` / `relayAddrsConfigured` / `reservation` / `relay{state,relayAddr,detail}` / `exposeRules` / `connects` / `modes[]`。排障先看 `relay.state` 与 `relay.detail`，再看 `modes` 定位是 LAN 探测失败还是 WAN 未配置。
- 应用命令面（如 BedCode 的 `session.tunnel.prepare`）里 `relayAddrs: []` 表示「用户主动清空配置」，不是「沿用旧值」；地址来源是配置中心的 `relayAddrs`（版本非 1 视作未知 → 显性报错）。

### 5.5 双端宿主开关

```toml
# wasmnest-desktop/src-tauri/Cargo.toml（钉 tag）/ wasmnest-mobile/src-tauri/Cargo.toml（path）
wasmnest-server-peer-net = { …, features = ["common-host", "relay"] }
```

`relay` feature 关闭时引擎显性返回 `RelayDisabled`（不静默降级成「LAN only」），无头测试宿主保持默认关闭形态。

---

## 6. 端到端使用流程

1. **部署中继**（§4）：`init` → `up -d` → `print-addrs --json`；云安全组放行 TCP 4001。
2. **导入地址**：桌面端「网络配置」应用 →「导入 relay 地址」卡片，粘贴 `print-addrs` 的 JSON 或文本形地址；卡片顶部的「当前中转配置」会显示本地复算的指纹，与服务器 `healthz` 的 `peer_id_sha256` 一致才算导入成功。
3. **放行业务**：在同一页的 WAN 策略里为需要的应用打开 `allowWan`（服务端要暴露的一方必须开）。
4. **业务侧建立入口**：应用调 `tunnel.configure`（`allowWan = true` + 地址）与 `tunnel.expose`（`kind = "http"` 或 `"tcp"`）。
5. **对端接入**：对端拿到含 `peer.addrs`（LAN + relay 两种地址）的 QR / 连接串，`tunnel.connect` 多地址拨号；LAN 可达走 `lan-direct`，否则走 `wan-relay`。
6. **核对状态**：两端 `tunnel.status` 看 `relay.state = relay-reserved`、`modes` 与 `relayAddrsConfigured`；服务端 `/metrics` 看 `reservations_active` / `circuits_active` 是否随流量变化。

---

## 7. 排障

| 症状 | 排查顺序 |
| --- | --- |
| 客户端报「中继不可达」 | 云安全组 / 宿主防火墙是否放行 TCP 4001 → `doctor` 的 `listen` 项 → 域名是否解析到本机 → multiaddr 是否含 `/p2p/<relayPeerId>` |
| 导入卡片报「指纹不一致 / 地址非法」 | 地址是否带了 `/p2p-circuit`（那是拨号目标，不是端点）；PeerId 是否被改写；载荷版本是否 `v = 1` |
| 预留被拒（`rejected{reason="reservation-denied"}`） | `access.mode` 是否 `allowlist`；白名单 / token 是否已兑换（`/data/enrolled-peers.json`）；单 peer 是否超 `max_reservations_per_peer` |
| `relay.state = relay-idle` 但地址已配置 | `allowWan` 是否关闭；是否有活的 expose 规则或入站 WAN 会话（§2.4 的引用计数条件） |
| `relay.state = relay-lost` 反复重试 | 中继是否重启且身份变了（`print-addrs` 对比 `peerIdSha256`）；数据卷是否挂错（§4.5 ①） |
| 预留成功但对端连不上 | 对端是否也在线并已预留；两端导入的是**同一份**地址（含同一 relay PeerId）；目标侧 `modes` 里是否 `lan-unreachable` 而未切 WAN |
| 大文件传到一半失败 | `max_circuit_bytes` / `max_circuit_duration_secs` 是否被调小；`doctor` 的 `version` 项会提示 < 1 GiB |
| 容器起来就退出 | 首次运行前没 `init`（`run` 找不到 `identity.key` 会显性失败并提示）；`docker compose logs relay` |
| 重启后 PeerId 变了 | `/data` 卷没挂上或换了卷；`print-addrs` 对比指纹 |

日志：`WASMNEST_RELAY_LOG=debug`（容器 `-e WASMNEST_RELAY_LOG=debug`）；只打 PeerId 短指纹与事件，不打载荷、文件名、路径、token。

---

## 8. 已知缺口（2026-11-10 核实）

| 缺口 | 现状 | 影响 |
| --- | --- | --- |
| GHCR 镜像未发布 | `ghcr.io/7zai/wasmnest-relay` 的 `0.0.1` / `0.1.0` / `latest` 均 403 | 不能 `pull`，需本地构建（附录 B）或 `docker compose build`（构建机会编 Rust） |
| arm64 镜像未验证 | 上游 Dockerfile 支持 buildx 多架构，但未实跑 | arm64 VPS 需自行 buildx |
| 隧道层无真实中继用例 | `tunnel/manager/tests.rs` 的 `TunnelEngine` 是端口替身（`reserve_relay` 打桩）；真实 circuit 只在引擎层 `relay_flow`（裸 libp2p relay）与 `relay-transport`（真实 `wasmnest-relay`）覆盖 | `expose → reservation → 对端 connect` 的宿主装配链没有端到端自动化，回归靠单测 + 手工目验 |
| relay 版本轴未进清单 | `release-manifest.json` 只登记 `wasmnest:tunnel` WIT 包版本；`wasmnest-relay` 版本仅在本 crate `Cargo.toml` 与镜像 tag | 发布时无法从清单追溯线上中继是哪个版本 |
| 指标无字节数 | 上游事件不带字节数 | 只能按 circuit 时长/数量估算带宽占用 |
| QUIC / DCUtR 打洞 | v1 不启用 | 全部 WAN 流量经中继，带宽成本在中继侧 |

---

## 附录 A：本仓实测实例（2026-11-10，内部测试用，不对外）

| 项 | 值 |
| --- | --- |
| 机器 | 华为云 ECS，Ubuntu 24.04 / x86_64 / 2 核 1.7 GiB，内网 `172.31.4.52` |
| 部署形态 | Docker Compose，落点 `~/wasmnest-relay/`，卷 `wasmnest-relay-data`（`name:` 钉死） |
| 端口 | `4001/tcp`（安全组已放行）+ `127.0.0.1:9090`（指标） |
| 准入 | `open`（配额默认值，未改） |
| 验证 | 外部机器真实 libp2p 拨号握手成功（`DIAL_OK`，PeerId 与服务器 `peer_id_sha256` 一致）；服务端 `connections_total` 随之 +1 |
| 网关验证（2026-11-10） | `wasmnest-test/cross-end-tests/relay-transport` 用本服务器跑通：客户端预留被接受（`relay-reserved`）→ 经 `/p2p-circuit` 拨号判为 `wan-relay` → SESSION 流 64 KiB 往返逐字一致；服务端 `reservations_total` / `circuits_total` 各 +1（active 随用例关停归零） |
| 坑 | 首次部署踩到 §4.5 ①（卷名前缀）导致容器反复重启，`name:` 钉死后恢复，身份未丢 |

## 附录 B：GHCR 没有镜像时的替代构建

目标机内存小（如 1.7 GiB 无 swap）时，**不要在容器里编 Rust**（libp2p + ring 的 release 构建会 OOM）。改为「构建机编二进制 + 目标机只做运行层」：

```bash
# 1) 构建机（glibc 版本必须 ≤ 目标机）：先确认符号需求再决定能否直接跑
cd wasmnest-relay
cargo build --release --locked --offline
# 本 crate 的 .cargo/config.toml 把 target-dir 指向共享桶，产物不在 crate/target/ 下：
BIN=../target/server-libs/release/wasmnest-relay
objdump -T "$BIN" | grep -oP 'GLIBC_[0-9.]+' | sort -Vu | tail -1   # 需 ≤ 目标机 glibc
strip --strip-all "$BIN"

# 2) 运行层（目标机）：只需 ubuntu:24.04 基础镜像 + COPY 二进制
#    FROM ubuntu:24.04
#    RUN mkdir -p /data && chown 10001:10001 /data
#    COPY wasmnest-relay /usr/local/bin/wasmnest-relay
#    USER 10001:10001
#    ENTRYPOINT ["/usr/local/bin/wasmnest-relay"]
#    CMD ["run","--config","/data/config.toml"]
docker build -t wasmnest-relay:0.0.1 .

# 3) 之后流程与 §4.1 完全一致（init → up -d → print-addrs），但 compose 的 image: 要指向本地 tag
```

镜像体积约 135 MB（ubuntu 基础层 75 MB + 二进制 6 MB）。若要最小化，用上游 `deploy/relay/Dockerfile` 的 alpine + musl 路线（需 `x86_64-unknown-linux-musl` 目标与 musl 工具链，ring 的 C 部分需 `musl-gcc`）。
