// 可移植面单测（原生 go test；组件面 entry_wasm/host_wasm 由 TinyGo 构建
// testplugin 验证——Testing Decisions：绑定生成相关改动以产出组件为准）。
package sdk

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCommandTableUnknownCommandFailsVisibly(t *testing.T) {
	table := CommandTable{"ping": func(json.RawMessage) (any, error) { return "pong", nil }}
	_, err := table.Invoke("nope", json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("未知命令必须显性报错（不静默返回空）")
	}
	if !strings.Contains(err.Error(), "unknown command: nope") {
		t.Fatalf("错误须点名未知命令，实际: %v", err)
	}
}

func TestCommandTableDispatch(t *testing.T) {
	table := CommandTable{
		"echo": func(args json.RawMessage) (any, error) { return string(args), nil },
	}
	got, err := table.Invoke("echo", json.RawMessage(`{"a":1}`))
	if err != nil {
		t.Fatalf("echo 不应报错: %v", err)
	}
	if got != `{"a":1}` {
		t.Fatalf("载荷应原样透传，实际: %v", got)
	}
}

func TestCommandResultJSONErrorShape(t *testing.T) {
	got := commandResultJSON(nil, errString(`boom "quoted" \slash`))
	var decoded map[string]string
	if err := json.Unmarshal([]byte(got), &decoded); err != nil {
		t.Fatalf("错误应答必须是合法 JSON（引号/反斜杠转义）: %v → %s", err, got)
	}
	if decoded["error"] != `boom "quoted" \slash` {
		t.Fatalf("错误串应经转义往返不损，实际: %s", got)
	}
}

func TestCommandResultJSONValueShapes(t *testing.T) {
	cases := []struct {
		name string
		v    any
		want string
	}{
		{"nil → null（Rust Value::Null 同形）", nil, "null"},
		{"bool", true, "true"},
		{"对象", map[string]any{"pong": true}, `{"pong":true}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := commandResultJSON(c.v, nil); got != c.want {
				t.Fatalf("got %s want %s", got, c.want)
			}
		})
	}
}

func TestMustJSONNonSerializableStaysValidJSON(t *testing.T) {
	got := mustJSON(map[string]any{"ch": make(chan int)})
	var decoded map[string]string
	if err := json.Unmarshal([]byte(got), &decoded); err != nil {
		t.Fatalf("不可编码值的兜底应答仍须是合法 JSON: %v → %s", err, got)
	}
	if !strings.Contains(decoded["error"], "not JSON-serializable") {
		t.Fatalf("兜底应点名序列化失败，实际: %s", got)
	}
}

// errString 是测试用的最小 error 实现（避免引入 errors 依赖本体已经足够薄）。
func errString(s string) error { return &staticErr{s} }

type staticErr struct{ msg string }

func (e *staticErr) Error() string { return e.msg }
