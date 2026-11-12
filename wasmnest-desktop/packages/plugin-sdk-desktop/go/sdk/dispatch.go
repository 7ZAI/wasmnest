// 命令分发表——最简形态的 [Plugin.InvokeCommand] 实现（可移植，原生可测）。
//
// 未知命令显性报错是纪律不是建议（spec #21 User Story 5：不静默返回空），
// [CommandTable.Invoke] 把这条纪律做成默认行为；应用自定义分发时须自行保持。
package sdk

import (
	"encoding/json"
	"fmt"
)

// CommandFunc 是单条命令的处理函数：原始 JSON 载荷进、任意 JSON 可序列化
// 值出（nil 序列化为 null，与 Rust `Value::Null` 同形）。
type CommandFunc func(args json.RawMessage) (any, error)

// CommandTable 是命令名到处理函数的分发表。
type CommandTable map[string]CommandFunc

// Invoke 分发一条命令；未知命令返回点名错误（不静默返回空）。
func (t CommandTable) Invoke(name string, args json.RawMessage) (any, error) {
	fn, ok := t[name]
	if !ok {
		return nil, fmt.Errorf("unknown command: %s", name)
	}
	return fn(args)
}

// commandResultJSON 把命令结果序列化为宿主回传形状：成功 → 值的 JSON；
// 失败 → `{"error":"…"}`（错误串经 json.Marshal 转义，与 Rust 侧
// `serde_json::json!({ "error": e.to_string() })` 同口径，避免引号 /
// 反斜杠产出非法 JSON 屏蔽真实错误原因）。
func commandResultJSON(v any, err error) string {
	if err != nil {
		return mustJSON(map[string]string{"error": err.Error()})
	}
	return mustJSON(v)
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		// 序列化失败只可能是值携带 chan / func 等不可编码类型（应用侧缺陷），
		// 点名值类型而非吞错——宿主侧拿到非法 JSON 的诊断更难。
		// 错误串本身经 map 编码转义（字符串值恒可编码，递归必终止），
		// 不手工拼接——拼接会把错误串里的引号 / 反斜杠变成非法 JSON。
		return mustJSON(map[string]string{"error": "command result not JSON-serializable: " + err.Error()})
	}
	return string(b)
}
