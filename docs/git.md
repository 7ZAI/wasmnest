# 提交、回滚与 Git 规则（平台仓特有 + 共享规范指针）

> **本文件是 `AGENTS.md` 的拆分文档（Git）**。
> **通用 git 提交规范（commit 格式 / 禁止 AI 标记 / --force 禁令 / 开工自检 / 只提交源码 / 文件回滚 / 四仓 tag 规则 / 跨仓提交顺序）真源 = [`docs/public/git.md`](public/git.md)**（四仓共享，不在此复制）。
> 本文件只保留**平台仓特有**的 git 规则：能力仓 sibling 钉版、跨仓钉法与 manifest 联动。与 `AGENTS.md` 的硬约束同级别。

## 1. 能力仓 sibling 钉版纪律（平台仓特有）

- 能力仓 `../wasmnest-lib` 是全部内部依赖 crate 的唯一真源；平台经 Cargo sibling path 直接消费，**不复制、不镜像、不挂 submodule**。
- 能力仓改动先在 `../wasmnest-lib` 提交 / 打 tag；平台只更新 `release-manifest.json`（`repos.lib.tag` / `contract.version`），不存在需要移动的 submodule 指针。
- 跨仓钉法（每次 lib / apps 改动必走）：改 → 提交 → 打 tag（`lib-vX.Y.Z` / `apps-vX.Y.Z`）→ 平台改 `release-manifest.json`（`lib.tag` / `apps.tag` = 对应仓 HEAD **精确 tag**）→ `pnpm run check:manifest`（同时校验能力仓工作树干净）→ 平台提交。
- `release-manifest.json` 的 `repos.lib.tag` / `repos.apps.tag` 必须是**精确 tag**（不是分支名 / 短哈希）。

## 2. 跨仓提交顺序（通用规则在 docs/public/git.md §7）

同一特性跨仓时：**能力仓（真源 + tag `lib-v*`）→ 平台仓（指针 / 清单 / SDK 生成物）→ 应用仓（产物重建，tag `apps-v*`）**；每一仓各自可回退。