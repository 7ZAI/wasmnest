//go:build wasip2

// Entry：组件全部必选导出的一次性接线——Rust 侧 `wasm_entry!(T)` 宏的
// 对等物（issue #21 Phase 1；接线形态经 Phase 0 spike 实证：wit-bindgen-go
// 的 Exports 结构体函数字段赋值即完成导出实现）。
//
// 与 Rust 宏的语义对齐点：
//   - 五必选导出全接线：manifest.get / abi-form.form / lifecycle 四函数 /
//     command.invoke / events 七函数并集（桌面宿主只调 on-message /
//     on-process-done，其余 5 个移动词汇对桌面原生插件是默认空实现）；
//   - guest 自报失败一律 log_warn 不 log_error（AGENTS §8 日志红线 ③：
//     宿主故障与插件自报 Err 分级，告警不因「插件返回了个 Err」失真）；
//   - 生命周期结果如实上抛（失败 → 宿主置失败态，不静默降级为已激活）。
package sdk

import (
	"encoding/json"

	"go.bytecodealliance.org/cm"

	abiform "github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/abi-form"
	"github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/command"
	"github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/events"
	hostlog "github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/host-log"
	"github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/lifecycle"
	"github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/manifest"
)

// 桌面组件形态值（cap-desktop.wit：form()==1；0 是已退役的自研 core ABI）
const abiFormComponent uint32 = 1

// result<_, string> 的 Go 形状（lifecycle / events 全部回调共用）
type unitResult = cm.Result[string, struct{}, string]

// current 是接线后的插件实例（Entry 调用即覆盖；正常应用整个生命周期只有一个）。
var current Plugin

// Entry 接线全部必选导出。应用在 init() 中调用：
//
//	func init() { sdk.Entry(myPlugin{}) }
//
// 重复调用以后者覆盖（替换接线仅供测试复用同一组件产物）。
func Entry(p Plugin) {
	current = p

	// ==================== manifest / abi-form ====================

	manifest.Exports.Get = func() string { return p.Manifest() }
	abiform.Exports.Form = func() uint32 { return abiFormComponent }

	// ==================== command（原 __wasmnest_invoke_command） ====================

	command.Exports.Invoke = func(name string, argsJSON string) string {
		v, err := p.InvokeCommand(name, json.RawMessage(argsJSON))
		return commandResultJSON(v, err)
	}

	// ==================== lifecycle（原 activate/deactivate/on_startup/on_shutdown） ====================

	lifecycle.Exports.Activate = func() unitResult {
		if err := p.Activate(); err != nil {
			hostlog.Warn("activate failed: " + err.Error())
			return cm.Err[unitResult](err.Error())
		}
		hostlog.Info("Plugin activated (wasm)")
		return cm.OK[unitResult](struct{}{})
	}
	lifecycle.Exports.Deactivate = func() unitResult {
		if err := p.Deactivate(); err != nil {
			hostlog.Warn("deactivate failed: " + err.Error())
			return cm.Err[unitResult](err.Error())
		}
		return cm.OK[unitResult](struct{}{})
	}
	lifecycle.Exports.OnStartup = func() unitResult {
		hook, ok := p.(StartupHook)
		if !ok {
			return cm.OK[unitResult](struct{}{})
		}
		if err := hook.OnStartup(); err != nil {
			hostlog.Warn("on_startup failed: " + err.Error())
			return cm.Err[unitResult](err.Error())
		}
		hostlog.Info("Plugin startup init completed")
		return cm.OK[unitResult](struct{}{})
	}
	lifecycle.Exports.OnShutdown = func() unitResult {
		hook, ok := p.(ShutdownHook)
		if !ok {
			return cm.OK[unitResult](struct{}{})
		}
		if err := hook.OnShutdown(); err != nil {
			hostlog.Warn("on_shutdown failed: " + err.Error())
			return cm.Err[unitResult](err.Error())
		}
		return cm.OK[unitResult](struct{}{})
	}

	// ==================== events（七函数并集；可选回调未实现即空实现） ====================

	events.Exports.OnMessage = func(topic, sender, payloadJSON string) unitResult {
		observer, ok := p.(MessageObserver)
		if !ok {
			return cm.OK[unitResult](struct{}{})
		}
		if err := observer.OnMessage(BusMessage{
			Topic:     topic,
			Sender:    sender,
			Payload:   json.RawMessage(payloadJSON),
			Timestamp: 0,
		}); err != nil {
			hostlog.Warn("on_message failed: " + err.Error())
			return cm.Err[unitResult](err.Error())
		}
		return cm.OK[unitResult](struct{}{})
	}
	events.Exports.OnProcessDone = func(payloadJSON string) unitResult {
		observer, ok := p.(ProcessDoneObserver)
		if !ok {
			return cm.OK[unitResult](struct{}{})
		}
		if err := observer.OnProcessDone(payloadJSON); err != nil {
			hostlog.Warn("on_process_done failed: " + err.Error())
			return cm.Err[unitResult](err.Error())
		}
		return cm.OK[unitResult](struct{}{})
	}
	events.Exports.OnBusMessage = func(topic, payloadJSON string) unitResult {
		observer, ok := p.(BusMessageObserver)
		if !ok {
			return cm.OK[unitResult](struct{}{})
		}
		if err := observer.OnBusMessage(BusMessage{
			Topic:     topic,
			Sender:    "", // 移动词汇无 sender 段（与 Rust 宏同形）
			Payload:   json.RawMessage(payloadJSON),
			Timestamp: 0,
		}); err != nil {
			hostlog.Warn("on_bus_message failed: " + err.Error())
			return cm.Err[unitResult](err.Error())
		}
		return cm.OK[unitResult](struct{}{})
	}
	events.Exports.OnAuthSuccess = func() unitResult {
		observer, ok := p.(AuthSuccessObserver)
		if !ok {
			return cm.OK[unitResult](struct{}{})
		}
		if err := observer.OnAuthSuccess(); err != nil {
			hostlog.Warn("on_auth_success failed: " + err.Error())
			return cm.Err[unitResult](err.Error())
		}
		return cm.OK[unitResult](struct{}{})
	}
	events.Exports.OnDisconnect = func(reason string) unitResult {
		observer, ok := p.(DisconnectObserver)
		if !ok {
			return cm.OK[unitResult](struct{}{})
		}
		if err := observer.OnDisconnect(reason); err != nil {
			hostlog.Warn("on_disconnect failed: " + err.Error())
			return cm.Err[unitResult](err.Error())
		}
		return cm.OK[unitResult](struct{}{})
	}
	events.Exports.OnSessionCreated = func(sessionID string) unitResult {
		observer, ok := p.(SessionCreatedObserver)
		if !ok {
			return cm.OK[unitResult](struct{}{})
		}
		if err := observer.OnSessionCreated(sessionID); err != nil {
			hostlog.Warn("on_session_created failed: " + err.Error())
			return cm.Err[unitResult](err.Error())
		}
		return cm.OK[unitResult](struct{}{})
	}
	events.Exports.OnSessionStopped = func(sessionID string) unitResult {
		observer, ok := p.(SessionStoppedObserver)
		if !ok {
			return cm.OK[unitResult](struct{}{})
		}
		if err := observer.OnSessionStopped(sessionID); err != nil {
			hostlog.Warn("on_session_stopped failed: " + err.Error())
			return cm.Err[unitResult](err.Error())
		}
		return cm.OK[unitResult](struct{}{})
	}
}
