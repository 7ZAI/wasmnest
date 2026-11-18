// Package sdk 是 WasmNest 插件的 Go 壳——Rust 侧 `wasmnest-plugin-api`
// （`WasmPlugin` trait + `wasm_entry!` 宏）的对等物（issue #21 Phase 1）。
//
// 应用后端实现 [Plugin] 接口并在 init() 调用 [Entry]，即完成组件全部
// 必选导出（command / lifecycle / manifest / events / abi-form）的接线；
// 可选回调经接口升级（本文件末尾的 Observer 接口）按需实现，未实现的
// 回调导出空实现（宿主按名探测，与 Rust 侧 trait 默认实现同语义）。
//
// 文件分两类（原生 `go test ./sdk` 只编译可移植文件，wasmimport 重定位
// 在原生目标不可链接——Phase 0 spike 实证）：
//   - 可移植（无 build tag）：本文件、dispatch.go——纯 Go 逻辑，原生可测；
//   - 组件目标（//go:build wasip2）：entry_wasip2.go、host_wasip2.go——引用
//     gen/ 绑定，仅 TinyGo `-target=wasip2` 构建参与编译。
//     文件名后缀刻意用 `wasip2` 而非 `wasm`：`_wasm` 是 GOARCH 隐式约束
//     （与 //go:build AND 组合），在本目标（GOARCH=arm/amd64）下会把文件
//     无条件排除——`wasip2` 不是 GOOS/GOARCH 值，无隐式约束。
//
// 可选探测导出（events-binary / events-ws / events-task / auth-policy）
// 首期不提供：宿主按名探测、缺失容忍（spec #21 Implementation Decisions）。
package sdk

import "encoding/json"

// Plugin 是 Go 后端应用必须实现的核心接口（Rust `WasmPlugin` 必选方法的对等物）。
type Plugin interface {
	// Manifest 返回插件清单 JSON（plugin.json 内容，原样字符串）。
	Manifest() string

	// Activate 激活插件；返回错误时宿主将插件置为失败态（不静默降级）。
	Activate() error

	// Deactivate 停用插件；返回错误仅记录日志，不影响宿主停用流程。
	Deactivate() error

	// InvokeCommand 调用自定义命令。args 为原始 JSON 载荷（不预解码——
	// 无效 JSON 由插件自行 Unmarshal 并显性失败，不静默替换为 null）；
	// 返回值经 JSON 序列化回传前端，错误序列化为 `{"error":"…"}` 形状
	// （与 Rust 侧 wasm_entry! 的命令应答口径一致）。
	// 未知命令必须显性报错（spec #21 User Story 5）——用 [CommandTable]
	// 即自动获得该纪律。
	InvokeCommand(name string, args json.RawMessage) (any, error)
}

// BusMessage 是总线消息的可移植形状（Rust SDK `BusMessage` 的对等物；
// ABI 三段字符串在 entry_wasm.go 装配，timestamp 当前 ABI 未传递、恒 0）。
type BusMessage struct {
	Topic     string          `json:"topic"`
	Sender    string          `json:"sender"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp uint64          `json:"timestamp"`
}

// ==================== 可选回调（接口升级，等价 Rust trait 默认实现） ====================

// StartupHook 应用启动完成回调（建表 / 注册扩展点等；错误 → 宿主置 Degraded）。
type StartupHook interface {
	OnStartup() error
}

// ShutdownHook 应用即将关闭回调（错误仅记录日志）。
type ShutdownHook interface {
	OnShutdown() error
}

// MessageObserver 接收总线消息（桌面词汇；订阅须先经 HostBusSubscribe）。
type MessageObserver interface {
	OnMessage(msg BusMessage) error
}

// ProcessDoneObserver 接收进程执行完成事件（host-process run 的异步回执，
// payloadJSON 形如 `{"run_id":…,"exit_code":…,"timed_out":…}`）。
type ProcessDoneObserver interface {
	OnProcessDone(payloadJSON string) error
}

// 以下 5 个为移动词汇回调（events 七函数并集，桌面宿主不调用）：
// 双端共享产物按桌面 world 构建时同时导出，桌面原生插件可不实现。

// BusMessageObserver 移动词汇总线消息回调（无 sender 段；与 OnMessage 汇流由
// 共享产物自行决定）。
type BusMessageObserver interface {
	OnBusMessage(msg BusMessage) error
}

// AuthSuccessObserver 移动词汇：WS 认证成功回调。
type AuthSuccessObserver interface {
	OnAuthSuccess() error
}

// DisconnectObserver 移动词汇：WS 断开回调（reason 为人类可读原因）。
type DisconnectObserver interface {
	OnDisconnect(reason string) error
}

// SessionCreatedObserver 移动词汇：会话创建回调。
type SessionCreatedObserver interface {
	OnSessionCreated(sessionID string) error
}

// SessionStoppedObserver 移动词汇：会话停止回调。
type SessionStoppedObserver interface {
	OnSessionStopped(sessionID string) error
}
