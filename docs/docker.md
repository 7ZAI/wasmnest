# 本机 Docker 部署事实

> 本机 Docker 环境的版本 / 配置 / 排障事实（2026-10-25 自原 `docs/layerfs.md` 抽出留存；LayerFS 已从开发流程退役，Docker 本身保留）。

## 1. 部署事实

| 项 | 位置/值 |
| --- | --- |
| Docker | docker-ce 29.x，**API 1.56**（系统原 26.1.5 的 API 1.45 太旧——按新版 API 写的客户端工具不兼容：binding 硬编码 `/v1.54` 且 streaming archive 有 broken pipe，已实测） |
| data-root | `~/.docker-data`（daemon.json 配置；卷 / 镜像 / 容器数据全在用户目录，host 无需 root 读卷） |

## 2. 排障（本机实测过）

| 现象 | 原因 / 处理 |
| --- | --- |
| `client version 1.54 is too new. Maximum supported API version is 1.45` | docker 太旧：需 docker-ce ≥ 27（本机 29.x / API 1.56）；26.1.5 另有 streaming archive broken pipe，仅升级解决 |
| docker 命令 permission denied | 当前会话用户未在 docker 组（或组集合未刷新）：用 `sg docker -c '…'` 包装（已在组则免密） |
| Docker Hub 拉镜像超时 | 直连被墙：`docker pull docker.m.daocloud.io/library/<img>:<tag>` 再 `docker tag` 成本地名；npm/pnpm 代理 env `npm_config_proxy` / `npm_config_https_proxy=http://127.0.0.1:10811` |

## 3. 清理

- `docker image prune` 清旧镜像。
- **LayerFS 遗留（已退役，2026-10-25）**：store 卷 `pi-wasmnest-store`（全部历史分支都在其中，卷内路径 `global/store.sqlite`）、sandbox 容器 `layerfs-wasmnest-*`、镜像 `layerfs-352-runtime:node24` 与缓存卷 `layerfs-cargo` / `layerfs-target` 仍在机上；确认不再需要后可 `docker volume rm` / `docker rm -f` / `docker rmi` 回收磁盘。
