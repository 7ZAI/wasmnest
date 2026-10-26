//go:build wasip2

// 宿主能力域惯用包装：host-http（HTTP 出站代理）——随首个消费面（ai-chatbox
// Go 试点，issue #21 Solution 5）落 SDK，Rust 侧 `HostHttp::http_fetch` 的对等物。
// 其余能力域（ws / peer / pty / mdns / notify / …）仍经 gen 包直用，消费面出现再补。
package sdk

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/host-http"
)

// HostHTTPFetch 经宿主代理发起 HTTP 请求（需要 network:http 权限）。
//
// request 为任意 JSON 可序列化载荷（method / url / headers / body / stream /
// streamEvent / sseFormat，形状契约见 core.wit host-http 注释）。返回解包约定：
//   - err != nil：请求不可序列化 / 宿主侧失败（权限、网络错误）；
//   - ok=false 且 err=nil：宿主返回空结果（合法空态，调用方显性处置）；
//   - ok=true：响应 JSON 原文（已校验合法性；流式请求为 `{streamId, streamEvent}`，
//     非流式为 `{status, body, headers}`）。
func HostHTTPFetch(request any) (json.RawMessage, bool, error) {
	reqJSON, err := json.Marshal(request)
	if err != nil {
		return nil, false, fmt.Errorf("http_fetch: serialize request failed: %w", err)
	}
	res := hosthttp.Fetch(string(reqJSON))
	if res.IsErr() {
		return nil, false, errOf(res)
	}
	opt := res.OK()
	if opt == nil || opt.None() {
		return nil, false, nil
	}
	some := opt.Some()
	if some == nil || !json.Valid([]byte(*some)) {
		return nil, false, errors.New("http_fetch: response is not valid JSON")
	}
	return json.RawMessage(*some), true, nil
}
