// WasmNest 插件 SDK——Go 壳（issue #21「应用后端 Go 语言支持」Phase 1）
//
// 模块随平台仓源码取用（首期不发布，spec #21 Out of Scope）：应用 Go 工程经
// replace 指令把本模块指到本目录，等价于 Rust 侧经 crates.io 版本 + [patch]
// 指回工作树 SDK 的消费形态。
//
// 绑定生成物 gen/ 与 SDK 壳 sdk/ 之外，本模块不含手工维护的契约内容——
// 契约真源在能力仓 WIT（经 compose-wit.mjs 拼装到 ../rust/wit/），重生成见
// tools/gen-bindings.mjs。
module github.com/7zai/wasmnest-plugin-sdk-go

go 1.27.3

require go.bytecodealliance.org/cm v0.3.0
