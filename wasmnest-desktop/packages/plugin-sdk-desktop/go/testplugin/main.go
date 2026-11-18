// SDK 壳验证组件（issue #21 Phase 1）——以 SDK 自身消费面验证：
//  1. sdk.Entry 接线后 TinyGo 能产出合法组件（Testing Decisions：涉及绑定
//     生成的改动必须跑一次 TinyGo 构建产出组件才算验证）；
//  2. host 包装（log / config）与命令分发的端到端形状。
//
// 构建见 go/README.md（tools/gen-bindings.mjs 先组装 wit 包，再
// tinygo build -target=wasip2 -wit-package ../wit -wit-world go-plugin）。
package main

import (
	_ "embed"
	"encoding/json"

	sdk "github.com/7zai/wasmnest-plugin-sdk-go/sdk"
)

//go:embed plugin.json
var pluginManifest string

//go:embed index.js
var frontendStub string

// _ 保住 index.js 的 embed（前端桩文件本组件不消费，产物目录布局要求它存在）
var _ = frontendStub

type probe struct{}

func (probe) Manifest() string { return pluginManifest }

func (probe) Activate() error {
	sdk.HostLogInfo("[go-sdk-probe] activated via sdk.Entry")
	return nil
}

func (probe) Deactivate() error { return nil }

var commands = sdk.CommandTable{
	// host-config 包装端到端：读 home_dir 回显（判据同 Phase 0 spike）
	"go-sdk.ping": func(json.RawMessage) (any, error) {
		home := ""
		if v, ok, err := sdk.HostConfigGet("home_dir"); err != nil {
			sdk.HostLogWarn("[go-sdk-probe] config get(home_dir) failed: " + err.Error())
		} else if ok {
			home = v
		}
		return map[string]any{"pong": true, "plugin": "com.wasmnest.go-sdk-probe", "home": home}, nil
	},
	// 命令载荷往返：args 原样回显（前端契约不变性的最小用例）
	"go-sdk.echo": func(args json.RawMessage) (any, error) {
		var v any
		if err := json.Unmarshal(args, &v); err != nil {
			return nil, err
		}
		return v, nil
	},
}

func (p probe) InvokeCommand(name string, args json.RawMessage) (any, error) {
	return commands.Invoke(name, args)
}

func init() { sdk.Entry(probe{}) }

func main() {
	// 库形态组件：导出全部经 sdk.Entry 在 init() 接线；TinyGo wasip2 默认追加的
	// wasi:cli/run 导出无害（宿主不探测）。
}
