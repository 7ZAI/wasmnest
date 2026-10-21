# WasmNest Dev Shell（桌面端应用浏览器开发环境）

在浏览器里运行**桌面 app 的挂载包源码**：HMR 直达、不必构建打包、不必装进宿主
即可迭代 UI 与前端逻辑。dev-shell 走的是**与桌面宿主同一条装载路径**——app 的
`src/entry.ts` 导出 `mountApp(root, env)`，dev-shell 的挂载槽按同一份契约调用它。

> 2026-10-21 同步：dev-shell 此前仍是旧贡献面形态（`activate(context)` + 侧边栏 /
> 工具箱 / 标题栏项等注册面），与机制 B（独立挂载包）不符，**当前桌面 app 一个都
> 预览不了**。现已按桌面宿主前端重写，详见 `docs/contracts.md` §5.2。

## 使用

### 前提

- Node ≥ 20
- 应用工程已声明 `@binblink/wasmnest-plugin-sdk-desktop` 依赖（`file:` 本地链接或 npm）
- SDK 构建产物存在：未构建时先在 SDK 目录执行 `pnpm install && pnpm run build`
  （报找不到模块多半是这一步没做）

### 启动（推荐走 CLI）

`dev-shell` 由 SDK 提供的 CLI 启动，统一用 **`pnpm exec wasmnest-plugin-desktop dev`**：
在应用工程目录运行（bin 来自应用的 SDK 依赖，勿省略 `npx`）：

```bash
cd wasmnest-apps/apps/file-transfer/desktop
pnpm exec wasmnest-plugin-desktop dev            # 使用当前目录作为应用
pnpm exec wasmnest-plugin-desktop dev --entry src/custom-entry.ts
pnpm exec wasmnest-plugin-desktop dev ../my-app --port 5180 --open
pnpm exec wasmnest-plugin-desktop dev --host     # 监听局域网（平板/其他设备浏览器访问）
```

也可在仓库任意位置指定应用目录：

```bash
pnpm exec wasmnest-plugin-desktop dev wasmnest-apps/apps/file-transfer/desktop
```

浏览器打开 `http://localhost:5173`（`--open` 自动打开）。首次运行会自动安装
dev-shell 自身依赖（vue / vite / tailwind 等，仅一次）。

#### 参数

| 参数 | 说明 |
|---|---|
| `[pluginDir]` | 应用工程目录，默认当前目录（须含 `plugin.json` 或入口文件） |
| `--entry <file>` | 应用入口文件，默认 `src/entry.ts`（无则回落 `src/index.ts`） |
| `--port <port>` | dev server 端口，默认 5173 |
| `--host [addr]` | 监听局域网（默认 `0.0.0.0`），手机/平板与电脑同一 WiFi 时访问 `http://<电脑IP>:<port>/` |
| `--open` | 启动后自动打开浏览器 |

环境异常时先自检：`pnpm exec wasmnest-plugin-desktop doctor`（检查 Node / Rust /
wasm32 target / dev-shell 依赖 / SDK 构建产物）。

### 手动启动（不走 CLI）

```bash
WASMNEST_DEV_PLUGINS="<应用目录>[::<入口文件>]" pnpm exec vite --config <dev-shell>/vite.config.ts
```

多个应用用逗号分隔，dev-shell 工具栏右侧的切换菜单可逐个切换。

## 结构（与桌面宿主同形）

```
┌──────────────────────────────────────────────┐
│ 壳标题栏（ShellToolbar）                     │  ← 宿主同款：品牌 / 当前应用 / 主题 / 语言 / 日志
├──────────────────────────────────────────────┤
│                                              │
│ 应用挂载槽（AppMountSlot）                   │  ← app 的 mountApp(root, env) 挂在这里
│                                              │     与真机同边界：只占标题栏以下的区域
├──────────────────────────────────────────────┤
│ 平台状态栏（ShellStatusBar）                  │  ← 宿主同款：运行时就绪 / 应用数
└──────────────────────────────────────────────┘
```

