# 品牌文案（slogan / 定位句）

> 本文件是 WasmNest **对外文案的唯一真源**：品牌主标、副标句、技术意象句、备选池、使用规则与落地位置。
> 视觉口径（配色 / 字体 / 图形 logo / 设计 token）**不在本文件**——token 在 `wasmnest-desktop/src/style.css` 与 `wasmnest-mobile/src/styles/mobile.css` 的 CSS 变量里，图标由 `wasmnest-desktop/scripts/generate-*.js` 生成。
> 文案字面 ≠ 事实：§4 逐条登记实现点与现状，改文案前先 `rg` 核对对应 key 是否还在。

---

## 1. 定稿（用户 2026-10-27 确认）

| 层级 | 语言 | 文案 | 用途 |
| --- | --- | --- | --- |
| 主标 | 中文 | **你的工具，住进你的巢。** | 对外品牌记忆点（用户面）；logo 旁 / 开屏 / 商店简介首句 |
| 主标 | 英文 | **Your tools. Your nest. Your rules.** | 同上（英文面） |
| 副标句 | 中文 | **双端 Wasm 应用宿主 —— 能力即权限，宿主保持极简。** | README 首屏 / GitHub description |
| 副标句 | 英文 | **A dual-end Wasm app host — capability is permission, the host stays thin.** | README_en 首屏 |
| 技术意象句 | 中文 | **契约之内，自由生长** | 架构文档扉页 / 贡献者入口；不用于对外物料 |
| 一句话定位（长版） | 中文 | WasmNest 把每个产品能力做成可独立构建的 wasm 应用，装进一个薄壳宿主：一套契约跑桌面与 Android，能做什么由权限逐项决定。 | 发布说明 / 商店简介 |

## 2. 取舍理由

1. **「巢」是名字里唯一自带的品牌资产**。WasmNest = Wasm + Nest；巢既承接「装载 / 收纳」，也承接「养育 / 生长」——正对产品立场「应用不被停用就继续运行，宿主保持极简」。
2. **「住进」而不是「装进」**。装进是安装动作（一次性），住进是持续状态（应用在宿主里长期活着）。这是 WasmNest 与「插件式软件」最直观的差别，九个字讲完。
3. **英文三拍落在 rules**。前两拍给归属与品牌，第三拍把最关键的产品立场（能力即权限、无默认授予）压成一个词；比直译「住进你的巢」更有信息量。
4. **副标句保留技术锚点**。主标不解释技术，副标句负责让人三秒内知道这是什么产品；「能力即权限」是 README 现有表中唯一的立场性表述，直接复用不另造词。
5. **技术意象句只对贡献者**。「契约之内」指 WIT / Component Model 的硬边界，「自由生长」指应用侧不受宿主牵制——这正是「稳定的是设计边界，不是版本号」的等价表达，但技术词密度过高，不能当主标。

## 3. 备选池（未启用）

| 方向 | 文案 | 状态 | 说明 |
| --- | --- | --- | --- |
| 生态 | 薄壳宿主，万物可巢 | 备选 | 适合仓库 description / 特性段小标题 |
| 双端 | 写一次，两端入巢 | 备选 | 适合移动端落地页、双端对比图 |
| 权限 | 能力即权限，用多少给多少 | 已并入副标句 | 单独用时口语感强，适合安装引导 |
| 极简 | 巢小而自由 | 备选 | 适合 logo 下方横排 tagline（短、留白大） |
| 个人向 | 自己的工具，自己的巢 | 备选 | 适合面向非开发者用户（「个人小程序平台」定位） |

启用规则：备选池条目**不得直接进对外物料**；要启用必须先并入 §1 并同步 §4 全部落地位置（§6）。

## 4. 落地位置与现状

| 位置 | 文件 / key | 现在的内容 | 与定稿的差异 |
| --- | --- | --- | --- |
| 仓库首屏定位句 | `README.md` 第 3 行加粗句 | 「双端 Wasm 应用宿主：桌面与 Android 共用一套应用契约……」 | 纯技术描述，**待换为「主标 + 副标句」** |
| 仓库首屏定位句（英） | `README_en.md` 第 3 行加粗句 | 同上（英文直译） | 同上 |
| 桌面开屏副标题 | `wasmnest-desktop/src/i18n/host-zh-CN.ts` `desktop.splash.tagline` | 多 WASM 应用运行平台 | 技术描述；且 `WASM` 全大写与 README 的「Wasm / wasm 应用」口径不一致 |
| 桌面开屏副标题（英） | `wasmnest-desktop/src/i18n/host-en.ts` `desktop.splash.tagline` | Multi-WASM app runtime | 同上 |
| 移动开屏副标题 | `wasmnest-mobile/src/locales/zh-CN/mobile.ts` `splash.tagline`（key 由 `wasmnest-mobile/src/config/splash.ts` 的 `taglineKey` 引用） | 局域网远程终端 | **与当前移动宿主定位（wasm 应用壳）不符，疑为远程终端时期遗留**；改前先确认移动宿主定位 |
| 移动开屏副标题（英） | `wasmnest-mobile/src/locales/en/mobile.ts` 同 key | LAN Remote Terminal | 同上 |
| 桌面「关于」 | `wasmnest-desktop/src/shell/settings/SettingsAboutSection.vue` | 仅产品名 + 版本号 | 无副标，可放副标句（未做） |
| 移动「关于」 | `wasmnest-mobile/src/views/settings/AboutSettingsView.vue` | 仅产品名 + 版本号 | 同上（未做） |

> §4 的差异**不是待办清单**：换哪一处、何时换由产品决定；改之前按 §6 走。

## 5. 使用规则

- **主标恒定**：不改写、不缩短、不中英混拼（不写「你的工具，住进 WasmNest」之类改写）。
- **英文三拍是句，不是并列短语**：句号分隔、每句首字母大写。不写成 `Your tools, your nest, your rules.`——逗号连写会丢掉三拍停顿，也就丢掉了落在 rules 上的重音。
- **中文全角标点**，句末保留句号；单独成行时不加书名号 / 引号 / 破折号。
- **一屏一个层级**：主标 + 副标句可同屏；技术意象句不与前两者同屏（技术词与用户面混排会让两句都失效）。
- **术语口径**：对外文案统一写「Wasm 应用」/「wasm 应用」（以 `README.md` 首段为准），不写全大写「WASM」；技术制品名（`wasm32-wasip3`、`.wasm` 文件名、`WASM_*` 环境变量）不受此限。

## 6. 变更纪律

改 §1 任一条目 = 品牌变更，按以下顺序一次做完（禁止只改一处就收工）：

1. 同一提交内同步 §4 **全部**落地位置（含中英双语），并更新本文件 §1 的日期。
2. 动 i18n key 时遵守 `docs/frontend.md` 的文案纪律（宿主文案不进应用包；双语必须同步——桌面侧由 `wasmnest-desktop/src/__tests__/shell/i18nTemplateKeys.test.ts` 的 key 存在性锁兜底）。
3. 验证：改到的端跑该端测试（桌面 `cd wasmnest-desktop && pnpm run test:run`；移动同），开屏 / 关于页在真实宿主目验（文案是排版敏感的短句，长一两个字就会换行）。
4. 已发布版本上的开屏文案属于界面，按 `docs/git.md` 的正常提交规范走，不需要 bump 版本号（版本只在发布时设置，见 `docs/public/versioning.md`）。
