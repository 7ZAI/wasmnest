# WasmNest 插件 SDK — Go 壳

Rust 侧 `wasmnest-plugin-api`（`WasmPlugin` trait + `wasm_entry!` 宏）的 Go 对等物：
应用后端实现 `sdk.Plugin` 接口并在 `init()` 调用 `sdk.Entry`，即完成组件全部
必选导出（command / lifecycle / manifest / events / abi-form）的接线。规格与
判据见应用仓 issue #21（Go 语言支持，Phase 1）。

## 布局

| 路径 | 内容 | 归属 |
| --- | --- | --- |
| `sdk/` | 壳包：`Plugin` 接口 + 可选回调接口（可移植，原生可测）／`Entry` 接线 + 宿主能力包装（`//go:build wasip2`，组件目标；core 九接口见 `host_wasip2.go`，能力域首件 http 见 `host_http_wasip2.go`） | 手写真源 |
| `gen/` | wit-bindgen-go 绑定（world `plugin` 全接口面） | 生成物（提交；改契约后重跑脚本） |
| `wit/` | 组装用 wit 包（拼装件 + go-plugin world + TinyGo wasi-cli deps） | 派生（gitignore，`tools/assemble-wit.mjs --out` 组装；应用构建复用同一脚本） |
| `tools/gen-bindings.mjs` | 绑定重生成脚本 | 手写 |
| `testplugin/` | 验证组件（SDK 自消费：TinyGo 构建 + 真实宿主冒烟） | 手写 |

## 工具链（Phase 0 spike 实证组合，2026-10-25）

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| Go | 1.27.3 | 原生单测 / vet / gofmt |
| TinyGo | 0.43.0 | `-target=wasip2` 组件构建（lib/wasi-cli wit 是脚本输入之一） |
| wit-bindgen-go | v0.7.0 | 绑定生成（依赖 `go.bytecodealliance.org/cm v0.3.0`） |
| wasm-tools | 1.240.0 | TinyGo 组件化外部依赖（缺失报 `component embed failed`） |

## 常用命令（本目录）

```bash
# 绑定重生成（改契约 / WIT 后必跑；幂等）
node tools/gen-bindings.mjs && go mod tidy

# 壳可移植面单测 + 格式检查（原生）
go test ./sdk/ && gofmt -l sdk/ && go vet ./sdk/

# 验证组件构建（组件验证判据：产出组件才算验证）
cd testplugin && tinygo build -target=wasip2 -wit-package ../wit -wit-world go-plugin -o go_sdk_probe.wasm .
wasm-tools validate go_sdk_probe.wasm   # 组件合法性
```

## 应用工程接入（首期源码取用，不发布）

```toml
# 应用 Go 工程的 go.mod（路径按仓布局调整）
replace github.com/7zai/wasmnest-plugin-sdk-go => <平台仓>/wasmnest-desktop/packages/plugin-sdk-desktop/go
```

应用侧最小形态（`testplugin/main.go` 是可运行范例）：

```go
type myApp struct{}

func (myApp) Manifest() string                       { return manifestJSON }
func (myApp) Activate() error                        { return nil }
func (myApp) Deactivate() error                      { return nil }
func (p myApp) InvokeCommand(name string, args json.RawMessage) (any, error) {
    return commands.Invoke(name, args) // sdk.CommandTable：未知命令显性报错
}

func init() { sdk.Entry(myApp{}) }
func main() {}
```

可选回调（`OnStartup` / `OnMessage` / `OnProcessDone` / 移动词汇 5 回调等）经
接口升级按需实现，见 `sdk/plugin.go`。宿主能力经 `sdk.Host*` 包装调用
（core.wit 九个内核机制接口 + 能力域首件 `HostHTTPFetch`；其余能力域接口经
`gen/wasmnest/plugin/host-*` 直用）。

## 设计要点（踩坑记录）

- **绑定只对 world `plugin` 生成**：wasi:cli/command 的标准导入由 TinyGo 运行时
  自带，再生成一份会重复；构建期 world 用 `go-plugin`（多一个 wasi include）。
- **组件目标文件用 `//go:build wasip2` 且文件名后缀避开 `_wasm`**：`_wasm` 是
  GOARCH 隐式约束（与 `//go:build` AND 组合），在非 wasm GOARCH 下会把文件
  无条件排除——Phase 1 实证。
- **导入面天然最小化**：TinyGo 链接器剪除未引用的 wasmimport 包装，产物 import
  集合 = 代码实际引用面（Phase 1 实证：全 9 个 core 包装在案，产物只 import
  host-log / host-config 两个）。
- **wasi-cli deps 平铺**：TinyGo 的 `lib/wasi-cli/wit/deps/` 必须按 wasm-tools
  `deps/` 单层约定拷入（嵌套 deps 不被发现，Phase 0 spike 实证）。