- **设计 token 单一真源**：monorepo 内 dev-shell 直接 import 宿主
  `src/style.css` 与 `src/shell/styles/shell.css`（跟随宿主更新，零维护）；npm 包内
  没有宿主，退回自带副本，副本与宿主的一致性由 `dev-shell/__tests__/visualParity.test.ts` 钉住。
- **契约漂移锁**：`dev-shell/__tests__/shell/contractDrift.test.ts` 逐字段比对
  dev-shell 的挂载契约与宿主 `src/shell/mount/useAppMount.ts`，并断言退役的贡献面
  API 不回接。

## Mock 边界（与真机差异）

| 能力 | 浏览器行为 |
|---|---|
| 挂载 | 加载 app 的 `src/entry.ts` **源码**（真机加载构建产物整包） |
| `appInvoke`（app 自己的 Rust 命令） | 由领域 mock 表应答；app 的 `devMock` 种子驱动返回值与事件。未注册的命令**显性失败**（日志面板可见），需真机验证 |
| `invoke`（宿主面命令） | 仅 `get_app_settings` / `report_frontend_log` 有浏览器语义，其余显性失败 |
| 事件通道 | Tauri IPC 垫片（`plugin:event|listen/unlisten/emit`）——app 的 `listen()` 在浏览器里照常工作，领域 mock 推的事件经同一条通道送达 |
| 存储 | localStorage 持久化（`wasmnest-dev-shell:<appId>:<key>`） |
| 权限 / 令牌 | 无（dev-shell 不做权限仲裁，app 的令牌由 mock 顶替） |
| 主题 / 字号 | 与宿主同语义（`light` / `dark` / `system` + `--ui-scale`，Linux 基线 ×1.15）；色板不再落 documentElement（宿主已退役该机制） |
| 应用的 Tailwind | 应用的 CSS 在 dev-shell 里由**dev-shell 的** tailwind 配置编译（与宿主同一份 theme，但宿主与 app 各自的构建产物仍由各自配置产出）。默认档（`--ui-scale = 1`）两者外观一致；改字号档位时 app 文字会随 `--ui-scale` 缩放，而真机上的 app 产物不缩放——字号档位的最终观感以真机为准 |

### 领域种子（devMock）

app 在 `src/index.ts` 导出 `devMock`（各 app 自持演示数据）时，dev-shell 按种子
子域挂载对应领域 mock（file-transfer 的 peer / transfer 域、agent-hub 的五个域）。
**没有导出的 app**（如 ai-chatbox / bedcode / monitor）只校验壳与布局：其命令会在
日志面板里报「未注册 mock」，这是预期状态，不是 dev-shell 的故障。

### 预览面（mountPreview）

宿主的多任务卡片预览面（`mountPreview`）在 dev-shell **不复刻**（dev-shell 没有多任务
卡片层）。契约类型在 dev-shell 侧与宿主对齐，但预览路径未被 dev-shell 覆盖——
预览相关的行为需在真机验证。

## 常见问题

- **应用没挂上**：看挂载槽的错误详情——多半是入口不是 `src/entry.ts`，或该入口
  未导出 `mountApp`（契约不匹配）。日志面板有完整原因。
- **插件样式缺失**：dev-shell 的 tailwind.config.js 按 `WASMNEST_DEV_PLUGINS`
  动态扫描应用源码，新加类名自动生效。
- **命令报「未注册 mock」**：该命令没有领域 mock 实现——补 app 的 `devMock` 种子
  与对应 handler，或到真机验证。
- **SDK 报找不到模块**：应用工程的 `@binblink/wasmnest-plugin-sdk-desktop` 依赖指向
  SDK 包（file: 或 npm），其 `dist` 需存在（先构建一次 SDK）。
- **真机专属能力**（Rust 命令、真实 HTTP 端点、系统文件选择）无法在浏览器
  模拟，发布前需在真实宿主验证。
